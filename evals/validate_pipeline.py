#!/usr/bin/env python3
"""
CDST Pipeline Validation Script
================================
Validates all 9 LLM pipeline calls end-to-end using a real audio recording.

Usage:
    python validate_pipeline.py <audio_file> [--track 1|2|both] [--out report.json]

Environment variables required:
    GEMINI_API_KEY        — Google Gemini API key
    DEEPGRAM_API_KEY      — Deepgram API key (for batch transcription)

Track 2 additionally requires:
    DATABASE_URL          — Postgres connection string (default: postgresql://localhost/cdst)
    JWT_SECRET            — Must match orchestrator (default: change-me-in-production)
    VALIDATION_MODE=true  — Must be set when starting the orchestrator

Assumptions baked in (no GPS / time data available):
    District : Birbhum (WB_BRB)
    Month    : 3 (March → pre_monsoon season)
    Patient  : new (no prior records)
"""

import argparse
import asyncio
import base64
import copy
import json
import os
import subprocess
import sys
import textwrap
import time
from datetime import datetime, timezone
from pathlib import Path

# Load .env from the repo root before anything else reads os.environ
_env_file = Path(__file__).parent / ".env"
if _env_file.exists():
    for _line in _env_file.read_text().splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip())

import httpx

from epi_utils import load_baseline_diseases, load_epi_prior
from history_stage import (
    extract_chief_complaint,
    generate_questionnaire,
    validate_questionnaire,
)
from diagnosis_stage import (
    extract_medical_concepts,
    generate_differential,
    generate_clarifying_questions,
)
from management_stage import (
    extract_clarifying_findings,
    generate_provisional_diagnosis_and_rx,
    generate_risk_assessment,
    generate_triage_and_handoff,
    run_rule_engine,
    load_formulary,
)
from llm_client import pop_usage_log

# ── Constants ────────────────────────────────────────────────────────────────

DISTRICT_CODE = "WB_BRB"
DISTRICT_NAME = "Birbhum"
MONTH         = 3           # March → pre_monsoon
LAT, LNG      = 23.73, 87.53

DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY", "")

# ── Helpers ───────────────────────────────────────────────────────────────────

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _transcript_lines(text: str) -> list[str]:
    """
    Split a diarized transcript into display lines.
    Each [Speaker N] turn is one line; long turns are word-wrapped at 110 chars.
    """
    result: list[str] = []
    for raw_line in text.splitlines():
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        if len(raw_line) <= 110:
            result.append(raw_line)
        else:
            # Preserve the speaker tag on the first wrapped line
            tag = ""
            body = raw_line
            if raw_line.startswith("[Speaker"):
                bracket_end = raw_line.index("]") + 1
                tag  = raw_line[:bracket_end + 1]   # "[Speaker N] "
                body = raw_line[len(tag):]
            wrapped = textwrap.wrap(body, width=110 - len(tag))
            for j, chunk in enumerate(wrapped):
                prefix = tag if j == 0 else " " * len(tag)
                result.append(prefix + chunk)
    return result


def print_transcript_numbered(text: str) -> None:
    for i, line in enumerate(_transcript_lines(text), 1):
        print(f"  {i:4d}  {line}")


def split_transcript(full: str, marker_a_line: int, marker_b_line: int) -> tuple[str, str, str]:
    """Slice the diarized transcript into three phase strings based on speaker-turn line numbers."""
    lines = _transcript_lines(full)
    phase_1 = "\n".join(lines[:marker_a_line])
    phase_2 = "\n".join(lines[marker_a_line:marker_b_line])
    phase_3 = "\n".join(lines[marker_b_line:])
    return phase_1.strip(), phase_2.strip(), phase_3.strip()


def extract_prescription(problem_list_output: dict) -> list[dict]:
    """Pull prescription items out of the problem_list for the highlights section."""
    rows = []
    for problem in problem_list_output.get("problem_list", []):
        title = problem.get("problem_title", "?")
        for rx in problem.get("plan", {}).get("prescription", []):
            rows.append({
                "problem":   title,
                "drug":      rx.get("drug", ""),
                "dose":      rx.get("dose", ""),
                "route":     rx.get("route", ""),
                "frequency": rx.get("frequency", ""),
                "duration":  rx.get("duration", ""),
                "stg_source": rx.get("stg_source", None),
            })
    return rows


def print_summary(report: dict) -> None:
    """Print a concise terminal summary of the validation run."""
    h = report["highlights"]
    print("\n" + "=" * 70)
    print("VALIDATION SUMMARY")
    print("=" * 70)

    print(f"\nRisk tier : {h['risk_tier']}")
    triggers = h.get("rule_engine_triggered", [])
    if triggers:
        print(f"Rule engine triggers:")
        for t in triggers:
            print(f"  • {t}")
    else:
        print("Rule engine triggers : none")

    if h.get("stg_rag_warning"):
        print(f"\n[!] {h['stg_rag_warning']}")

    print("\nTop differential:")
    for dx in report["call_outputs"]["D2_differential_table"][:3]:
        mnm = " [MUST-NOT-MISS]" if dx.get("must_not_miss") else ""
        print(f"  {dx.get('rank','')}. {dx.get('disease','')}  ({dx.get('probability','')}){mnm}")

    print("\nQuestionnaire sections:")
    for s in h.get("questionnaire_sections", []):
        print(f"  • {s}")

    print("\nClarifying questions:")
    for q in h.get("clarifying_questions", []):
        print(f"  [{q.get('priority','')}] {q.get('question','')}")

    print("\nPrescription:")
    rx_rows = h.get("prescription", [])
    if rx_rows:
        for row in rx_rows:
            stg = f"  (STG: {row['stg_source']})" if row.get("stg_source") else ""
            print(f"  • [{row['problem']}] {row['drug']} {row['dose']} {row['route']} "
                  f"{row['frequency']} × {row['duration']}{stg}")
    else:
        print("  (no prescription items)")

    if "track2_orchestrator" in report:
        t2 = report["track2_orchestrator"]
        match = t2.get("match_vs_track1", {})
        print(f"\nTrack 2 match vs Track 1:")
        for stage, ok in match.items():
            status = "OK" if ok else "MISMATCH"
            print(f"  {stage}: {status}")

    print()


# ── Transcription ─────────────────────────────────────────────────────────────

def _build_diarized_transcript(words: list[dict]) -> str:
    """
    Reconstruct a speaker-labelled transcript from Deepgram's word-level
    diarization output.  Consecutive words from the same speaker are joined
    into a single line:

        [Speaker 0] What is your name?
        [Speaker 1] My name is Ramesh. I am 35 years old.
    """
    if not words:
        return ""

    lines: list[str] = []
    current_speaker: int | None = None
    current_words: list[str] = []

    for w in words:
        speaker = w.get("speaker", 0)
        word    = w.get("punctuated_word") or w.get("word", "")
        if speaker != current_speaker:
            if current_words:
                lines.append(f"[Speaker {current_speaker}] {' '.join(current_words)}")
            current_speaker = speaker
            current_words   = [word]
        else:
            current_words.append(word)

    if current_words:
        lines.append(f"[Speaker {current_speaker}] {' '.join(current_words)}")

    return "\n".join(lines)


async def transcribe_audio(audio_path: str) -> str:
    """
    Submit audio to Deepgram batch REST endpoint.
    Uses language=en-US (English output) and diarize=true (speaker labels).
    Returns a speaker-labelled transcript:
        [Speaker 0] ...
        [Speaker 1] ...
    """
    if not DEEPGRAM_API_KEY:
        print("ERROR: DEEPGRAM_API_KEY is not set.")
        sys.exit(1)

    print(f"Transcribing {audio_path} via Deepgram batch API …")

    with open(audio_path, "rb") as f:
        audio_bytes = f.read()

    params = {
        "model":      "nova-3",
        "language":   "bn",
        "diarize":    "true",
        "punctuate":  "true",
    }

    async with httpx.AsyncClient(timeout=300) as client:
        resp = await client.post(
            "https://api.deepgram.com/v1/listen",
            params=params,
            headers={
                "Authorization": f"Token {DEEPGRAM_API_KEY}",
                "Content-Type":  "audio/mpeg",
            },
            content=audio_bytes,
        )

    if resp.status_code != 200:
        print(f"ERROR: Deepgram returned {resp.status_code}: {resp.text[:500]}")
        sys.exit(1)

    result   = resp.json()
    alt      = (
        result.get("results", {})
              .get("channels", [{}])[0]
              .get("alternatives", [{}])[0]
    )
    words    = alt.get("words", [])
    fallback = alt.get("transcript", "")

    transcript = _build_diarized_transcript(words) if words else fallback

    if not transcript.strip():
        print("ERROR: Deepgram returned an empty transcript.")
        print("DEBUG response:", json.dumps(result, indent=2)[:2000])
        sys.exit(1)

    speaker_ids = {w.get("speaker") for w in words if "speaker" in w}
    print(
        f"Transcription complete — {len(words)} words, "
        f"{len(speaker_ids)} speaker(s) detected"
    )

    # Save raw transcript so user can translate externally if needed
    raw_path = Path(audio_path).with_suffix(".bengali_transcript.txt")
    raw_path.write_text(transcript, encoding="utf-8")
    print(f"Bengali transcript saved to: {raw_path}")

    return transcript


# ── Interactive phase splitting ────────────────────────────────────────────────

def _split_on_markers(text: str) -> tuple[str, str, str] | None:
    """
    If the transcript contains #MARKER A#, #MARKER B#, #MARKER C# lines,
    split on them automatically. Returns None if markers are not found.
    """
    import re
    marker_a = re.compile(r"^#\s*MARKER\s*A\s*#", re.IGNORECASE)
    marker_b = re.compile(r"^#\s*MARKER\s*B\s*#", re.IGNORECASE)
    marker_c = re.compile(r"^#\s*MARKER\s*C\s*#", re.IGNORECASE)

    lines = text.splitlines()
    a_idx = b_idx = c_idx = None
    for i, line in enumerate(lines):
        s = line.strip()
        if marker_a.match(s):
            a_idx = i
        elif marker_b.match(s):
            b_idx = i
        elif marker_c.match(s):
            c_idx = i

    if a_idx is None or b_idx is None:
        return None

    phase_1 = "\n".join(lines[:a_idx]).strip()
    phase_2 = "\n".join(lines[a_idx + 1:b_idx]).strip()
    end     = c_idx if c_idx is not None else len(lines)
    phase_3 = "\n".join(lines[b_idx + 1:end]).strip()
    return phase_1, phase_2, phase_3


def prompt_phase_splits(full_transcript: str) -> tuple[str, str, str]:
    """
    Split transcript into three phases.
    If #MARKER A# / #MARKER B# are present, splits automatically.
    Otherwise falls back to interactive line-number prompts.
    """
    auto = _split_on_markers(full_transcript)
    if auto:
        phase_1, phase_2, phase_3 = auto
        print("\nPhase markers detected — splitting automatically.")
        print(f"  Phase 1: {len(phase_1.splitlines())} lines")
        print(f"  Phase 2: {len(phase_2.splitlines())} lines")
        print(f"  Phase 3: {len(phase_3.splitlines())} lines")
        return phase_1, phase_2, phase_3

    lines = _transcript_lines(full_transcript)
    total = len(lines)

    print("\n" + "=" * 70)
    print("FULL TRANSCRIPT (numbered lines)")
    print("=" * 70)
    print_transcript_numbered(full_transcript)
    print(f"\n  Total lines: {total}")
    print()
    print("  Phase 1 = first ~30 seconds: name, age, village, chief complaint")
    print("  Phase 2 = main structured interview (3-4 minutes)")
    print("  Phase 3 = clarifying questions phase (1-2 minutes)")
    print()

    while True:
        try:
            a = int(input("  Line number where Phase 1 ends (Marker A): ").strip())
            if 1 <= a < total:
                break
            print(f"  Must be between 1 and {total - 1}")
        except ValueError:
            print("  Please enter an integer.")

    while True:
        try:
            b = int(input("  Line number where Phase 2 ends (Marker B): ").strip())
            if a < b <= total:
                break
            print(f"  Must be between {a + 1} and {total}")
        except ValueError:
            print("  Please enter an integer.")

    phase_1, phase_2, phase_3 = split_transcript(full_transcript, a, b)

    print("\n--- Phase 1 (first ~30s) ---")
    for ln in phase_1.splitlines():
        print(f"  {ln}")
    print("\n--- Phase 2 (main interview) ---")
    for ln in phase_2.splitlines():
        print(f"  {ln}")
    print("\n--- Phase 3 (clarifying questions) ---")
    for ln in phase_3.splitlines():
        print(f"  {ln}")
    print()

    confirm = input("  Proceed with these splits? [Y/n]: ").strip().lower()
    if confirm and confirm != "y":
        print("  Re-running phase split.")
        return prompt_phase_splits(full_transcript)

    return phase_1, phase_2, phase_3


# ── Track 1: Direct LLM validation ───────────────────────────────────────────

def _perf_entry(elapsed: float, usage_entries: list) -> dict:
    inp = sum(e.get("input_tokens", 0)  for e in usage_entries)
    out = sum(e.get("output_tokens", 0) for e in usage_entries)
    return {"elapsed_s": round(elapsed, 1), "input_tokens": inp, "output_tokens": out, "total_tokens": inp + out}


def _sum_perf(entries: list[dict]) -> dict:
    return {
        "elapsed_s":     round(sum(e["elapsed_s"]     for e in entries), 1),
        "input_tokens":  sum(e["input_tokens"]         for e in entries),
        "output_tokens": sum(e["output_tokens"]        for e in entries),
        "total_tokens":  sum(e["total_tokens"]         for e in entries),
    }


async def run_track1(
    phase_1: str,
    phase_2: str,
    phase_3: str,
) -> dict:
    """
    Call all 9 LLM functions directly with an in-memory vault.
    No database required.
    Returns the full report dict (call_outputs, vault_snapshots, highlights).
    """
    print("\n" + "=" * 70)
    print("TRACK 1 — Direct LLM validation (in-memory vault)")
    print("=" * 70)

    baseline = load_baseline_diseases()
    epi      = load_epi_prior(DISTRICT_CODE, MONTH)
    formulary = load_formulary()

    vault: dict = {
        "patient_id": "VAL-001",
        "gps": {"district_code": DISTRICT_CODE, "lat": LAT, "lng": LNG},
        "patient_record": {},
        "demographics": {},
        "transcript_segments": {
            "phase_1": phase_1,
            "phase_2": phase_2,
            "phase_3": phase_3,
        },
        "risk_tier": None,
        "doctor_auth_status": "pending",
    }

    call_outputs    = {}
    vault_snapshots = {}
    call_perf       = {}

    # ── H1 ────────────────────────────────────────────────────────────────────
    print("H1  extract_chief_complaint …", end=" ", flush=True)
    stage_t0 = t0 = time.perf_counter()
    h1 = await extract_chief_complaint(phase_1, vault)
    elapsed = time.perf_counter() - t0
    print(f"{elapsed:.1f}s")
    call_perf["H1"] = _perf_entry(elapsed, pop_usage_log())
    call_outputs["H1_chief_complaint"] = h1
    vault.update({"chief_complaint": h1})

    # ── H2 ────────────────────────────────────────────────────────────────────
    print("H2  generate_questionnaire …", end=" ", flush=True)
    t0 = time.perf_counter()
    h2 = await generate_questionnaire(h1, vault, baseline, epi, patient_record={})
    h2 = validate_questionnaire(h2)
    elapsed = time.perf_counter() - t0
    print(f"{elapsed:.1f}s")
    call_perf["H2"] = _perf_entry(elapsed, pop_usage_log())
    call_outputs["H2_questionnaire"] = h2
    vault.update({
        "questionnaire":           h2,
        "history_stage_status":    "complete",
        "history_stage_completed_at": now_iso(),
    })
    vault_snapshots["after_history_stage"] = copy.deepcopy(vault)
    history_elapsed = time.perf_counter() - stage_t0

    # ── D1 ────────────────────────────────────────────────────────────────────
    print("D1  extract_medical_concepts …", end=" ", flush=True)
    stage_t0 = t0 = time.perf_counter()
    d1 = await extract_medical_concepts(phase_2, vault)
    elapsed = time.perf_counter() - t0
    print(f"{elapsed:.1f}s")
    call_perf["D1"] = _perf_entry(elapsed, pop_usage_log())
    call_outputs["D1_extracted_concepts"] = d1
    vault.update({"extracted_concepts": d1})

    # ── D2 ────────────────────────────────────────────────────────────────────
    print("D2  generate_differential …", end=" ", flush=True)
    t0 = time.perf_counter()
    d2 = await generate_differential(d1, vault, baseline, epi)
    elapsed = time.perf_counter() - t0
    print(f"{elapsed:.1f}s")
    call_perf["D2"] = _perf_entry(elapsed, pop_usage_log())
    call_outputs["D2_differential_table"] = d2
    vault.update({"differential_table": d2})

    # ── D3 ────────────────────────────────────────────────────────────────────
    print("D3  generate_clarifying_questions …", end=" ", flush=True)
    t0 = time.perf_counter()
    d3 = await generate_clarifying_questions(d2, d1, vault)
    elapsed = time.perf_counter() - t0
    print(f"{elapsed:.1f}s")
    call_perf["D3"] = _perf_entry(elapsed, pop_usage_log())
    call_outputs["D3_clarifying_questions"] = d3
    vault.update({
        "clarifying_questions":       d3,
        "diagnosis_stage_status":     "complete",
        "diagnosis_stage_completed_at": now_iso(),
    })
    vault_snapshots["after_diagnosis_stage"] = copy.deepcopy(vault)
    diagnosis_elapsed = time.perf_counter() - stage_t0

    # ── M1 ────────────────────────────────────────────────────────────────────
    print("M1  extract_clarifying_findings …", end=" ", flush=True)
    stage_t0 = t0 = time.perf_counter()
    m1 = await extract_clarifying_findings(phase_3, vault)
    elapsed = time.perf_counter() - t0
    print(f"{elapsed:.1f}s")
    call_perf["M1"] = _perf_entry(elapsed, pop_usage_log())
    call_outputs["M1_clarifying_findings"] = m1
    vault.update({"clarifying_findings": m1})

    # ── M2 (RAG empty — STG not ingested) ────────────────────────────────────
    print("M2  generate_provisional_diagnosis_and_rx …", end=" ", flush=True)
    t0 = time.perf_counter()
    m2 = await generate_provisional_diagnosis_and_rx(m1, vault, stg_context="", formulary=formulary)
    elapsed = time.perf_counter() - t0
    print(f"{elapsed:.1f}s")
    call_perf["M2"] = _perf_entry(elapsed, pop_usage_log())
    call_outputs["M2_problem_list"] = m2
    vault.update({"problem_list": m2})

    # ── M3 ────────────────────────────────────────────────────────────────────
    print("M3  generate_risk_assessment …", end=" ", flush=True)
    t0 = time.perf_counter()
    m3 = await generate_risk_assessment(m2, m1, vault)
    elapsed = time.perf_counter() - t0
    print(f"{elapsed:.1f}s")
    call_perf["M3"] = _perf_entry(elapsed, pop_usage_log())
    call_outputs["M3_risk_assessment"] = m3
    vault.update({"risk_assessment": m3})

    # ── M4 ────────────────────────────────────────────────────────────────────
    print("M4  generate_triage_and_handoff …", end=" ", flush=True)
    t0 = time.perf_counter()
    m4 = await generate_triage_and_handoff(m2, m3, vault)
    elapsed = time.perf_counter() - t0
    print(f"{elapsed:.1f}s")
    call_perf["M4"] = _perf_entry(elapsed, pop_usage_log())
    call_outputs["M4_triage_output"] = m4
    vault.update({"triage_output": m4})
    management_elapsed = time.perf_counter() - stage_t0

    # ── Rule engine ───────────────────────────────────────────────────────────
    print("Rule engine …", end=" ", flush=True)
    acute_confidence = (
        m2.get("problem_list", [{}])[0]
          .get("assessment", {})
          .get("confidence")
    )
    rule_result = run_rule_engine(
        m2, m4,
        demographics=vault.get("demographics", {}),
        vitals=m1.get("vitals_found", {}),
        red_flags=d1.get("red_flags", []),
        extracted_concepts=d1,
        acute_confidence=acute_confidence,
    )
    final_tier = rule_result["final_risk_tier"]
    m4.setdefault("triage", {})["tier"] = final_tier
    print(f"{final_tier}")

    vault.update({
        "triage_output":                m4,
        "management_stage_status":      "complete",
        "management_stage_completed_at": now_iso(),
        "risk_tier":                    final_tier,
        "rule_engine_result":           rule_result,
    })
    vault_snapshots["after_management_stage"] = copy.deepcopy(vault)

    # ── Highlights ────────────────────────────────────────────────────────────
    highlights = {
        "questionnaire_sections": [
            s.get("section_title", "") for s in h2.get("sections", [])
        ],
        "clarifying_questions": d3.get("clarifying_questions", []),
        "prescription":         extract_prescription(m2),
        "risk_tier":            final_tier,
        "rule_engine_triggered": rule_result.get("rules_triggered", []),
        "stg_rag_warning":      "STG not ingested — M2 prescription not STG-grounded",
    }

    def _stage(elapsed, keys):
        s = _sum_perf([call_perf[k] for k in keys])
        s["elapsed_s"] = round(elapsed, 1)
        return s

    perf = {
        "calls": call_perf,
        "stages": {
            "history":    _stage(history_elapsed,    ["H1", "H2"]),
            "diagnosis":  _stage(diagnosis_elapsed,  ["D1", "D2", "D3"]),
            "management": _stage(management_elapsed, ["M1", "M2", "M3", "M4"]),
        },
        "total": _sum_perf(list(call_perf.values())),
    }

    return {
        "call_outputs":    call_outputs,
        "vault_snapshots": vault_snapshots,
        "highlights":      highlights,
        "perf":            perf,
    }


# ── Track 2: Orchestrator integration ────────────────────────────────────────

async def run_track2(
    phase_1: str,
    phase_2: str,
    phase_3: str,
    track1_outputs: dict,
) -> dict:
    """
    Connect to a running orchestrator via WebSocket, inject pre-transcribed
    phase segments, fire markers, and collect stage_complete payloads.

    Prerequisites:
      - Orchestrator running on localhost:8765 with VALIDATION_MODE=true
      - DATABASE_URL and JWT_SECRET env vars set
      - Local Postgres with schema applied
    """
    try:
        import websockets
        import jwt as pyjwt
    except ImportError:
        print("Track 2 requires: pip install websockets PyJWT")
        return {"error": "missing dependencies: websockets, PyJWT"}

    print("\n" + "=" * 70)
    print("TRACK 2 — Orchestrator integration test")
    print("=" * 70)

    jwt_secret = os.environ.get("JWT_SECRET", "change-me-in-production")
    token = pyjwt.encode(
        {"nurse_id": "N-VAL", "role": "nurse", "clinic_id": "C-VAL"},
        jwt_secret,
        algorithm="HS256",
    )

    uri = "ws://localhost:8765/ws"
    results: dict = {}

    async with websockets.connect(
        uri,
        additional_headers={"Authorization": f"Bearer {token}"},
    ) as ws:

        # ── Init ──────────────────────────────────────────────────────────────
        await ws.send(json.dumps({
            "type": "init",
            "patient_id": "VAL-P-001",
            "gps": {"district_code": DISTRICT_CODE, "lat": LAT, "lng": LNG},
        }))
        msg = json.loads(await ws.recv())
        assert msg["type"] == "session_ready", f"Expected session_ready, got {msg}"
        session_id = msg["session_id"]
        print(f"  Session ready: {session_id}")

        async def recv_until_complete(stage: str) -> dict:
            """Drain messages until stage_complete for the given stage arrives."""
            token_count = 0
            while True:
                raw = json.loads(await ws.recv())
                if raw["type"] == "stage_token" and raw.get("stage") == stage:
                    token_count += 1
                elif raw["type"] == "stage_complete" and raw.get("stage") == stage:
                    print(f"  {stage} stage_complete received ({token_count} tokens)")
                    return raw.get("data", {})
                elif raw["type"] == "error":
                    print(f"  ERROR from orchestrator: {raw}")
                    return {}

        # ── Phase 1 → Marker A ────────────────────────────────────────────────
        print("  Injecting phase_1 transcript …")
        await ws.send(json.dumps({"type": "inject_transcript", "text": phase_1}))
        await ws.send(json.dumps({"type": "marker", "marker": "history_complete", "t": 30.0}))
        results["stage_complete_history"] = await recv_until_complete("history")

        # ── Phase 2 → Marker B ────────────────────────────────────────────────
        print("  Injecting phase_2 transcript …")
        await ws.send(json.dumps({"type": "inject_transcript", "text": phase_2}))
        await ws.send(json.dumps({"type": "marker", "marker": "diagnosis_complete", "t": 270.0}))
        results["stage_complete_diagnosis"] = await recv_until_complete("diagnosis")

        # ── Phase 3 → Marker C ────────────────────────────────────────────────
        print("  Injecting phase_3 transcript …")
        await ws.send(json.dumps({"type": "inject_transcript", "text": phase_3}))
        await ws.send(json.dumps({"type": "marker", "marker": "management_complete", "t": 390.0}))
        results["stage_complete_management"] = await recv_until_complete("management")

        # ── Session end ───────────────────────────────────────────────────────
        await ws.send(json.dumps({"type": "session_end", "t": 400.0}))
        print("  Session closed.")

    # ── Fetch vault from DB ───────────────────────────────────────────────────
    try:
        import asyncpg
        database_url = os.environ.get("DATABASE_URL", "postgresql://localhost/cdst")
        conn = await asyncpg.connect(database_url)
        row = await conn.fetchrow(
            "SELECT data FROM sessions WHERE session_id = $1", session_id
        )
        await conn.close()
        results["vault_from_db"] = json.loads(row["data"]) if row else {}
    except Exception as exc:
        print(f"  Warning: could not fetch vault from DB — {exc}")
        results["vault_from_db"] = {}

    # ── Compare against Track 1 ───────────────────────────────────────────────
    t1 = track1_outputs["call_outputs"]

    def _top_dx(ddx: list) -> list:
        return [d.get("disease", "") for d in (ddx or [])[:3]]

    t2_ddx = results["stage_complete_diagnosis"].get("differential_table", [])
    t1_ddx = t1.get("D2_differential_table", [])

    t2_tier = (
        results.get("vault_from_db", {}).get("risk_tier") or
        results["stage_complete_management"].get("risk_tier")
    )
    t1_tier = track1_outputs["highlights"]["risk_tier"]

    results["match_vs_track1"] = {
        "history_questionnaire_sections_count": (
            len(results["stage_complete_history"].get("sections", [])) ==
            len(t1.get("H2_questionnaire", {}).get("sections", []))
        ),
        "diagnosis_top3_match": _top_dx(t2_ddx) == _top_dx(t1_ddx),
        "risk_tier_match": t2_tier == t1_tier,
    }

    return results


# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    parser = argparse.ArgumentParser(description="CDST pipeline validation")
    parser.add_argument("audio_file", nargs="?", help="Path to the interview audio file")
    parser.add_argument(
        "--track", choices=["1", "2", "both"], default="both",
        help="Which validation track to run (default: both)"
    )
    parser.add_argument("--out", default=None, help="Output JSON report path")
    parser.add_argument(
        "--transcript", default=None,
        help="Path to a pre-translated English transcript (.txt) — skips Deepgram entirely"
    )
    args = parser.parse_args()

    if args.transcript:
        if not os.path.exists(args.transcript):
            print(f"ERROR: Transcript file not found: {args.transcript}")
            sys.exit(1)
        full_transcript = Path(args.transcript).read_text(encoding="utf-8").strip()
        print(f"Loaded transcript from {args.transcript} ({len(full_transcript)} chars)")
    else:
        if not args.audio_file:
            print("ERROR: Provide an audio file or --transcript <file>")
            sys.exit(1)
        if not os.path.exists(args.audio_file):
            print(f"ERROR: Audio file not found: {args.audio_file}")
            sys.exit(1)
        full_transcript = await transcribe_audio(args.audio_file)

    audio_label = args.audio_file or args.transcript
    out_path = args.out or f"validation_output_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"

    # ── Phase splits ──────────────────────────────────────────────────────────
    phase_1, phase_2, phase_3 = prompt_phase_splits(full_transcript)

    # ── Build report skeleton ─────────────────────────────────────────────────
    report: dict = {
        "meta": {
            "audio_file":      audio_label,
            "district":        f"{DISTRICT_NAME} ({DISTRICT_CODE})",
            "season":          "pre_monsoon",
            "month":           MONTH,
            "stg_rag_available": False,
            "run_at":          now_iso(),
        },
        "transcripts": {
            "full":    full_transcript,
            "phase_1": phase_1,
            "phase_2": phase_2,
            "phase_3": phase_3,
        },
    }

    # ── Track 1 ───────────────────────────────────────────────────────────────
    if args.track in ("1", "both"):
        t1_result = await run_track1(phase_1, phase_2, phase_3)
        report.update(t1_result)

    # ── Track 2 ───────────────────────────────────────────────────────────────
    if args.track in ("2", "both"):
        if args.track == "2" and "call_outputs" not in report:
            # Need Track 1 outputs for comparison even if not saving them
            t1_result = await run_track1(phase_1, phase_2, phase_3)
            report.update(t1_result)
        report["track2_orchestrator"] = await run_track2(
            phase_1, phase_2, phase_3, report
        )

    # ── Save report ───────────────────────────────────────────────────────────
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"\nReport saved -> {out_path}")

    # ── Terminal summary ──────────────────────────────────────────────────────
    if "highlights" in report:
        print_summary(report)


if __name__ == "__main__":
    asyncio.run(main())
