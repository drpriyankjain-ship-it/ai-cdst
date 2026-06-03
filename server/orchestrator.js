/**
 * CDST Session Orchestrator — WebSocket handler
 * ===============================================
 * Direct port of orchestrator.py WebSocket endpoint.
 */

import { v4 as uuidv4 } from 'uuid';
import { DeepgramClient } from '@deepgram/sdk';
import { getPool, vaultInit, vaultRead, vaultUpdate, vaultSetNested, vaultAppendTranscript, loadPatientRecord, insertLlmResult, insertPipelineFailure, insertSessionMetrics } from './lib/db.js';
import { verifyJwt } from './lib/auth.js';
import { loadBaselineDiseases, loadEpiPrior } from './lib/epiUtils.js';
import { buildMultimodalContent } from './lib/llmClient.js';
import { extractChiefComplaint, generateQuestionnaire, validateQuestionnaire, extractPatientRecordUpdate } from './stages/historyStage.js';
import { extractMedicalConcepts, generateDifferential, validateDifferential, generateClarifyingQuestions, runDiagnosisStage } from './stages/diagnosisStage.js';
import { runManagementStage } from './stages/managementStage.js';

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const DEEPGRAM_LANGUAGE = process.env.DEEPGRAM_LANGUAGE || 'hi';

// ---------------------------------------------------------------------------
// Deepgram live STT helper (SDK v5 API)
// ---------------------------------------------------------------------------

async function startDeepgramSTT(ws, state) {
  if (!DEEPGRAM_API_KEY) {
    console.log(`[${state.sessionId}] No DEEPGRAM_API_KEY — live transcript disabled`);
    return null;
  }

  try {
    const deepgram = new DeepgramClient({ apiKey: DEEPGRAM_API_KEY });

    const socket = await deepgram.listen.v1.createConnection({
      model: 'nova-3',
      language: DEEPGRAM_LANGUAGE,
      smart_format: true,
      interim_results: true,
      utterance_end_ms: 1500,
      vad_events: true,
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
    });

    socket.on('message', async (data) => {
      if (data.type === 'Results' && data.channel?.alternatives?.[0]) {
        const transcript = data.channel.alternatives[0].transcript;
        if (!transcript) return;
        const isFinal = data.is_final;
        wsSend(ws, { type: 'transcript', text: transcript, is_final: isFinal });
        await state.appendTranscript(transcript, isFinal);
      }
    });

    socket.on('error', (err) => {
      console.error(`[${state.sessionId}] Deepgram error:`, err);
    });

    socket.on('close', () => {
      console.log(`[${state.sessionId}] Deepgram connection closed`);
    });

    socket.connect();
    await socket.waitForOpen();

    console.log(`[${state.sessionId}] Deepgram STT started — model=nova-3 language=${DEEPGRAM_LANGUAGE}`);
    return socket;
  } catch (err) {
    console.error(`[${state.sessionId}] Failed to start Deepgram:`, err);
    return null;
  }
}

// Active sessions registry
const _active = new Map();

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

class SessionState {
  constructor(sessionId, dbClient) {
    this.sessionId = sessionId;
    this.dbClient = dbClient;
    this.transcriptFull = '';
    this.phase1End = '';
    this.phase2End = '';
    this.markerAAt = null;
    this.markerBAt = null;
    this.markerCAt = null;
    this.dg = null;
    this.ringBuffer = [];
    this.nurseId = null;
    this.userId = null;
    // Timing
    this.networkRttMs = null;
    this.phaseStartAt = null;   // Date.now() when marker received
    this.lastTranscriptionMs = null; // from upload response
    this.phaseTimings = [];     // accumulated per-phase timing breakdowns
  }

  async appendTranscript(text, isFinal) {
    if (isFinal && text.trim()) {
      this.transcriptFull += text + ' ';
      await vaultAppendTranscript(this.dbClient, this.sessionId, text);
    }
  }

  static async fromVault(sessionId, dbClient) {
    const state = new SessionState(sessionId, dbClient);
    const ctx = await vaultRead(dbClient, sessionId);
    const segs = ctx.transcript_segments || {};
    state.transcriptFull = ctx.transcript_full || '';
    state.phase1End = segs.phase_1 || '';
    state.phase2End = state.phase1End + (segs.phase_2 || '');
    state.markerAAt = ctx.marker_a_at;
    state.markerBAt = ctx.marker_b_at;
    state.markerCAt = ctx.marker_c_at;
    return state;
  }
}

// ---------------------------------------------------------------------------
// Safe WS send
// ---------------------------------------------------------------------------

function wsSend(ws, payload) {
  try { ws.send(JSON.stringify(payload)); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Doctor notification stub
// ---------------------------------------------------------------------------

function notifyDoctor(sessionId, triageOutput) {
  const oneLiner = triageOutput?.triage?.one_liner || 'see session';
  console.warn(`[${sessionId}] HIGH RISK — doctor notification triggered. one_liner=${oneLiner}`);
}

/**
 * Collect all photos from vault across all phases.
 * Returns a flat array of { mimeType, data } objects.
 */
function collectAllPhotos(vaultCtx) {
  const sessionPhotos = vaultCtx.session_photos || {};
  const all = [];
  for (const phaseKey of Object.keys(sessionPhotos)) {
    const photos = sessionPhotos[phaseKey];
    if (Array.isArray(photos)) all.push(...photos);
  }
  return all;
}

// ---------------------------------------------------------------------------
// Phase timing breakdown builder
// ---------------------------------------------------------------------------

function buildPhaseTiming(state, callMetas, stageName) {
  const now = Date.now();
  const phaseTotal = state.phaseStartAt ? now - state.phaseStartAt : null;
  const geminiMs = callMetas.reduce((sum, m) => sum + (m?.latency_ms || 0), 0) || null;
  const transcriptionMs = state.lastTranscriptionMs || null;
  const serverOverhead = phaseTotal && geminiMs
    ? phaseTotal - geminiMs - (transcriptionMs || 0)
    : null;

  const timing = {
    stage: stageName || 'unknown',
    phase_total_ms: phaseTotal,
    network_rtt_ms: state.networkRttMs,
    transcription_ms: transcriptionMs,
    gemini_calls_ms: geminiMs,
    server_overhead_ms: serverOverhead > 0 ? serverOverhead : 0,
    call_count: callMetas.length,
    per_call: callMetas.map(m => ({
      model: m?.model_used,
      latency_ms: m?.latency_ms || null,
      input_tokens: m?.input_tokens || null,
      output_tokens: m?.output_tokens || null,
      cost_usd: m?.cost_usd || null,
    })),
    timestamp: now,
  };

  // Compute percentage breakdown
  if (phaseTotal && phaseTotal > 0) {
    const pct = (v) => v ? parseFloat(((v / phaseTotal) * 100).toFixed(1)) : 0;
    timing.breakdown = {
      gemini_pct: pct(geminiMs),
      transcription_pct: pct(transcriptionMs),
      server_pct: pct(serverOverhead > 0 ? serverOverhead : 0),
    };
  }

  // Accumulate for DB write and reset
  state.phaseTimings.push(timing);
  state.lastTranscriptionMs = null;
  state.phaseStartAt = null;

  return timing;
}

// ---------------------------------------------------------------------------
// Marker handlers
// ---------------------------------------------------------------------------

async function handleMarkerA(ws, state, t) {
  state.markerAAt = t;
  state.phaseStartAt = Date.now();
  await vaultUpdate(state.dbClient, state.sessionId, { marker_a_at: t });

  const { sessionId, dbClient } = state;
  // Read phase 1 transcript from vault (populated by audio upload route)
  const currentVault = await vaultRead(dbClient, sessionId);
  const phase1 = (currentVault.transcript_segments || {}).phase_1 || state.transcriptFull || '';
  console.log(`[${sessionId}] Marker A — phase 1 transcript length: ${phase1.length}`);

  (async () => {
    try {
      const vaultCtx = await vaultRead(dbClient, sessionId);
      const photos = collectAllPhotos(vaultCtx);
      if (photos.length) console.log(`[${sessionId}] Including ${photos.length} clinical photo(s) in Gemini calls`);
      const patientRecord = vaultCtx.patient_record || {};
      const gps = vaultCtx.gps || {};
      const districtCode = gps.district_code || 'WB_UNKNOWN';
      const baseline = loadBaselineDiseases();
      const epi = loadEpiPrior(districtCode, new Date().getMonth() + 1);

      console.log(`[${sessionId}] History Call 1: extracting chief complaint`);
      let t0 = Date.now();
      const h1 = await extractChiefComplaint(phase1, vaultCtx, photos);
      const chief = h1.result;
      h1.meta.latency_ms = Date.now() - t0;
      await insertLlmResult(dbClient, sessionId, 'H1_chief_complaint', 'history', 1, chief, { ...h1.meta });
      await vaultUpdate(dbClient, sessionId, { chief_complaint: chief });

      let h2Meta = {};
      console.log(`[${sessionId}] History Call 2: generating questionnaire`);
      const t1 = Date.now();
      const h2 = await generateQuestionnaire(chief, vaultCtx, baseline, epi, patientRecord, photos);
      const questionnaire = validateQuestionnaire(h2.result);
      h2.meta.latency_ms = Date.now() - t1;
      h2Meta = h2.meta;
      await insertLlmResult(dbClient, sessionId, 'H2_questionnaire', 'history', 2, questionnaire, { ...h2.meta });
      const stub = extractPatientRecordUpdate(questionnaire, chief, sessionId);
      await vaultUpdate(dbClient, sessionId, { questionnaire, patient_record_stub: stub, history_stage_status: 'complete', history_stage_completed_at: new Date().toISOString() });
      wsSend(ws, {
        type: 'stage_complete', stage: 'history', data: questionnaire,
        timing: buildPhaseTiming(state, [h1.meta, h2Meta], 'history'),
      });
      console.log(`[${sessionId}] History stage complete`);
    } catch (exc) {
      console.error(`[${sessionId}] History stage error:`, exc);
      insertPipelineFailure(dbClient, sessionId, null, 'history', null, exc.message).catch(() => {});
      wsSend(ws, { type: 'error', code: 'HISTORY_STAGE_ERROR', message: exc.message });
    }
  })();
}

async function handleMarkerB(ws, state, t) {
  state.markerBAt = t;
  state.phaseStartAt = Date.now();
  const { sessionId, dbClient } = state;
  await vaultUpdate(dbClient, sessionId, { marker_b_at: t });

  // Read phase 2 transcript from vault (populated by audio upload route)
  const currentVault = await vaultRead(dbClient, sessionId);
  const phase2 = (currentVault.transcript_segments || {}).phase_2 || '';
  console.log(`[${sessionId}] Marker B — phase 2 transcript length: ${phase2.length}`);

  (async () => {
    try {
      let vaultCtx = await vaultRead(dbClient, sessionId);
      const photos = collectAllPhotos(vaultCtx);
      if (photos.length) console.log(`[${sessionId}] Including ${photos.length} clinical photo(s) in diagnosis`);
      const gps = vaultCtx.gps || {};
      const baseline = loadBaselineDiseases();
      const epi = loadEpiPrior(gps.district_code || 'WB_UNKNOWN', new Date().getMonth() + 1);

      console.log(`[${sessionId}] Diagnosis Call 1: extracting concepts`);
      let t0 = Date.now();
      const d1 = await extractMedicalConcepts(phase2, vaultCtx, photos);
      const concepts = d1.result;
      d1.meta.latency_ms = Date.now() - t0;
      await insertLlmResult(dbClient, sessionId, 'D1_medical_concepts', 'diagnosis', 3, concepts, { ...d1.meta });
      await vaultUpdate(dbClient, sessionId, { extracted_concepts: concepts });

      if (concepts.pregnancy_status != null) {
        await vaultSetNested(dbClient, sessionId, ['demographics', 'pregnancy_status'], concepts.pregnancy_status);
        if (concepts.lmp) await vaultSetNested(dbClient, sessionId, ['demographics', 'lmp'], concepts.lmp);
        vaultCtx = await vaultRead(dbClient, sessionId);
      }

      let d2Meta = {};
      console.log(`[${sessionId}] Diagnosis Call 2: generating differential`);
      const t1 = Date.now();
      const d2 = await generateDifferential(concepts, vaultCtx, baseline, epi, photos);
      const ddx = d2.result;
      d2.meta.latency_ms = Date.now() - t1;
      d2Meta = d2.meta;
      await insertLlmResult(dbClient, sessionId, 'D2_differential', 'diagnosis', 4, ddx, { ...d2.meta });
      await vaultUpdate(dbClient, sessionId, { differential_table: ddx });

      console.log(`[${sessionId}] Diagnosis Call 3: clarifying questions`);
      const t2 = Date.now();
      const d3 = await generateClarifyingQuestions(ddx, concepts, vaultCtx);
      const clarifying = d3.result;
      d3.meta.latency_ms = Date.now() - t2;
      await insertLlmResult(dbClient, sessionId, 'D3_clarifying_questions', 'diagnosis', 5, clarifying, { ...d3.meta });
      await vaultUpdate(dbClient, sessionId, { clarifying_questions: clarifying, diagnosis_stage_status: 'complete', diagnosis_stage_completed_at: new Date().toISOString() });

      wsSend(ws, {
        type: 'stage_complete', stage: 'diagnosis',
        data: { differential: ddx, clarifying_questions: clarifying },
        timing: buildPhaseTiming(state, [d1.meta, d2Meta, d3.meta], 'diagnosis'),
      });
      console.log(`[${sessionId}] Diagnosis stage complete`);
    } catch (exc) {
      console.error(`[${sessionId}] Diagnosis stage error:`, exc);
      insertPipelineFailure(dbClient, sessionId, null, 'diagnosis', null, exc.message).catch(() => {});
      wsSend(ws, { type: 'error', code: 'DIAGNOSIS_STAGE_ERROR', message: exc.message });
    }
  })();
}

async function handleMarkerC(ws, state, t) {
  state.markerCAt = t;
  state.phaseStartAt = Date.now();
  const { sessionId, dbClient } = state;
  await vaultUpdate(dbClient, sessionId, { marker_c_at: t });

  // Read phase 3 transcript from vault (populated by audio upload route)
  const currentVault = await vaultRead(dbClient, sessionId);
  const phase3 = (currentVault.transcript_segments || {}).phase_3 || '';
  console.log(`[${sessionId}] Marker C — phase 3 transcript length: ${phase3.length}`);

  (async () => {
    try {
      console.log(`[${sessionId}] Management stage: pipeline starting`);
      const result = await runManagementStage(sessionId, phase3, dbClient);

      const triage = result.triage || {};
      const riskTier = result.rule_engine?.final_risk_tier || 'high';
      wsSend(ws, {
        type: 'stage_complete', stage: 'management',
        data: { triage_output: triage, risk_tier: riskTier, problem_list: result.problem_list || {}, risk_assessment: result.risk_assessment || {} },
        timing: buildPhaseTiming(state, [], 'management'),
      });

      if (riskTier === 'HIGH') notifyDoctor(sessionId, triage);
      console.log(`[${sessionId}] Management stage complete — risk_tier=${riskTier}`);

      // Write to patient_log — stores proforma, clarifying questions, and management plan distinctly
      try {
        const vaultFinal = await vaultRead(dbClient, sessionId);
        await dbClient.query(
          `INSERT INTO patient_log (patient_id, session_id, source, proforma, clarifying_questions, management_plan)
           VALUES ($1, $2, 'live', $3, $4, $5)`,
          [
            vaultFinal.patient_id || vaultFinal.demographics?.patient_id || '',
            sessionId,
            JSON.stringify(vaultFinal.questionnaire || null),
            JSON.stringify(vaultFinal.clarifying_questions || null),
            JSON.stringify({
              problem_list: result.problem_list || null,
              triage_output: triage,
              risk_assessment: result.risk_assessment || null,
              risk_tier: riskTier,
            }),
          ]
        );
        console.log(`[${sessionId}] patient_log entry created`);
      } catch (logErr) {
        console.error(`[${sessionId}] patient_log write failed:`, logErr.message);
      }

      // Write session_metrics aggregate
      try {
        const vaultFinal = await vaultRead(dbClient, sessionId);
        const gps = vaultFinal.gps || {};
        const sessionStart = vaultFinal.session_started_at ? new Date(vaultFinal.session_started_at).getTime() : null;
        const e2eDuration = sessionStart ? Date.now() - sessionStart : null;

        // Aggregate timing from all phases
        const totalTranscriptionMs = state.phaseTimings.reduce((s, p) => s + (p.transcription_ms || 0), 0);
        const totalServerOverheadMs = state.phaseTimings.reduce((s, p) => s + (p.server_overhead_ms || 0), 0);

        await insertSessionMetrics(dbClient, {
          session_id: sessionId,
          user_id: state.userId || null,
          patient_id: vaultFinal.patient_id || vaultFinal.demographics?.patient_id || null,
          gps_lat: gps.lat || null,
          gps_lon: gps.lon || null,
          district_code: gps.district_code || null,
          risk_tier: riskTier,
          pipeline_status: 'complete',
          e2e_duration_ms: e2eDuration,
          network_rtt_ms: state.networkRttMs || null,
          total_transcription_ms: totalTranscriptionMs || null,
          total_server_overhead_ms: totalServerOverheadMs || null,
          phase_timings: state.phaseTimings,
        });
        console.log(`[${sessionId}] session_metrics written`);
      } catch (metErr) {
        console.error(`[${sessionId}] session_metrics write failed:`, metErr.message);
      }
    } catch (exc) {
      console.error(`[${sessionId}] Management stage error:`, exc);
      insertPipelineFailure(dbClient, sessionId, state.nurseId || null, 'management', null, exc.message).catch(() => {});
      wsSend(ws, { type: 'error', code: 'MANAGEMENT_STAGE_ERROR', message: exc.message });
    }
  })();
}

async function handleSessionEnd(ws, state, t) {
  const vaultCtx = await vaultRead(state.dbClient, state.sessionId);
  const riskTier = vaultCtx.risk_tier || 'unknown';
  const phase3 = state.markerCAt ? state.transcriptFull.slice(state.phase2End.length) : '';

  await vaultUpdate(state.dbClient, state.sessionId, {
    session_ended_at: new Date().toISOString(),
    session_duration_seconds: t,
    transcript_segments: {
      phase_1: state.phase1End,
      phase_2: state.transcriptFull.slice(state.phase1End.length, state.phase2End.length),
      phase_3: phase3,
    },
  });

  if (state.dg) { try { state.dg.finish(); } catch {} }
  _active.delete(state.sessionId);
  wsSend(ws, { type: 'session_closed', risk_tier: riskTier });
  console.log(`[${state.sessionId}] Session closed — risk_tier=${riskTier} duration=${t}s`);
}

// ---------------------------------------------------------------------------
// WebSocket handler — mounted by express-ws
// ---------------------------------------------------------------------------

export function mountWebSocket(app) {
  app.ws('/session/ws', async (ws, req) => {
    // Auth — accept from header OR query param (RN WebSocket doesn't reliably send headers)
    const authHeader = req.headers.authorization || '';
    const queryToken = req.query.token || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : queryToken;
    if (!token) { console.log('[WS] No token — closing'); ws.close(4001, 'Missing Authorization'); return; }
    let claims;
    try { claims = verifyJwt(token); } catch (e) { console.log('[WS] JWT verify failed:', e.message); ws.close(4001, e.message); return; }
    console.log('[WS] Auth OK — user:', claims.user_id, 'email:', claims.email);

    // Use pool directly instead of dedicated client to avoid connection exhaustion
    const pool = getPool();
    let state = null;

    ws.on('message', async (raw) => {
      console.log('[WS] Message received:', typeof raw === 'string' ? raw.slice(0, 100) : `Buffer(${raw.length})`);
      let msg;
      try { msg = JSON.parse(raw); } catch { wsSend(ws, { type: 'error', code: 'INVALID_JSON', message: 'Could not parse message' }); return; }
      const msgType = msg.type;

      try {
        if (msgType === 'init' && !state) {
          const sessionId = `sess_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
          console.log(`[${sessionId}] Init received — patient=${msg.patient_id} nurse=${claims.nurse_id || claims.user_id}`);
          let patientRecord = {};
          try { patientRecord = await loadPatientRecord(pool, msg.patient_id); } catch (e) { console.warn(`[${sessionId}] loadPatientRecord failed:`, e.message); }
          try { await vaultInit(pool, sessionId, msg.patient_id, claims.nurse_id || claims.user_id, msg.gps || {}, patientRecord); } catch (e) { console.error(`[${sessionId}] vaultInit failed:`, e.message); wsSend(ws, { type: 'error', code: 'INIT_ERROR', message: e.message }); return; }
          state = new SessionState(sessionId, pool);
          state.nurseId = claims.nurse_id || claims.user_id;
          state.userId = claims.user_id;
          _active.set(sessionId, state);
          wsSend(ws, { type: 'session_ready', session_id: sessionId, is_new_patient: Object.keys(patientRecord).length === 0 });
          // Measure initial network RTT
          wsSend(ws, { type: 'ping', ping_ts: Date.now() });
          console.log(`[${sessionId}] Session started — patient=${msg.patient_id}`);
        } else if (msgType === 'reconnect' && !state && msg.session_id) {
          // Restore session state from vault after WS reconnection
          const sid = msg.session_id;
          console.log(`[${sid}] Reconnect request from user ${claims.user_id}`);
          try {
            const vault = await vaultRead(pool, sid);
            if (!vault) {
              wsSend(ws, { type: 'error', code: 'SESSION_NOT_FOUND', message: `Session ${sid} not found` });
              return;
            }
            state = await SessionState.fromVault(sid, pool);
            state.nurseId = claims.nurse_id || claims.user_id;
            state.userId = claims.user_id;
            _active.set(sid, state);
            wsSend(ws, { type: 'session_reconnected', session_id: sid });
            // Re-measure network RTT
            wsSend(ws, { type: 'ping', ping_ts: Date.now() });
            console.log(`[${sid}] Session reconnected — state restored from vault`);
          } catch (e) {
            console.error(`[${sid}] Reconnect failed:`, e.message);
            wsSend(ws, { type: 'error', code: 'RECONNECT_ERROR', message: e.message });
          }
        } else if (msgType === 'marker' && state) {
          const marker = msg.marker;
          if (marker === 'history_complete') await handleMarkerA(ws, state, msg.t);
          else if (marker === 'diagnosis_complete') await handleMarkerB(ws, state, msg.t);
          else if (marker === 'management_complete') await handleMarkerC(ws, state, msg.t);
        } else if (msgType === 'marker' && !state) {
          // Marker received but session state is lost — tell client to reconnect
          console.warn(`[WS] Marker received without session state — asking client to reconnect`);
          wsSend(ws, { type: 'error', code: 'SESSION_LOST', message: 'Session state lost. Please reconnect with session_id.' });
        } else if (msgType === 'session_end' && state) {
          await handleSessionEnd(ws, state, msg.t);
        } else if (msgType === 'audio_uploaded' && state) {
          await vaultUpdate(pool, state.sessionId, { audio: { upload_status: 'confirmed', url: msg.url, codec: msg.codec, duration_seconds: msg.duration_seconds, size_bytes: msg.size_bytes, retain_until: new Date(Date.now() + 3650 * 86400000).toISOString() } });
          wsSend(ws, { type: 'audio_confirmed' });
        } else if (msgType === 'pong' && state) {
          // Client responded to our ping — calculate RTT
          if (msg.ping_ts) {
            state.networkRttMs = Date.now() - msg.ping_ts;
            console.log(`[${state.sessionId}] Network RTT: ${state.networkRttMs}ms`);
          }
        } else if (msgType === 'transcription_timing' && state) {
          // Client reports transcription timing from upload response
          state.lastTranscriptionMs = msg.transcription_ms || null;
        }
      } catch (err) {
        console.error('WS message error:', err);
        wsSend(ws, { type: 'error', code: 'INTERNAL_ERROR', message: err.message });
      }
    });

    ws.on('close', () => {
      console.log('[WS] Connection closed');
      if (state) {
        _active.delete(state.sessionId);
        // Clean up Deepgram
        if (state.dg) {
          try { state.dg.close(); } catch {}
          state.dg = null;
        }
      }
    });
  });
}
