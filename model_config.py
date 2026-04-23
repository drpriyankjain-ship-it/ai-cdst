"""
CDST Model Configuration
========================
Single place to assign LLM models to every call in the pipeline.
To change any model — including replacing deprecated versions — edit here only.

Each constant is passed directly to generate_with_cascade / stream_with_cascade
in llm_client.py, which tries models left-to-right on 503/404/429.

Tiers:
  TIER_FAST     — simple extraction, no complex reasoning (flash-lite)
  TIER_STANDARD — complex reasoning, latency-sensitive (flash)

Both tiers use Gemini 3.x as preferred with 2.5 as fallback.
Pro models are excluded — their thinking overhead is prohibitive for real-time use.
"""

TIER_FAST     = ["gemini-3.1-flash-lite-preview", "gemini-2.5-flash-lite"]
TIER_STANDARD = ["gemini-3-flash-preview", "gemini-2.5-flash"]
TIER_STANDARD_CRITICAL = ["gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash"]

# ── History Stage ────────────────────────────────────────────────────────────
MODEL_H1_CHIEF_COMPLAINT = TIER_FAST       # extract_chief_complaint — extraction only
MODEL_H2_QUESTIONNAIRE   = TIER_STANDARD   # generate_questionnaire — visit-type inference, SOCRATES, tailored intake

# ── Diagnosis Stage ──────────────────────────────────────────────────────────
MODEL_D1_CONCEPTS        = TIER_FAST       # extract_medical_concepts — extraction (uncertain_findings nuanced but bounded)
MODEL_D2_DIFFERENTIAL    = TIER_STANDARD_CRITICAL   # generate_differential — ranked clinical reasoning, epi priors
MODEL_D3_CLARIFYING      = TIER_STANDARD   # generate_clarifying_questions — DDx discrimination reasoning

# ── Management Stage ─────────────────────────────────────────────────────────
MODEL_M1_FINDINGS        = TIER_FAST       # extract_clarifying_findings — extraction only
MODEL_M2_PRESCRIPTION    = TIER_STANDARD_CRITICAL   # generate_provisional_diagnosis_and_rx — formulary-constrained multi-problem
MODEL_M3_RISK            = TIER_STANDARD   # generate_risk_assessment — five reasoning chains, drives triage tier
MODEL_M4_TRIAGE          = TIER_FAST       # generate_triage_and_handoff — synthesis/formatting of upstream outputs
