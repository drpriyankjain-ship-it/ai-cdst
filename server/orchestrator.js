/**
 * CDST Session Orchestrator — WebSocket handler
 * ===============================================
 * Direct port of orchestrator.py WebSocket endpoint.
 */

import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getPool, vaultInit, vaultRead, vaultUpdate, vaultSetNested, loadPatientRecord, insertLlmResult, insertPipelineFailure, insertSessionMetrics } from './lib/db.js';
import { verifyJwt } from './lib/auth.js';
import { loadBaselineDiseases, loadEpiPrior } from './lib/epiUtils.js';
import { extractChiefComplaint, generateQuestionnaire, validateQuestionnaire, extractPatientRecordUpdate } from './stages/historyStage.js';
import { extractMedicalConcepts, generateDifferential, validateDifferential, generateClarifyingQuestions } from './stages/diagnosisStage.js';
import { runManagementStage } from './stages/managementStage.js';
import { uploadAudioToStorage } from './lib/storage.js';

// ffmpeg for phase-level audio concatenation at session end
let _ffmpeg = null;
async function getFfmpeg() {
  if (_ffmpeg) return _ffmpeg;
  try {
    const { default: ffmpegInstaller } = await import('@ffmpeg-installer/ffmpeg');
    const { default: ffmpegModule } = await import('fluent-ffmpeg');
    ffmpegModule.setFfmpegPath(ffmpegInstaller.path);
    _ffmpeg = ffmpegModule;
    return _ffmpeg;
  } catch {
    console.warn('[FFMPEG] fluent-ffmpeg not available — phase audio will be uploaded as individual segments');
    return null;
  }
}

// Generic proforma fallback — loaded once
let _genericProforma = null;
function loadGenericProforma() {
  if (_genericProforma) return _genericProforma;
  try {
    const dataDir = fs.existsSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data'))
      ? path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data')
      : path.join(path.dirname(new URL(import.meta.url).pathname), 'data');
    _genericProforma = JSON.parse(fs.readFileSync(path.join(dataDir, 'generic_proforma.json'), 'utf-8'));
  } catch {
    console.warn('[WARN] Could not load generic_proforma.json');
    _genericProforma = { sections: [], mandatory_safety_questions: [], opening_context: 'Use this standard proforma to conduct the history.' };
  }
  return _genericProforma;
}

// Active sessions registry — exported for use by audio-segment route
export const _active = new Map();

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

class SessionState {
  constructor(sessionId, dbClient) {
    this.sessionId = sessionId;
    this.dbClient = dbClient;
    this.markerAAt = null;
    this.markerBAt = null;
    this.markerCAt = null;
    this.nurseId = null;
    this.userId = null;
    // Phase audio buffers — arrays of Buffer objects, one per 12s segment
    this.phaseAudioBuffers = { 1: [], 2: [], 3: [] };
    this.currentPhase = 1;
    this.markerRetryCount = { 1: 0, 2: 0, 3: 0 };
    // Timing
    this.networkRttMs = null;
    this.phaseStartAt = null;
    this.lastTranscriptionMs = null;
    this.phaseTimings = [];
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

  if (phaseTotal && phaseTotal > 0) {
    const pct = (v) => v ? parseFloat(((v / phaseTotal) * 100).toFixed(1)) : 0;
    timing.breakdown = {
      gemini_pct: pct(geminiMs),
      transcription_pct: pct(transcriptionMs),
      server_pct: pct(serverOverhead > 0 ? serverOverhead : 0),
    };
  }

  state.phaseTimings.push(timing);
  state.lastTranscriptionMs = null;
  state.phaseStartAt = null;

  return timing;
}

// ---------------------------------------------------------------------------
// Audio archive — ffmpeg concat per phase + Supabase Storage upload
// Runs asynchronously after session end; does not block the nurse.
// ---------------------------------------------------------------------------

async function concatAndArchiveAudio(sessionId, phaseAudioBuffers, dbClient) {
  const ffmpeg = await getFfmpeg();
  const audioUrls = {};
  const retainUntil = new Date(Date.now() + 3650 * 86400000).toISOString();

  for (const phase of [1, 2, 3]) {
    const buffers = phaseAudioBuffers[phase] || [];
    if (!buffers.length) continue;

    let audioPath = null;
    let tmpDir = null;

    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cdst-${sessionId}-p${phase}-`));

      if (buffers.length === 1) {
        // Single segment — write directly, no concat needed
        audioPath = path.join(tmpDir, 'audio.m4a');
        fs.writeFileSync(audioPath, buffers[0]);
      } else if (ffmpeg) {
        // Multiple segments — concat with ffmpeg
        const segPaths = buffers.map((buf, i) => {
          const p = path.join(tmpDir, `seg${i}.m4a`);
          fs.writeFileSync(p, buf);
          return p;
        });
        const listPath = path.join(tmpDir, 'list.txt');
        fs.writeFileSync(listPath, segPaths.map(p => `file '${p}'`).join('\n'));
        audioPath = path.join(tmpDir, 'audio.m4a');
        await new Promise((resolve, reject) => {
          ffmpeg()
            .input(listPath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .outputOptions(['-c', 'copy'])
            .save(audioPath)
            .on('end', resolve)
            .on('error', reject);
        });
      } else {
        // ffmpeg unavailable — upload first segment only, log warning
        console.warn(`[${sessionId}] ffmpeg unavailable — uploading phase ${phase} segment 0 of ${buffers.length} only`);
        audioPath = path.join(tmpDir, 'audio.m4a');
        fs.writeFileSync(audioPath, buffers[0]);
      }

      const { publicUrl } = await uploadAudioToStorage(audioPath, sessionId, phase, 'audio/mp4');
      audioUrls[`phase_${phase}_url`] = publicUrl;
      console.log(`[${sessionId}] Phase ${phase} audio archived: ${publicUrl}`);
    } catch (err) {
      console.error(`[${sessionId}] Phase ${phase} audio archive failed: ${err.message}`);
    } finally {
      if (tmpDir) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    }
  }

  if (Object.keys(audioUrls).length) {
    await vaultUpdate(dbClient, sessionId, {
      audio: {
        ...audioUrls,
        upload_status: 'complete',
        retain_until: retainUntil,
        retention_days: 3650,
        archived_at: new Date().toISOString(),
      },
    });
    console.log(`[${sessionId}] Audio vault updated with ${Object.keys(audioUrls).length} phase URL(s)`);
  }
}

// ---------------------------------------------------------------------------
// Marker handlers
// ---------------------------------------------------------------------------

async function handleMarkerA(ws, state, t) {
  state.markerAAt = t;
  state.phaseStartAt = Date.now();
  await vaultUpdate(state.dbClient, state.sessionId, { marker_a_at: t });

  const { sessionId, dbClient } = state;
  const audioBuffers = state.phaseAudioBuffers[1];
  state.currentPhase = 2;

  // Fallback: empty buffer
  if (!audioBuffers.length) {
    if (state.markerRetryCount[1] < 1) {
      state.markerRetryCount[1]++;
      console.warn(`[${sessionId}] Marker A — no audio buffered yet, requesting retry`);
      wsSend(ws, { type: 'retry_marker', marker: 'history_complete', reason: 'audio_not_ready' });
      return;
    }
    // Second failure — return generic proforma
    console.warn(`[${sessionId}] Marker A retry failed — returning generic proforma`);
    const proforma = loadGenericProforma();
    await vaultUpdate(dbClient, sessionId, { questionnaire: proforma, history_stage_status: 'generic_fallback' });
    wsSend(ws, { type: 'stage_complete', stage: 'history', data: proforma, fallback: true });
    return;
  }

  (async () => {
    try {
      const vaultCtx = await vaultRead(dbClient, sessionId);
      const photos = collectAllPhotos(vaultCtx);
      if (photos.length) console.log(`[${sessionId}] Including ${photos.length} clinical photo(s) in H1/H2`);
      const patientRecord = vaultCtx.patient_record || {};
      const gps = vaultCtx.gps || {};
      const districtCode = gps.district_code || 'WB_UNKNOWN';
      const baseline = loadBaselineDiseases();
      const epi = loadEpiPrior(districtCode, new Date().getMonth() + 1);

      console.log(`[${sessionId}] History Call 1: extracting chief complaint from ${audioBuffers.length} segment(s)`);
      let t0 = Date.now();
      const h1 = await extractChiefComplaint(audioBuffers, vaultCtx, photos);
      const chief = h1.result;
      h1.meta.latency_ms = Date.now() - t0;
      await insertLlmResult(dbClient, sessionId, 'H1_chief_complaint', 'history', 1, chief, { ...h1.meta });

      // Write transcript to vault
      if (chief.transcript) {
        await vaultSetNested(dbClient, sessionId, ['transcript_segments', 'phase_1'], chief.transcript);
      }
      await vaultUpdate(dbClient, sessionId, { chief_complaint: chief });

      console.log(`[${sessionId}] History Call 2: generating questionnaire`);
      const t1 = Date.now();
      const h2 = await generateQuestionnaire(chief, vaultCtx, baseline, epi, patientRecord, photos);
      const questionnaire = validateQuestionnaire(h2.result);
      h2.meta.latency_ms = Date.now() - t1;
      await insertLlmResult(dbClient, sessionId, 'H2_questionnaire', 'history', 2, questionnaire, { ...h2.meta });
      const stub = extractPatientRecordUpdate(questionnaire, chief, sessionId);
      await vaultUpdate(dbClient, sessionId, {
        questionnaire, patient_record_stub: stub,
        history_stage_status: 'complete', history_stage_completed_at: new Date().toISOString(),
      });
      wsSend(ws, {
        type: 'stage_complete', stage: 'history', data: questionnaire,
        timing: buildPhaseTiming(state, [h1.meta, h2.meta], 'history'),
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

  const audioBuffers = state.phaseAudioBuffers[2];
  state.currentPhase = 3;

  // Fallback: empty buffer
  if (!audioBuffers.length) {
    if (state.markerRetryCount[2] < 1) {
      state.markerRetryCount[2]++;
      console.warn(`[${sessionId}] Marker B — no audio buffered, requesting retry`);
      wsSend(ws, { type: 'retry_marker', marker: 'diagnosis_complete', reason: 'audio_not_ready' });
      return;
    }
    console.warn(`[${sessionId}] Marker B retry failed — flagging for full doctor review`);
    wsSend(ws, {
      type: 'error', code: 'DIAGNOSIS_AUDIO_UNAVAILABLE',
      message: 'AI analysis unavailable — use clinical judgment. This consultation is flagged for full doctor review.',
    });
    return;
  }

  (async () => {
    try {
      let vaultCtx = await vaultRead(dbClient, sessionId);
      const photos = collectAllPhotos(vaultCtx);
      if (photos.length) console.log(`[${sessionId}] Including ${photos.length} clinical photo(s) in D1/D2/D3`);
      const gps = vaultCtx.gps || {};
      const baseline = loadBaselineDiseases();
      const epi = loadEpiPrior(gps.district_code || 'WB_UNKNOWN', new Date().getMonth() + 1);

      console.log(`[${sessionId}] Diagnosis Call 1: extracting concepts from ${audioBuffers.length} segment(s)`);
      let t0 = Date.now();
      const d1 = await extractMedicalConcepts(audioBuffers, vaultCtx, photos);
      const concepts = d1.result;
      d1.meta.latency_ms = Date.now() - t0;
      await insertLlmResult(dbClient, sessionId, 'D1_medical_concepts', 'diagnosis', 3, concepts, { ...d1.meta });

      // Write transcript to vault
      if (concepts.transcript) {
        await vaultSetNested(dbClient, sessionId, ['transcript_segments', 'phase_2'], concepts.transcript);
      }
      await vaultUpdate(dbClient, sessionId, { extracted_concepts: concepts });

      if (concepts.pregnancy_status != null) {
        await vaultSetNested(dbClient, sessionId, ['demographics', 'pregnancy_status'], concepts.pregnancy_status);
        if (concepts.lmp) await vaultSetNested(dbClient, sessionId, ['demographics', 'lmp'], concepts.lmp);
        vaultCtx = await vaultRead(dbClient, sessionId);
      }

      console.log(`[${sessionId}] Diagnosis Call 2: generating differential`);
      const t1 = Date.now();
      const d2 = await generateDifferential(concepts, vaultCtx, baseline, epi, photos);
      const ddx = d2.result;
      d2.meta.latency_ms = Date.now() - t1;
      await insertLlmResult(dbClient, sessionId, 'D2_differential', 'diagnosis', 4, ddx, { ...d2.meta });
      await vaultUpdate(dbClient, sessionId, { differential_table: ddx });

      console.log(`[${sessionId}] Diagnosis Call 3: clarifying questions`);
      const t2 = Date.now();
      const d3 = await generateClarifyingQuestions(ddx, concepts, vaultCtx);
      const clarifying = d3.result;
      d3.meta.latency_ms = Date.now() - t2;
      await insertLlmResult(dbClient, sessionId, 'D3_clarifying_questions', 'diagnosis', 5, clarifying, { ...d3.meta });
      await vaultUpdate(dbClient, sessionId, {
        clarifying_questions: clarifying,
        diagnosis_stage_status: 'complete', diagnosis_stage_completed_at: new Date().toISOString(),
      });

      wsSend(ws, {
        type: 'stage_complete', stage: 'diagnosis',
        data: { differential: ddx, clarifying_questions: clarifying },
        timing: buildPhaseTiming(state, [d1.meta, d2.meta, d3.meta], 'diagnosis'),
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

  const audioBuffers = state.phaseAudioBuffers[3];

  // Fallback: empty buffer
  if (!audioBuffers.length) {
    if (state.markerRetryCount[3] < 1) {
      state.markerRetryCount[3]++;
      console.warn(`[${sessionId}] Marker C — no audio buffered, requesting retry`);
      wsSend(ws, { type: 'retry_marker', marker: 'management_complete', reason: 'audio_not_ready' });
      return;
    }
    console.warn(`[${sessionId}] Marker C retry failed — flagging for full doctor review`);
    wsSend(ws, {
      type: 'error', code: 'MANAGEMENT_AUDIO_UNAVAILABLE',
      message: 'AI analysis unavailable — use clinical judgment. This consultation is flagged for full doctor review.',
    });
    return;
  }

  (async () => {
    try {
      console.log(`[${sessionId}] Management stage: pipeline starting (${audioBuffers.length} segment(s))`);
      const result = await runManagementStage(sessionId, audioBuffers, dbClient);

      // Write transcript to vault from M1 output
      const m1Transcript = result.clarifying_findings?.transcript;
      if (m1Transcript) {
        await vaultSetNested(dbClient, sessionId, ['transcript_segments', 'phase_3'], m1Transcript);
      }

      const triage = result.triage || {};
      const riskTier = result.rule_engine?.final_risk_tier || 'high';
      wsSend(ws, {
        type: 'stage_complete', stage: 'management',
        data: { triage_output: triage, risk_tier: riskTier, problem_list: result.problem_list || {}, risk_assessment: result.risk_assessment || {} },
        timing: buildPhaseTiming(state, [], 'management'),
      });

      if (riskTier === 'HIGH') notifyDoctor(sessionId, triage);
      console.log(`[${sessionId}] Management stage complete — risk_tier=${riskTier}`);

      // Write to patient_log
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

  await vaultUpdate(state.dbClient, state.sessionId, {
    session_ended_at: new Date().toISOString(),
    session_duration_seconds: t,
  });

  _active.delete(state.sessionId);
  wsSend(ws, { type: 'session_closed', risk_tier: riskTier });
  console.log(`[${state.sessionId}] Session closed — risk_tier=${riskTier} duration=${t}s`);

  // Async: concatenate phase audio per phase and archive to Supabase Storage.
  // Does not block session close — fires in background.
  const { sessionId, dbClient, phaseAudioBuffers } = state;
  concatAndArchiveAudio(sessionId, phaseAudioBuffers, dbClient).then(() => {
    console.log(`[${sessionId}] Audio archive complete`);
  }).catch(err => {
    console.error(`[${sessionId}] Audio archive error: ${err.message}`);
  });
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
          wsSend(ws, { type: 'ping', ping_ts: Date.now() });
          console.log(`[${sessionId}] Session started — patient=${msg.patient_id}`);
        } else if (msgType === 'marker' && state) {
          const marker = msg.marker;
          if (marker === 'history_complete') await handleMarkerA(ws, state, msg.t);
          else if (marker === 'diagnosis_complete') await handleMarkerB(ws, state, msg.t);
          else if (marker === 'management_complete') await handleMarkerC(ws, state, msg.t);
        } else if (msgType === 'session_end' && state) {
          await handleSessionEnd(ws, state, msg.t);
        } else if (msgType === 'audio_uploaded' && state) {
          // Legacy: client notifies that it has uploaded full session audio externally
          await vaultUpdate(pool, state.sessionId, {
            audio: {
              upload_status: 'client_confirmed',
              url: msg.url,
              codec: msg.codec,
              duration_seconds: msg.duration_seconds,
              size_bytes: msg.size_bytes,
              retain_until: new Date(Date.now() + 3650 * 86400000).toISOString(),
              retention_days: 3650,
            },
          });
          wsSend(ws, { type: 'audio_confirmed' });
        } else if (msgType === 'pong' && state) {
          if (msg.ping_ts) {
            state.networkRttMs = Date.now() - msg.ping_ts;
            console.log(`[${state.sessionId}] Network RTT: ${state.networkRttMs}ms`);
          }
        } else if (msgType === 'transcription_timing' && state) {
          state.lastTranscriptionMs = msg.transcription_ms || null;
        }
      } catch (err) {
        console.error('WS message error:', err);
        wsSend(ws, { type: 'error', code: 'INTERNAL_ERROR', message: err.message });
      }
    });

    ws.on('close', () => {
      console.log('[WS] Connection closed');
      if (state) _active.delete(state.sessionId);
    });
  });
}
