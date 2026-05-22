/**
 * CDST — Session Routes (audio upload + Gemini transcription)
 * =============================================================
 * POST /api/session/:sessionId/upload-audio
 *   - Accepts .m4a audio file upload
 *   - Transcribes via Gemini (handles Hindi/English natively)
 *   - Stores transcript in session vault
 */

import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPool, vaultRead, vaultAppendTranscript, vaultSetNested, upsertSessionAudio } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { gemini } from '../lib/llmClient.js';
import { uploadAudioToStorage } from '../lib/storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

// Ensure upload dir exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.m4a', '.mp4', '.wav', '.webm', '.ogg', '.mp3', '.aac'];
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (allowed.includes(ext) || file.mimetype?.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported audio format: ${ext || file.mimetype}`));
    }
  },
});

/**
 * Transcribe audio file using Gemini (supports Hindi/English code-switching)
 */
async function transcribeWithGemini(filePath, mimeType) {
  const audioBuffer = fs.readFileSync(filePath);
  const base64Audio = audioBuffer.toString('base64');

  const response = await gemini.models.generateContent({
    model: 'gemini-2.0-flash',
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: mimeType || 'audio/mp4',
              data: base64Audio,
            },
          },
          {
            text: 'Transcribe this audio recording of a nurse-patient clinical consultation. ' +
              'The conversation may be in Hindi, English, or a mix of both. ' +
              'Output ONLY the transcript text in the original language(s) spoken. ' +
              'Do not add any commentary, labels, or formatting — just the raw transcript.',
          },
        ],
      },
    ],
    config: {
      thinkingConfig: { thinkingBudget: 0 },
      maxOutputTokens: 8000,
    },
  });

  const transcript = response.text || '';
  const duration = audioBuffer.length / (16000 * 2); // rough estimate for display

  return { transcript: transcript.trim(), confidence: 0.95, duration };
}

const router = Router();

/**
 * POST /api/session/:sessionId/upload-audio
 * Body: multipart/form-data with 'audio' file field + 'phase' field (1, 2, or 3)
 */
router.post('/:sessionId/upload-audio', requireAuth, upload.single('audio'), async (req, res) => {
  const { sessionId } = req.params;
  const phase = parseInt(req.body.phase || '1', 10);

  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' });
  }

  console.log(`[${sessionId}] Audio upload: phase=${phase} size=${req.file.size} mime=${req.file.mimetype}`);

  try {
    const pool = getPool();

    // Check session exists
    const vault = await vaultRead(pool, sessionId);
    if (!vault) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Transcribe with Gemini
    console.log(`[${sessionId}] Transcribing phase ${phase} audio with Gemini...`);
    const { transcript, confidence, duration } = await transcribeWithGemini(
      req.file.path,
      req.file.mimetype || 'audio/mp4'
    );
    console.log(`[${sessionId}] Transcript (phase ${phase}): "${transcript.slice(0, 100)}..." (confidence=${confidence}, duration=${duration.toFixed(1)}s)`);

    // Store transcript in vault
    const phaseKey = `phase_${phase}`;
    await vaultSetNested(pool, sessionId, ['transcript_segments', phaseKey], transcript);

    // Also append to full transcript
    await vaultAppendTranscript(pool, sessionId, transcript);

    // Upload audio to Supabase Storage (Patient_audios bucket)
    let storageUrl = null;
    try {
      const { publicUrl } = await uploadAudioToStorage(
        req.file.path,
        sessionId,
        phase,
        req.file.mimetype || 'audio/mp4'
      );
      storageUrl = publicUrl;
      console.log(`[${sessionId}] Audio iteration ${phase} uploaded to Supabase Storage`);
    } catch (storageErr) {
      console.error(`[${sessionId}] Supabase Storage upload failed:`, storageErr.message);
      // Continue — transcript is still saved even if storage upload fails
    }

    // Clean up local temp file
    try { fs.unlinkSync(req.file.path); } catch {}

    // Persist metadata + transcript to session_audio table
    await upsertSessionAudio(pool, sessionId, phase, {
      file_path: storageUrl || req.file.path,
      file_size_bytes: req.file.size,
      mime_type: req.file.mimetype || 'audio/mp4',
      duration_seconds: duration,
      transcript,
      transcript_engine: 'gemini',
      upload_status: storageUrl ? 'transcribed' : 'failed',
    });
    console.log(`[${sessionId}] Audio iteration ${phase} saved to session_audio`);

    res.json({
      success: true,
      transcript,
      confidence,
      duration,
      phase,
    });
  } catch (err) {
    console.error(`[${sessionId}] Transcription error:`, err.message);
    try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: err.message });
  }
});

export default router;

