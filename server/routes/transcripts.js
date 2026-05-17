/**
 * CDST — Transcript Routes
 */

import { Router } from 'express';
import { getPool } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { gemini } from '../lib/llmClient.js';

const router = Router();

// GET /api/transcripts
router.get('/', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query(
      'SELECT id, patient_name, patient_id, transcript, ai_suggestion, status, created_at FROM audio_records WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.user_id]
    );
    res.json({ transcripts: result.rows });
  } catch (err) { res.status(500).json({ error: 'Failed to load transcripts' }); }
});

// GET /api/transcripts/grouped
router.get('/grouped', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query(
      'SELECT id, patient_name, patient_id, transcript, ai_suggestion, status, created_at FROM audio_records WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.user_id]
    );
    const grouped = {};
    for (const r of result.rows) {
      const date = new Date(r.created_at).toISOString().split('T')[0];
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push(r);
    }
    res.json({ grouped });
  } catch (err) { res.status(500).json({ error: 'Failed to load grouped transcripts' }); }
});

// GET /api/transcripts/gemini-latest
router.get('/gemini-latest', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query(
      "SELECT id, patient_name, ai_suggestion, created_at FROM audio_records WHERE user_id = $1 AND ai_suggestion IS NOT NULL ORDER BY created_at DESC LIMIT 5",
      [req.user.user_id]
    );
    res.json({ suggestions: result.rows });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// GET /api/transcripts/gemini-suggestions
router.get('/gemini-suggestions', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query(
      "SELECT id, patient_name, ai_suggestion, created_at FROM audio_records WHERE user_id = $1 AND ai_suggestion IS NOT NULL ORDER BY created_at DESC",
      [req.user.user_id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// GET /api/transcripts/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query('SELECT * FROM audio_records WHERE id = $1 AND user_id = $2', [req.params.id, req.user.user_id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ transcript: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// POST /api/transcripts/:id/followup
router.post('/:id/followup', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const record = await pool.query('SELECT transcript, ai_suggestion FROM audio_records WHERE id = $1', [req.params.id]);
    if (!record.rows.length) return res.status(404).json({ error: 'Not found' });
    const { question } = req.body;

    const response = await gemini.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Context: Medical consultation transcript:\n${record.rows[0].transcript}\n\nPrevious AI analysis:\n${record.rows[0].ai_suggestion}\n\nFollow-up question from nurse:\n${question}\n\nProvide a helpful, clinically relevant answer.`,
      config: { maxOutputTokens: 1500 },
    });
    const answer = response.candidates?.[0]?.content?.parts?.[0]?.text || 'Unable to generate response';
    res.json({ success: true, answer });
  } catch (err) { res.status(500).json({ error: 'Follow-up failed' }); }
});

// POST /api/transcripts/:id/flag
router.post('/:id/flag', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    await pool.query("UPDATE audio_records SET status = 'flagged', flag_reason = $1 WHERE id = $2", [req.body.reason || 'Flagged for review', req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Flag failed' }); }
});

// POST /api/transcripts/:id/complete
router.post('/:id/complete', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    await pool.query("UPDATE audio_records SET status = 'completed' WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// POST /api/transcripts/:id/reopen
router.post('/:id/reopen', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    await pool.query("UPDATE audio_records SET status = 'pending' WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// POST /api/transcripts/proforma
router.post('/proforma', requireAuth, async (req, res) => {
  try {
    const { transcript, proformaType } = req.body;
    const response = await gemini.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Extract structured ${proformaType || 'general'} proforma data from:\n\n${transcript}`,
      config: { responseMimeType: 'application/json', maxOutputTokens: 2000 },
    });
    res.json({ success: true, data: JSON.parse(response.candidates?.[0]?.content?.parts?.[0]?.text || '{}') });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

export default router;
