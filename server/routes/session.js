/**
 * CDST — Session Routes
 * =====================
 * POST /api/session/:sessionId/audio-segment
 *   Receives a 12-second m4a segment from the app and buffers it in the
 *   in-memory session state. No transcription at upload time — audio is
 *   passed to Gemini in bulk at each marker press (H1/D1/M1).
 *
 * Photos are still accepted here and stored as base64 in the vault,
 * identical to the previous implementation.
 */

import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { requireAuth } from '../lib/auth.js';
import { generateWithCascade, responseText } from '../lib/llmClient.js';
import { TIER_FAST } from '../lib/modelConfig.js';
import { uploadAudioToStorage } from '../lib/storage.js';
import { _active } from '../orchestrator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'photos') {
      const imgExts = ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp'];
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (imgExts.includes(ext) || file.mimetype?.startsWith('image/')) return cb(null, true);
      return cb(new Error(`Unsupported image format: ${ext || file.mimetype}`));
    }
    const allowed = ['.m4a', '.mp4', '.wav', '.webm', '.ogg', '.mp3', '.aac'];
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (allowed.includes(ext) || file.mimetype?.startsWith('audio/')) return cb(null, true);
    return cb(new Error(`Unsupported format: ${ext || file.mimetype}`));
  },
});

const uploadFields = upload.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'photos', maxCount: 10 },
]);


const router = Router();

/**
 * POST /api/session/:sessionId/audio-segment
 * Body: multipart/form-data
 *   - audio: m4a file (required)
 *   - phase: 1 | 2 | 3 (required)
 *   - segment_index: integer (for logging)
 *   - photos: image files (optional, up to 10)
 */
router.post('/:sessionId/audio-segment', requireAuth, uploadFields, async (req, res) => {
  const { sessionId } = req.params;
  const phase = parseInt(req.body.phase || '1', 10);
  const segmentIndex = parseInt(req.body.segment_index || '0', 10);
  const audioFile = req.files?.audio?.[0];
  const photoFiles = req.files?.photos || [];

  if (!audioFile) {
    photoFiles.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    return res.status(400).json({ error: 'No audio file provided' });
  }

  try {
    // Read audio into buffer and clean up temp file immediately
    const audioBuffer = fs.readFileSync(audioFile.path);
    try { fs.unlinkSync(audioFile.path); } catch {}

    // Find the active session and append to its phase buffer
    const sessionState = _active.get(sessionId);
    if (!sessionState) {
      photoFiles.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
      return res.status(404).json({ error: 'Session not active — segment received after session close or before init' });
    }

    if (!sessionState.phaseAudioBuffers[phase]) sessionState.phaseAudioBuffers[phase] = [];
    sessionState.phaseAudioBuffers[phase].push(audioBuffer);

    const totalSegments = sessionState.phaseAudioBuffers[phase].length;
    const totalBytes = sessionState.phaseAudioBuffers[phase].reduce((s, b) => s + b.length, 0);
    console.log(`[${sessionId}] Buffered segment ${segmentIndex} phase=${phase} size=${audioBuffer.length}B total=${totalSegments} segs (${(totalBytes / 1024).toFixed(0)}KB)`);

    // Handle photos — buffer in session state; archived to S3 at session end (same pattern as audio)
    if (photoFiles.length > 0) {
      for (const f of photoFiles) {
        const photoBuffer = fs.readFileSync(f.path);
        sessionState.phasePhotoBuffers[phase].push({ buffer: photoBuffer, mimeType: f.mimetype || 'image/jpeg' });
        try { fs.unlinkSync(f.path); } catch {}
      }
      console.log(`[${sessionId}] ${photoFiles.length} photo(s) buffered in memory for phase ${phase}`);
    }

    res.json({
      ok: true,
      phase,
      segment_index: segmentIndex,
      buffered_segments: totalSegments,
    });
  } catch (err) {
    console.error(`[${sessionId}] Segment buffer error:`, err.message);
    try { if (audioFile?.path) fs.unlinkSync(audioFile.path); } catch {}
    photoFiles.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    res.status(500).json({ error: err.message });
  }
});

export default router;
