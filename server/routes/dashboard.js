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
// Management Plans — patient_log endpoints
// ============================================================

// GET /api/dashboard/management-plans — active plans for dashboard
router.get('/management-plans', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    // Get active patient_log entries, join with audio_records for patient name (upload flow)
    const result = await pool.query(
      `SELECT
         pl.id, pl.patient_id, pl.session_id, pl.audio_record_id, pl.source,
         pl.proforma, pl.clarifying_questions, pl.management_plan,
         pl.status, pl.created_at, pl.updated_at,
         COALESCE(ar.patient_name, s.data->>'patient_id') AS patient_name
       FROM patient_log pl
       LEFT JOIN audio_records ar ON pl.audio_record_id = ar.id
       LEFT JOIN sessions s ON pl.session_id = s.session_id
       WHERE pl.status = 'active'
       ORDER BY pl.created_at DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[DASHBOARD] Management plans error:', err);
    res.status(500).json({ error: 'Failed to load management plans' });
  }
});

// POST /api/dashboard/management-plans/:id/clear — move plan from dashboard to history
router.post('/management-plans/:id/clear', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    await pool.query(
      "UPDATE patient_log SET status = 'cleared', updated_at = NOW() WHERE id = $1",
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[DASHBOARD] Clear management plan error:', err);
    res.status(500).json({ error: 'Failed to clear management plan' });
  }
});

// GET /api/dashboard/management-plans/history — cleared plans for history page
router.get('/management-plans/history', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT
         pl.id, pl.patient_id, pl.session_id, pl.audio_record_id, pl.source,
         pl.proforma, pl.clarifying_questions, pl.management_plan,
         pl.status, pl.created_at, pl.updated_at,
         COALESCE(ar.patient_name, s.data->>'patient_id') AS patient_name
       FROM patient_log pl
       LEFT JOIN audio_records ar ON pl.audio_record_id = ar.id
       LEFT JOIN sessions s ON pl.session_id = s.session_id
       WHERE pl.status = 'cleared'
       ORDER BY pl.updated_at DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[DASHBOARD] Management plan history error:', err);
    res.status(500).json({ error: 'Failed to load management plan history' });
  }
});

// ============================================================
// Session Audio — per-iteration audio retrieval
// ============================================================

// GET /api/dashboard/session-audio/:sessionId — all iterations for a session
router.get('/session-audio/:sessionId', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query(
      'SELECT * FROM session_audio WHERE session_id = $1 ORDER BY iteration',
      [req.params.sessionId]
    );
    const isComplete = result.rows.length === 3 &&
      result.rows.every(r => r.upload_status === 'transcribed');
    res.json({
      success: true,
      session_id: req.params.sessionId,
      iterations: result.rows,
      is_complete: isComplete,
      total_duration: result.rows.reduce((sum, r) => sum + (parseFloat(r.duration_seconds) || 0), 0),
    });
  } catch (err) {
    console.error('[DASHBOARD] Session audio error:', err);
    res.status(500).json({ error: 'Failed to load session audio' });
  }
});

// GET /api/dashboard/session-audio/:sessionId/:iteration — single iteration
router.get('/session-audio/:sessionId/:iteration', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const iteration = parseInt(req.params.iteration, 10);
    if (![1, 2, 3].includes(iteration)) {
      return res.status(400).json({ error: 'Iteration must be 1, 2, or 3' });
    }
    const result = await pool.query(
      'SELECT * FROM session_audio WHERE session_id = $1 AND iteration = $2',
      [req.params.sessionId, iteration]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: `No audio found for iteration ${iteration}` });
    }
    res.json({ success: true, audio: result.rows[0] });
  } catch (err) {
    console.error('[DASHBOARD] Session audio iteration error:', err);
    res.status(500).json({ error: 'Failed to load session audio iteration' });
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
