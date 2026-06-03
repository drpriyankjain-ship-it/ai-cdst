/**
 * CDST — Audio Routes
 * ====================
 * Audio upload, transcription via Gemini, proforma extraction, and prescription generation.
 * Bridges the mobile app's REST upload flow with the CDST clinical pipeline.
 */

import { Router } from 'express';
import multer from 'multer';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

import { getPool } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { gemini } from '../lib/llmClient.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = join(__dirname, '..', 'uploads');
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 50 * 1024 * 1024 } });
const router = Router();

// POST /api/audio/upload
router.post('/upload', requireAuth, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    const pool = getPool();
    const userId = req.user.user_id;
    const patientName = req.body.patientName || 'Unknown';
    const patientId = req.body.patientId || '';
    const recordId = uuidv4();

    // Transcribe with Gemini
    const audioBuffer = readFileSync(req.file.path);
    const base64Audio = audioBuffer.toString('base64');

    const transcribeResponse = await gemini.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          parts: [
            { inlineData: { mimeType: req.file.mimetype || 'audio/m4a', data: base64Audio } },
            { text: 'Transcribe this audio recording of a nurse-patient medical consultation. Include all spoken content accurately. If the audio is in Hindi or another Indian language, transcribe and translate to English.' },
          ],
        },
      ],
    });

    const transcript = transcribeResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Generate AI suggestions
    const suggestResponse = await gemini.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `You are a clinical decision support system. Based on this medical consultation transcript, provide:\n1. A brief clinical summary\n2. Preliminary assessment\n3. Suggested next steps\n4. Any red flags or concerns\n\nTranscript:\n${transcript}`,
      config: { responseMimeType: 'application/json', responseSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' }, assessment: { type: 'string' },
          suggestions: { type: 'array', items: { type: 'string' } },
          redFlags: { type: 'array', items: { type: 'string' } },
          diagnosis: { type: 'string' },
        },
        required: ['summary', 'assessment', 'suggestions'],
      }, maxOutputTokens: 2000 },
    });

    let aiSuggestion = {};
    try { aiSuggestion = JSON.parse(suggestResponse.candidates?.[0]?.content?.parts?.[0]?.text || '{}'); } catch { aiSuggestion = { summary: 'AI analysis pending' }; }

    // Store in DB
    await pool.query(
      `INSERT INTO audio_records (id, user_id, patient_name, patient_id, file_path, transcript, ai_suggestion, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', NOW())`,
      [recordId, userId, patientName, patientId, req.file.path, transcript, JSON.stringify(aiSuggestion)]
    );

    res.json({
      success: true, id: recordId, transcript,
      geminiSuggestion: aiSuggestion, status: 'completed',
    });
  } catch (err) {
    console.error('[AUDIO] Upload error:', err);
    res.status(500).json({ error: 'Audio processing failed', details: err.message });
  }
});

// POST /api/audio/extract-proforma
router.post('/extract-proforma', requireAuth, async (req, res) => {
  try {
    const { transcript, proformaType } = req.body;
    const response = await gemini.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Extract structured medical data from this transcript for a ${proformaType || 'general'} proforma.\n\nTranscript:\n${transcript}`,
      config: { responseMimeType: 'application/json', maxOutputTokens: 3000 },
    });
    const data = JSON.parse(response.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
    res.json({ success: true, proformaData: data });
  } catch (err) {
    console.error('[AUDIO] Proforma error:', err);
    res.status(500).json({ error: 'Proforma extraction failed' });
  }
});

// POST /api/audio/:id/prescribe
router.post('/:id/prescribe', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const record = await pool.query('SELECT transcript, ai_suggestion FROM audio_records WHERE id = $1', [req.params.id]);
    if (!record.rows.length) return res.status(404).json({ error: 'Record not found' });

    const response = await gemini.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Based on this consultation, generate a prescription:\n\nTranscript:\n${record.rows[0].transcript}\n\nAssessment:\n${record.rows[0].ai_suggestion}`,
      config: { responseMimeType: 'application/json', maxOutputTokens: 2000 },
    });
    const prescription = JSON.parse(response.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
    res.json({ success: true, prescription });
  } catch (err) { res.status(500).json({ error: 'Prescription generation failed' }); }
});

// POST /api/audio/:id/retry-gemini
router.post('/:id/retry-gemini', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const record = await pool.query('SELECT transcript FROM audio_records WHERE id = $1', [req.params.id]);
    if (!record.rows.length) return res.status(404).json({ error: 'Record not found' });

    const suggestResponse = await gemini.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Analyze this medical consultation transcript and provide clinical suggestions:\n\n${record.rows[0].transcript}`,
      config: { responseMimeType: 'application/json', maxOutputTokens: 2000 },
    });
    const aiSuggestion = JSON.parse(suggestResponse.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
    await pool.query('UPDATE audio_records SET ai_suggestion = $1 WHERE id = $2', [JSON.stringify(aiSuggestion), req.params.id]);
    res.json({ success: true, geminiSuggestion: aiSuggestion });
  } catch (err) { res.status(500).json({ error: 'Retry failed' }); }
});

export default router;
