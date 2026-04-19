"""
CDST Model Configuration
========================
Single place to assign LLM models to every call in the pipeline.
To change any model — including replacing deprecated versions — edit here only.

Tiers:
  TIER_FAST     — extraction and display streaming (low reasoning demand)
  TIER_STANDARD — gap analysis, risk assessment, questionnaire generation
  TIER_BEST     — DDx generation (D2) and prescription (M2) — patient-safety critical

NOTE: Update the model ID strings below to the actual Gemini 3 model IDs
once they are published. Current values are placeholders using Gemini 2.5.
"""

TIER_FAST     = "gemini-2.5-flash"
TIER_STANDARD = "gemini-2.5-pro"
TIER_BEST     = "gemini-2.5-pro"    # update to Gemini 3.1 pro

# ── History Stage ────────────────────────────────────────────────────────────
MODEL_H1_CHIEF_COMPLAINT = TIER_FAST       # extract_chief_complaint — simple extraction
MODEL_H2_QUESTIONNAIRE   = TIER_STANDARD   # generate_questionnaire + stream_questionnaire

# ── Diagnosis Stage ──────────────────────────────────────────────────────────
MODEL_D1_CONCEPTS        = TIER_FAST       # extract_medical_concepts — structured extraction
MODEL_D2_DIFFERENTIAL    = TIER_BEST       # generate_differential + stream_differential — safety-critical
MODEL_D3_CLARIFYING      = TIER_STANDARD   # generate_clarifying_questions

# ── Management Stage ─────────────────────────────────────────────────────────
MODEL_M1_FINDINGS        = TIER_FAST       # extract_clarifying_findings — extraction only
MODEL_M2_PRESCRIPTION    = TIER_BEST       # generate_provisional_diagnosis_and_rx — safety-critical RAG call
MODEL_M3_RISK            = TIER_STANDARD   # generate_risk_assessment — five-dimension reasoning
MODEL_M4_TRIAGE          = TIER_FAST       # generate_triage_and_handoff + stream_management — summarisation
