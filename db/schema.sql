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
--   "demographics": {
--     "patient_id": "P-00123",
--     "age": 34,
--     "sex": "F",
--     "pregnancy_status": "not pregnant",
--     "known_conditions": ["iron deficiency anaemia"],
--     "known_allergies": ["penicillin"]
--   },
--   "gps": {
--     "district": "Murshidabad",
--     "district_code": "WB_MSD",
--     "lat": 24.18,
--     "lng": 88.27,
--     "timestamp": "2024-09-14T10:23:00Z"
--   },
--   "prior_encounters": [
--     {
--       "date": "2024-03-02",
--       "provisional_diagnosis": "Plasmodium vivax malaria",
--       "confirmed": true,
--       "confirmation_method": ["RDT positive", "treatment response"],
--       "treatment": "Chloroquine + Primaquine",
--       "outcome": "resolved"
--     }
--   ],
--
--   -- TRANSCRIPT (written continuously during session by STT service)
--   "transcript_full": "Nurse: Good morning. Can you tell me what brings you in today? Patient: I have had fever for five days...",
--   "transcript_segments": {
--     "phase_1": "transcript text from session start to marker A",
--     "phase_2": "transcript text from marker A to marker B",
--     "phase_3": "transcript text from marker B to marker C"
--   },
--
--   -- SESSION TIMELINE (session-relative timestamps in seconds)
--   "session_started_at": "2024-09-14T10:23:00Z",
--   "marker_a_at": 94.3,     -- nurse pressed button after initial complaint
--   "marker_b_at": 312.7,    -- nurse pressed button after structured interview
--   "marker_c_at": 498.1,    -- nurse pressed button after clarifying questions
--   "session_ended_at": "2024-09-14T10:35:22Z",
--   "session_duration_seconds": 742,
--
--   -- AUDIO (written asynchronously after session close — does not block nurse UX)
--   "audio": {
--     "url": "s3://cdst-media/sessions/sess_abc123/audio.opus",
--     "codec": "opus",
--     "sample_rate_hz": 16000,
--     "channels": 1,
--     "duration_seconds": 742,
--     "size_bytes": 1893422,
--     "upload_status": "complete|pending|failed",
--     "uploaded_at": "2024-09-14T10:36:05Z",
--     "retain_until": "2025-01-14",
--     "retention_days": 3650
--   },
--
--   -- AGENT OUTPUTS
--   "extracted_concepts": { ... },          -- written by diagnosis agent step 1
--   "differential_table": [ ... ],          -- written by diagnosis agent step 3
--   "clarifying_questions": { ... },        -- written by diagnosis agent step 4
--   "diagnosis_agent_status": "complete",
--   "management_output": { ... },           -- written by management agent
--
--   -- RISK AND AUTHORIZATION
--   "risk_tier": "low|high",               -- written by rule engine
--   "risk_flags": ["drug: injectable artesunate", "patient: infant under 2 months"],
--   "doctor_auth_status": "pending|approved|modified|rejected",
--   "doctor_auth_at": "2024-09-14T14:10:00Z",
--   "doctor_notes": "Approved. Confirm weight-based dosing.",
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
