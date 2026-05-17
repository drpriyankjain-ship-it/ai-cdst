-- =============================================
-- patient_log — Structured clinical output log
-- Links patient_id + session_id to the proforma,
-- clarifying questions, and management plan as
-- distinct columns.
-- Run after schema.sql and schema_mobile.sql.
-- =============================================

CREATE TABLE IF NOT EXISTS patient_log (
    id                    SERIAL PRIMARY KEY,
    patient_id            TEXT NOT NULL,
    session_id            TEXT,                       -- references sessions(session_id) when from live consultation
    audio_record_id       TEXT,                       -- references audio_records(id) when from RecordPage flow
    source                TEXT NOT NULL DEFAULT 'live',  -- 'live' (WebSocket pipeline) or 'upload' (RecordPage audio upload)
    proforma              JSONB,                      -- questionnaire / case proforma output
    clarifying_questions  JSONB,                      -- clarifying questions from diagnosis stage
    management_plan       JSONB,                      -- full management plan (problem_list, triage, risk_assessment)
    status                TEXT NOT NULL DEFAULT 'active',  -- 'active' (on dashboard) or 'cleared' (moved to history)
    created_at            TIMESTAMPTZ DEFAULT NOW(),
    updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_patient_log_patient ON patient_log(patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_log_session ON patient_log(session_id);
CREATE INDEX IF NOT EXISTS idx_patient_log_audio_record ON patient_log(audio_record_id);
CREATE INDEX IF NOT EXISTS idx_patient_log_status ON patient_log(status);
CREATE INDEX IF NOT EXISTS idx_patient_log_source ON patient_log(source);

-- Trigger for updated_at
CREATE TRIGGER patient_log_updated_at
    BEFORE UPDATE ON patient_log
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
