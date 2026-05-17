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

export default router;

