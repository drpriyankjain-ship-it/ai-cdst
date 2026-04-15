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
    pip install anthropic asyncpg fastapi pydantic
"""

import json
from datetime import datetime
from typing import AsyncIterator

import anthropic
import asyncpg
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CLAUDE_MODEL       = "claude-sonnet-4-20250514"
EPI_PRIOR_PATH     = "data/epi_prior_wb.json"

client = anthropic.Anthropic()   # API key from environment


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


# ---------------------------------------------------------------------------
# Epidemiological prior — Layer 1 + Layer 2
# ---------------------------------------------------------------------------

MONTH_TO_SEASON = {
    1: "winter",        2: "winter",        3: "pre_monsoon",
    4: "pre_monsoon",   5: "pre_monsoon",   6: "monsoon",
    7: "monsoon",       8: "monsoon",       9: "monsoon",
    10: "post_monsoon", 11: "post_monsoon", 12: "winter",
}


def load_baseline_diseases() -> str:
    """
    Layer 1 — common primary care presentations in rural West Bengal.
    Injected into Call 2 to ensure the questionnaire probes relevant
    differential directions even when the chief complaint is vague.
    """
    return (
        "LAYER 1 — BASELINE DISEASE BURDEN (rural West Bengal primary care):\n"
        "Always consider these regardless of location or season:\n"
        "  Respiratory : acute RTI, pneumonia, pulmonary TB, COPD exacerbation, asthma\n"
        "  Fever       : typhoid, malaria, dengue, UTI, viral syndrome, scrub typhus\n"
        "  GI          : acute gastroenteritis, peptic ulcer disease, cholera, hepatitis A/E\n"
        "  Cardiac     : hypertension, heart failure, ischaemic heart disease\n"
        "  Metabolic   : type 2 diabetes, iron-deficiency anaemia, malnutrition, B12 deficiency\n"
        "  Neurological: stroke, GBS, peripheral neuropathy, epilepsy, cord compression\n"
        "  Obstetric   : pre-eclampsia, anaemia in pregnancy, post-partum sepsis\n"
        "  Trauma      : snake envenomation, fractures, burns\n"
        "Use these to shape questionnaire sections — the epi prior below elevates "
        "specific conditions for this district and season."
    )


def load_epi_prior(district_code: str, month: int) -> str:
    """
    Layer 2 — IDSP/NVBDCP district + season endemic disease weights.
    Shapes the questionnaire toward locally prevalent conditions where
    the chief complaint is compatible.
    """
    with open(EPI_PRIOR_PATH) as f:
        prior = json.load(f)

    season        = MONTH_TO_SEASON.get(month, "monsoon")
    district_data = prior.get("districts", {}).get(district_code)

    if not district_data:
        print(
            f"[EPI PRIOR WARNING] District '{district_code}' not found. "
            f"Layer 2 modifier absent for this session."
        )
        return ""

    season_diseases = district_data.get("seasons", {}).get(season, [])
    if not season_diseases:
        return ""

    district_name = district_data.get("name", district_code)
    lines = "\n".join(
        "  - {disease}: weight {weight:.2f}{note}".format(
            disease=d["disease"],
            weight=d["weight"],
            note=f" — {d['note']}" if d.get("note") else ""
        )
        for d in sorted(season_diseases, key=lambda x: x["weight"], reverse=True)
    )
    return (
        f"LAYER 2 — DISTRICT/SEASON MODIFIER "
        f"({district_name}, {season} season, IDSP/NVBDCP data):\n"
        "Include targeted questions for these conditions where the chief "
        "complaint is compatible — do not probe for malaria if the patient "
        "presents with difficulty walking.\n"
        f"{lines}"
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

def parse_llm_json(raw: str) -> dict | list:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return json.loads(raw.strip())


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

    output_schema = json.dumps({
        "patient_name":             "name as stated verbally",
        "age":                      "age as stated e.g. '34' or 'about 40'",
        "village":                  "village or area as stated",
        "chief_complaint":          "single sentence — what the patient came for",
        "duration":                 "how long this has been present — patient's own words or null",
        "severity_if_mentioned":    "mild|moderate|severe or null if not mentioned",
        "spontaneous_history": [
            "anything the patient volunteered beyond the direct opening questions"
        ],
        "red_flags_mentioned": [
            "any alarming symptom explicitly mentioned — e.g. blood, cannot walk, chest pain"
        ],
        "language_of_consultation": "English|Bengali|Hindi|mixed"
    }, indent=2)

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
            "- This is ~30 seconds. Most fields will be null. Do not infer.\n\n"
            f"Return ONLY valid JSON matching this schema:\n{output_schema}\n\n"
            "JSON only. No explanation. No markdown."
        ),
    ])

    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=600,
        messages=[{"role": "user", "content": prompt}]
    )

    return parse_llm_json(response.content[0].text)


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

    output_schema = json.dumps({
        "opening_context": "one sentence for the nurse — what to focus on",
        "known_and_verified": [
            "field already in record — just confirm e.g. 'Still taking metformin?'"
        ],
        "sections": [{
            "section_title": "section name",
            "rationale":     "why included — which conditions it probes",
            "questions": [{
                "question":      "exact nurse-readable question",
                "follow_up":     "if yes / if abnormal — what to ask next",
                "discriminates": "brief clinical note for nurse (not read to patient)"
            }]
        }],
        "mandatory_safety_questions": [{
            "question": "must-ask question",
            "reason":   "why mandatory"
        }],
        "prior_encounter_flags": [
            "specific thing to verify from prior records"
        ],
        "patient_record_fields": {
            "past_medical_history": ["condition name — collect if missing"],
            "family_history":       ["condition — relationship"],
            "social_history": {
                "occupation":       "as stated",
                "living_situation": "as stated",
                "tobacco":          "yes|no|unknown",
                "alcohol":          "yes|no|unknown"
            },
            "current_medications": ["drug — dose — reason"],
            "allergies":           ["allergen — reaction type"],
            "immunisation_flags":  ["vaccination to verify"]
        }
    }, indent=2)

    prompt = "\n\n".join(filter(bool, [
        (
            "You are generating a structured interview questionnaire for a nurse "
            "in a remote rural clinic in West Bengal, India. The nurse reads these "
            "questions directly to the patient during a 3-4 minute interview.\n\n"
            f"PATIENT RECORD STATUS:\n{known_context}"
        ),
        f"PATIENT (from 30-second opening):\n{json.dumps(vault_context.get('demographics', {}), indent=2)}",
        f"CHIEF COMPLAINT:\n{json.dumps(chief_complaint, indent=2)}",
        spontaneous_text,
        baseline_layer,
        epi_layer,
        (
            "QUESTIONNAIRE DESIGN:\n"
            "- 4-6 sections maximum — interview takes 3-4 minutes total\n"
            "- Each section: 3-5 questions\n"
            "- Chief complaint section is ALWAYS first\n"
            "- Questions within each section: most to least discriminating\n"
            "- Plain language — questions are read directly to the patient\n"
            "- follow_up: what to ask if the answer is yes or abnormal\n"
            "- discriminates: brief nurse-only note — not read to patient\n\n"
            "CHIEF COMPLAINT SECTION (always include):\n"
            "- SOCRATES: site, onset, character, radiation, associated symptoms,\n"
            "  timing, exacerbating/relieving factors, severity\n"
            "- Systemic symptoms: fever, weight loss, night sweats, fatigue, appetite\n"
            "- Epi prior conditions: include ONLY if compatible with chief complaint\n\n"
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
            "Leave fields empty ([]) if already recorded and no update expected.\n\n"
            f"Return ONLY valid JSON matching this schema:\n{output_schema}\n\n"
            "JSON only. No explanation. No markdown."
        ),
    ]))

    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}]
    )

    return parse_llm_json(response.content[0].text)


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
    known_context, missing_fields = build_patient_record_context(patient_record)
    has_missing = bool(missing_fields)

    prompt = "\n\n".join(filter(bool, [
        "Generate a structured interview questionnaire for a nurse in rural "
        "West Bengal. Write it as clearly numbered sections with questions the "
        "nurse reads directly to the patient. Be concise — start immediately.\n\n"
        f"PATIENT RECORD STATUS:\n{known_context}",
        f"Patient: {json.dumps(demographics)}",
        f"Chief complaint: {json.dumps(chief_complaint)}",
        baseline_layer,
        epi_layer,
        (
            "Format: numbered sections with bullet questions. "
            "4-6 sections, 3-5 questions each. Plain language. "
            "Chief complaint first. "
            + ("Collect missing history fields: " + ", ".join(missing_fields) + "."
               if has_missing else "Verify existing history — confirm what has changed.")
        ),
    ]))

    with client.messages.stream(
        model=CLAUDE_MODEL,
        max_tokens=1500,
        messages=[{"role": "user", "content": prompt}]
    ) as stream:
        for text in stream.text_stream:
            yield text


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
