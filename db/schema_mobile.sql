-- =============================================
-- Additional tables for the mobile app REST API
-- Run after the existing db/schema.sql
-- =============================================

-- Users table for auth
CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    email           TEXT UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    phone           TEXT,
    role            TEXT DEFAULT 'nurse',
    otp_code        TEXT,
    otp_expires_at  TIMESTAMPTZ,
    verified        BOOLEAN DEFAULT FALSE,
    consent_given   BOOLEAN DEFAULT FALSE,
    consent_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Audio records table
CREATE TABLE IF NOT EXISTS audio_records (
    id              TEXT PRIMARY KEY,
    user_id         INTEGER REFERENCES users(id),
    patient_name    TEXT,
    patient_id      TEXT,
    file_path       TEXT,
    transcript      TEXT,
    ai_suggestion   JSONB,
    status          TEXT DEFAULT 'pending',
    flag_reason     TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audio_records_user ON audio_records(user_id);
CREATE INDEX IF NOT EXISTS idx_audio_records_status ON audio_records(status);

-- Patient log — structured clinical output log
-- Links patient_id + session_id to proforma, clarifying questions, and management plan
CREATE TABLE IF NOT EXISTS patient_log (
    id                    SERIAL PRIMARY KEY,
    patient_id            TEXT NOT NULL,
    session_id            TEXT,
    audio_record_id       TEXT,
    source                TEXT NOT NULL DEFAULT 'live',
    proforma              JSONB,
    clarifying_questions  JSONB,
    management_plan       JSONB,
    status                TEXT NOT NULL DEFAULT 'active',
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_patient_log_patient ON patient_log(patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_log_session ON patient_log(session_id);
CREATE INDEX IF NOT EXISTS idx_patient_log_audio_record ON patient_log(audio_record_id);
CREATE INDEX IF NOT EXISTS idx_patient_log_status ON patient_log(status);

