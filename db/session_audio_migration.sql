-- =============================================
-- session_audio — Per-iteration audio storage
-- =============================================
-- Each clinical session has 3 audio iterations:
--   iteration 1: Initial patient description (before proforma generation)
--   iteration 2: Answers to proforma questions
--   iteration 3: Answers to clarifying questions
-- Together, iterations 1-3 form one complete consultation audio set.
-- Run after schema.sql and schema_mobile.sql.
-- =============================================

CREATE TABLE IF NOT EXISTS session_audio (
    id                  SERIAL PRIMARY KEY,
    session_id          TEXT NOT NULL,               -- FK to sessions(session_id)
    iteration           INTEGER NOT NULL CHECK (iteration IN (1, 2, 3)),
    label               TEXT NOT NULL,               -- human-readable: 'Initial Description', 'Proforma Answers', 'Clarifying Answers'
    file_path           TEXT,                        -- local/cloud path to stored audio file
    file_size_bytes     INTEGER,                     -- size of the audio file
    mime_type           TEXT,                        -- e.g. 'audio/mp4', 'audio/m4a', 'audio/wav'
    duration_seconds    NUMERIC(10,2),               -- duration of the audio clip
    transcript          TEXT,                        -- transcription text (from Gemini/Deepgram)
    transcript_engine   TEXT DEFAULT 'gemini',        -- 'gemini', 'deepgram', etc.
    upload_status       TEXT NOT NULL DEFAULT 'pending'  CHECK (upload_status IN ('pending', 'uploaded', 'transcribed', 'failed')),
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),

    -- Foreign key to sessions table
    CONSTRAINT fk_session_audio_session
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
        ON DELETE CASCADE,

    -- Each session can only have one audio per iteration
    CONSTRAINT uq_session_iteration UNIQUE (session_id, iteration)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_session_audio_session ON session_audio(session_id);
CREATE INDEX IF NOT EXISTS idx_session_audio_iteration ON session_audio(session_id, iteration);
CREATE INDEX IF NOT EXISTS idx_session_audio_status ON session_audio(upload_status);

-- Trigger for updated_at
CREATE TRIGGER session_audio_updated_at
    BEFORE UPDATE ON session_audio
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================
-- Convenience view: full audio set per session
-- Returns one row per session with all 3 iterations side by side
-- =============================================
CREATE OR REPLACE VIEW session_audio_summary AS
SELECT
    s.session_id,
    s.created_at AS session_created_at,
    -- Iteration 1: Initial description (before proforma)
    a1.id              AS iter1_id,
    a1.file_path       AS iter1_file_path,
    a1.transcript      AS iter1_transcript,
    a1.duration_seconds AS iter1_duration,
    a1.upload_status   AS iter1_status,
    -- Iteration 2: Proforma answers
    a2.id              AS iter2_id,
    a2.file_path       AS iter2_file_path,
    a2.transcript      AS iter2_transcript,
    a2.duration_seconds AS iter2_duration,
    a2.upload_status   AS iter2_status,
    -- Iteration 3: Clarifying answers
    a3.id              AS iter3_id,
    a3.file_path       AS iter3_file_path,
    a3.transcript      AS iter3_transcript,
    a3.duration_seconds AS iter3_duration,
    a3.upload_status   AS iter3_status,
    -- Aggregates
    COALESCE(a1.duration_seconds, 0) + COALESCE(a2.duration_seconds, 0) + COALESCE(a3.duration_seconds, 0) AS total_duration_seconds,
    (a1.id IS NOT NULL AND a2.id IS NOT NULL AND a3.id IS NOT NULL) AS is_complete
FROM sessions s
LEFT JOIN session_audio a1 ON a1.session_id = s.session_id AND a1.iteration = 1
LEFT JOIN session_audio a2 ON a2.session_id = s.session_id AND a2.iteration = 2
LEFT JOIN session_audio a3 ON a3.session_id = s.session_id AND a3.iteration = 3;

-- =============================================
-- Also add session_id FK to patient_log if missing
-- (patient_log.session_id should reference sessions)
-- =============================================
-- Note: patient_log already has session_id TEXT column.
-- If your DB doesn't yet have the FK constraint, uncomment:
-- ALTER TABLE patient_log
--     ADD CONSTRAINT fk_patient_log_session
--     FOREIGN KEY (session_id) REFERENCES sessions(session_id)
--     ON DELETE SET NULL;
