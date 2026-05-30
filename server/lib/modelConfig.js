/**
 * CDST — Model Configuration
 * ===========================
 * Single place to assign LLM models to every call in the pipeline.
 * Direct port of model_config.py
 */

export const TIER_FAST              = ['gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.5-flash'];
export const TIER_STANDARD          = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.0-flash'];
export const TIER_STANDARD_CRITICAL = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'];

// ── History Stage ────────────────────────────────────────────────────────────
export const MODEL_H1_CHIEF_COMPLAINT = TIER_FAST;       // extract_chief_complaint — extraction only
export const MODEL_H2_QUESTIONNAIRE   = TIER_STANDARD;   // generate_questionnaire — visit-type inference

// ── Diagnosis Stage ──────────────────────────────────────────────────────────
export const MODEL_D1_CONCEPTS        = TIER_FAST;                // extract_medical_concepts — extraction
export const MODEL_D2_DIFFERENTIAL    = TIER_STANDARD_CRITICAL;   // generate_differential — ranked reasoning
export const MODEL_D3_CLARIFYING      = TIER_STANDARD;            // generate_clarifying_questions

// ── Management Stage ─────────────────────────────────────────────────────────
export const MODEL_M1_FINDINGS        = TIER_FAST;                // extract_clarifying_findings
export const MODEL_M2_PRESCRIPTION    = TIER_STANDARD_CRITICAL;   // generate_provisional_diagnosis_and_rx
export const MODEL_M3_RISK            = TIER_STANDARD;            // generate_risk_assessment
export const MODEL_M4_TRIAGE          = TIER_FAST;                // generate_triage_and_handoff
