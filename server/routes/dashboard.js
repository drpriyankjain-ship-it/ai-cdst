/**
 * CDST — Dashboard Routes
 */

import { Router } from 'express';
import { getPool } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { gemini } from '../lib/llmClient.js';

const router = Router();

// GET /api/dashboard/summary
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const userId = req.user.user_id;
    const total = await pool.query('SELECT COUNT(*) FROM audio_records WHERE user_id = $1', [userId]);
    const pending = await pool.query("SELECT COUNT(*) FROM audio_records WHERE user_id = $1 AND status = 'pending'", [userId]);
    const completed = await pool.query("SELECT COUNT(*) FROM audio_records WHERE user_id = $1 AND status = 'completed'", [userId]);
    const recent = await pool.query(
      'SELECT id, patient_name, status, created_at FROM audio_records WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5',
      [userId]
    );
    res.json({
      total: parseInt(total.rows[0].count),
      pending: parseInt(pending.rows[0].count),
      completed: parseInt(completed.rows[0].count),
      recentRecords: recent.rows,
    });
  } catch (err) {
    console.error('[DASHBOARD] Summary error:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// GET /api/dashboard/patient-tasks
router.get('/patient-tasks', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query(
      "SELECT id, patient_name, patient_id, status, ai_suggestion, created_at FROM audio_records WHERE user_id = $1 AND status != 'archived' ORDER BY created_at DESC",
      [req.user.user_id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Failed to load tasks' }); }
});

// POST /api/dashboard/patient-tasks/:id/complete
router.post('/patient-tasks/:id/complete', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    await pool.query("UPDATE audio_records SET status = 'archived' WHERE id = $1 AND user_id = $2", [req.params.id, req.user.user_id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed to complete task' }); }
});

// ============================================================
// Case Queue — nurse dashboard workflow state
// Clinical data (problem list, triage, etc.) is read from
// the vault (sessions.data) via JOIN — not duplicated here.
// ============================================================

// GET /api/dashboard/management-plans — active cases for nurse dashboard
router.get('/management-plans', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const userId = req.user.user_id;
    const result = await pool.query(
      `SELECT
         cq.session_id              AS id,
         cq.session_id,
         cq.risk_tier,
         cq.status,
         cq.created_at,
         s.data->>'patient_id'                          AS patient_id,
         COALESCE(
           s.data->'demographics'->>'name',
           s.data->'chief_complaint'->>'patient_name'
         )                                              AS patient_name,
         s.data->>'nurse_id'                            AS nurse_id,
         s.data->'chief_complaint'                      AS chief_complaint,
         s.data->'questionnaire'                        AS questionnaire,
         s.data->'extracted_concepts'                   AS extracted_concepts,
         s.data->'differential_table'                   AS differential_table,
         s.data->'clarifying_questions'                 AS clarifying_questions,
         s.data->'clarifying_findings'                  AS clarifying_findings,
         s.data->'problem_list'                         AS problem_list,
         s.data->'triage_output'                        AS triage_output,
         s.data->'risk_assessment'                      AS risk_assessment,
         s.data->'transcript_segments'                  AS transcript_segments,
         s.data->'followups'                          AS followups,
         'live'                                         AS source
       FROM case_queue cq
       JOIN sessions s ON cq.session_id = s.session_id
       WHERE cq.status = 'active'
         AND (s.data->>'nurse_id' = $1 OR s.data->>'nurse_id' = $2)
       ORDER BY
         CASE cq.risk_tier WHEN 'HIGH' THEN 0 ELSE 1 END,
         cq.created_at DESC`,
      [String(userId), `N-${userId}`]
    );

    // Fetch audio URLs for all sessions
    const sessionIds = result.rows.map(r => r.session_id);
    let audioMap = {};
    if (sessionIds.length > 0) {
      const audioRes = await pool.query(
        `SELECT id, session_id, iteration, label, duration_seconds, transcript
         FROM session_audio
         WHERE session_id = ANY($1)
         ORDER BY session_id, iteration`,
        [sessionIds]
      );
      for (const row of audioRes.rows) {
        if (!audioMap[row.session_id]) audioMap[row.session_id] = [];
        audioMap[row.session_id].push({
          ...row,
          file_path: `/api/session/audio/${row.id}`,
        });
      }
    }

    const data = result.rows.map(row => ({
      ...row,
      audio_files: audioMap[row.session_id] || [],
      management_plan: JSON.stringify({
        risk_tier: row.risk_tier,
        problem_list: row.problem_list,
        triage_output: row.triage_output,
      }),
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('[DASHBOARD] Management plans error:', err);
    res.status(500).json({ error: 'Failed to load management plans' });
  }
});

// POST /api/dashboard/management-plans/:sessionId/clear — move case to history
router.post('/management-plans/:sessionId/clear', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    await pool.query(
      `UPDATE case_queue SET status = 'cleared', cleared_at = NOW()
       WHERE session_id = $1
         AND session_id IN (
           SELECT session_id FROM sessions
           WHERE data->>'nurse_id' = $2 OR data->>'nurse_id' = $3
         )`,
      [req.params.sessionId, String(req.user.user_id), `N-${req.user.user_id}`]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[DASHBOARD] Clear management plan error:', err);
    res.status(500).json({ error: 'Failed to clear management plan' });
  }
});

// POST /api/dashboard/management-plans/:sessionId/followup — ask AI about a case
router.post('/management-plans/:sessionId/followup', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const { sessionId } = req.params;
    const { question } = req.body;
    const userId = req.user.user_id;

    if (!question || !question.trim()) {
      return res.status(400).json({ error: 'Question is required' });
    }

    // Load full session context from vault
    const sessRes = await pool.query(
      `SELECT data FROM sessions WHERE session_id = $1
       AND (data->>'nurse_id' = $2 OR data->>'nurse_id' = $3)`,
      [sessionId, String(userId), `N-${userId}`]
    );
    if (!sessRes.rows.length) return res.status(404).json({ error: 'Session not found' });

    const vault = sessRes.rows[0].data;

    // Build context summary for Gemini
    const contextParts = [
      'You are a clinical decision support AI. A nurse/doctor is asking a follow-up question about a patient case. Answer based ONLY on the case data provided below. Be concise, clinical, and actionable.',
      '',
      '=== PATIENT ===',
      `Patient ID: ${vault.patient_id || 'Unknown'}`,
      `Demographics: ${JSON.stringify(vault.demographics || {}, null, 2)}`,
      '',
      '=== CHIEF COMPLAINT ===',
      JSON.stringify(vault.chief_complaint || {}, null, 2),
      '',
      '=== QUESTIONNAIRE ===',
      JSON.stringify(vault.questionnaire || {}, null, 2),
      '',
      '=== EXTRACTED MEDICAL CONCEPTS ===',
      JSON.stringify(vault.extracted_concepts || {}, null, 2),
      '',
      '=== DIFFERENTIAL DIAGNOSIS ===',
      JSON.stringify(vault.differential_table || [], null, 2),
      '',
      '=== CLARIFYING QUESTIONS ===',
      JSON.stringify(vault.clarifying_questions || {}, null, 2),
      '',
      '=== CLARIFYING FINDINGS ===',
      JSON.stringify(vault.clarifying_findings || {}, null, 2),
      '',
      '=== PROBLEM LIST ===',
      JSON.stringify(vault.problem_list || {}, null, 2),
      '',
      '=== RISK ASSESSMENT ===',
      JSON.stringify(vault.risk_assessment || {}, null, 2),
      '',
      '=== TRIAGE OUTPUT ===',
      JSON.stringify(vault.triage_output || {}, null, 2),
    ];

    // Include previous followups for conversation continuity
    const existingFollowups = vault.followups || [];
    if (existingFollowups.length > 0) {
      contextParts.push('', '=== PREVIOUS FOLLOW-UP Q&A ===');
      for (const fu of existingFollowups) {
        contextParts.push(`Q: ${fu.question}`);
        contextParts.push(`A: ${fu.answer}`);
        contextParts.push('');
      }
    }

    contextParts.push('', '=== NEW QUESTION ===', question.trim());

    const prompt = contextParts.join('\n');

    console.log(`[DASHBOARD] Followup question for ${sessionId}: "${question.trim().substring(0, 80)}"`);

    // Call Gemini
    const response = await gemini.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        temperature: 0.3,
        maxOutputTokens: 2000,
      },
    });

    // Extract answer — filter out thinking parts if present
    let answer = '';
    try {
      const parts = response.candidates?.[0]?.content?.parts || [];
      const textParts = parts.filter(p => p.text && !p.thought);
      answer = textParts.map(p => p.text).join('');
    } catch (e) {
      console.error('[DASHBOARD] Followup response parse error:', e);
    }
    if (!answer) {
      // Fallback: try the simple text accessor
      try { answer = response.text || ''; } catch { /* ignore */ }
    }
    if (!answer) {
      answer = 'Unable to generate answer. Please try again.';
    }

    // Build the followup entry
    const followupEntry = {
      question: question.trim(),
      answer: answer,
      asked_at: new Date().toISOString(),
      asked_by: `N-${userId}`,
    };

    // Append to vault JSON — first ensure followups array exists, then append
    await pool.query(
      `UPDATE sessions
       SET data = CASE
         WHEN data ? 'followups'
         THEN jsonb_set(data, '{followups}', (data->'followups') || $1::jsonb)
         ELSE jsonb_set(data, '{followups}', ('[]'::jsonb) || $1::jsonb)
       END
       WHERE session_id = $2`,
      [JSON.stringify(followupEntry), sessionId]
    );

    console.log(`[DASHBOARD] Followup answered for ${sessionId} (${answer.length} chars)`);

    res.json({ success: true, followup: followupEntry });
  } catch (err) {
    console.error('[DASHBOARD] Followup error:', err.message || err);
    res.status(500).json({ error: 'Failed to process follow-up question' });
  }
});

// GET /api/dashboard/management-plans/history — cleared cases
router.get('/management-plans/history', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const userId = req.user.user_id;
    const result = await pool.query(
      `SELECT
         cq.session_id              AS id,
         cq.session_id,
         cq.risk_tier,
         cq.status,
         cq.created_at,
         cq.cleared_at,
         s.data->>'patient_id'                          AS patient_id,
         COALESCE(
           s.data->'demographics'->>'name',
           s.data->'chief_complaint'->>'patient_name'
         )                                              AS patient_name,
         s.data->>'nurse_id'                            AS nurse_id,
         s.data->'triage_output'->'triage'->>'one_liner' AS one_liner,
         s.data->'triage_output'                        AS triage_output,
         s.data->'problem_list'                         AS problem_list,
         s.data->'clarifying_questions'                 AS clarifying_questions,
         s.data->'followups'                          AS followups,
         'live'                                         AS source
       FROM case_queue cq
       JOIN sessions s ON cq.session_id = s.session_id
       WHERE cq.status = 'cleared'
         AND (s.data->>'nurse_id' = $1 OR s.data->>'nurse_id' = $2)
       ORDER BY cq.cleared_at DESC`,
      [String(userId), `N-${userId}`]
    );

    const data = result.rows.map(row => ({
      ...row,
      management_plan: JSON.stringify({
        risk_tier: row.risk_tier,
        problem_list: row.problem_list,
        triage_output: row.triage_output,
      }),
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('[DASHBOARD] Management plan history error:', err);
    res.status(500).json({ error: 'Failed to load management plan history' });
  }
});

// ============================================================
// Analytics — cost, latency, location, failure monitoring
// ============================================================

// GET /api/dashboard/analytics/session/:sessionId — per-session breakdown
router.get('/analytics/session/:sessionId', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const { sessionId } = req.params;

    // Session metrics
    const metaRes = await pool.query('SELECT * FROM session_metrics WHERE session_id = $1', [sessionId]);
    const metrics = metaRes.rows[0] || null;

    // Per-call breakdown
    const callsRes = await pool.query(
      `SELECT call_name, call_order, stage, model_used, input_tokens, output_tokens,
              latency_ms, cost_usd, error, created_at
       FROM llm_results WHERE session_id = $1 ORDER BY call_order`,
      [sessionId]
    );

    // GPS from vault
    const vaultRes = await pool.query('SELECT data FROM sessions WHERE session_id = $1', [sessionId]);
    const vault = vaultRes.rows[0]?.data || {};
    const gps = vault.gps || {};

    res.json({
      success: true,
      session_id: sessionId,
      patient_id: metrics?.patient_id || vault.patient_id || null,
      gps: { lat: gps.lat || null, lon: gps.lon || null, district_code: gps.district_code || null },
      risk_tier: metrics?.risk_tier || vault.risk_tier || null,
      e2e_duration_ms: metrics?.e2e_duration_ms ? parseInt(metrics.e2e_duration_ms) : null,
      total_cost_usd: metrics?.total_cost_usd ? parseFloat(metrics.total_cost_usd) : null,
      total_input_tokens: metrics?.total_input_tokens || null,
      total_output_tokens: metrics?.total_output_tokens || null,
      total_latency_ms: metrics?.total_latency_ms || null,
      pipeline_status: metrics?.pipeline_status || null,
      calls: callsRes.rows.map(r => ({
        ...r,
        input_tokens: r.input_tokens ? parseInt(r.input_tokens) : null,
        output_tokens: r.output_tokens ? parseInt(r.output_tokens) : null,
        latency_ms: r.latency_ms ? parseInt(r.latency_ms) : null,
        cost_usd: r.cost_usd ? parseFloat(r.cost_usd) : null,
      })),
    });
  } catch (err) {
    console.error('[ANALYTICS] Session error:', err);
    res.status(500).json({ error: 'Failed to load session analytics' });
  }
});

// GET /api/dashboard/analytics/user/:userId — per-user aggregate
router.get('/analytics/user/:userId', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const userId = parseInt(req.params.userId, 10);

    const sessRes = await pool.query(
      `SELECT
         COUNT(*)::int AS total_sessions,
         COALESCE(SUM(total_cost_usd), 0)::numeric(10,6) AS total_cost_usd,
         COALESCE(AVG(total_cost_usd), 0)::numeric(10,6) AS avg_cost_per_session,
         COALESCE(AVG(total_latency_ms), 0)::int AS avg_latency_ms,
         COALESCE(AVG(e2e_duration_ms), 0)::int AS avg_e2e_duration_ms,
         COALESCE(SUM(total_input_tokens), 0)::int AS total_input_tokens,
         COALESCE(SUM(total_output_tokens), 0)::int AS total_output_tokens
       FROM session_metrics WHERE user_id = $1`,
      [userId]
    );

    const failRes = await pool.query(
      'SELECT COUNT(*)::int AS total_failures FROM pipeline_failures WHERE user_id = $1',
      [userId]
    );

    const s = sessRes.rows[0] || {};
    const totalSessions = s.total_sessions || 0;
    const totalFailures = failRes.rows[0]?.total_failures || 0;

    res.json({
      success: true,
      user_id: userId,
      total_sessions: totalSessions,
      total_cost_usd: parseFloat(s.total_cost_usd) || 0,
      avg_cost_per_session: parseFloat(s.avg_cost_per_session) || 0,
      avg_latency_ms: s.avg_latency_ms || 0,
      avg_e2e_duration_ms: s.avg_e2e_duration_ms || 0,
      total_input_tokens: s.total_input_tokens || 0,
      total_output_tokens: s.total_output_tokens || 0,
      total_failures: totalFailures,
      failure_rate_pct: totalSessions > 0 ? parseFloat(((totalFailures / totalSessions) * 100).toFixed(2)) : 0,
    });
  } catch (err) {
    console.error('[ANALYTICS] User error:', err);
    res.status(500).json({ error: 'Failed to load user analytics' });
  }
});

// GET /api/dashboard/analytics/overview — system-wide health
router.get('/analytics/overview', requireAuth, async (req, res) => {
  try {
    const pool = getPool();

    // Overall aggregates
    const totalRes = await pool.query(
      `SELECT
         COUNT(*)::int AS total_sessions,
         COALESCE(SUM(total_cost_usd), 0)::numeric(10,6) AS total_cost_usd,
         COALESCE(AVG(total_cost_usd), 0)::numeric(10,6) AS avg_cost_per_session,
         COALESCE(AVG(e2e_duration_ms), 0)::int AS avg_e2e_duration_ms
       FROM session_metrics`
    );

    // Today's stats
    const todayRes = await pool.query(
      `SELECT
         COUNT(*)::int AS sessions_today,
         COALESCE(SUM(total_cost_usd), 0)::numeric(10,6) AS cost_today_usd
       FROM session_metrics WHERE created_at >= CURRENT_DATE`
    );

    // Calls by model
    const modelRes = await pool.query(
      `SELECT model_used, COUNT(*)::int AS count, COALESCE(SUM(cost_usd), 0)::numeric(10,6) AS total_cost
       FROM llm_results WHERE model_used IS NOT NULL GROUP BY model_used ORDER BY count DESC`
    );

    // Avg latency by call name
    const latencyRes = await pool.query(
      `SELECT call_name, COALESCE(AVG(latency_ms), 0)::int AS avg_latency_ms, COUNT(*)::int AS count
       FROM llm_results GROUP BY call_name ORDER BY call_name`
    );

    // Sessions by risk tier
    const riskRes = await pool.query(
      `SELECT risk_tier, COUNT(*)::int AS count FROM session_metrics WHERE risk_tier IS NOT NULL GROUP BY risk_tier`
    );

    // Failure rate
    const failRes = await pool.query('SELECT COUNT(*)::int AS total FROM pipeline_failures');
    const failTodayRes = await pool.query(
      'SELECT COUNT(*)::int AS total FROM pipeline_failures WHERE created_at >= CURRENT_DATE'
    );

    const t = totalRes.rows[0] || {};
    const td = todayRes.rows[0] || {};

    res.json({
      success: true,
      total_sessions: t.total_sessions || 0,
      total_cost_usd: parseFloat(t.total_cost_usd) || 0,
      avg_cost_per_session: parseFloat(t.avg_cost_per_session) || 0,
      avg_e2e_duration_ms: t.avg_e2e_duration_ms || 0,
      sessions_today: td.sessions_today || 0,
      cost_today_usd: parseFloat(td.cost_today_usd) || 0,
      calls_by_model: Object.fromEntries(modelRes.rows.map(r => [r.model_used, { count: r.count, cost: parseFloat(r.total_cost) }])),
      avg_latency_by_call: Object.fromEntries(latencyRes.rows.map(r => [r.call_name, { avg_ms: r.avg_latency_ms, count: r.count }])),
      sessions_by_risk_tier: Object.fromEntries(riskRes.rows.map(r => [r.risk_tier, r.count])),
      total_failures: failRes.rows[0]?.total || 0,
      failures_today: failTodayRes.rows[0]?.total || 0,
      failure_rate_pct: (t.total_sessions || 0) > 0
        ? parseFloat((((failRes.rows[0]?.total || 0) / t.total_sessions) * 100).toFixed(2))
        : 0,
    });
  } catch (err) {
    console.error('[ANALYTICS] Overview error:', err);
    res.status(500).json({ error: 'Failed to load analytics overview' });
  }
});

// GET /api/dashboard/analytics/failures — recent pipeline failures
router.get('/analytics/failures', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const limit = parseInt(req.query.limit, 10) || 50;

    const failRes = await pool.query(
      `SELECT id, session_id, user_id, stage, call_name, error_code, error_msg, created_at
       FROM pipeline_failures ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );

    const fail24h = await pool.query(
      'SELECT COUNT(*)::int AS total FROM pipeline_failures WHERE created_at >= NOW() - INTERVAL \'24 hours\''
    );
    const sess24h = await pool.query(
      'SELECT COUNT(*)::int AS total FROM session_metrics WHERE created_at >= NOW() - INTERVAL \'24 hours\''
    );

    const totalFail = fail24h.rows[0]?.total || 0;
    const totalSess = sess24h.rows[0]?.total || 0;

    res.json({
      success: true,
      failures: failRes.rows,
      failure_rate_24h_pct: totalSess > 0 ? parseFloat(((totalFail / totalSess) * 100).toFixed(2)) : 0,
      total_failures_24h: totalFail,
      total_sessions_24h: totalSess,
    });
  } catch (err) {
    console.error('[ANALYTICS] Failures error:', err);
    res.status(500).json({ error: 'Failed to load failure analytics' });
  }
});

export default router;
