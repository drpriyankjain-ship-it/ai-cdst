"""
CDST Diagnosis Stage  [fixed pipeline]
=======================================
Three-call pipeline — no RAG (moved to Management Stage):

  Call 1: transcript segment → extracted medical concepts       (~900ms)
  Call 2: concepts + epi prior → ranked differential (DDx)     (~3.2s, streaming)
  Call 3: DDx + bedside tools → gap analysis + clarifying Qs   (~1.4s, streaming)

Design rationale:
  - LLM native clinical reasoning handles differential generation and gap
    analysis correctly without retrieval support.
  - RAG is reserved for the Management Stage where retrieved STG protocol
    text directly governs dosing, contraindications, and referral decisions.
  - Epi prior (Layer 1 baseline + Layer 2 IDSP district/season lookup) is
    injected directly into Call 2 as structured context — no vector search.

Dependencies:
    pip install google-genai asyncpg fastapi pydantic
"""

import json
from datetime import datetime
from typing import AsyncIterator

import asyncpg
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from google.genai import types
from pydantic import BaseModel

from epi_utils import (
    state_from_district_code,
    load_baseline_diseases,
    load_epi_prior,
)
from llm_client import gemini, generate_with_retry, parse_json_response, response_text
from model_config import MODEL_D1_CONCEPTS, MODEL_D2_DIFFERENTIAL, MODEL_D3_CLARIFYING


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BEDSIDE_TOOLS_PATH     = "data/bedside_tools.json"
MUST_NOT_MISS_PATH     = "data/must_not_miss.json"


def load_must_not_miss() -> list[str]:
    """Load must-not-miss diagnosis names from data/must_not_miss.json."""
    with open(MUST_NOT_MISS_PATH) as f:
        data = json.load(f)
    return [entry["name"] for entry in data["diagnoses"]]


# ---------------------------------------------------------------------------
# Vault — Postgres session store
# ---------------------------------------------------------------------------

class Vault:
    """
    Thin wrapper around the Postgres session JSONB document.
    Each session is one row keyed on session_id.
    Agents read from and write to it incrementally.
    """

    def __init__(self, conn: asyncpg.Connection, session_id: str):
        self.conn = conn
        self.session_id = session_id

    async def read(self) -> dict:
        row = await self.conn.fetchrow(
            "SELECT data FROM sessions WHERE session_id = $1",
            self.session_id
        )
        if not row:
            raise ValueError(f"Session {self.session_id} not found")
        return json.loads(row["data"])

    async def update(self, patch: dict) -> None:
        """Merge patch fields into the existing session document."""
        await self.conn.execute(
            """
            UPDATE sessions
            SET data = data || $2::jsonb,
                updated_at = now()
            WHERE session_id = $1
            """,
            self.session_id,
            json.dumps(patch)
        )

    async def update_nested(self, path: list[str], value) -> None:
        """
        Set a single key deep inside the JSONB document using jsonb_set.
        path = ["demographics", "pregnancy_status"]
        Creates intermediate objects if they do not yet exist.
        """
        await self.conn.execute(
            """
            UPDATE sessions
            SET data       = jsonb_set(data, $2::text[], $3::jsonb, true),
                updated_at = now()
            WHERE session_id = $1
            """,
            self.session_id,
            path,
            json.dumps(value),
        )


# ---------------------------------------------------------------------------
# Differential schema validation
# ---------------------------------------------------------------------------

DIFFERENTIAL_FIELDS = {
    "rank":                 int,
    "disease":              str,
    "icd10_code":           str,
    "probability":          str,
    "supporting_features":  list,
    "against":              list,
    "must_not_miss":        bool,
    "regionally_specific":  bool,
    "reasoning":            str,
    "discriminating_tests": list,
    "referral_required":    bool,
}

VALID_PROBABILITY = {"high", "moderate", "low"}

FIELD_DEFAULTS = {
    "rank":                 0,
    "disease":              "Unknown",
    "icd10_code":           "R69",
    "probability":          "low",
    "supporting_features":  [],
    "against":              [],
    "must_not_miss":        False,
    "regionally_specific":  False,
    "reasoning":            "No reasoning provided",
    "discriminating_tests": [],
    "referral_required":    False,
}


def validate_differential(ddx: list[dict]) -> list[dict]:
    """
    Enforce the canonical 11-field schema on every DDx entry.

    - Missing fields     → safe default + logged warning
    - Invalid probability → normalised to "moderate" + logged warning
    - Output re-sorted by rank

    Downstream consumers (Management Stage, rule engine, doctor UI)
    depend on this structure being predictable on every call.
    """
    validated = []
    for i, entry in enumerate(ddx):
        label = entry.get("disease", f"entry {i}")
        clean = {}
        for field in DIFFERENTIAL_FIELDS:
            val = entry.get(field)
            if val is None:
                print(f"[DDX SCHEMA] '{label}' missing '{field}' — using default")
                clean[field] = FIELD_DEFAULTS[field]
            elif field == "probability" and val not in VALID_PROBABILITY:
                print(f"[DDX SCHEMA] '{label}' invalid probability '{val}' — normalising to 'moderate'")
                clean[field] = "moderate"
            else:
                clean[field] = val
        validated.append(clean)

    validated.sort(key=lambda x: x["rank"])
    return validated


# ---------------------------------------------------------------------------
# Response schemas — structured JSON output for every LLM call
# ---------------------------------------------------------------------------

_SCHEMA_MEDICAL_CONCEPTS = {
    "type": "object",
    "properties": {
        "chief_complaint":  {"type": "string"},
        "symptoms": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name":      {"type": "string"},
                    "duration":  {"type": "string", "nullable": True},
                    "severity":  {"type": "string", "nullable": True},
                    "character": {"type": "string", "nullable": True},
                },
                "required": ["name"],
            },
        },
        "negatives":        {"type": "array", "items": {"type": "string"}},
        "relevant_history": {"type": "array", "items": {"type": "string"}},
        "risk_factors":     {"type": "array", "items": {"type": "string"}},
        "vitals_reported": {
            "type": "object",
            "properties": {
                "temperature_c":    {"type": "number", "nullable": True},
                "pulse_bpm":        {"type": "number", "nullable": True},
                "systolic_bp_mmhg": {"type": "number", "nullable": True},
                "spo2_pct":         {"type": "number", "nullable": True},
                "rr_per_min":       {"type": "number", "nullable": True},
                "bgl_mmol":         {"type": "number", "nullable": True},
                "gcs":              {"type": "number", "nullable": True},
            },
        },
        "red_flags":          {"type": "array", "items": {"type": "string"}},
        "pregnancy_status":   {"type": "string", "nullable": True},
        "lmp":                {"type": "string", "nullable": True},
        "uncertain_findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "topic":            {"type": "string"},
                    "patient_response": {"type": "string"},
                },
                "required": ["topic", "patient_response"],
            },
        },
        "past_medical_history": {"type": "array", "items": {"type": "string"}},
        "current_medications":  {"type": "array", "items": {"type": "string"}},
        "allergies_reported":   {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "chief_complaint", "symptoms", "negatives", "relevant_history",
        "risk_factors", "vitals_reported", "red_flags", "pregnancy_status",
        "lmp", "uncertain_findings", "past_medical_history",
        "current_medications", "allergies_reported",
    ],
}

_DDX_ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "rank":                 {"type": "integer"},
        "disease":              {"type": "string"},
        "icd10_code":           {"type": "string"},
        "probability":          {"type": "string", "enum": ["high", "moderate", "low"]},
        "supporting_features":  {"type": "array", "items": {"type": "string"}},
        "against":              {"type": "array", "items": {"type": "string"}},
        "must_not_miss":        {"type": "boolean"},
        "regionally_specific":  {"type": "boolean"},
        "reasoning":            {"type": "string"},
        "discriminating_tests": {"type": "array", "items": {"type": "string"}},
        "referral_required":    {"type": "boolean"},
    },
    "required": [
        "rank", "disease", "icd10_code", "probability",
        "supporting_features", "against", "must_not_miss",
        "regionally_specific", "reasoning", "discriminating_tests",
        "referral_required",
    ],
}

_SCHEMA_DIFFERENTIAL = {
    "type": "object",
    "properties": {
        "differential": {"type": "array", "items": _DDX_ITEM_SCHEMA},
    },
    "required": ["differential"],
}

_SCHEMA_CLARIFYING_QS = {
    "type": "object",
    "properties": {
        "clinical_summary": {"type": "string"},
        "key_uncertainty":  {"type": "string"},
        "clarifying_questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "question":              {"type": "string"},
                    "discriminates_between": {"type": "array", "items": {"type": "string"}},
                    "if_yes_favours":        {"type": "string"},
                    "if_no_favours":         {"type": "string"},
                    "priority":              {"type": "integer"},
                },
                "required": ["question", "discriminates_between", "if_yes_favours", "if_no_favours", "priority"],
            },
        },
        "bedside_observations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "observation":           {"type": "string"},
                    "tool_required":         {"type": "string"},
                    "discriminates_between": {"type": "array", "items": {"type": "string"}},
                    "finding_and_meaning":   {"type": "string"},
                    "priority":              {"type": "integer"},
                },
                "required": ["observation", "tool_required", "discriminates_between", "finding_and_meaning", "priority"],
            },
        },
    },
    "required": ["clinical_summary", "key_uncertainty", "clarifying_questions", "bedside_observations"],
}


# ---------------------------------------------------------------------------
# Call 1 — Concept extraction
# ---------------------------------------------------------------------------

async def extract_medical_concepts(
    transcript_segment: str,
    vault_context: dict,
) -> dict:
    """
    Extract structured medical concepts from the phase 2 transcript.

    Input : raw transcript text (from marker A to marker B)
    Output: structured JSON — chief complaint, symptoms, negatives,
            relevant history, risk factors, vitals if mentioned

    No epi prior. No retrieval. Pure extraction grounded by demographics
    and prior encounter history from the Vault.
    """
    demographics     = vault_context.get("demographics", {})
    prior_encounters = vault_context.get("patient_record", {}).get("encounters", [])

    prior_text = (
        json.dumps(prior_encounters[-3:], indent=2)
        if prior_encounters else "No prior encounters recorded."
    )

    prompt = "\n\n".join([
        "Extract structured medical concepts from this nurse-patient interview transcript.",
        f"PATIENT DEMOGRAPHICS:\n{json.dumps(demographics, indent=2)}",
        f"PRIOR ENCOUNTER SUMMARY (last 3 visits):\n{prior_text}",
        f"TRANSCRIPT (phase 2 interview):\n{transcript_segment}",
        (
            "INSTRUCTIONS:\n"
            "- Extract only what is explicitly stated or clearly implied\n"
            "- Negatives are as important as positives — list all denied symptoms\n"
            "- Do not infer or assume anything not present in the transcript\n"
            "- vitals_reported: return NUMERIC JSON numbers only.\n"
            "  temperature_c: convert to °C before returning.\n"
            "    If the stated value is > 50, assume °F and convert: (F − 32) × 5/9.\n"
            "    If the stated value is ≤ 50, assume °C. Round to 1 decimal.\n"
            "  All other vitals: strip units as-is.\n"
            "  e.g. SpO2 94% → 94; BP 90/60 → 90 (systolic only).\n"
            "  Null for any vital sign not explicitly mentioned in the transcript.\n"
            "- red_flags: list verbatim any alarming symptom or finding explicitly stated.\n"
            "  Include: 'cannot walk', 'vomiting blood', 'fitting', 'unconscious',\n"
            "  'rigidity', 'severe breathing difficulty', 'cannot breathe', etc.\n"
            "  Empty list [] if none mentioned.\n"
            "- pregnancy_status: MANDATORY for any female patient aged 12-50.\n"
            "  Set to 'pregnant' / 'not_pregnant' / 'postpartum' from explicit statements.\n"
            "  Set to 'unknown' if the topic was not raised OR patient could not confirm.\n"
            "  Set to null only for male patients or age clearly outside 12-50.\n"
            "- lmp: record verbatim if stated; null otherwise\n"
            "- uncertain_findings: list any topic where the patient's answer was\n"
            "  ambiguous, qualified, or unclear — e.g. 'sometimes', 'maybe', 'not sure',\n"
            "  'a little'. Record the topic name and the patient's response verbatim.\n"
            "  Do NOT place these in symptoms or negatives.\n"
            "  Empty list [] if all answers were clear.\n"
            "- past_medical_history: list any chronic or past conditions the patient\n"
            "  explicitly mentions (e.g. 'I have diabetes', 'treated for TB last year').\n"
            "  Empty list [] if none stated.\n"
            "- current_medications: list drugs the patient says they are currently taking,\n"
            "  with dose and frequency if stated. Empty list [] if none.\n"
            "- allergies_reported: list allergens with reaction as stated\n"
            "  (e.g. 'penicillin — rash'). Empty list [] if none."
        ),
    ])

    response = await generate_with_retry(
        model=MODEL_D1_CONCEPTS,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=_SCHEMA_MEDICAL_CONCEPTS,
            max_output_tokens=1000,
        )
    )

    return parse_json_response(response_text(response))


# ---------------------------------------------------------------------------
# Call 2 — Differential diagnosis
# ---------------------------------------------------------------------------

async def generate_differential(
    concepts: dict,
    vault_context: dict,
    baseline_layer: str,
    epi_layer: str,
) -> list[dict]:
    """
    Generate a ranked differential of 4-6 conditions.

    Inputs:
      - Extracted concepts (Call 1 output)
      - Layer 1 baseline disease burden  (hardcoded string)
      - Layer 2 IDSP epi prior           (district + season lookup)
      - LLM native clinical reasoning    (no RAG)

    The epi prior modifies where clinically relevant but never overrides
    the presenting complaint. A neurological presentation in a
    malaria-endemic district correctly leads with neurological diagnoses.

    Output validated against the 11-field canonical schema.
    """
    demographics  = vault_context.get("demographics", {})
    district_code = vault_context.get("gps", {}).get("district_code", "WB_UNKNOWN")
    state_name    = state_from_district_code(district_code)

    instructions = (
        "INSTRUCTIONS:\n"
        "- Generate 4-6 differential diagnoses ranked by probability\n"
        "- Layer 1 lists common primary care presentations — include any that are\n"
        "  compatible with the presenting features. If the clinical picture strongly\n"
        "  suggests a diagnosis outside Layer 1, rank it appropriately regardless.\n"
        "  The presenting complaint always dominates — never force a Layer 1 disease\n"
        "  into the differential when it does not fit the features.\n"
        "- Layer 2 epi prior elevates endemic diseases where the presentation is compatible\n"
        "  — it never overrides the presenting complaint\n"
        f"- must_not_miss=true regardless of probability for: {', '.join(load_must_not_miss())}\n"
        f"- regionally_specific=true for diseases with elevated {state_name} prevalence\n"
        "- referral_required=true for any diagnosis needing hospital-level care\n"
        "- discriminating_tests: list investigations that would most effectively\n"
        "  distinguish this diagnosis from others in the differential.\n"
        "  Include all relevant tests — bedside, laboratory, or imaging.\n"
        "- icd10_code: most specific applicable ICD-10 code\n"
        "- Base reasoning ONLY on features present — never assume unstated findings"
    )

    prompt = "\n\n".join([
        f"You are a clinical decision support system assisting a nurse in rural {state_name}, India.\n"
        "Generate a differential diagnosis for the patient below.",
        f"PATIENT:\n{json.dumps(demographics, indent=2)}",
        f"EXTRACTED CLINICAL CONCEPTS:\n{json.dumps(concepts, indent=2)}",
        baseline_layer,
        epi_layer if epi_layer else "(No Layer 2 modifier — district not found in epi prior)",
        instructions,
    ])

    response = await generate_with_retry(
        model=MODEL_D2_DIFFERENTIAL,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=_SCHEMA_DIFFERENTIAL,
            max_output_tokens=2000,
        )
    )

    return validate_differential(parse_json_response(response_text(response))["differential"])


# ---------------------------------------------------------------------------
# Call 2 — streaming variant (for real-time nurse UX)
# ---------------------------------------------------------------------------

async def stream_differential(
    concepts: dict,
    vault_context: dict,
    baseline_layer: str,
    epi_layer: str,
) -> AsyncIterator[str]:
    """
    Streaming version of generate_differential.

    Yields token chunks as they arrive so the differential paints
    on screen in real time. The nurse sees the top diagnosis within
    ~600ms of the LLM call starting.

    The non-streaming generate_differential() is called separately
    afterward to get the validated structured output for the Vault.
    This function is for display only.
    """
    demographics  = vault_context.get("demographics", {})
    district_code = vault_context.get("gps", {}).get("district_code", "WB_UNKNOWN")
    state_name    = state_from_district_code(district_code)

    prompt = "\n\n".join([
        f"You are a clinical decision support system for a nurse in rural {state_name}.\n"
        "Generate a ranked differential diagnosis. Write it as a readable numbered list "
        "with brief reasoning for each entry. Be concise — the nurse is with a patient.",
        f"Patient: {json.dumps(demographics)}",
        f"Clinical features: {json.dumps(concepts)}",
        baseline_layer,
        epi_layer if epi_layer else "",
    ])

    async for chunk in gemini.aio.models.generate_content_stream(
        model=MODEL_D2_DIFFERENTIAL,
        contents=prompt,
        config=types.GenerateContentConfig(max_output_tokens=1500),
    ):
        if chunk.text:
            yield chunk.text


# ---------------------------------------------------------------------------
# Call 3 — Gap analysis and clarifying questions
# ---------------------------------------------------------------------------

# Obstetric diagnoses that make pregnancy status safety-critical
_PREGNANCY_SENSITIVE_DX = {
    "ectopic pregnancy", "pre-eclampsia", "eclampsia",
    "anaemia in pregnancy", "postpartum sepsis", "post-partum sepsis",
    "hyperemesis gravidarum", "placenta praevia", "abruption",
    "threatened miscarriage", "miscarriage", "antepartum haemorrhage",
    "gestational diabetes", "obstetric cholestasis",
    # Non-obstetric but treatment critically changes in pregnancy
    "malaria", "severe malaria", "typhoid", "tuberculosis",
    "pulmonary tb", "urinary tract infection", "uti",
    "epilepsy", "hypertension",
}


def _pregnancy_relevance(
    ddx: list[dict],
    concepts: dict,
    vault_context: dict,
) -> tuple[bool, bool]:
    """
    Determine whether pregnancy clarification is needed in this session.

    Returns:
      needs_lmp_question : True → an LMP clarifying question must be injected
      status_unknown     : True → pregnancy_status is absent or 'unknown'
    """
    demographics      = vault_context.get("demographics", {})
    age               = demographics.get("age", 99)
    sex               = demographics.get("sex", "").upper()
    pregnancy_status  = (
        concepts.get("pregnancy_status")
        or demographics.get("pregnancy_status", "")
        or ""
    ).lower()

    status_unknown = pregnancy_status in ("", "unknown")

    if sex != "F" or not (12 <= age <= 50):
        return False, False   # not applicable

    if not status_unknown:
        return False, False   # already confirmed

    # Check whether any DDx entry is pregnancy-sensitive
    dx_names = " ".join(d.get("disease", "").lower() for d in ddx)
    relevant  = any(term in dx_names for term in _PREGNANCY_SENSITIVE_DX)

    return relevant, True


async def generate_clarifying_questions(
    ddx: list[dict],
    concepts: dict,
    vault_context: dict,
) -> dict:
    """
    Given the ranked differential, identify:
      1. Clarifying questions the nurse should ask the patient
      2. Bedside observations the nurse can make with available tools

    Both are ranked by discriminating power — the finding that would
    most change the probability ranking comes first.

    Constrained to tools in bedside_tools.json. Never suggests
    investigations unavailable at a rural clinic.

    Special rule — pregnancy clarification:
      If the patient is a female of reproductive age (12-50), pregnancy
      status was not established in phase 2, AND any DDx entry is
      pregnancy-sensitive, an LMP / pregnancy status question is
      injected at priority 1 regardless of the LLM's ranking.

    Output schema:
    {
      "clinical_summary": "one sentence — what we know so far",
      "key_uncertainty": "the single most important unresolved question",
      "clarifying_questions": [
        {
          "question":              "exact wording to ask the patient",
          "discriminates_between": ["disease A", "disease B"],
          "if_yes_favours":        "disease name or pattern",
          "if_no_favours":         "disease name or pattern",
          "priority":              1
        }
      ],
      "bedside_observations": [
        {
          "observation":           "specific action for the nurse",
          "tool_required":         "tool name from available list",
          "discriminates_between": ["disease A", "disease B"],
          "finding_and_meaning":   "if X then Y; if Z then W",
          "priority":              1
        }
      ]
    }
    """
    with open(BEDSIDE_TOOLS_PATH) as f:
        available_tools = json.load(f)

    district_code = vault_context.get("gps", {}).get("district_code", "WB_UNKNOWN")
    state_name    = state_from_district_code(district_code)

    lang = (
        vault_context.get("chief_complaint", {}).get("language_of_consultation", "English")
        or "English"
    )
    language_instruction = (
        "" if lang == "English" else
        f"LANGUAGE: The consultation is in {lang}. After each clarifying question, "
        f"add a romanised {lang} translation in brackets using plain everyday words "
        f"(not medical terminology). Example format: "
        f"\"Do you have a headache? *(mathay byatha hochhe?)*\" (Bengali) or "
        f"\"Do you have a headache? *(sir mein dard hai?)*\" (Hindi)."
    )

    top_diagnoses  = [d["disease"] for d in ddx[:3]]
    must_not_miss  = [d["disease"] for d in ddx if d.get("must_not_miss")]
    needs_referral = [d["disease"] for d in ddx if d.get("referral_required")]

    needs_lmp_question, status_unknown = _pregnancy_relevance(ddx, concepts, vault_context)


    # Build the pregnancy instruction block (injected only when needed)
    if needs_lmp_question:
        pregnancy_instruction = (
            "MANDATORY PREGNANCY CLARIFICATION (priority 1):\n"
            "Pregnancy status for this patient was not established in the history phase "
            "and is relevant to the current differential. You MUST include the following "
            "as the first clarifying question (priority 1) — do not omit or merge it:\n"
            "  question: \"When did your last period start? Are you pregnant, "
            "or could you be pregnant?\"\n"
            "  discriminates_between: list all pregnancy-sensitive diagnoses in the DDx\n"
            "  if_yes_favours: obstetric diagnosis or pregnancy-modified treatment path\n"
            "  if_no_favours: non-obstetric diagnoses\n"
            "  priority: 1 — renumber all other questions starting from 2\n"
        )
    else:
        pregnancy_instruction = ""

    instructions = "\n\n".join(filter(bool, [
        (
            "INSTRUCTIONS:\n"
            "- Generate 3-5 clarifying questions ranked by discriminating power\n"
            "- Generate 2-4 bedside observations ranked by discriminating power\n"
            "- Priority 1 = the single finding that would most change the ranking\n"
            "- Must-not-miss diagnoses must be screened for even if probability is low\n"
            "- Questions must be phrased simply enough for any patient to understand\n"
            "- Observations must use ONLY tools from the available list below\n"
            "- Never suggest labs, imaging, LP, ECG, or any hospital-level investigation\n"
            f"AVAILABLE BEDSIDE TOOLS:\n{json.dumps(available_tools, indent=2)}"
        ),
        pregnancy_instruction,
        language_instruction,
    ]))

    prompt = "\n\n".join([
        f"You are designing a targeted clinical assessment for a nurse in a remote "
        f"rural clinic in {state_name}. Prioritise questions and observations that are "
        "highest-yield — findings that would most change the differential or flag a "
        "must-not-miss diagnosis — and that can be completed within a routine clinic visit.",
        f"CURRENT DIFFERENTIAL (ranked):\n{json.dumps(ddx, indent=2)}",
        f"TOP DIAGNOSES TO DISCRIMINATE: {json.dumps(top_diagnoses)}",
        f"MUST-NOT-MISS (screen regardless of probability): {json.dumps(must_not_miss)}",
        f"REFERRAL-REQUIRED DIAGNOSES: {json.dumps(needs_referral)}",
        f"CLINICAL FEATURES ALREADY KNOWN:\n{json.dumps(concepts, indent=2)}",
        (
            "UNCERTAIN FINDINGS (ambiguous or qualified answers from the transcript — "
            "prioritise re-asking these if they are discriminating for the differential):\n"
            + (json.dumps(concepts.get("uncertain_findings", []), indent=2)
               if concepts.get("uncertain_findings")
               else "None — all answers were clear.")
        ),
        instructions,
    ])

    response = await generate_with_retry(
        model=MODEL_D3_CLARIFYING,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=_SCHEMA_CLARIFYING_QS,
            max_output_tokens=1500,
        )
    )

    result = parse_json_response(response_text(response))

    # Safety net: if needs_lmp_question and the LLM somehow omitted it,
    # insert the LMP question deterministically at priority 1.
    if needs_lmp_question:
        existing_qs = result.get("clarifying_questions", [])
        lmp_already_present = any(
            "period" in q.get("question", "").lower()
            or "lmp" in q.get("question", "").lower()
            or "pregnant" in q.get("question", "").lower()
            for q in existing_qs
        )
        if not lmp_already_present:
            pregnancy_sensitive_in_ddx = [
                d["disease"] for d in ddx
                if any(term in d["disease"].lower() for term in _PREGNANCY_SENSITIVE_DX)
            ] or top_diagnoses
            lmp_q = {
                "question":              (
                    "When did your last period start? "
                    "Are you pregnant, or could you be pregnant?"
                ),
                "discriminates_between": pregnancy_sensitive_in_ddx,
                "if_yes_favours":        "obstetric or pregnancy-modified diagnosis",
                "if_no_favours":         "non-obstetric diagnosis",
                "priority":              1,
            }
            # Renumber existing questions
            for q in existing_qs:
                q["priority"] = q.get("priority", 1) + 1
            result["clarifying_questions"] = [lmp_q] + existing_qs
            print(
                "[PREGNANCY GATE] LMP clarifying question injected deterministically "
                "(LLM omitted it despite instruction)."
            )

    return result


# ---------------------------------------------------------------------------
# Main pipeline — orchestrates all three calls
# ---------------------------------------------------------------------------

async def run_diagnosis_stage(
    session_id: str,
    transcript_segment: str,
    db_conn: asyncpg.Connection,
) -> dict:
    """
    Full Diagnosis Stage pipeline. Called by the session orchestrator
    when the nurse presses the marker B button.

    Flow:
      1. Load Vault context + epi prior (no network calls)
      2. Call 1 — concept extraction                  (~900ms)
      3. Call 2 — differential generation             (~3.2s)
      4. Call 3 — gap analysis + clarifying questions (~1.4s)
      5. Write all outputs to Vault

    Total: ~5.5s. Nurse sees differential streaming from ~1.5s onward.
    """
    vault         = Vault(db_conn, session_id)
    vault_context = await vault.read()

    gps           = vault_context.get("gps", {})
    district_code = gps.get("district_code", "WB_UNKNOWN")
    current_month = datetime.now().month

    baseline_layer = load_baseline_diseases()
    epi_layer      = load_epi_prior(district_code, current_month)

    # Call 1 — concept extraction
    print(f"[{session_id}] Call 1: extracting medical concepts")
    concepts = await extract_medical_concepts(transcript_segment, vault_context)
    await vault.update({"extracted_concepts": concepts})

    # Write extracted pregnancy_status back into demographics so the rule
    # engine and Management Stage always see a populated field.
    extracted_pregnancy = concepts.get("pregnancy_status")
    if extracted_pregnancy is not None:
        # Merge into the demographics sub-document
        await vault.update_nested(
            ["demographics", "pregnancy_status"], extracted_pregnancy
        )
        if concepts.get("lmp"):
            await vault.update_nested(["demographics", "lmp"], concepts["lmp"])
        print(
            f"[{session_id}] Pregnancy status extracted: {extracted_pregnancy} "
            f"(LMP: {concepts.get('lmp')})"
        )
        # Refresh vault_context so Call 2 and Call 3 see the updated demographics
        vault_context = await vault.read()
    else:
        print(f"[{session_id}] pregnancy_status not applicable for this patient")

    # Call 2 — differential generation
    print(f"[{session_id}] Call 2: generating differential")
    ddx = await generate_differential(concepts, vault_context, baseline_layer, epi_layer)
    await vault.update({"differential_table": ddx})

    # Call 3 — gap analysis + clarifying questions
    # Pass updated vault_context so _pregnancy_relevance sees the latest demographics
    print(f"[{session_id}] Call 3: generating clarifying questions")
    clarifying = await generate_clarifying_questions(ddx, concepts, vault_context)
    await vault.update({
        "clarifying_questions":          clarifying,
        "diagnosis_stage_status":        "complete",
        "diagnosis_stage_completed_at":  datetime.now().isoformat(),
    })

    print(f"[{session_id}] Diagnosis stage complete")
    return {
        "session_id": session_id,
        "concepts":   concepts,
        "ddx":        ddx,
        "clarifying": clarifying,
    }


# ---------------------------------------------------------------------------
# FastAPI endpoints
# ---------------------------------------------------------------------------

app = FastAPI()


class DiagnosisRequest(BaseModel):
    session_id:          str
    transcript_segment:  str


@app.post("/stage/diagnosis")
async def diagnosis_endpoint(req: DiagnosisRequest):
    """
    Non-streaming endpoint. Returns full structured result when complete.
    Use when the nurse has natural downtime (she does — she's conducting
    the consultation while the stage runs in the background).
    """
    conn = await asyncpg.connect(dsn="postgresql://localhost/cdst")
    try:
        return await run_diagnosis_stage(req.session_id, req.transcript_segment, conn)
    finally:
        await conn.close()


@app.post("/stage/diagnosis/stream")
async def diagnosis_stream_endpoint(req: DiagnosisRequest):
    """
    Streaming endpoint for the differential display step only.

    Yields the readable differential as tokens arrive so the nurse
    sees results painting in real time. The structured JSON output
    is written to the Vault by run_diagnosis_stage() separately.
    """
    conn          = await asyncpg.connect(dsn="postgresql://localhost/cdst")
    vault_context = await Vault(conn, req.session_id).read()
    gps           = vault_context.get("gps", {})
    concepts      = await extract_medical_concepts(req.transcript_segment, vault_context)
    baseline      = load_baseline_diseases()
    epi           = load_epi_prior(gps.get("district_code", "WB_UNKNOWN"), datetime.now().month)

    async def token_stream():
        async for chunk in stream_differential(concepts, vault_context, baseline, epi):
            yield chunk
        await conn.close()

    return StreamingResponse(token_stream(), media_type="text/plain")
