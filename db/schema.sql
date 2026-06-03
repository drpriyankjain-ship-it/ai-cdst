-- ============================================================
-- Vault session store
-- ============================================================
CREATE TABLE sessions (
    session_id      TEXT PRIMARY KEY,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),
    data            JSONB NOT NULL DEFAULT '{}'
);

-- Example session document structure (data column):
-- {
--   "patient_id": "P-00123",
--   "nurse_id": "N-001",
--   "demographics": {
--     "patient_id": "P-00123",
--     "age": 34,
--     "sex": "F",
--     "pregnancy_status": "not pregnant",   -- written by D1 if detected
--     "lmp": "2024-06-01",                  -- written by D1 if detected
--     "known_conditions": ["iron deficiency anaemia"],
--     "known_allergies": ["penicillin"]
--   },
--   "gps": {
--     "district": "Murshidabad",
--     "district_code": "WB_MSD",
--     "lat": 24.18,
--     "lng": 88.27
--   },
--   "patient_record": { ... },              -- full patient_records summary at session start
--
--   -- TRANSCRIPTS (written by Gemini H1/D1/M1 — one field per phase)
--   "transcript_segments": {
--     "phase_1": "verbatim transcript of phase 1 audio, returned by H1",
--     "phase_2": "verbatim transcript of phase 2 audio, returned by D1",
--     "phase_3": "verbatim transcript of phase 3 audio, returned by M1"
--   },
--
--   -- SESSION TIMELINE
--   "session_started_at": "2024-09-14T10:23:00Z",
--   "marker_a_at": 94.3,                   -- session-relative seconds
--   "marker_b_at": 312.7,
--   "marker_c_at": 498.1,
--   "session_ended_at": "2024-09-14T10:35:22Z",
--   "session_duration_seconds": 742,
--
--   -- AUDIO (written async after session close — does not block nurse UX)
--   -- App records 12s m4a segments; server buffers them and ffmpeg-concatenates
--   -- per phase before uploading to object storage.
--   "audio": {
--     "phase_1_url": "s3://cdst-media/sessions/sess_abc123/phase1.m4a",
--     "phase_2_url": "s3://cdst-media/sessions/sess_abc123/phase2.m4a",
--     "phase_3_url": "s3://cdst-media/sessions/sess_abc123/phase3.m4a",
--     "upload_status": "complete|pending|failed",
--     "archived_at": "2024-09-14T10:36:05Z",
--     "retain_until": "2034-09-14",
--     "retention_days": 3650
--   },
--
--   -- HISTORY STAGE OUTPUTS (written at Marker A)
--   "chief_complaint": { ... },             -- H1
--   "questionnaire": { ... },               -- H2
--   "patient_record_stub": { ... },         -- H2 — structured update for patient_records
--   "history_stage_status": "complete|generic_fallback",
--   "history_stage_completed_at": "2024-09-14T10:25:10Z",
--
--   -- DIAGNOSIS STAGE OUTPUTS (written at Marker B)
--   "extracted_concepts": { ... },          -- D1
--   "differential_table": [ ... ],          -- D2
--   "clarifying_questions": { ... },        -- D3
--   "diagnosis_stage_status": "complete",
--   "diagnosis_stage_completed_at": "2024-09-14T10:30:45Z",
--
--   -- MANAGEMENT STAGE OUTPUTS (written at Marker C)
--   "clarifying_findings": { ... },         -- M1: answers to clarifying questions + bedside exam findings + vitals
--   "problem_list": { ... },                -- M2: all clinical problems with assessment and plan per problem.
--                                           --     prescription is nested here: problem_list[N].plan.prescription[]
--                                           --     each prescription item carries drug/dose/route/frequency/duration/stg_source/for_problem
--   "risk_assessment": { ... },             -- M3: rich 5-dimension clinical narrative (diagnostic uncertainty,
--                                           --     iatrogenic risk, delay risk, complication watch, mitigation plan).
--                                           --     this is the reasoning document — it goes to the doctor review queue.
--                                           --     it also contains the LLM's own overall_risk_tier proposal (LOW|HIGH).
--   "triage_output": { ... },              -- M4 + rule engine. contains three sub-documents:
--                                           --   triage: referral assessment + tier/action/rationale (tier injected by rule engine)
--                                           --   patient_instructions: plain-language diagnosis, treatment summary, do/don't lists
--                                           --   doctor_handoff: one_liner, clinical_summary, key_risks, questions,
--                                           --                   prescription_issued (deterministic text built from problem_list, not LLM-generated)
--
--   -- RISK AND AUTHORIZATION
--   -- risk_tier is the final binary verdict (LOW|HIGH). it starts from risk_assessment.mitigation_plan.overall_risk_tier
--   -- (LLM proposal) and is passed through the deterministic rule engine which checks vital derangements, red flag
--   -- symptoms, diagnosis hard stops, injectable drugs, patient age, pregnancy + sensitive dx/drug, allergy conflicts,
--   -- and low diagnostic confidence. the rule engine can only escalate LOW→HIGH, never downgrade. this is the field
--   -- the nurse acts on — it determines whether she proceeds with treatment or calls the doctor immediately.
--   "risk_tier": "LOW|HIGH",               -- written by rule engine after M3+M4 complete
--   "doctor_auth_status": "pending|approved|modified|rejected",
--   "doctor_auth_at": "2024-09-14T14:10:00Z",
--   "doctor_notes": "Approved. Confirm weight-based dosing.",
--
--   -- PHOTOS (written async at session end alongside audio — same pattern)
--   -- During the session, photos are buffered in server RAM (phasePhotoBuffers in SessionState).
--   -- At session end, each photo is uploaded to Supabase Storage and its URL recorded here.
--   -- Photos are compressed + resized to max 1280px on the mobile before upload.
--   "session_photos": {
--     "phase_1": [ { "mimeType": "image/jpeg", "url": "https://.../phase1_0.jpg" } ],
--     "phase_2": [ ... ]
--   },
--
--   -- CONFIRMATION GATES (for Layer 3 epidemiological data eligibility)
--   "confirmation": {
--     "rdt_result": "positive_pf",          -- null until test result received
--     "rdt_recorded_at": "2024-09-14T10:45:00Z",
--     "treatment_response": "resolved",     -- null until follow-up recorded
--     "follow_up_recorded_at": "2024-09-28T09:15:00Z",
--     "doctor_agreed": true,
--     "confidence_weight": 1.0,             -- 0.5 = weak, 1.0 = all gates passed
--     "committed_to_layer3": true,
--     "committed_at": "2024-09-28T09:20:00Z"
--   }
-- }


-- ============================================================
-- STG chunks — pgvector store for RAG
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE stg_chunks (
    chunk_id        SERIAL PRIMARY KEY,
    source          TEXT NOT NULL,          -- e.g. "NHM_STG_2023_malaria"
    disease         TEXT,                   -- inferred from chunk text; null for generic/front-matter chunks
    section         TEXT,                   -- treatment | dosing | contraindications | referral | diagnosis | complications | general
    content         TEXT NOT NULL,
    content_hash    TEXT NOT NULL,          -- md5(source + content), used to skip exact duplicates
    embedding       vector(384),            -- MiniLM-L6-v2 dimension
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON stg_chunks USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- Filter index for disease-scoped retrieval
CREATE INDEX ON stg_chunks (disease);
CREATE INDEX ON stg_chunks (section);
CREATE UNIQUE INDEX stg_chunks_source_content_hash_idx ON stg_chunks (source, content_hash);


-- ============================================================
-- updated_at triggers
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_updated_at
    BEFORE UPDATE ON sessions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER patient_records_updated_at
    BEFORE UPDATE ON patient_records
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- Audio retention cleanup
-- A scheduled job (cron or pg_cron) runs this daily to identify
-- sessions whose audio retention window has expired.
-- The job deletes from object storage then nulls the audio URL.
-- ============================================================
CREATE INDEX ON sessions
    ((data->'audio'->>'retain_until'))
    WHERE data ? 'audio';

-- Convenience: find all sessions with audio expiring today or earlier
-- SELECT session_id, data->'audio'->>'url', data->'audio'->>'retain_until'
-- FROM sessions
-- WHERE (data->'audio'->>'retain_until')::date <= CURRENT_DATE
--   AND data->'audio'->>'upload_status' = 'complete';


-- ============================================================
-- Patient records — compact forward-facing summary
-- Written after confirmation gates pass, not at session close.
-- This is what the History Agent reads at the next encounter.
-- ============================================================
CREATE TABLE patient_records (
    patient_id          TEXT PRIMARY KEY,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now(),
    summary             JSONB NOT NULL DEFAULT '{}'
);

-- Example patient_records summary document:
-- {
--   "patient_id": "P-00123",
--   "demographics": {
--     "name": "...",
--     "dob": "1990-05-12",
--     "sex": "F",
--     "village": "Beldanga",
--     "district": "Murshidabad"
--   },
--   "known_conditions": ["iron deficiency anaemia"],
--   "known_allergies": ["penicillin"],
--   "current_medications": [],
--   "encounters": [
--     {
--       "date": "2024-09-14",
--       "session_id": "sess_abc123",        -- back-reference to full session
--       "chief_complaint": "Fever 5 days, headache, chills",
--       "confirmed_diagnosis": "Plasmodium falciparum malaria",
--       "treatment": "Artemether-lumefantrine 6-dose",
--       "outcome": "resolved at follow-up 2024-09-28",
--       "doctor_approved": true
--     }
--   ],
--   "significant_history": [
--     "P. falciparum malaria Sep 2024 — treated and resolved"
--   ],
--   "last_updated": "2024-09-28T09:20:00Z"
-- }

-- Index for fast patient lookup on next encounter
CREATE INDEX ON patient_records (patient_id);


-- ============================================================
-- Layer 3 — confirmed encounter epidemiology
-- (written only after multi-gate confirmation)
-- ============================================================
CREATE TABLE confirmed_encounters (
    encounter_id        SERIAL PRIMARY KEY,
    session_id          TEXT REFERENCES sessions(session_id),
    district_code       TEXT NOT NULL,
    month               INT NOT NULL,       -- 1-12
    disease             TEXT NOT NULL,
    confirmation_gates  JSONB NOT NULL,     -- which gates passed
    confidence_weight   FLOAT NOT NULL,     -- 0.5 (treatment response only) to 1.0 (all gates)
    recorded_at         TIMESTAMPTZ DEFAULT now()
);

-- Query to build Layer 3 prior for a district/month:
-- SELECT disease,
--        SUM(confidence_weight) AS weighted_count,
--        COUNT(*) AS raw_count
-- FROM confirmed_encounters
-- WHERE district_code = $1 AND month = $2
-- GROUP BY disease
-- ORDER BY weighted_count DESC;


-- ============================================================
-- Clinics / facilities
-- One row per physical facility. Drives formulary selection,
-- epi prior lookup, and HIGH risk doctor routing.
-- ============================================================
CREATE TABLE clinics (
    clinic_id       TEXT PRIMARY KEY,           -- e.g. "C-042"
    name            TEXT NOT NULL,
    facility_type   TEXT NOT NULL CHECK (facility_type IN ('SHC', 'HWC', 'PHC', 'CHC')),
    district_code   TEXT NOT NULL,              -- must match keys in epi_prior_*.json
    district        TEXT NOT NULL,              -- human-readable district name
    state_code      TEXT NOT NULL,              -- e.g. 'WB', 'MH' — selects epi prior file
    formulary_file  TEXT NOT NULL,              -- filename in data/ e.g. 'formulary_wb_shc.json'
    lat             NUMERIC(9,6),
    lng             NUMERIC(9,6),
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON clinics (district_code);
CREATE INDEX ON clinics (state_code);

CREATE TRIGGER clinics_updated_at
    BEFORE UPDATE ON clinics
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- Users — nurses, doctors, admins
-- Single table; role discriminates behaviour.
-- Auth is owned here (password_hash). To migrate to Firebase Auth
-- later: add firebase_uid TEXT UNIQUE, drop password_hash, swap
-- the login endpoint. Nothing else in the system changes.
-- ============================================================
CREATE TABLE users (
    user_id         TEXT PRIMARY KEY,           -- e.g. "N-001", "D-007"
    role            TEXT NOT NULL CHECK (role IN ('nurse', 'doctor', 'admin')),
    name            TEXT NOT NULL,
    phone           TEXT,                       -- required for nurses and doctors; optional for admins
    CONSTRAINT phone_required_for_clinical_roles CHECK (role = 'admin' OR phone IS NOT NULL),
    email           TEXT UNIQUE,
    password_hash   TEXT NOT NULL,              -- bcrypt; replace with firebase_uid to migrate auth
    clinic_id       TEXT REFERENCES clinics(clinic_id),  -- nurses: home clinic; null for doctors/admins
    fcm_token       TEXT,                       -- updated by device on each login
    language_pref   TEXT NOT NULL DEFAULT 'en', -- output language for stage responses (e.g. 'en', 'bn')
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON users (clinic_id);
CREATE INDEX ON users (role);

CREATE TRIGGER users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- Doctor–clinic assignments
-- One doctor may cover multiple clinics (common in rural settings
-- where one MO covers several SHCs). Used by the orchestrator to
-- route HIGH risk notifications to the right doctor.
-- ============================================================
CREATE TABLE doctor_clinic_assignments (
    doctor_id       TEXT NOT NULL REFERENCES users(user_id),
    clinic_id       TEXT NOT NULL REFERENCES clinics(clinic_id),
    PRIMARY KEY (doctor_id, clinic_id)
);


-- ============================================================
-- LLM Results — per-call output and operational metadata
-- One row per LLM call. 9 rows per completed session (H1-H2,
-- D1-D3, M1-M4). Source of truth for cost and latency tracking.
-- session_metrics aggregates from this table.
-- ============================================================
CREATE TABLE llm_results (
    id            SERIAL PRIMARY KEY,
    session_id    TEXT NOT NULL REFERENCES sessions(session_id),
    call_name     TEXT NOT NULL,        -- e.g. 'H1_chief_complaint', 'D2_differential'
    stage         TEXT NOT NULL,        -- 'history' | 'diagnosis' | 'management'
    call_order    INT NOT NULL,         -- 1-9, global order across all stages
    model_used    TEXT,
    input_tokens  INT,
    output_tokens INT,
    latency_ms    INT,
    cost_usd      NUMERIC(10,6),
    result        JSONB NOT NULL DEFAULT '{}',
    error         TEXT,
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON llm_results (session_id);
CREATE INDEX ON llm_results (call_name);
CREATE INDEX ON llm_results (model_used);


-- ============================================================
-- Pipeline Failures — durable error log
-- Written on any stage exception. Console logs are ephemeral;
-- this table survives server restarts and enables failure rate
-- monitoring by stage, call, and error type.
-- ============================================================
CREATE TABLE pipeline_failures (
    id          SERIAL PRIMARY KEY,
    session_id  TEXT REFERENCES sessions(session_id),
    user_id     TEXT,
    stage       TEXT,                   -- 'history' | 'diagnosis' | 'management'
    call_name   TEXT,
    error_code  TEXT,                   -- 'LLM_503' | 'LLM_429' | 'PARSE_ERROR' | 'ENOENT' | 'UNKNOWN'
    error_msg   TEXT,
    created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON pipeline_failures (session_id);
CREATE INDEX ON pipeline_failures (created_at);
CREATE INDEX ON pipeline_failures (user_id);


-- ============================================================
-- Session Metrics — per-session aggregate
-- Written once after Marker C. Denormalized from llm_results
-- for fast analytics dashboard queries. ON CONFLICT upsert
-- allows the orchestrator to rewrite it if Marker C retries.
-- ============================================================
CREATE TABLE session_metrics (
    session_id               TEXT PRIMARY KEY REFERENCES sessions(session_id),
    user_id                  TEXT,
    patient_id               TEXT,
    total_llm_calls          INT,
    total_input_tokens       INT,
    total_output_tokens      INT,
    total_cost_usd           NUMERIC(10,6),
    total_latency_ms         INT,
    e2e_duration_ms          INT,
    gps_lat                  NUMERIC(9,6),
    gps_lon                  NUMERIC(9,6),
    district_code            TEXT,
    risk_tier                TEXT,
    pipeline_status          TEXT,      -- 'complete' | 'partial' | 'failed'
    network_rtt_ms           INT,
    total_transcription_ms   INT,
    total_server_overhead_ms INT,
    phase_timings            JSONB,
    created_at               TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON session_metrics (user_id);
CREATE INDEX ON session_metrics (created_at);
CREATE INDEX ON session_metrics (risk_tier);


-- ============================================================
-- Case Queue — nurse dashboard workflow state
-- One row per completed session (written at Marker C).
-- Tracks only dashboard status; all clinical data is in the
-- vault (sessions.data). Dashboard joins with sessions to read
-- patient ID, triage output, etc.
-- ============================================================
CREATE TABLE case_queue (
    session_id  TEXT PRIMARY KEY REFERENCES sessions(session_id),
    risk_tier   TEXT NOT NULL,                   -- 'LOW' | 'HIGH'
    status      TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'cleared'
    cleared_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON case_queue (status, created_at);
CREATE INDEX ON case_queue (risk_tier);
