"""
CDST History Stage  [fixed pipeline]
=====================================
Two-call pipeline — no RAG:

  Call 1: ~30s transcript → chief complaint extraction            (~700ms)
  Call 2: concepts + epi prior + visit type → questionnaire       (~1.3s, streaming)

Most latency-critical stage in the pipeline. The nurse pressed the button
mid-consultation and is waiting for the questionnaire before continuing.
Target: first token on screen within 1.5s of button press.

Questionnaire has two jobs depending on visit type:

  FIRST VISIT:
    - SOCRATES on chief complaint
    - Full past medical / family / social / medication / allergy history
      (nothing is known upfront in rural settings)
    - Outputs patient_record_fields which seeds the permanent patient record

  RETURN VISIT:
    - SOCRATES on chief complaint
    - Verify and update existing history — has anything changed?
    - Do not re-collect history from scratch

Design rationale:
  - No RAG. Questionnaire generation draws on general clinical knowledge
    (SOCRATES, systems review, history-taking frameworks) that the LLM
    holds natively.
  - Epi prior (district + season) shapes which conditions to probe for —
    injected directly, not retrieved.
  - Prior encounter history is small structured JSON — injected directly.
  - Two calls kept separate: extraction is a different task from generation,
    and extracted concepts are written to the Vault independently so the
    Diagnosis Stage can read them without re-parsing the transcript.

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
    DISTRICT_CODE_TO_STATE,
    state_from_district_code,
    MONTH_TO_SEASON,
    load_baseline_diseases,
    load_epi_prior,
)
from llm_client import gemini, generate_with_cascade, stream_with_cascade, parse_json_response, response_text
from model_config import MODEL_H1_CHIEF_COMPLAINT, MODEL_H2_QUESTIONNAIRE


# ---------------------------------------------------------------------------
# Vault
# ---------------------------------------------------------------------------

class Vault:
    def __init__(self, conn: asyncpg.Connection, session_id: str):
        self.conn       = conn
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


def build_patient_record_context(patient_record: dict) -> tuple[str, list[str]]:
    """
    Read the patient record and determine:
      1. What is already known (inject as context so the questionnaire does not re-ask)
      2. What fields are missing or incomplete (the questionnaire must collect these)

    Returns:
      known_context  : formatted string of what the record already contains
      missing_fields : list of field names that need to be collected this visit

    This function is the sole determiner of questionnaire scope. The nurse
    never specifies visit type — the agent reasons it from the record state.
    """
    if not patient_record:
        # No record at all — new patient, collect everything
        missing = [
            "past_medical_history",
            "family_history",
            "social_history",
            "current_medications",
            "allergies",
            "immunisation_history",
        ]
        return "NEW PATIENT — no prior records exist.", missing

    missing = []
    known_lines = ["EXISTING PATIENT RECORD:"]

    # ── Encounter history ─────────────────────────────────────────────────────
    encounters = patient_record.get("encounters", [])
    confirmed = [
        e for e in encounters
        if e.get("confidence_weight", 0) >= 0.5 or e.get("confirmed", False)
    ]
    if confirmed:
        known_lines.append(f"  Prior visits: {len(confirmed)} confirmed encounter(s)")
        for e in confirmed[-3:]:
            known_lines.append(
                f"    {e.get('date', '?')}: "
                f"{e.get('confirmed_diagnosis', e.get('provisional_diagnosis', '?'))} — "
                f"Rx: {e.get('treatment', '?')} — outcome: {e.get('outcome', '?')}"
            )
    else:
        known_lines.append("  Prior visits: none confirmed yet")

    # ── Past medical history ──────────────────────────────────────────────────
    pmh = patient_record.get("known_conditions", [])
    if pmh:
        known_lines.append(f"  Known conditions: {', '.join(pmh)}")
    else:
        missing.append("past_medical_history")
        known_lines.append("  Known conditions: NOT YET RECORDED")

    # ── Allergies ─────────────────────────────────────────────────────────────
    allergies = patient_record.get("known_allergies", [])
    if allergies:
        known_lines.append(f"  Allergies: {', '.join(allergies)}")
    else:
        missing.append("allergies")
        known_lines.append("  Allergies: NOT YET RECORDED")

    # ── Current medications ───────────────────────────────────────────────────
    meds = patient_record.get("current_medications", [])
    if meds:
        known_lines.append(f"  Current medications: {', '.join(meds)}")
    else:
        missing.append("current_medications")
        known_lines.append("  Current medications: NOT YET RECORDED")

    # ── Family history ────────────────────────────────────────────────────────
    fhx = patient_record.get("family_history", [])
    if fhx:
        known_lines.append(f"  Family history: {', '.join(fhx)}")
    else:
        missing.append("family_history")
        known_lines.append("  Family history: NOT YET RECORDED")

    # ── Social history ────────────────────────────────────────────────────────
    soc = patient_record.get("social_history", {})
    if soc:
        known_lines.append(
            f"  Social history: occupation={soc.get('occupation', '?')}, "
            f"tobacco={soc.get('tobacco', '?')}, alcohol={soc.get('alcohol', '?')}"
        )
    else:
        missing.append("social_history")
        known_lines.append("  Social history: NOT YET RECORDED")

    # ── Significant history narrative ─────────────────────────────────────────
    sig = patient_record.get("significant_history", [])
    if sig:
        known_lines.append("  Significant history:")
        for s in sig[-3:]:
            known_lines.append(f"    - {s}")

    known_context = "\n".join(known_lines)
    return known_context, missing


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def is_complaint_missing(chief_complaint: dict) -> bool:
    """
    Return True if the chief complaint was not captured in phase 1.
    Triggers the nudge path — Call 2 is NOT fired.

    Treats null, empty string, and semantically empty values
    ("unknown", "unclear", "not stated", "n/a") as missing.
    """
    value = (chief_complaint.get("chief_complaint") or "").strip().lower()
    if not value:
        return True
    empty_sentinels = {"unknown", "unclear", "not stated", "not mentioned", "n/a", "none"}
    return value in empty_sentinels


# ---------------------------------------------------------------------------
# Response schemas — structured JSON output for every LLM call
# ---------------------------------------------------------------------------

_SCHEMA_CHIEF_COMPLAINT = {
    "type": "object",
    "properties": {
        "patient_name":             {"type": "string", "nullable": True},
        "age":                      {"type": "string", "nullable": True},
        "village":                  {"type": "string", "nullable": True},
        "chief_complaint":          {"type": "string", "nullable": True},
        "additional_complaints":    {"type": "array", "items": {"type": "string"}},
        "duration":                 {"type": "string", "nullable": True},
        "severity_if_mentioned":    {"type": "string", "nullable": True},
        "spontaneous_history":      {"type": "array", "items": {"type": "string"}},
        "red_flags_mentioned":      {"type": "array", "items": {"type": "string"}},
        "language_of_consultation": {"type": "string"},
    },
    "required": [
        "patient_name", "age", "village", "chief_complaint",
        "additional_complaints", "duration", "severity_if_mentioned",
        "spontaneous_history", "red_flags_mentioned", "language_of_consultation",
    ],
}

_SCHEMA_QUESTIONNAIRE = {
    "type": "object",
    "properties": {
        "opening_context":    {"type": "string"},
        "known_and_verified": {"type": "array", "items": {"type": "string"}},
        "sections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "section_title": {"type": "string"},
                    "rationale":     {"type": "string"},
                    "questions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "question":      {"type": "string"},
                                "follow_up":     {"type": "string"},
                                "discriminates": {"type": "string"},
                            },
                            "required": ["question", "follow_up", "discriminates"],
                        },
                    },
                },
                "required": ["section_title", "rationale", "questions"],
            },
        },
        "mandatory_safety_questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "question": {"type": "string"},
                    "reason":   {"type": "string"},
                },
                "required": ["question", "reason"],
            },
        },
        "prior_encounter_flags": {"type": "array", "items": {"type": "string"}},
        "patient_record_fields": {
            "type": "object",
            "properties": {
                "past_medical_history": {"type": "array", "items": {"type": "string"}},
                "family_history":       {"type": "array", "items": {"type": "string"}},
                "social_history": {
                    "type": "object",
                    "properties": {
                        "occupation":       {"type": "string"},
                        "living_situation": {"type": "string"},
                        "tobacco":          {"type": "string"},
                        "alcohol":          {"type": "string"},
                    },
                },
                "current_medications": {"type": "array", "items": {"type": "string"}},
                "allergies":           {"type": "array", "items": {"type": "string"}},
                "immunisation_flags":  {"type": "array", "items": {"type": "string"}},
            },
            "required": [
                "past_medical_history", "family_history", "social_history",
                "current_medications", "allergies", "immunisation_flags",
            ],
        },
    },
    "required": [
        "opening_context", "known_and_verified", "sections",
        "mandatory_safety_questions", "prior_encounter_flags", "patient_record_fields",
    ],
}


# ---------------------------------------------------------------------------
# Call 1 — Extract chief complaint from ~30 second opening
# ---------------------------------------------------------------------------

async def extract_chief_complaint(
    transcript_segment: str,
    vault_context: dict,
) -> dict:
    """
    Extract structured chief complaint from the ~30 second phase 1 transcript.

    At this point the nurse has asked:
    "What is your name, age, village, what is your complaint, how long sick?"

    That is all. No history, no medications, no allergies — nothing else is
    known. The schema reflects this reality — most fields will be null or
    empty on a first visit.

    Output is written to the Vault and passed into Call 2.
    """
    demographics = vault_context.get("demographics", {})

    prompt = "\n\n".join([
        "Extract the chief complaint from this brief nurse-patient consultation "
        "opening. The recording is approximately 30 seconds — the nurse asked "
        "name, age, village, chief complaint, and duration. Extract only what "
        "is explicitly stated.",
        f"PATIENT DEMOGRAPHICS (from registration if any):\n{json.dumps(demographics, indent=2)}",
        f"TRANSCRIPT (phase 1, ~30 seconds):\n{transcript_segment}",
        (
            "INSTRUCTIONS:\n"
            "- Extract only what is explicitly stated in the transcript\n"
            "- patient_name, age, village: verbatim from the opening exchange\n"
            "- duration: patient's own words — do not interpret or convert\n"
            "- spontaneous_history: anything volunteered beyond the direct questions\n"
            "- red_flags_mentioned: only what the patient explicitly stated\n"
            "- This is ~30 seconds. Most fields will be null. Do not infer."
        ),
    ])

    response = await generate_with_cascade(
        models=MODEL_H1_CHIEF_COMPLAINT,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=_SCHEMA_CHIEF_COMPLAINT,
            max_output_tokens=600,
        )
    )

    return parse_json_response(response_text(response))


# ---------------------------------------------------------------------------
# Fixed first-visit background history section
# ---------------------------------------------------------------------------
#
# Injected verbatim into the questionnaire output for every new patient
# (i.e. any visit where background history fields are missing from the record).
# Not LLM-generated — same questions, same order, every first visit.
# Rationale: see docs/eng/adr/002-history-intake-approach.md
#
FIRST_VISIT_HISTORY_QUESTIONS = {
    "section_title": "Background History",
    "rationale": (
        "Standard first-visit intake — collected once per patient, "
        "seeds the permanent record. Fixed question set for consistent coverage."
    ),
    "questions": [
        {
            "question":      "Do you have any long-term illness — like diabetes, high blood pressure, TB, asthma, epilepsy, or heart disease?",
            "follow_up":     "How long have you had it? Are you on treatment for it?",
            "discriminates": "Past medical history — chronic conditions",
        },
        {
            "question":      "Have you ever been admitted to hospital or had an operation?",
            "follow_up":     "When was this, and what was it for?",
            "discriminates": "Past medical history — hospitalisations and surgery",
        },
        {
            "question":      "Do any illnesses run in your family — your parents or brothers and sisters — like diabetes, TB, high blood pressure, or cancer?",
            "follow_up":     "Which family member, and which illness?",
            "discriminates": "Family history",
        },
        {
            "question":      "What work do you do?",
            "follow_up":     "Any exposure to chemicals, dust, pesticides, or heavy lifting at work?",
            "discriminates": "Social history — occupation and occupational exposures",
        },
        {
            "question":      "Do you use tobacco in any form — smoking, chewing, or gutka? Do you drink alcohol?",
            "follow_up":     "How much, and for how long?",
            "discriminates": "Social history — tobacco and alcohol use",
        },
        {
            "question":      "Are you taking any medicines at the moment — tablets, injections, syrups, or any traditional or herbal remedies?",
            "follow_up":     "What is the name? What dose? How long have you been taking it?",
            "discriminates": "Current medications — including OTC and traditional",
        },
        {
            "question":      "Have you ever had a bad reaction or allergy to any medicine or food?",
            "follow_up":     "What happened — rash, swelling, breathing difficulty?",
            "discriminates": "Allergies and adverse drug reactions",
        },
    ],
}


# ---------------------------------------------------------------------------
# Call 2 — Generate contextualised questionnaire
# ---------------------------------------------------------------------------

async def generate_questionnaire(
    chief_complaint: dict,
    vault_context: dict,
    baseline_layer: str,
    epi_layer: str,
    patient_record: dict,
) -> dict:
    """
    Generate a structured, contextualised questionnaire for the nurse.

    FIRST VISIT behaviour:
      Questionnaire has two equal jobs:
        1. Clinical history of the presenting complaint (SOCRATES + systems review)
        2. Full past medical / family / social / medication / allergy history
           — nothing is known upfront in this rural setting
      The patient_record_fields output seeds the permanent patient record.

    RETURN VISIT behaviour:
      Job 1 is the same. Job 2 shrinks to verification:
        "Have any of your health conditions changed since your last visit?"
      Prior records are presented to the nurse for confirmation, not re-collected.

    Output schema:
    {
      "visit_type":    "first_visit|return_visit",
      "opening_context": "one sentence for the nurse — what to focus on",
      "sections": [
        {
          "section_title":  "e.g. 'Fever characterisation'",
          "rationale":      "why included — which conditions it probes",
          "questions": [
            {
              "question":       "exact question for the nurse to ask",
              "follow_up":      "if yes/if abnormal: what to ask next",
              "discriminates":  "brief nurse-only clinical note"
            }
          ]
        }
      ],
      "mandatory_safety_questions": [
        {
          "question": "must-ask question",
          "reason":   "why mandatory"
        }
      ],
      "prior_encounter_flags": [
        "specific thing to verify given this patient's history"
      ],
      "patient_record_fields": {
        "past_medical_history": ["condition name"],
        "family_history":       ["condition — relationship"],
        "social_history": {
          "occupation":        "patient's occupation",
          "living_situation":  "e.g. joint family",
          "tobacco":           "yes|no|unknown",
          "alcohol":           "yes|no|unknown"
        },
        "current_medications": ["drug name — dose if known — reason if stated"],
        "allergies":           ["allergen — reaction type if stated"],
        "immunisation_flags":  ["vaccination to verify"]
      }
    }
    """
    demographics      = vault_context.get("demographics", {})
    district_code     = vault_context.get("gps", {}).get("district_code", "WB_UNKNOWN")
    state_name        = state_from_district_code(district_code)
    lang              = chief_complaint.get("language_of_consultation", "English")
    language_instruction = (
        "" if lang == "English" else
        f"LANGUAGE: The consultation is in {lang}. "
        f"After each question, add a romanised {lang} translation in brackets — "
        f"for example: 'Do you have fever? (jwor hochhe?)' for Bengali, "
        f"'Do you have fever? (bukhaar hai?)' for Hindi. "
        f"Use plain everyday words in the translation — not medical terminology."
    )

    # ── Determine what is known and what needs to be collected ───────────────
    known_context, missing_fields = build_patient_record_context(patient_record)
    has_prior_record = bool(patient_record)

    # Anything volunteered spontaneously in phase 1
    spontaneous = chief_complaint.get("spontaneous_history", [])
    spontaneous_text = (
        "VOLUNTEERED IN PHASE 1 (patient mentioned unprompted):\n"
        + "\n".join(f"  - {s}" for s in spontaneous)
        if spontaneous else ""
    )

    # Build field-specific collection instructions from what is missing
    field_labels = {
        "past_medical_history": (
            "  past_medical_history: all chronic conditions, prior hospitalisations,\n"
            "    major illnesses, surgeries — ask specifically about diabetes, TB,\n"
            "    hypertension, heart disease, asthma, epilepsy"
        ),
        "family_history": (
            "  family_history: diabetes, hypertension, TB, cancer, heart disease\n"
            "    in first-degree relatives (parents, siblings, children)"
        ),
        "social_history": (
            "  social_history: occupation, living situation (joint/nuclear family),\n"
            "    tobacco use, alcohol use"
        ),
        "current_medications": (
            "  current_medications: ALL drugs — prescription, over-the-counter,\n"
            "    and traditional/herbal remedies — name, dose, and reason if known"
        ),
        "allergies": (
            "  allergies: drug allergies, food allergies, any known reactions\n"
            "    to medicines or other substances"
        ),
        "immunisation_history": (
            "  immunisation_history: tetanus status (especially if trauma),\n"
            "    pregnancy vaccines if applicable"
        ),
    }

    if missing_fields:
        history_instruction = (
            "HISTORY FIELDS TO COLLECT THIS VISIT:\n"
            "The following fields are missing from this patient's record.\n"
            "Include questions to collect them — work them naturally into the interview.\n"
            + "\n".join(field_labels[f] for f in missing_fields if f in field_labels)
        )
    else:
        history_instruction = (
            "HISTORY VERIFICATION:\n"
            "All history fields are recorded. Include a brief verification section:\n"
            "  'Have any of your health conditions changed since your last visit?'\n"
            "  'Are you still taking the same medications?'\n"
            "  'Any new allergies or reactions to medicines?'"
        )

    prompt = "\n\n".join(filter(bool, [
        (
            "You are generating a structured interview questionnaire for a nurse "
            f"in a remote rural clinic in {state_name}, India. The nurse reads these "
            "questions directly to the patient during a structured interview.\n\n"
            f"PATIENT RECORD STATUS:\n{known_context}"
        ),
        f"PATIENT (from 30-second opening):\n{json.dumps(vault_context.get('demographics', {}), indent=2)}",
        f"CHIEF COMPLAINT:\n{json.dumps(chief_complaint, indent=2)}",
        spontaneous_text,
        language_instruction,
        baseline_layer,
        epi_layer,
        (
            "CLINICAL FRAMEWORK FOR CHIEF COMPLAINT SECTION:\n"
            "Choose the framework that fits the presentation — do not force SOCRATES where it does not apply.\n"
            "  Pain / acute symptoms   → SOCRATES (site, onset, character, radiation, associated\n"
            "                            symptoms, timing, exacerbating/relieving factors, severity)\n"
            "  Gynaecological/obstetric → Menstrual/obstetric history: LMP, cycle regularity,\n"
            "                             duration and quantity of bleeding (pad count, clots),\n"
            "                             pain, obstetric history (G/P/A), contraception use\n"
            "  Infertility              → Duration of trying, cycle regularity, prior pregnancies,\n"
            "                             partner history, relevant risk factors (STI, TB)\n"
            "  Chronic/constitutional  → Duration, progression, systemic features (weight loss,\n"
            "                            night sweats, fatigue, appetite), relevant exposures\n"
            "  Psychiatric/behavioural → Onset, triggers, sleep, function, safety (self-harm)\n"
            "For mixed presentations, use the framework that best fits the primary complaint.\n\n"
            "QUESTIONNAIRE DESIGN:\n"
            "- 4-8 sections depending on complexity — interview typically 5-10 minutes\n"
            "- Each section: 3-5 questions\n"
            "- Chief complaint section is ALWAYS first\n"
            "- Questions within each section: most to least discriminating\n"
            "- Plain language — questions are read directly to the patient\n"
            "- follow_up: what to ask if the answer is yes or abnormal\n"
            "- discriminates: brief nurse-only note — not read to patient\n\n"
            "CHIEF COMPLAINT SECTION (always include):\n"
            "- Primary complaint: full clinical framework (see below)\n"
            "- Systemic symptoms: fever, weight loss, night sweats, fatigue, appetite\n"
            "- Epi prior conditions: include ONLY if compatible with chief complaint\n"
            "- Additional complaints: if present in chief_complaint.additional_complaints,\n"
            "  add one shorter section per complaint — onset, severity, and 2-3 key\n"
            "  discriminating questions only. Do not apply full framework to secondary complaints.\n\n"
            + history_instruction + "\n\n"
            "MANDATORY SAFETY QUESTIONS (always — regardless of what is recorded):\n"
            "- Female patients aged 12-50: current pregnancy status and LMP\n"
            "- All patients: confirm current medications — even if already recorded\n"
            "- All patients: confirm allergies — even if already recorded\n"
            "- Any red flags from phase 1: follow up each one directly\n\n"
            "known_and_verified: list confirmations for fields already in the record\n"
            "  e.g. 'Confirm still taking metformin 500mg' — short, one per known field\n\n"
            "patient_record_fields: populate with questions to ASK — "
            "answers will come from the phase 2 transcript. "
            "Leave fields empty ([]) if already recorded and no update expected."
        ),
    ]))

    response = await generate_with_cascade(
        models=MODEL_H2_QUESTIONNAIRE,
        contents=prompt,
        config=types.GenerateContentConfig(
            thinking_config=types.ThinkingConfig(thinking_budget=0),
            response_mime_type="application/json",
            response_schema=_SCHEMA_QUESTIONNAIRE,
            max_output_tokens=8000,
        )
    )

    questionnaire = parse_json_response(response_text(response))

    # Inject fixed background history section for first/partial visits.
    # The LLM generates the chief complaint section; this ensures complete
    # and consistent coverage of PMH/FHx/SHx/medications/allergies every time.
    if missing_fields:
        questionnaire.setdefault("sections", [])
        questionnaire["sections"].append(FIRST_VISIT_HISTORY_QUESTIONS)

    return questionnaire


# ---------------------------------------------------------------------------
# Call 2 — Streaming variant
# ---------------------------------------------------------------------------

async def stream_questionnaire(
    chief_complaint: dict,
    vault_context: dict,
    baseline_layer: str,
    epi_layer: str,
    patient_record: dict,
) -> AsyncIterator[str]:
    """
    Streaming version of generate_questionnaire.

    The nurse sees sections appearing in real time and can begin the
    interview before the full questionnaire has finished generating.
    This is the primary display path — generate_questionnaire() runs
    separately for the structured Vault write.
    """
    demographics    = vault_context.get("demographics", {})
    district_code   = vault_context.get("gps", {}).get("district_code", "WB_UNKNOWN")
    state_name      = state_from_district_code(district_code)
    lang            = chief_complaint.get("language_of_consultation", "English")
    language_instruction = (
        "" if lang == "English" else
        f"LANGUAGE: The consultation is in {lang}. "
        f"After each question, add a romanised {lang} translation in brackets — "
        f"for example: 'Do you have fever? (jwor hochhe?)' for Bengali, "
        f"'Do you have fever? (bukhaar hai?)' for Hindi. "
        f"Use plain everyday words in the translation — not medical terminology."
    )
    known_context, missing_fields = build_patient_record_context(patient_record)
    has_missing = bool(missing_fields)

    prompt = "\n\n".join(filter(bool, [
        f"Generate a structured interview questionnaire for a nurse in rural "
        f"{state_name}. Write it as clearly numbered sections with questions the "
        "nurse reads directly to the patient. Be concise — start immediately.\n\n"
        f"PATIENT RECORD STATUS:\n{known_context}",
        f"Patient: {json.dumps(demographics)}",
        f"Chief complaint (primary): {json.dumps(chief_complaint.get('chief_complaint'))}",
        (
            "Additional complaints: " + json.dumps(chief_complaint.get("additional_complaints", []))
            if chief_complaint.get("additional_complaints")
            else ""
        ),
        language_instruction,
        baseline_layer,
        epi_layer,
        (
            "Clinical framework — choose by presentation type:\n"
            "  Pain/acute → SOCRATES\n"
            "  Gynaecological/obstetric → menstrual/obstetric history (LMP, cycle, quantity, G/P/A, contraception)\n"
            "  Infertility → duration, cycle regularity, prior pregnancies, partner history\n"
            "  Chronic/constitutional → duration, progression, systemic features, exposures\n"
            "Do not force SOCRATES fields that do not apply."
        ),
        (
            "Format: numbered sections with bullet questions. "
            "4-8 sections depending on complexity, 3-5 questions each. Plain language. "
            "Primary complaint first (full framework). "
            "If additional complaints listed, add one short section per complaint (2-3 questions each). "
            + ("Collect missing history fields: " + ", ".join(missing_fields) + "."
               if has_missing else "Verify existing history — confirm what has changed.")
        ),
    ]))

    async for chunk in stream_with_cascade(
        MODEL_H2_QUESTIONNAIRE,
        contents=prompt,
        config=types.GenerateContentConfig(max_output_tokens=1500),
    ):
        if chunk.text:
            yield chunk.text

    # Append fixed background history section for first/partial visits.
    # Streamed as plain text after the LLM section so the nurse sees it immediately.
    if has_missing:
        section = FIRST_VISIT_HISTORY_QUESTIONS
        yield f"\n\n{section['section_title'].upper()}\n"
        for i, q in enumerate(section["questions"], 1):
            yield f"\n{i}. {q['question']}\n"
            if q.get("follow_up"):
                yield f"   → If yes / abnormal: {q['follow_up']}\n"


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------

def validate_questionnaire(q: dict) -> dict:
    """
    Enforce required top-level fields and sub-fields.
    Applies safe defaults for missing fields and logs warnings.

    Two consumers:
      - Nurse: interview sections (human-readable)
      - patient_records table: patient_record_fields (machine-readable)
    Both need structural completeness.
    """
    required_defaults = {
        "visit_type":                 "first_visit",
        "opening_context":            "Conduct the structured interview below.",
        "sections":                   [],
        "mandatory_safety_questions": [],
        "prior_encounter_flags":      [],
        "patient_record_fields": {
            "past_medical_history": [],
            "family_history":       [],
            "social_history":       {},
            "current_medications":  [],
            "allergies":            [],
            "immunisation_flags":   [],
        },
    }

    for field, default in required_defaults.items():
        if field not in q:
            print(f"[QUESTIONNAIRE WARNING] Missing field '{field}' — using default")
            q[field] = default

    for i, section in enumerate(q.get("sections", [])):
        section.setdefault("section_title", f"Section {i + 1}")
        section.setdefault("questions",     [])
        section.setdefault("rationale",     "")
        for qn in section["questions"]:
            qn.setdefault("question",      "[Question text missing]")
            qn.setdefault("follow_up",     "")
            qn.setdefault("discriminates", "")

    prf = q.setdefault("patient_record_fields", {})
    prf.setdefault("past_medical_history", [])
    prf.setdefault("family_history",       [])
    prf.setdefault("social_history",       {})
    prf.setdefault("current_medications",  [])
    prf.setdefault("allergies",            [])
    prf.setdefault("immunisation_flags",   [])

    return q


# ---------------------------------------------------------------------------
# Patient record extraction
# ---------------------------------------------------------------------------

def extract_patient_record_update(
    questionnaire: dict,
    chief_complaint: dict,
    session_id: str,
) -> dict:
    """
    Extract the patient_record_fields from the questionnaire output and
    format them as a partial patient record update.

    Note: at this point, the questionnaire contains the QUESTIONS to ask —
    not the answers. The actual answers come from the phase 2 transcript
    parsed by the Diagnosis Stage. This function prepares the schema
    so the Diagnosis Stage's concept extractor knows what structured
    fields to populate.

    The actual patient_records update happens after session close, once
    answers have been extracted from the phase 2 transcript and confirmed.
    """
    prf = questionnaire.get("patient_record_fields", {})

    return {
        "session_id":    session_id,
        "chief_complaint_summary": chief_complaint.get("chief_complaint", ""),
        "history_fields_to_collect": list(prf.keys()),
        "status": "pending — awaiting phase 2 transcript extraction",
    }


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

async def run_history_stage(
    session_id: str,
    transcript_segment: str,
    db_conn: asyncpg.Connection,
) -> dict:
    """
    Full History Stage pipeline.
    Called by the session orchestrator when the nurse presses marker A.

    Flow:
      1. Load Vault context + prior encounter history + epi prior
      2. Call 1 — extract chief complaint               (~700ms)
      3. Call 2 — generate questionnaire                (~1.3s, streaming)
      4. Write outputs to Vault

    Total: ~2s. Nurse sees questionnaire streaming from ~800ms after button press.
    """
    vault         = Vault(db_conn, session_id)
    vault_context = await vault.read()

    gps           = vault_context.get("gps", {})
    district_code = gps.get("district_code", "WB_UNKNOWN")
    current_month = datetime.now().month
    # Load patient record — the source of truth for what is already known
    # patient_record comes from the patient_records table, pre-loaded into
    # the Vault by the session orchestrator at session start.
    # Empty dict = new patient, all fields missing.
    patient_record = vault_context.get("patient_record", {})

    baseline_layer = load_baseline_diseases()
    epi_layer      = load_epi_prior(district_code, current_month)

    # Call 1
    print(f"[{session_id}] History stage Call 1: extracting chief complaint")
    chief_complaint = await extract_chief_complaint(transcript_segment, vault_context)
    await vault.update({"chief_complaint": chief_complaint})

    # Nudge path — chief complaint not captured, do not fire Call 2
    if is_complaint_missing(chief_complaint):
        print(f"[{session_id}] History stage: chief complaint missing — nudge sent, Call 2 skipped")
        await vault.update({
            "history_stage_status": "nudge_required",
            "nudge_reason":         "chief_complaint_missing",
        })
        return {
            "session_id":  session_id,
            "nudge":       True,
            "nudge_message": (
                "Chief complaint was not captured clearly. "
                "Please ask the patient to describe their problem again "
                "and press Marker A once more."
            ),
        }

    # Call 2
    print(f"[{session_id}] History stage Call 2: generating questionnaire")
    questionnaire = await generate_questionnaire(
        chief_complaint,
        vault_context,
        baseline_layer,
        epi_layer,
        patient_record,
    )
    questionnaire = validate_questionnaire(questionnaire)

    patient_record_stub = extract_patient_record_update(
        questionnaire, chief_complaint, session_id
    )

    await vault.update({
        "chief_complaint":               chief_complaint,
        "questionnaire":                 questionnaire,
        "patient_record_stub":           patient_record_stub,
        "history_stage_status":          "complete",
        "history_stage_completed_at":    datetime.now().isoformat(),
    })

    missing = [f for f in [
        "past_medical_history", "family_history", "social_history",
        "current_medications", "allergies"
    ] if not patient_record.get(f)]
    print(f"[{session_id}] History stage complete — "
          f"missing fields to collect: {missing if missing else 'none — verification only'}")

    return {
        "session_id":          session_id,
        "chief_complaint":     chief_complaint,
        "questionnaire":       questionnaire,
        "patient_record_stub": patient_record_stub,
    }


# ---------------------------------------------------------------------------
# FastAPI endpoints
# ---------------------------------------------------------------------------

app = FastAPI()


class HistoryRequest(BaseModel):
    session_id:         str
    transcript_segment: str


@app.post("/stage/history")
async def history_endpoint(req: HistoryRequest):
    """
    Non-streaming endpoint. Returns full structured result when complete.
    """
    conn = await asyncpg.connect(dsn="postgresql://localhost/cdst")
    try:
        return await run_history_stage(
            req.session_id, req.transcript_segment, conn
        )
    finally:
        await conn.close()


@app.post("/stage/history/stream")
async def history_stream_endpoint(req: HistoryRequest):
    """
    Streaming endpoint — yields questionnaire as tokens arrive.

    The nurse sees sections appearing in real time and can start the
    interview immediately. The structured Vault write happens in
    parallel via run_history_stage() called by the orchestrator.
    """
    conn          = await asyncpg.connect(dsn="postgresql://localhost/cdst")
    vault_context = await Vault(conn, req.session_id).read()

    gps           = vault_context.get("gps", {})
    district_code = gps.get("district_code", "WB_UNKNOWN")
    current_month = datetime.now().month
    patient_record  = vault_context.get("patient_record", {})

    chief_complaint = await extract_chief_complaint(req.transcript_segment, vault_context)
    baseline_layer  = load_baseline_diseases()
    epi_layer       = load_epi_prior(district_code, current_month)

    if is_complaint_missing(chief_complaint):
        async def nudge_stream():
            yield (
                "\n⚠ Chief complaint was not captured clearly. "
                "Please ask the patient to describe their problem again "
                "and press Marker A once more.\n"
            )
            await conn.close()
        return StreamingResponse(nudge_stream(), media_type="text/plain")

    async def token_stream():
        async for chunk in stream_questionnaire(
            chief_complaint,
            vault_context,
            baseline_layer,
            epi_layer,
            patient_record,
        ):
            yield chunk
        await conn.close()

    return StreamingResponse(token_stream(), media_type="text/plain")
