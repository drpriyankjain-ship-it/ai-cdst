/**
 * CDST Session Orchestrator — WebSocket handler
 * ===============================================
 * Direct port of orchestrator.py WebSocket endpoint.
 */

import { v4 as uuidv4 } from 'uuid';
import { DeepgramClient } from '@deepgram/sdk';
import { getPool, vaultInit, vaultRead, vaultUpdate, vaultSetNested, vaultAppendTranscript, loadPatientRecord } from './lib/db.js';
import { verifyJwt } from './lib/auth.js';
import { loadBaselineDiseases, loadEpiPrior } from './lib/epiUtils.js';
import { extractChiefComplaint, generateQuestionnaire, validateQuestionnaire, extractPatientRecordUpdate } from './stages/historyStage.js';
import { extractMedicalConcepts, generateDifferential, generateClarifyingQuestions } from './stages/diagnosisStage.js';
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

// ---------------------------------------------------------------------------
// Marker handlers
// ---------------------------------------------------------------------------

async function handleMarkerA(ws, state, t) {
  state.markerAAt = t;
  await vaultUpdate(state.dbClient, state.sessionId, { marker_a_at: t });

  const { sessionId, dbClient } = state;
  // Read phase 1 transcript from vault (populated by audio upload route)
  const currentVault = await vaultRead(dbClient, sessionId);
  const phase1 = (currentVault.transcript_segments || {}).phase_1 || state.transcriptFull || '';
  console.log(`[${sessionId}] Marker A — phase 1 transcript length: ${phase1.length}`);

  (async () => {
    try {
      const vaultCtx = await vaultRead(dbClient, sessionId);
      const patientRecord = vaultCtx.patient_record || {};

      console.log(`[${sessionId}] History Call 1: extracting chief complaint`);
      const chief = await extractChiefComplaint(phase1, vaultCtx);
      await vaultUpdate(dbClient, sessionId, { chief_complaint: chief });

      console.log(`[${sessionId}] History Call 2: generating questionnaire`);
      let questionnaire = await generateQuestionnaire(chief, vaultCtx, patientRecord);
      questionnaire = validateQuestionnaire(questionnaire);
      const stub = extractPatientRecordUpdate(questionnaire, chief, sessionId);
      await vaultUpdate(dbClient, sessionId, { questionnaire, patient_record_stub: stub, history_stage_status: 'complete', history_stage_completed_at: new Date().toISOString() });

      // Push formatted questionnaire to nurse section by section
      if (questionnaire.opening_context) {
        wsSend(ws, { type: 'stage_token', stage: 'history', token: questionnaire.opening_context + '\n\n' });
      }
      (questionnaire.sections || []).forEach((s, i) => {
        let text = `${i + 1}. ${s.section_title}\n`;
        for (const qn of s.questions || []) {
          text += `\n  • ${qn.question}`;
          if (qn.follow_up) text += `\n    → ${qn.follow_up}`;
        }
        wsSend(ws, { type: 'stage_token', stage: 'history', token: text + '\n\n' });
      });
      if (questionnaire.mandatory_safety_questions?.length) {
        let text = 'MANDATORY SAFETY QUESTIONS\n';
        for (const msq of questionnaire.mandatory_safety_questions) {
          text += `\n  • ${msq.question}`;
        }
        wsSend(ws, { type: 'stage_token', stage: 'history', token: text + '\n' });
      }
      wsSend(ws, { type: 'stage_complete', stage: 'history', data: questionnaire });
      console.log(`[${sessionId}] History stage complete`);
    } catch (exc) {
      console.error(`[${sessionId}] History stage error:`, exc);
      wsSend(ws, { type: 'error', code: 'HISTORY_STAGE_ERROR', message: exc.message });
    }
  })();
}

async function handleMarkerB(ws, state, t) {
  state.markerBAt = t;
  const { sessionId, dbClient } = state;
  await vaultUpdate(dbClient, sessionId, { marker_b_at: t });

  // Read phase 2 transcript from vault (populated by audio upload route)
  const currentVault = await vaultRead(dbClient, sessionId);
  const phase2 = (currentVault.transcript_segments || {}).phase_2 || '';
  console.log(`[${sessionId}] Marker B — phase 2 transcript length: ${phase2.length}`);

  (async () => {
    try {
      let vaultCtx = await vaultRead(dbClient, sessionId);
      const gps = vaultCtx.gps || {};
      const baseline = loadBaselineDiseases();
      const epi = loadEpiPrior(gps.district_code || 'WB_UNKNOWN', new Date().getMonth() + 1);

      console.log(`[${sessionId}] Diagnosis Call 1: extracting concepts`);
      const concepts = await extractMedicalConcepts(phase2, vaultCtx);
      await vaultUpdate(dbClient, sessionId, { extracted_concepts: concepts });

      if (concepts.pregnancy_status != null) {
        await vaultSetNested(dbClient, sessionId, ['demographics', 'pregnancy_status'], concepts.pregnancy_status);
        if (concepts.lmp) await vaultSetNested(dbClient, sessionId, ['demographics', 'lmp'], concepts.lmp);
        vaultCtx = await vaultRead(dbClient, sessionId);
      }

      console.log(`[${sessionId}] Diagnosis Call 2: generating differential`);
      const ddx = await generateDifferential(concepts, vaultCtx, baseline, epi);
      await vaultUpdate(dbClient, sessionId, { differential_table: ddx });

      // Push formatted differential
      wsSend(ws, { type: 'stage_token', stage: 'diagnosis', token: 'DIFFERENTIAL DIAGNOSIS\n\n' });
      for (const entry of ddx) {
        const flags = [
          entry.must_not_miss    ? 'Must-not-miss'    : null,
          entry.referral_required ? 'Referral required' : null,
        ].filter(Boolean).join(' | ');
        let text = `${entry.rank}. ${entry.disease} [${entry.probability}]`;
        if (flags) text += ` — ${flags}`;
        text += '\n';
        if (entry.supporting_features?.length) text += `   Supporting: ${entry.supporting_features.join(', ')}\n`;
        if (entry.against?.length)             text += `   Against: ${entry.against.join(', ')}\n`;
        if (entry.reasoning)                   text += `   Reasoning: ${entry.reasoning}\n`;
        wsSend(ws, { type: 'stage_token', stage: 'diagnosis', token: text + '\n' });
      }

      console.log(`[${sessionId}] Diagnosis Call 3: clarifying questions`);
      const clarifying = await generateClarifyingQuestions(ddx, concepts, vaultCtx);
      await vaultUpdate(dbClient, sessionId, { clarifying_questions: clarifying, diagnosis_stage_status: 'complete', diagnosis_stage_completed_at: new Date().toISOString() });

      // Push formatted clarifying questions and bedside observations
      const qs  = (clarifying.clarifying_questions || []).slice().sort((a, b) => a.priority - b.priority);
      const obs = (clarifying.bedside_observations  || []).slice().sort((a, b) => a.priority - b.priority);
      if (qs.length) {
        wsSend(ws, { type: 'stage_token', stage: 'diagnosis', token: 'CLARIFYING QUESTIONS\n\n' });
        for (const q of qs) {
          let text = `  • ${q.question}\n`;
          if (q.if_yes_favours || q.if_no_favours) {
            text += `    → If yes: ${q.if_yes_favours || '—'} | If no: ${q.if_no_favours || '—'}\n`;
          }
          wsSend(ws, { type: 'stage_token', stage: 'diagnosis', token: text });
        }
      }
      if (obs.length) {
        wsSend(ws, { type: 'stage_token', stage: 'diagnosis', token: '\nBEDSIDE OBSERVATIONS\n\n' });
        for (const o of obs) {
          let text = `  • ${o.observation} [${o.tool_required}]\n`;
          if (o.finding_and_meaning) text += `    → ${o.finding_and_meaning}\n`;
          wsSend(ws, { type: 'stage_token', stage: 'diagnosis', token: text });
        }
      }

      wsSend(ws, { type: 'stage_complete', stage: 'diagnosis', data: { differential: ddx, clarifying_questions: clarifying } });
      console.log(`[${sessionId}] Diagnosis stage complete`);
    } catch (exc) {
      console.error(`[${sessionId}] Diagnosis stage error:`, exc);
      wsSend(ws, { type: 'error', code: 'DIAGNOSIS_STAGE_ERROR', message: exc.message });
    }
  })();
}

async function handleMarkerC(ws, state, t) {
  state.markerCAt = t;
  const { sessionId, dbClient } = state;
  await vaultUpdate(dbClient, sessionId, { marker_c_at: t });

  // Read phase 3 transcript from vault (populated by audio upload route)
  const currentVault = await vaultRead(dbClient, sessionId);
  const phase3 = (currentVault.transcript_segments || {}).phase_3 || '';
  console.log(`[${sessionId}] Marker C — phase 3 transcript length: ${phase3.length}`);

  (async () => {
    try {
      console.log(`[${sessionId}] Management stage: starting`);
      const result = await runManagementStage(sessionId, phase3, dbClient);

      const triage = result.triage || {};
      const riskTier = result.rule_engine?.final_risk_tier || 'HIGH';

      // Push formatted problem list (from M2)
      const problems = result.problem_list?.problem_list || [];
      if (problems.length) {
        wsSend(ws, { type: 'stage_token', stage: 'management', token: 'MANAGEMENT PLAN\n\n' });
        for (const p of problems) {
          const a = p.assessment || {};
          const typeLabel = { acute_new: 'Acute', established: 'Established', incidental: 'Incidental', deferred: 'Deferred' }[p.type] || p.type;
          const confidence = a.confidence ? ` — ${a.confidence} confidence` : '';
          let text = `Problem ${p.problem_number} — ${p.problem_title} [${typeLabel}]${confidence}\n`;
          const dx = a.provisional_diagnosis || a.condition || a.finding;
          if (dx) text += `  Assessment: ${dx}\n`;
          if (a.rationale) text += `  Rationale: ${a.rationale}\n`;
          const rx = p.plan?.prescription || [];
          if (rx.length) {
            text += `  Prescription:\n`;
            for (const item of rx) {
              const parts = [item.drug, item.dose, item.route, item.frequency, item.duration ? `for ${item.duration}` : ''].filter(Boolean);
              text += `    • ${parts.join(' | ')}\n`;
              if (item.instructions) text += `      ${item.instructions}\n`;
            }
          }
          const invx = p.plan?.investigations || [];
          if (invx.length) text += `  Investigations: ${invx.join(', ')}\n`;
          const nonPharm = p.plan?.non_pharmacological || [];
          if (nonPharm.length) text += `  Non-pharmacological: ${nonPharm.join('; ')}\n`;
          wsSend(ws, { type: 'stage_token', stage: 'management', token: text + '\n' });
        }
      }

      // Push triage decision (tier + action injected deterministically by runManagementStage)
      const triageTier = triage.triage?.tier || riskTier;
      const triageAction = triage.triage?.action || '';
      wsSend(ws, { type: 'stage_token', stage: 'management', token: `TRIAGE: ${triageTier}\n${triageAction}\n\n` });

      // Push patient instructions (from M4)
      const pi = triage.patient_instructions;
      if (pi) {
        wsSend(ws, { type: 'stage_token', stage: 'management', token: 'PATIENT INSTRUCTIONS\n\n' });
        if (pi.diagnosis_explained) wsSend(ws, { type: 'stage_token', stage: 'management', token: `${pi.diagnosis_explained}\n\n` });
        if (pi.treatment_summary)   wsSend(ws, { type: 'stage_token', stage: 'management', token: `${pi.treatment_summary}\n\n` });
        if (pi.return_criteria?.length) {
          wsSend(ws, { type: 'stage_token', stage: 'management', token: `Return immediately if:\n${pi.return_criteria.map(c => `  • ${c}`).join('\n')}\n\n` });
        }
        if (pi.follow_up) wsSend(ws, { type: 'stage_token', stage: 'management', token: `Follow-up: ${pi.follow_up}\n` });
      }

      wsSend(ws, { type: 'stage_complete', stage: 'management', data: { triage_output: triage, risk_tier: riskTier, problem_list: result.problem_list || {}, risk_assessment: result.risk_assessment || {} } });

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
    } catch (exc) {
      console.error(`[${sessionId}] Management stage error:`, exc);
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
          _active.set(sessionId, state);
          wsSend(ws, { type: 'session_ready', session_id: sessionId, is_new_patient: Object.keys(patientRecord).length === 0 });
          console.log(`[${sessionId}] Session started — patient=${msg.patient_id}`);
        } else if (msgType === 'marker' && state) {
          const marker = msg.marker;
          if (marker === 'history_complete') await handleMarkerA(ws, state, msg.t);
          else if (marker === 'diagnosis_complete') await handleMarkerB(ws, state, msg.t);
          else if (marker === 'management_complete') await handleMarkerC(ws, state, msg.t);
        } else if (msgType === 'session_end' && state) {
          await handleSessionEnd(ws, state, msg.t);
        } else if (msgType === 'audio_uploaded' && state) {
          await vaultUpdate(pool, state.sessionId, { audio: { upload_status: 'confirmed', url: msg.url, codec: msg.codec, duration_seconds: msg.duration_seconds, size_bytes: msg.size_bytes, retain_until: new Date(Date.now() + 90 * 86400000).toISOString() } });
          wsSend(ws, { type: 'audio_confirmed' });
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
