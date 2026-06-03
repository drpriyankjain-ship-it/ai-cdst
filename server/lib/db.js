/**
 * CDST — Database connection pool
 * ================================
 * Shared PostgreSQL pool with pgvector support.
 * Imported by all modules that need DB access.
 */

import pg from 'pg';
import pgvector from 'pgvector/pg';

const { Pool } = pg;

let pool = null;

export async function initPool() {
  if (pool) return pool;
  pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Register pgvector types on every new connection
  pool.on('connect', async (client) => {
    await pgvector.registerTypes(client);
  });

  // Test connection
  const client = await pool.connect();
  await pgvector.registerTypes(client);
  client.release();
  console.log('[DB] Pool initialised —', process.env.DATABASE_URL);
  return pool;
}

export function getPool() {
  if (!pool) throw new Error('Database pool not initialised — call initPool() first');
  return pool;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('[DB] Pool closed');
  }
}

// ---------------------------------------------------------------------------
// Vault helpers — session JSONB CRUD
// ---------------------------------------------------------------------------

export async function vaultInit(client, sessionId, patientId, nurseId, gps, patientRecord) {
  const demographics = { ...(patientRecord.demographics || {}), patient_id: patientId };
  const document = {
    patient_id: patientId,
    nurse_id: nurseId,
    demographics,
    gps,
    patient_record: patientRecord,
    session_started_at: new Date().toISOString(),
    transcript_segments: { phase_1: '', phase_2: '', phase_3: '' },
    audio: { upload_status: 'pending', retain_until: null },
    risk_tier: null,
    doctor_auth_status: 'pending',
  };
  await client.query(
    'INSERT INTO sessions (session_id, data) VALUES ($1, $2::jsonb)',
    [sessionId, JSON.stringify(document)]
  );
}

export async function vaultRead(client, sessionId) {
  const res = await client.query(
    'SELECT data FROM sessions WHERE session_id = $1',
    [sessionId]
  );
  if (res.rows.length === 0) throw new Error(`Session ${sessionId} not found in Vault`);
  return typeof res.rows[0].data === 'string' ? JSON.parse(res.rows[0].data) : res.rows[0].data;
}

export async function vaultUpdate(client, sessionId, patch) {
  await client.query(
    `UPDATE sessions SET data = data || $2::jsonb, updated_at = now() WHERE session_id = $1`,
    [sessionId, JSON.stringify(patch)]
  );
}

export async function vaultSetNested(client, sessionId, path, value) {
  const pathArray = `{${path.join(',')}}`;
  await client.query(
    `UPDATE sessions SET data = jsonb_set(data, $2::text[], $3::jsonb, true), updated_at = now() WHERE session_id = $1`,
    [sessionId, pathArray, JSON.stringify(value)]
  );
}


export async function loadPatientRecord(client, patientId) {
  const res = await client.query(
    'SELECT summary FROM patient_records WHERE patient_id = $1',
    [patientId]
  );
  if (res.rows.length === 0) return {};
  const summary = res.rows[0].summary;
  return typeof summary === 'string' ? JSON.parse(summary) : summary;
}

// ---------------------------------------------------------------------------
// Session Audio helpers — per-iteration audio CRUD
// ---------------------------------------------------------------------------

const ITERATION_LABELS = {
  1: 'Initial Description',
  2: 'Proforma Answers',
  3: 'Clarifying Answers',
};

/**
 * Upsert a session audio record (insert or update on conflict).
 * @param {object} client - pg pool/client
 * @param {string} sessionId
 * @param {number} iteration - 1, 2, or 3
 * @param {object} data - { file_path, file_size_bytes, mime_type, duration_seconds, transcript, transcript_engine, upload_status }
 */
export async function upsertSessionAudio(client, sessionId, iteration, data) {
  if (![1, 2, 3].includes(iteration)) throw new Error(`Invalid iteration: ${iteration}`);
  const label = ITERATION_LABELS[iteration];

  const res = await client.query(
    `INSERT INTO session_audio
       (session_id, iteration, label, file_path, file_size_bytes, mime_type, duration_seconds, transcript, transcript_engine, upload_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (session_id, iteration)
     DO UPDATE SET
       file_path        = COALESCE(EXCLUDED.file_path,        session_audio.file_path),
       file_size_bytes  = COALESCE(EXCLUDED.file_size_bytes,  session_audio.file_size_bytes),
       mime_type        = COALESCE(EXCLUDED.mime_type,         session_audio.mime_type),
       duration_seconds = COALESCE(EXCLUDED.duration_seconds,  session_audio.duration_seconds),
       transcript       = COALESCE(EXCLUDED.transcript,        session_audio.transcript),
       transcript_engine= COALESCE(EXCLUDED.transcript_engine, session_audio.transcript_engine),
       upload_status    = COALESCE(EXCLUDED.upload_status,     session_audio.upload_status),
       updated_at       = NOW()
     RETURNING *`,
    [
      sessionId,
      iteration,
      label,
      data.file_path || null,
      data.file_size_bytes || null,
      data.mime_type || null,
      data.duration_seconds || null,
      data.transcript || null,
      data.transcript_engine || 'gemini',
      data.upload_status || 'pending',
    ]
  );
  return res.rows[0];
}

/**
 * Get all audio iterations for a session (ordered by iteration).
 */
export async function getSessionAudio(client, sessionId) {
  const res = await client.query(
    'SELECT * FROM session_audio WHERE session_id = $1 ORDER BY iteration',
    [sessionId]
  );
  return res.rows;
}

/**
 * Get a single iteration's audio record.
 */
export async function getSessionAudioIteration(client, sessionId, iteration) {
  const res = await client.query(
    'SELECT * FROM session_audio WHERE session_id = $1 AND iteration = $2',
    [sessionId, iteration]
  );
  return res.rows[0] || null;
}

// ---------------------------------------------------------------------------
// LLM Results — per-call output logging
// ---------------------------------------------------------------------------

import { calculateCost } from './llmClient.js';

/**
 * Insert a single LLM call result into llm_results.
 * Non-throwing — logs errors but never crashes the pipeline.
 *
 * @param {object} client - pg pool/client
 * @param {string} sessionId
 * @param {string} callName - e.g. 'H1_chief_complaint'
 * @param {string} stage - 'history' | 'diagnosis' | 'management'
 * @param {number} callOrder - 1-9
 * @param {object} result - the LLM output (JSON-serialisable)
 * @param {object} [meta] - { model_used, latency_ms, input_tokens, output_tokens, cost_usd, error }
 */
export async function insertLlmResult(client, sessionId, callName, stage, callOrder, result, meta = {}) {
  try {
    const costUsd = meta.cost_usd ?? calculateCost(meta.model_used, meta.input_tokens || 0, meta.output_tokens || 0);
    await client.query(
      `INSERT INTO llm_results (session_id, call_name, stage, call_order, model_used, input_tokens, output_tokens, latency_ms, cost_usd, result, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
      [
        sessionId,
        callName,
        stage,
        callOrder,
        meta.model_used || null,
        meta.input_tokens || null,
        meta.output_tokens || null,
        meta.latency_ms || null,
        costUsd || null,
        JSON.stringify(result ?? {}),
        meta.error || null,
      ]
    );
  } catch (err) {
    console.error(`[${sessionId}] llm_results insert failed for ${callName}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Pipeline Failures — error logging
// ---------------------------------------------------------------------------

/**
 * Log a pipeline failure. Non-throwing.
 */
export async function insertPipelineFailure(client, sessionId, userId, stage, callName, errorMsg) {
  try {
    const errorCode = errorMsg?.includes('503') ? 'LLM_503'
      : errorMsg?.includes('429') ? 'LLM_429'
      : errorMsg?.includes('Cannot parse JSON') ? 'PARSE_ERROR'
      : errorMsg?.includes('ENOENT') ? 'ENOENT'
      : 'UNKNOWN';
    await client.query(
      `INSERT INTO pipeline_failures (session_id, user_id, stage, call_name, error_code, error_msg)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, userId, stage, callName, errorCode, (errorMsg || '').slice(0, 1000)]
    );
  } catch (err) {
    console.error(`[${sessionId}] pipeline_failures insert failed:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Session Metrics — per-session aggregate
// ---------------------------------------------------------------------------

/**
 * Compute and insert session_metrics from llm_results for a completed session.
 * Non-throwing.
 */
export async function insertSessionMetrics(client, data) {
  try {
    // Aggregate from llm_results
    const agg = await client.query(
      `SELECT
         COUNT(*)::int AS total_llm_calls,
         COALESCE(SUM(input_tokens), 0)::int AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0)::int AS total_output_tokens,
         COALESCE(SUM(cost_usd), 0)::numeric(10,6) AS total_cost_usd,
         COALESCE(SUM(latency_ms), 0)::int AS total_latency_ms
       FROM llm_results WHERE session_id = $1`,
      [data.session_id]
    );
    const a = agg.rows[0] || {};

    await client.query(
      `INSERT INTO session_metrics
         (session_id, user_id, patient_id, total_llm_calls, total_input_tokens, total_output_tokens,
          total_cost_usd, total_latency_ms, e2e_duration_ms, gps_lat, gps_lon, district_code,
          risk_tier, pipeline_status, network_rtt_ms, total_transcription_ms, total_server_overhead_ms, phase_timings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
       ON CONFLICT (session_id) DO UPDATE SET
         total_llm_calls = EXCLUDED.total_llm_calls,
         total_input_tokens = EXCLUDED.total_input_tokens,
         total_output_tokens = EXCLUDED.total_output_tokens,
         total_cost_usd = EXCLUDED.total_cost_usd,
         total_latency_ms = EXCLUDED.total_latency_ms,
         e2e_duration_ms = EXCLUDED.e2e_duration_ms,
         risk_tier = EXCLUDED.risk_tier,
         pipeline_status = EXCLUDED.pipeline_status,
         network_rtt_ms = EXCLUDED.network_rtt_ms,
         total_transcription_ms = EXCLUDED.total_transcription_ms,
         total_server_overhead_ms = EXCLUDED.total_server_overhead_ms,
         phase_timings = EXCLUDED.phase_timings`,
      [
        data.session_id,
        data.user_id,
        data.patient_id,
        a.total_llm_calls,
        a.total_input_tokens,
        a.total_output_tokens,
        a.total_cost_usd,
        a.total_latency_ms,
        data.e2e_duration_ms,
        data.gps_lat,
        data.gps_lon,
        data.district_code,
        data.risk_tier,
        data.pipeline_status,
        data.network_rtt_ms,
        data.total_transcription_ms,
        data.total_server_overhead_ms,
        JSON.stringify(data.phase_timings || []),
      ]
    );
  } catch (err) {
    console.error(`[${data.session_id}] session_metrics insert failed:`, err.message);
  }
}
