/**
 * CDST — Supabase Storage helper
 * ================================
 * Uploads audio files to Supabase Storage bucket.
 * Files are organized as: <session_id>/iteration_<N>.<ext>
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'Patient_audios';

let supabase = null;

function getSupabase() {
  if (!supabase) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for storage uploads');
    }
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabase;
}

/**
 * Upload an audio file to Supabase Storage.
 * @param {string} localFilePath - Path to the local file
 * @param {string} sessionId - Session ID (used as folder name)
 * @param {number} iteration - 1, 2, or 3
 * @param {string} mimeType - MIME type of the file
 * @returns {{ storagePath: string, publicUrl: string }}
 */
export async function uploadAudioToStorage(localFilePath, sessionId, iteration, mimeType) {
  const sb = getSupabase();
  const ext = path.extname(localFilePath) || '.m4a';
  const storagePath = `${sessionId}/iteration_${iteration}${ext}`;

  const fileBuffer = fs.readFileSync(localFilePath);

  const { data, error } = await sb.storage
    .from(BUCKET)
    .upload(storagePath, fileBuffer, {
      contentType: mimeType || 'audio/mp4',
      upsert: true, // overwrite if re-uploaded
    });

  if (error) {
    console.error(`[STORAGE] Upload failed for ${storagePath}:`, error.message);
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  // Get public URL
  const { data: urlData } = sb.storage
    .from(BUCKET)
    .getPublicUrl(storagePath);

  const publicUrl = urlData?.publicUrl || '';

  console.log(`[STORAGE] Uploaded ${storagePath} (${fileBuffer.length} bytes) → ${publicUrl}`);
  return { storagePath, publicUrl };
}

/**
 * Upload a photo buffer to Supabase Storage.
 * @param {Buffer} buffer - Raw image bytes
 * @param {string} sessionId
 * @param {number} phase - 1, 2, or 3
 * @param {number} photoIndex - 0-based index within the phase
 * @param {string} mimeType - e.g. 'image/jpeg'
 * @returns {{ storagePath: string, publicUrl: string }}
 */
export async function uploadPhotoToStorage(buffer, sessionId, phase, photoIndex, mimeType) {
  const sb = getSupabase();
  const extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heic' };
  const ext = extMap[mimeType] || '.jpg';
  const storagePath = `${sessionId}/photos/phase${phase}_${photoIndex}${ext}`;

  const { error } = await sb.storage
    .from(BUCKET)
    .upload(storagePath, buffer, { contentType: mimeType || 'image/jpeg', upsert: true });

  if (error) {
    console.error(`[STORAGE] Photo upload failed for ${storagePath}:`, error.message);
    throw new Error(`Photo upload failed: ${error.message}`);
  }

  const { data: urlData } = sb.storage.from(BUCKET).getPublicUrl(storagePath);
  const publicUrl = urlData?.publicUrl || '';
  console.log(`[STORAGE] Photo uploaded ${storagePath} (${buffer.length} bytes) → ${publicUrl}`);
  return { storagePath, publicUrl };
}

/**
 * Get a signed URL for a stored audio file (if bucket is private).
 * @param {string} storagePath - e.g. "sess_abc123/iteration_1.m4a"
 * @param {number} expiresIn - seconds until expiry (default 1 hour)
 */
export async function getSignedAudioUrl(storagePath, expiresIn = 3600) {
  const sb = getSupabase();
  const { data, error } = await sb.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, expiresIn);

  if (error) {
    console.error(`[STORAGE] Signed URL failed for ${storagePath}:`, error.message);
    throw new Error(`Signed URL failed: ${error.message}`);
  }

  return data.signedUrl;
}
