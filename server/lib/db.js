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
  console.log('[DB] Pool initialised');
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
    transcript_full: '',
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

export async function vaultAppendTranscript(client, sessionId, text) {
  await client.query(
    `UPDATE sessions SET data = jsonb_set(
       data, '{transcript_full}',
       to_jsonb(coalesce(data->>'transcript_full', '') || $2),
       true
     ), updated_at = now() WHERE session_id = $1`,
    [sessionId, text + ' ']
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
