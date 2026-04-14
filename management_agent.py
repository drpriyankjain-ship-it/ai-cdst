"""
CDST Management Agent
=====================
Four-call pipeline with RAG for treatment protocol retrieval:

  Call 1: phase 3 transcript → extracted clarifying findings     (~900ms)
  [parallel: RAG retrieval of STG treatment protocols]
  Call 2: full Vault + RAG → provisional diagnosis + Rx draft    (~2.5s, streaming)
  Call 3: provisional Dx + Rx → five-dimension risk assessment   (~1.8s)
  Call 4: risk assessment → triage + patient instructions        (~1.2s, streaming)
           + doctor handoff package
  [post: deterministic rule engine gate]

Risk assessment dimensions (Call 3):
  1. Diagnostic uncertainty — what if the provisional Dx is wrong?
  2. Iatrogenic risk       — risk of the treatment itself
  3. Delay risk            — consequence of waiting for doctor auth
  4. Complication watch    — what to monitor in the provisional Dx
  5. Mitigation plan       — what resolves each risk; what cannot be mitigated

Triage output:
  - LOW  : async doctor review, nurse proceeds with treatment plan
  - HIGH : urgent synchronous doctor contact or immediate referral

Dependencies:
    pip install anthropic asyncpg pgvector sentence-transformers fastapi pydantic
"""

import json
from datetime import datetime
from typing import AsyncIterator

import anthropic
import asyncpg
from sentence_transformers import SentenceTransformer
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CLAUDE_MODEL       = "claude-sonnet-4-20250514"
EPI_PRIOR_PATH     = "data/epi_prior_wb.json"
BEDSIDE_TOOLS_PATH = "data/bedside_tools.json"
FORMULARY_PATH     = "data/formulary_wb.json"
ESCALATION_RULES_PATH = "escalation_rules.json"
RAG_TOP_K          = 8    # STG chunks per diagnosis for treatment retrieval

client   = anthropic.Anthropic()
embedder = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")


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
# Helpers
# ---------------------------------------------------------------------------

def parse_llm_json(raw: str) -> dict | list:
    """Strip markdown fences and parse JSON."""
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return json.loads(raw.strip())


def load_formulary() -> dict:
    with open(FORMULARY_PATH) as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# RAG — STG treatment protocol retrieval
# ---------------------------------------------------------------------------

async def retrieve_treatment_protocols(
    conn: asyncpg.Connection,
    diagnoses: list[str],
    top_k: int = RAG_TOP_K,
) -> str:
    """
    Retrieve STG treatment protocol chunks for the top 1-2 diagnoses.

    Queries are treatment-focused — dose, duration, route, contraindications,
    referral criteria. This is the core RAG use case for the Management Agent:
    retrieved authoritative text governs the prescription, not LLM recall.

    Returns a formatted string ready for prompt injection, or empty string
    if no relevant chunks are found.
    """
    retrieved_sections = []

    for diagnosis in diagnoses:
        query = (
            f"treatment protocol dose duration route contraindications "
            f"referral criteria {diagnosis} NHM India STG"
        )
        query_embedding = embedder.encode(query).tolist()

        rows = await conn.fetch(
            """
            SELECT content, source, chunk_id,
                   1 - (embedding <=> $1::vector) AS similarity
            FROM stg_chunks
            WHERE 1 - (embedding <=> $1::vector) > 0.55
            ORDER BY embedding <=> $1::vector
            LIMIT $2
            """,
            query_embedding,
            top_k
        )

        if rows:
            chunks = "\n\n".join(
                f"[{row['source']} / chunk {row['chunk_id']} "
                f"| similarity {row['similarity']:.2f}]\n{row['content']}"
                for row in rows
            )
            retrieved_sections.append(f"=== {diagnosis} ===\n{chunks}")

    if not retrieved_sections:
        print("[RAG WARNING] No STG chunks retrieved. "
              "Prescription will rely on LLM knowledge only — flag for review.")
        return ""

    return "\n\n".join(retrieved_sections)


# ---------------------------------------------------------------------------
# Call 1 — Extract clarifying findings from phase 3 transcript
# ---------------------------------------------------------------------------

async def extract_clarifying_findings(
    transcript_segment: str,
    vault_context: dict,
) -> dict:
    """
    Extract structured findings from the phase 3 clarifying questions transcript.

    This is the nurse's answers to the Diagnosis Agent's clarifying questions
    plus any bedside examination findings. It updates the clinical picture
    before the Management Agent generates the provisional diagnosis.

    Input : phase 3 transcript (marker B → marker C)
    Output: structured JSON with answers, examination findings, updated
            symptom profile, and any new information not in phase 2
    """
    ddx              = vault_context.get("differential_table", [])
    clarifying_qs    = vault_context.get("clarifying_questions", {})
    prior_concepts   = vault_context.get("extracted_concepts", {})
    demographics     = vault_context.get("demographics", {})

    output_schema = json.dumps({
        "answers_to_clarifying_questions": [
            {
                "question":  "question that was asked",
                "answer":    "patient's answer",
                "implication": "which diagnosis this supports or rules out"
            }
        ],
        "bedside_examination_findings": [
            {
                "observation": "what the nurse observed or measured",
                "result":      "finding value or description",
                "implication": "clinical significance"
            }
        ],
        "new_symptoms":  ["any symptom mentioned in phase 3 not in phase 2"],
        "vitals_found": {
            "temperature_c":    "numeric °C only e.g. 38.5 — null if not measured",
            "pulse_bpm":        "numeric bpm only e.g. 112 — null if not measured",
            "systolic_bp_mmhg": "numeric systolic mmHg only e.g. 85 — null if not measured",
            "spo2_pct":         "numeric SpO2 percent only e.g. 94 — null if not measured",
            "rr_per_min":       "numeric breaths/min only e.g. 28 — null if not measured",
            "bgl_mmol":         "blood glucose numeric mmol/L e.g. 11.2 — null if not measured",
            "gcs":              "numeric Glasgow Coma Scale 3-15 — null if not assessed",
            "weight_kg":        "numeric kg only e.g. 42.5 — null if not measured",
            "rdt_result":       "positive_pf | positive_pv | negative | not_done"
        },
        "updated_clinical_summary": "one sentence integrating all phases"
    }, indent=2)

    prompt = "\n\n".join([
        "Extract structured clinical findings from the phase 3 clarifying questions transcript.",
        f"PATIENT DEMOGRAPHICS:\n{json.dumps(demographics, indent=2)}",
        f"PHASE 2 CONCEPTS (already known):\n{json.dumps(prior_concepts, indent=2)}",
        f"CLARIFYING QUESTIONS THAT WERE ASKED:\n{json.dumps(clarifying_qs, indent=2)}",
        f"WORKING DIFFERENTIAL:\n{json.dumps(ddx, indent=2)}",
        f"PHASE 3 TRANSCRIPT:\n{transcript_segment}",
        (
            "INSTRUCTIONS:\n"
            "- Match answers to the specific clarifying questions where possible\n"
            "- Record all bedside examination findings the nurse performed\n"
            "- Note implications for the differential — which diagnoses are "
            "supported or ruled out by each finding\n"
            "- Only extract what is explicitly in the transcript\n"
            "- vitals_found: return NUMERIC JSON numbers only — strip all units.\n"
            "  e.g. temperature 38.5°C → 38.5; SpO2 94% → 94; BP 90/60 → 90 (systolic only).\n"
            "  Null for any vital not measured in this phase.\n\n"
            f"Return ONLY valid JSON matching this schema:\n{output_schema}\n\n"
            "JSON only. No explanation. No markdown."
        ),
    ])

    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=1200,
        messages=[{"role": "user", "content": prompt}]
    )

    return parse_llm_json(response.content[0].text)


# ---------------------------------------------------------------------------
# Call 2 — Provisional diagnosis + prescription draft
# ---------------------------------------------------------------------------

async def generate_provisional_diagnosis_and_rx(
    clarifying_findings: dict,
    vault_context: dict,
    stg_context: str,
    formulary: dict,
) -> dict:
    """
    Generate the provisional diagnosis and a fully specified prescription draft.

    Inputs:
      - Full Vault context (demographics, DDx, concepts, prior encounters)
      - Extracted clarifying findings (Call 1)
      - Retrieved STG treatment protocol chunks (RAG)
      - Local formulary (available drugs at this clinic)

    The STG context grounds the prescription — drug choice, dose by weight,
    duration, and route follow the retrieved protocol, not LLM recall.
    The formulary constrains the prescription to drugs actually available.

    Output schema:
    {
      "provisional_diagnosis": {
        "name":        "full diagnosis name",
        "icd10_code":  "ICD-10 code",
        "confidence":  "high|moderate|low",
        "rationale":   "clinical reasoning in 2-3 sentences",
        "key_features_supporting": ["finding 1", "finding 2"],
        "remaining_uncertainty":   "what is still unknown"
      },
      "prescription": [
        {
          "drug":         "generic drug name",
          "dose":         "dose with units e.g. 500mg",
          "route":        "oral|IM|IV|topical",
          "frequency":    "e.g. twice daily",
          "duration":     "e.g. 5 days",
          "instructions": "with food, avoid alcohol, etc.",
          "dose_basis":   "weight-based calculation if applicable",
          "stg_source":   "cite the retrieved chunk this follows"
        }
      ],
      "non_pharmacological": ["rest", "oral rehydration", "wound care — specific instructions"],
      "formulary_substitutions": ["drug X not available — substituted Y per STG second-line"]
    }
    """
    demographics     = vault_context.get("demographics", {})
    ddx              = vault_context.get("differential_table", [])
    concepts         = vault_context.get("extracted_concepts", {})
    prior_encounters = vault_context.get("prior_encounters", [])
    known_allergies  = demographics.get("known_allergies", [])

    output_schema = json.dumps({
        "provisional_diagnosis": {
            "name":                    "full diagnosis name",
            "icd10_code":              "ICD-10 code",
            "confidence":              "high|moderate|low",
            "rationale":               "2-3 sentence clinical reasoning",
            "key_features_supporting": ["finding"],
            "remaining_uncertainty":   "what is still not known"
        },
        "prescription": [{
            "drug":         "generic name",
            "dose":         "amount with units",
            "route":        "oral|IM|IV|topical|other",
            "frequency":    "e.g. twice daily",
            "duration":     "e.g. 5 days",
            "instructions": "specific patient instructions",
            "dose_basis":   "weight-based calculation or standard adult dose",
            "stg_source":   "citation from retrieved STG chunk"
        }],
        "non_pharmacological":     ["specific instruction"],
        "formulary_substitutions": ["substitution made and reason"]
    }, indent=2)

    stg_section = (
        f"RETRIEVED STG TREATMENT PROTOCOLS:\n{stg_context}"
        if stg_context else
        "WARNING: No STG chunks retrieved. Prescription based on LLM knowledge only — "
        "flag this session for mandatory doctor review before dispensing."
    )

    prompt = "\n\n".join([
        "You are generating a provisional diagnosis and prescription for a nurse "
        "in rural West Bengal. The prescription must follow retrieved NHM STG "
        "protocols and be constrained to drugs available in the local formulary.",
        f"PATIENT:\n{json.dumps(demographics, indent=2)}",
        f"KNOWN ALLERGIES: {json.dumps(known_allergies)}",
        f"PRIOR ENCOUNTERS (last 3):\n{json.dumps(prior_encounters[-3:], indent=2)}",
        f"WORKING DIFFERENTIAL:\n{json.dumps(ddx, indent=2)}",
        f"PHASE 2 CLINICAL CONCEPTS:\n{json.dumps(concepts, indent=2)}",
        f"PHASE 3 CLARIFYING FINDINGS:\n{json.dumps(clarifying_findings, indent=2)}",
        stg_section,
        f"LOCAL FORMULARY (available drugs only):\n{json.dumps(formulary, indent=2)}",
        (
            "INSTRUCTIONS:\n"
            "- Select the single most likely provisional diagnosis\n"
            "- Prescription must follow the retrieved STG protocol — cite the chunk\n"
            "- If STG specifies weight-based dosing, use the patient's weight "
            "from vitals_found; if weight unknown state this explicitly\n"
            "- Prescribe ONLY drugs present in the local formulary\n"
            "- If the first-line STG drug is not in the formulary, use the "
            "second-line alternative and record in formulary_substitutions\n"
            "- Do NOT prescribe any drug the patient is allergic to\n"
            "- stg_source must cite the specific retrieved chunk — "
            "do not cite if no chunk was retrieved\n\n"
            f"Return ONLY valid JSON matching this schema:\n{output_schema}\n\n"
            "JSON only. No explanation. No markdown."
        ),
    ])

    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}]
    )

    return parse_llm_json(response.content[0].text)


# ---------------------------------------------------------------------------
# Call 3 — Five-dimension risk assessment
# ---------------------------------------------------------------------------

async def generate_risk_assessment(
    provisional_dx: dict,
    clarifying_findings: dict,
    vault_context: dict,
) -> dict:
    """
    Five-dimension risk assessment over the provisional diagnosis and plan.

    Does NOT use RAG — pure LLM clinical reasoning over structured inputs.
    Each dimension produces identified risks AND a mitigation plan.
    The overall risk tier (LOW / HIGH) drives the triage decision in Call 4.

    Dimensions:
      1. diagnostic_uncertainty — what if the provisional Dx is wrong?
      2. iatrogenic_risk        — risk of the treatment itself
      3. delay_risk             — consequence of waiting for doctor auth
      4. complication_watch     — what complications to monitor for
      5. mitigation_plan        — what resolves each risk; what cannot be mitigated

    Output schema:
    {
      "diagnostic_uncertainty": {
        "must_not_miss_still_in_play": [
          {
            "diagnosis":        "name",
            "why_still_possible": "reasoning",
            "consequence_if_missed": "clinical consequence",
            "ruling_out_action": "what bedside action would exclude this"
          }
        ],
        "confidence_in_provisional": "high|moderate|low",
        "uncertainty_mitigable":     true|false
      },
      "iatrogenic_risk": {
        "risks": [
          {
            "risk":        "description",
            "affected_by": "patient factor driving this risk",
            "severity":    "low|moderate|high",
            "mitigation":  "specific action"
          }
        ],
        "allergy_check":     "clear|flag — detail if flagged",
        "interaction_check": "clear|flag — detail if flagged"
      },
      "delay_risk": {
        "time_sensitive": true|false,
        "safe_delay_window": "e.g. 4 hours | immediate | 24 hours",
        "rationale": "why this window",
        "if_delayed_consequence": "what happens if treatment waits"
      },
      "complication_watch": [
        {
          "complication":      "name",
          "warning_signs":     ["sign 1", "sign 2"],
          "nurse_action":      "what to do if signs appear",
          "timeframe":         "when to expect if it develops"
        }
      ],
      "mitigation_plan": {
        "mitigable_risks":     ["risk description — mitigation action"],
        "unmitigable_risks":   ["risk that cannot be safely managed remotely"],
        "home_monitoring":     ["specific instruction for patient/family"],
        "return_criteria":     ["return immediately if: symptom or sign"],
        "overall_risk_tier":   "LOW|HIGH",
        "risk_tier_rationale": "one sentence explaining the tier"
      }
    }
    """
    demographics    = vault_context.get("demographics", {})
    ddx             = vault_context.get("differential_table", [])
    known_allergies = demographics.get("known_allergies", [])
    current_meds    = demographics.get("current_medications", [])

    output_schema = json.dumps({
        "diagnostic_uncertainty": {
            "must_not_miss_still_in_play": [{
                "diagnosis":             "name",
                "why_still_possible":    "reasoning",
                "consequence_if_missed": "clinical consequence",
                "ruling_out_action":     "bedside action to exclude"
            }],
            "confidence_in_provisional": "high|moderate|low",
            "uncertainty_mitigable":     True
        },
        "iatrogenic_risk": {
            "risks": [{
                "risk":        "description",
                "affected_by": "patient factor",
                "severity":    "low|moderate|high",
                "mitigation":  "specific action"
            }],
            "allergy_check":     "clear|flag — detail",
            "interaction_check": "clear|flag — detail"
        },
        "delay_risk": {
            "time_sensitive":         True,
            "safe_delay_window":      "e.g. 4 hours",
            "rationale":              "why this window",
            "if_delayed_consequence": "what happens if treatment waits"
        },
        "complication_watch": [{
            "complication":  "name",
            "warning_signs": ["sign"],
            "nurse_action":  "what to do",
            "timeframe":     "when to expect"
        }],
        "mitigation_plan": {
            "mitigable_risks":     ["risk — mitigation"],
            "unmitigable_risks":   ["risk that cannot be managed remotely"],
            "home_monitoring":     ["specific instruction"],
            "return_criteria":     ["return immediately if: condition"],
            "overall_risk_tier":   "LOW|HIGH",
            "risk_tier_rationale": "one sentence"
        }
    }, indent=2)

    prompt = "\n\n".join([
        "Perform a five-dimension risk assessment for this clinical management plan. "
        "Be thorough — this assessment determines whether the patient can be safely "
        "managed at home or requires urgent referral.",
        f"PATIENT:\n{json.dumps(demographics, indent=2)}",
        f"KNOWN ALLERGIES: {json.dumps(known_allergies)}",
        f"CURRENT MEDICATIONS: {json.dumps(current_meds)}",
        f"FULL DIFFERENTIAL TABLE:\n{json.dumps(ddx, indent=2)}",
        f"PROVISIONAL DIAGNOSIS AND PRESCRIPTION:\n{json.dumps(provisional_dx, indent=2)}",
        f"CLARIFYING FINDINGS:\n{json.dumps(clarifying_findings, indent=2)}",
        (
            "INSTRUCTIONS:\n"
            "Assess all five dimensions:\n\n"
            "1. DIAGNOSTIC UNCERTAINTY\n"
            "   - Which must-not-miss diagnoses remain possible despite clarifying findings?\n"
            "   - What is the consequence of treating for the provisional Dx if one of "
            "these is actually present?\n"
            "   - Can this uncertainty be resolved with available bedside tools?\n\n"
            "2. IATROGENIC RISK\n"
            "   - What are the specific risks of each prescribed drug in this patient?\n"
            "   - Check for allergy conflicts and drug-drug interactions\n"
            "   - Weight-based dosing errors, paediatric risks, pregnancy risks\n\n"
            "3. DELAY RISK\n"
            "   - How time-sensitive is the provisional diagnosis?\n"
            "   - What is the safe window to wait for async doctor authorization?\n"
            "   - What deterioration occurs if treatment is delayed beyond that window?\n\n"
            "4. COMPLICATION WATCH\n"
            "   - What are the known complications of the provisional diagnosis?\n"
            "   - What warning signs should the nurse and patient watch for?\n"
            "   - What is the nurse's action if each complication develops?\n\n"
            "5. MITIGATION PLAN\n"
            "   - For each identified risk, what is the specific mitigation?\n"
            "   - Which risks CAN be mitigated remotely with available tools?\n"
            "   - Which risks CANNOT be safely mitigated without hospital-level care?\n"
            "   - Set overall_risk_tier to HIGH if ANY unmitigable risk exists, "
            "or if safe_delay_window is less than 2 hours\n"
            "   - Set overall_risk_tier to LOW only if all risks are mitigable "
            "and delay window is safe\n\n"
            f"Return ONLY valid JSON matching this schema:\n{output_schema}\n\n"
            "JSON only. No explanation. No markdown."
        ),
    ])

    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=2500,
        messages=[{"role": "user", "content": prompt}]
    )

    return parse_llm_json(response.content[0].text)


# ---------------------------------------------------------------------------
# Call 4 — Triage decision + patient instructions + doctor handoff
# ---------------------------------------------------------------------------

async def generate_triage_and_handoff(
    provisional_dx: dict,
    risk_assessment: dict,
    vault_context: dict,
) -> dict:
    """
    Synthesise the triage decision, patient-facing instructions,
    and the doctor handoff package from the risk assessment output.

    This is the final structured output the nurse sees and acts on.
    It is also the document sent to the doctor for async review.

    Triage tiers:
      LOW  — async doctor review within 4 hours; nurse proceeds with Rx
      HIGH — urgent synchronous doctor contact or immediate referral

    Output schema:
    {
      "triage": {
        "tier":           "LOW|HIGH",
        "rationale":      "one sentence",
        "action":         "specific instruction to the nurse",
        "referral": {
          "required":     true|false,
          "urgency":      "immediate|within 2 hours|within 24 hours|not required",
          "facility":     "PHC|CHC|district hospital|tertiary",
          "reason":       "clinical reason for referral"
        }
      },
      "patient_instructions": {
        "diagnosis_explained": "plain language explanation for patient and family",
        "treatment_summary":   "what drugs, when, how long — plain language",
        "do_list":             ["specific action"],
        "dont_list":           ["specific prohibition"],
        "return_criteria":     ["return immediately if: condition in plain language"],
        "follow_up":           "when and where to follow up"
      },
      "doctor_handoff": {
        "one_liner":           "age/sex + chief complaint + provisional Dx + Rx",
        "clinical_summary":    "structured summary for doctor review",
        "differential_table":  "top 3 diagnoses with confidence and key features",
        "prescription_issued": "drugs prescribed — pending your authorization",
        "key_risks_flagged":   ["risk requiring doctor attention"],
        "questions_for_doctor": ["specific clinical question needing doctor input"],
        "authorization_required_by": "timestamp — 4 hours from now for LOW, immediate for HIGH"
      }
    }
    """
    demographics = vault_context.get("demographics", {})
    ddx          = vault_context.get("differential_table", [])

    risk_tier = risk_assessment.get(
        "mitigation_plan", {}
    ).get("overall_risk_tier", "HIGH")   # default to HIGH if missing

    output_schema = json.dumps({
        "triage": {
            "tier":      "LOW|HIGH",
            "rationale": "one sentence",
            "action":    "specific nurse instruction",
            "referral": {
                "required": True,
                "urgency":  "immediate|within 2 hours|within 24 hours|not required",
                "facility": "PHC|CHC|district hospital|tertiary",
                "reason":   "clinical reason"
            }
        },
        "patient_instructions": {
            "diagnosis_explained": "plain language for patient/family",
            "treatment_summary":   "plain language drug instructions",
            "do_list":             ["action"],
            "dont_list":           ["prohibition"],
            "return_criteria":     ["return if: plain language condition"],
            "follow_up":           "when and where"
        },
        "doctor_handoff": {
            "one_liner":             "age/sex + complaint + Dx + Rx",
            "clinical_summary":      "structured summary",
            "differential_table":    "top 3 Dx with confidence and key features",
            "prescription_issued":   "drugs — pending authorization",
            "key_risks_flagged":     ["risk"],
            "questions_for_doctor":  ["question"],
            "authorization_required_by": "ISO timestamp"
        }
    }, indent=2)

    hours_to_auth = 4 if risk_tier == "LOW" else 0
    auth_deadline = (
        "IMMEDIATE — do not proceed without doctor contact"
        if hours_to_auth == 0
        else datetime.now().replace(
            hour=(datetime.now().hour + hours_to_auth) % 24
        ).strftime("%H:%M today")
    )

    prompt = "\n\n".join([
        "Generate the triage decision, patient instructions, and doctor handoff "
        "package based on the risk assessment below.",
        f"PATIENT:\n{json.dumps(demographics, indent=2)}",
        f"PROVISIONAL DIAGNOSIS AND PRESCRIPTION:\n{json.dumps(provisional_dx, indent=2)}",
        f"RISK ASSESSMENT:\n{json.dumps(risk_assessment, indent=2)}",
        f"FULL DIFFERENTIAL:\n{json.dumps(ddx[:3], indent=2)}",
        f"RISK TIER FROM ASSESSMENT: {risk_tier}",
        f"AUTHORIZATION DEADLINE: {auth_deadline}",
        (
            "INSTRUCTIONS:\n\n"
            "TRIAGE:\n"
            "- tier must match overall_risk_tier from the risk assessment — do not change it\n"
            "- action must be a specific, unambiguous instruction to the nurse\n"
            "- if HIGH: state explicitly whether the nurse should call the doctor now "
            "or refer the patient immediately, and to which facility\n"
            "- referral facility: use the lowest appropriate level "
            "(PHC before CHC before district hospital)\n\n"
            "PATIENT INSTRUCTIONS:\n"
            "- diagnosis_explained: plain language only — no medical jargon; "
            "explain what is wrong and why the treatment helps\n"
            "- treatment_summary: translate the prescription from "
            "PROVISIONAL DIAGNOSIS AND PRESCRIPTION above into plain language. "
            "Include every drug — name, dose, how many times a day, for how many days, "
            "and any specific instructions (with food, avoid alcohol, etc.). "
            "Do NOT omit or summarise any drug. Do NOT paraphrase doses.\n"
            "- return_criteria: must be specific and observable — not 'if you feel worse' "
            "but 'if fever goes above 39 degrees' or 'if you cannot walk at all'\n"
            "- follow_up: specific timeframe and named location\n\n"
            "DOCTOR HANDOFF:\n"
            "- one_liner: '[age][sex], [chief complaint] x [duration], "
            "provisional [Dx], prescribed [list every drug with dose], "
            "risk tier [LOW/HIGH]'\n"
            "- prescription_issued: copy EVERY drug from the prescription in "
            "PROVISIONAL DIAGNOSIS AND PRESCRIPTION exactly — "
            "drug name, dose, route, frequency, duration. "
            "Do not paraphrase, summarise, or omit any drug. "
            "This is the authoritative record the doctor will review and approve.\n"
            "- clinical_summary: structured paragraph — presenting complaint, "
            "key findings from all three phases, working differential, "
            "why this provisional diagnosis was chosen\n"
            "- key_risks_flagged: list every risk from the risk assessment "
            "that requires doctor attention or judgment\n"
            "- questions_for_doctor: genuine clinical uncertainties needing "
            "doctor judgment — not administrative questions\n"
            f"- authorization_required_by: use exactly this value: {auth_deadline}\n\n"
            f"Return ONLY valid JSON matching this schema:\n{output_schema}\n\n"
            "JSON only. No explanation. No markdown."
        ),
    ])

    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}]
    )

    return parse_llm_json(response.content[0].text)


# ---------------------------------------------------------------------------
# Rule engine helpers
# ---------------------------------------------------------------------------

def _to_float(val) -> float | None:
    """Safely coerce a vital sign value to float. Returns None on any failure."""
    if val is None:
        return None
    try:
        return float(str(val).strip().replace(",", "."))
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Rule engine — deterministic gate after Call 4
# ---------------------------------------------------------------------------

def run_rule_engine(
    provisional_dx:  dict,
    risk_assessment: dict,
    triage_output:   dict,
    demographics:    dict,
    vitals:          dict | None = None,
    red_flags:       list | None = None,
) -> dict:
    """
    Deterministic rule engine. Runs after all LLM calls.
    Checks structured output for hard stops that always trigger HIGH triage
    regardless of what the LLM assessed.

    Rules are explicit and auditable. They catch cases the LLM risk assessment
    might underweight. The rule engine overrides the LLM tier — it never downgrades.

    Rule categories (applied in order):
      1. Vital sign derangements      — objective, threshold-based
      2. Red flag symptoms            — alarming symptoms explicitly reported
      3. Diagnosis hard stops         — conditions requiring hospital-level care
      4. Drug hard stops              — injectables requiring supervised admin
      5. Patient profile              — age, pregnancy, low weight
      6. Allergy conflicts            — prescribed drug vs documented allergy
      7. Diagnostic confidence        — low LLM confidence in provisional Dx

    Returns:
    {
      "final_risk_tier":  "LOW|HIGH",
      "rules_triggered":  ["rule description"],
      "overrode_llm":     true|false,
      "override_reason":  "description if overrode"
    }
    """
    triggers = []

    dx_name   = provisional_dx.get("provisional_diagnosis", {}).get("name", "").lower()
    rx_drugs  = [d.get("drug", "").lower() for d in provisional_dx.get("prescription", [])]
    age       = demographics.get("age", 99)
    sex       = demographics.get("sex", "").upper()
    pregnancy = demographics.get("pregnancy_status", "").lower()
    weight_kg = demographics.get("weight_kg")

    with open(ESCALATION_RULES_PATH, "r") as f:
        escalation_rules = json.load(f)

    # --- 1. Vital sign derangements ---
    if vitals:
        v_thresh = escalation_rules.get("vital_thresholds", {})
        temp = _to_float(vitals.get("temperature_c"))
        hr   = _to_float(vitals.get("pulse_bpm"))
        sbp  = _to_float(vitals.get("systolic_bp_mmhg"))
        spo2 = _to_float(vitals.get("spo2_pct"))
        rr   = _to_float(vitals.get("rr_per_min"))
        bgl  = _to_float(vitals.get("bgl_mmol"))
        gcs  = _to_float(vitals.get("gcs"))

        if spo2 is not None and spo2 < v_thresh.get("spo2_critical_pct", 92):
            triggers.append(
                f"HYPOXIA: SpO2 {spo2:.0f}% < {v_thresh.get('spo2_critical_pct', 92)}% — respiratory support required, cannot be managed at PHC"
            )
        if sbp is not None and sbp < v_thresh.get("systolic_bp_shock_mmhg", 90):
            triggers.append(
                f"SHOCK: Systolic BP {sbp:.0f} mmHg < {v_thresh.get('systolic_bp_shock_mmhg', 90)} — haemodynamic instability, IV resuscitation required"
            )
        if sbp is not None and sbp >= v_thresh.get("systolic_bp_hypertensive_emergency_mmhg", 180):
            triggers.append(
                f"HYPERTENSIVE EMERGENCY: Systolic BP {sbp:.0f} mmHg ≥ {v_thresh.get('systolic_bp_hypertensive_emergency_mmhg', 180)} — immediate treatment and monitoring"
            )
        if hr is not None and hr > v_thresh.get("hr_tachycardia_bpm", 120):
            triggers.append(
                f"TACHYCARDIA: HR {hr:.0f} bpm > {v_thresh.get('hr_tachycardia_bpm', 120)} — arrhythmia or shock state"
            )
        if hr is not None and hr < v_thresh.get("hr_bradycardia_bpm", 50):
            triggers.append(
                f"BRADYCARDIA: HR {hr:.0f} bpm < {v_thresh.get('hr_bradycardia_bpm', 50)} — conduction block or shock"
            )
        if rr is not None and rr > v_thresh.get("rr_distress_per_min", 30):
            triggers.append(
                f"RESPIRATORY DISTRESS: RR {rr:.0f}/min > {v_thresh.get('rr_distress_per_min', 30)} — respiratory failure threshold"
            )
        if rr is not None and rr < v_thresh.get("rr_depression_per_min", 10):
            triggers.append(
                f"RESPIRATORY DEPRESSION: RR {rr:.0f}/min < {v_thresh.get('rr_depression_per_min', 10)} — impending respiratory arrest"
            )
        if temp is not None and temp > v_thresh.get("temperature_hyperpyrexia_c", 40.0):
            triggers.append(
                f"HYPERPYREXIA: Temperature {temp:.1f}°C > {v_thresh.get('temperature_hyperpyrexia_c', 40.0)} — cerebral malaria or meningitis risk"
            )
        if temp is not None and temp < v_thresh.get("temperature_hypothermia_c", 35.0):
            triggers.append(
                f"HYPOTHERMIA: Temperature {temp:.1f}°C < {v_thresh.get('temperature_hypothermia_c', 35.0)} — shock or severe exposure"
            )
        if gcs is not None and gcs < v_thresh.get("gcs_altered_consciousness", 15):
            triggers.append(
                f"ALTERED CONSCIOUSNESS: GCS {gcs:.0f}/15 — urgent neurological assessment required"
            )
        if bgl is not None and bgl < v_thresh.get("bgl_hypoglycaemia_mmol", 3.0):
            triggers.append(
                f"SEVERE HYPOGLYCAEMIA: BGL {bgl:.1f} mmol/L < {v_thresh.get('bgl_hypoglycaemia_mmol', 3.0)} — immediate glucose; if not correcting rapidly, refer"
            )
        if bgl is not None and bgl > v_thresh.get("bgl_hyperglycaemia_mmol", 16.6):
            triggers.append(
                f"SEVERE HYPERGLYCAEMIA: BGL {bgl:.1f} mmol/L > {v_thresh.get('bgl_hyperglycaemia_mmol', 16.6)} — possible DKA or HHS, refer for IV management"
            )

    # --- 2. Red flag symptoms ---
    if red_flags:
        CRITICAL_RED_FLAG_TERMS = [rt["term"].lower() for rt in escalation_rules.get("critical_red_flag_terms", [])]
        for flag in red_flags:
            flag_lower = flag.lower()
            for term in CRITICAL_RED_FLAG_TERMS:
                if term in flag_lower:
                    triggers.append(
                        f"RED FLAG SYMPTOM: '{flag}' — requires immediate clinical assessment"
                    )
                    break

    # --- 3. Diagnosis-level hard stops ---
    HIGH_RISK_DIAGNOSES = [dx["name"].lower() for dx in escalation_rules.get("high_risk_diagnoses", [])]
    for high_risk_dx in HIGH_RISK_DIAGNOSES:
        if high_risk_dx in dx_name:
            triggers.append(
                f"DIAGNOSIS HARD STOP: '{dx_name}' requires hospital-level care — immediate referral"
            )
            break  # one trigger per diagnosis is sufficient

    # --- 4. Drug-level hard stops (injectables requiring supervised administration) ---
    INJECTABLE_DRUGS = [inj["name"].lower() for inj in escalation_rules.get("injectable_drugs", [])]
    for drug in rx_drugs:
        for inj in INJECTABLE_DRUGS:
            if inj in drug:
                triggers.append(
                    f"INJECTABLE DRUG: '{drug}' requires supervised administration — "
                    f"doctor authorization mandatory before dispensing"
                )

    # --- 5. Patient profile hard stops ---
    profile_rules = escalation_rules.get("patient_profile_rules", {})
    if age < profile_rules.get("infant_age_years_threshold", 2):
        lbl = profile_rules.get("infant_threshold_label", "2 years")
        triggers.append(
            f"PATIENT AGE: infant under {lbl} — all prescriptions require doctor authorization"
        )

    # Pregnancy-aware check — applies to both known-pregnant AND unknown-status females.
    # Blanket blocking all prescriptions for pregnant patients is overly restrictive:
    # e.g. paracetamol for a headache in a pregnant woman is safe.
    # Only escalate when the diagnosis or drug is materially affected by pregnancy status.
    PREGNANCY_SENSITIVE_DX = [dx["name"].lower() for dx in escalation_rules.get("pregnancy_sensitive_diagnoses", [])]
    TERATOGENIC_DRUGS      = [td["name"].lower() for td in escalation_rules.get("teratogenic_drugs", [])]
    is_sensitive_dx = any(dx in dx_name for dx in PREGNANCY_SENSITIVE_DX)
    has_teratogen   = any(unsafe in drug for drug in rx_drugs for unsafe in TERATOGENIC_DRUGS)

    min_cb_age = profile_rules.get("childbearing_age_min_years", 12)
    max_cb_age = profile_rules.get("childbearing_age_max_years", 50)

    IS_PREGNANT = pregnancy in ("pregnant", "first trimester", "second trimester", "third trimester")
    IS_UNKNOWN  = pregnancy in ("", "unknown") and sex == "F" and min_cb_age <= age <= max_cb_age

    if IS_PREGNANT and (is_sensitive_dx or has_teratogen):
        triggers.append(
            "PREGNANCY: confirmed pregnancy and the provisional diagnosis or prescribed drug "
            "requires doctor sign-off before dispensing"
        )
    elif IS_UNKNOWN and (is_sensitive_dx or has_teratogen):
        triggers.append(
            "CHILDBEARING AGE: pregnancy status unknown in female of reproductive age, "
            "AND provisional diagnosis or prescribed drugs are pregnancy-sensitive — "
            "doctor authorization required"
        )

    weight_thresh = profile_rules.get("low_weight_kg_threshold", 5)
    if weight_kg and weight_kg < weight_thresh:
        triggers.append(
            f"LOW WEIGHT: patient weight < {weight_thresh}kg — weight-based dosing requires doctor verification"
        )

    # --- 6. Allergy conflict check ---
    known_allergies = [a.lower() for a in demographics.get("known_allergies", [])]
    for drug in rx_drugs:
        for allergy in known_allergies:
            if allergy in drug or drug in allergy:
                triggers.append(
                    f"ALLERGY CONFLICT: prescribed '{drug}' conflicts with "
                    f"documented allergy '{allergy}' — DO NOT DISPENSE"
                )

    # --- 7. Diagnostic confidence hard stop ---
    confidence = provisional_dx.get("provisional_diagnosis", {}).get("confidence", "high")
    if confidence == "low":
        triggers.append(
            "LOW DIAGNOSTIC CONFIDENCE: provisional diagnosis confidence is low — "
            "doctor review required before treatment"
        )

    # Determine final tier
    llm_tier     = triage_output.get("triage", {}).get("tier", "HIGH")
    overrode_llm = bool(triggers) and llm_tier == "LOW"
    final_tier   = "HIGH" if triggers else llm_tier

    if overrode_llm:
        print(f"[RULE ENGINE] Overriding LLM tier LOW → HIGH. Triggers: {triggers}")

    return {
        "final_risk_tier":  final_tier,
        "rules_triggered":  triggers,
        "overrode_llm":     overrode_llm,
        "override_reason":  "; ".join(triggers) if overrode_llm else None,
    }


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

async def run_management_agent(
    session_id: str,
    transcript_segment: str,   # phase 3 transcript (marker B → marker C)
    db_conn: asyncpg.Connection,
) -> dict:
    """
    Full Management Agent pipeline.
    Called by the session orchestrator when the nurse presses marker C.

    Flow:
      1. Load Vault + formulary
      2. Call 1 — extract clarifying findings              (~900ms)
         [parallel: RAG retrieval for top 1-2 diagnoses]
      3. Call 2 — provisional Dx + Rx draft               (~2.5s, streaming)
      4. Call 3 — five-dimension risk assessment           (~1.8s)
      5. Call 4 — triage + patient instructions + handoff  (~1.2s, streaming)
      6. Rule engine gate                                  (~0ms, deterministic)
      7. Write all outputs to Vault
    """
    import asyncio

    vault         = Vault(db_conn, session_id)
    vault_context = await vault.read()
    demographics  = vault_context.get("demographics", {})
    ddx           = vault_context.get("differential_table", [])
    formulary     = load_formulary()

    # Top 2 diagnoses for RAG retrieval
    top_diagnoses = [d["disease"] for d in ddx[:2]]

    # Call 1 + RAG in parallel
    print(f"[{session_id}] Call 1: extracting clarifying findings + RAG retrieval")
    call1_task = asyncio.create_task(
        extract_clarifying_findings(transcript_segment, vault_context)
    )
    rag_task = asyncio.create_task(
        retrieve_treatment_protocols(db_conn, top_diagnoses)
    )
    clarifying_findings, stg_context = await asyncio.gather(call1_task, rag_task)
    await vault.update({"clarifying_findings": clarifying_findings})

    # Call 2 — provisional diagnosis + prescription
    print(f"[{session_id}] Call 2: generating provisional diagnosis and prescription")
    provisional_dx = await generate_provisional_diagnosis_and_rx(
        clarifying_findings, vault_context, stg_context, formulary
    )
    await vault.update({"provisional_diagnosis": provisional_dx})

    # Call 3 — risk assessment
    print(f"[{session_id}] Call 3: five-dimension risk assessment")
    risk_assessment = await generate_risk_assessment(
        provisional_dx, clarifying_findings, vault_context
    )
    await vault.update({"risk_assessment": risk_assessment})

    # Call 4 — triage + handoff
    print(f"[{session_id}] Call 4: triage decision and doctor handoff")
    triage_output = await generate_triage_and_handoff(
        provisional_dx, risk_assessment, vault_context
    )

    # Rule engine gate
    print(f"[{session_id}] Rule engine: deterministic safety check")
    # Merge vitals from both phases. Phase 3 (clarifying findings) takes priority
    # on shared fields — measurements are more recent and more deliberate.
    vitals = {**vault_context.get("extracted_concepts", {}).get("vitals_reported", {})}
    for key, val in clarifying_findings.get("vitals_found", {}).items():
        if key not in ("rdt_result",) and val is not None:
            vitals[key] = val
    red_flags = vault_context.get("extracted_concepts", {}).get("red_flags", [])
    rule_result = run_rule_engine(
        provisional_dx, risk_assessment, triage_output, demographics,
        vitals=vitals, red_flags=red_flags,
    )

    # Merge rule engine tier into triage output
    triage_output["triage"]["tier"]          = rule_result["final_risk_tier"]
    triage_output["triage"]["rule_engine"]   = rule_result

    await vault.update({
        "triage_output":                   triage_output,
        "management_agent_status":         "complete",
        "management_agent_completed_at":   datetime.now().isoformat(),
        "risk_tier":                       rule_result["final_risk_tier"],
        "doctor_auth_status":              "pending",
    })

    print(f"[{session_id}] Management agent complete. "
          f"Risk tier: {rule_result['final_risk_tier']}")

    return {
        "session_id":         session_id,
        "clarifying_findings": clarifying_findings,
        "provisional_dx":     provisional_dx,
        "risk_assessment":    risk_assessment,
        "triage":             triage_output,
        "rule_engine":        rule_result,
    }


# ---------------------------------------------------------------------------
# FastAPI endpoints
# ---------------------------------------------------------------------------

app = FastAPI()


class ManagementRequest(BaseModel):
    session_id:         str
    transcript_segment: str


@app.post("/agent/management")
async def management_endpoint(req: ManagementRequest):
    """
    Non-streaming endpoint. Returns full structured result when complete.
    """
    conn = await asyncpg.connect(dsn="postgresql://localhost/cdst")
    try:
        return await run_management_agent(
            req.session_id, req.transcript_segment, conn
        )
    finally:
        await conn.close()


@app.post("/agent/management/stream")
async def management_stream_endpoint(req: ManagementRequest):
    """
    Streaming endpoint for Call 2 (provisional Dx) display.
    The nurse sees the diagnosis and prescription painting in real time
    while Calls 3 and 4 run in the background.
    """
    conn          = await asyncpg.connect(dsn="postgresql://localhost/cdst")
    vault_context = await Vault(conn, req.session_id).read()
    formulary     = load_formulary()
    ddx           = vault_context.get("differential_table", [])
    top_diagnoses = [d["disease"] for d in ddx[:2]]

    clarifying_findings = await extract_clarifying_findings(
        req.transcript_segment, vault_context
    )
    stg_context = await retrieve_treatment_protocols(conn, top_diagnoses)

    demographics  = vault_context.get("demographics", {})
    known_allergies = demographics.get("known_allergies", [])
    concepts      = vault_context.get("extracted_concepts", {})

    stream_prompt = (
        "Generate a provisional diagnosis and treatment plan for a nurse "
        "in rural West Bengal. Be clear and concise — the nurse is with a patient.\n\n"
        f"Patient: {json.dumps(demographics)}\n"
        f"Allergies: {json.dumps(known_allergies)}\n"
        f"Differential: {json.dumps(ddx[:3])}\n"
        f"Clarifying findings: {json.dumps(clarifying_findings)}\n"
        f"STG protocols:\n{stg_context[:2000] if stg_context else 'Not available'}\n"
        f"Formulary: {json.dumps(formulary)}\n\n"
        "Write: 1) Provisional diagnosis with brief rationale "
        "2) Prescription with doses 3) Key instructions for the nurse"
    )

    async def token_stream():
        with client.messages.stream(
            model=CLAUDE_MODEL,
            max_tokens=1500,
            messages=[{"role": "user", "content": stream_prompt}]
        ) as stream:
            for text in stream.text_stream:
                yield text
        await conn.close()

    return StreamingResponse(token_stream(), media_type="text/plain")
