# Photo Storage Redesign — S3 Archival + Mobile Compression

**Status:** Implemented  
**Branch:** main  
**Date:** 2026-06-03  
**Author:** Priyank Jain

---

## Summary

Replace base64-embedded photos in the vault JSONB document with S3-archived photos
(URLs in vault), matching the pattern established for audio. Compress and resize
photos on the mobile before upload to keep Gemini inline data well under the 20 MB
per-request limit.

---

## Problem

Photos were stored as raw base64 strings directly inside the vault JSONB document
(`session_photos.phase_N: [{mimeType, data: "<base64>"}]`). This created three issues:

**1. Vault document bloat.** A phone JPEG at full resolution (4032×3024) is 2–5 MB.
As base64 (+33% overhead) embedded in JSONB, 3–5 photos per session could add 10–20 MB
to a single row. Every `vaultRead` — including fast inter-call reads — fetches the
whole document. At scale, this degrades read performance and inflates storage costs.

**2. Inconsistency with audio.** Audio is buffered in server RAM during the session
and archived to Supabase Storage at session end, with only the S3 URLs written to vault.
Photos used an entirely different pattern (immediate base64-in-vault) with no clear
reason for the difference.

**3. No compression.** `expo-image-picker` applies JPEG quality compression (`quality:
0.7`) but does not resize image dimensions. A 4032×3024 photo at quality 0.7 is still
1–3 MB. Multiple photos across phases could push Gemini inline content toward the 20 MB
per-request limit, particularly in Phase 2 where audio is also largest (~1.5–2 MB for a
3–4 minute recording).

---

## Design

Photos now follow the same lifecycle as audio:

| Step | Audio | Photos (after this change) |
|------|-------|---------------------------|
| During session | Buffered in `state.phaseAudioBuffers` (RAM) | Buffered in `state.phasePhotoBuffers` (RAM) |
| Passed to Gemini | Base64 inlineData from RAM at marker press | Base64 inlineData from RAM at marker press |
| At session end | ffmpeg concat → S3 upload → URL in vault `audio` | S3 upload per photo → URL array in vault `session_photos` |
| Vault entry | `audio.phase_1_url`, etc. | `session_photos.phase_1[N].url` |

No vault write happens during the session for photos. The vault `session_photos` field
is written once, at session end, alongside the audio archive — both fire asynchronously
and do not block the nurse receiving the management output.

Photos are passed to Gemini from `state.phasePhotoBuffers` (not the vault) via the
updated `collectAllPhotos(state)` function, which converts each buffer to base64 inline
data at the point of use — the same moment audio buffers are passed to Gemini.

---

## Mobile Compression

`expo-image-manipulator` is added as a dependency. In `handleMarker` in
`LiveConsultationScreen`, each photo is resized before upload if its longest dimension
exceeds 1280 px:

```js
const scale = 1280 / longestSide;
const compressed = await ImageManipulator.manipulateAsync(
  photo.uri,
  [{ resize: { width: Math.round(photo.width * scale) } }],
  { compress: 0.75, format: ImageManipulator.SaveFormat.JPEG }
);
```

Photos already within 1280 px skip the resize step; only the format conversion (quality
0.75 JPEG) applies. Typical output: 100–350 KB per photo.

**Gemini inline data budget per request (worst case after compression):**

| Content | Size |
|---------|------|
| Phase 2 audio (~20 segments × 96 KB) | ~1.9 MB |
| 10 photos × 300 KB | ~3.0 MB |
| **Total** | **~5 MB** |

Well within Gemini's 20 MB inline limit.

---

## Files Changed

### New files

None.

### Modified files

#### `server/lib/storage.js`
- Added `uploadPhotoToStorage(buffer, sessionId, phase, photoIndex, mimeType)`.
- Storage path: `{sessionId}/photos/phase{N}_{index}.{ext}`.
- Extension inferred from mimeType (`image/jpeg` → `.jpg`, etc.).
- Same upsert pattern as `uploadAudioToStorage`.

#### `server/orchestrator.js`
- `SessionState`: added `phasePhotoBuffers: { 1: [], 2: [], 3: [] }`.
- `collectAllPhotos(vaultCtx)` → `collectAllPhotos(state)`: reads from
  `state.phasePhotoBuffers` instead of vault; converts each buffer to base64 inline
  object for Gemini at call time.
- `concatAndArchiveAudio(sessionId, phaseAudioBuffers, dbClient)` →
  `concatAndArchiveAudio(sessionId, phaseAudioBuffers, phasePhotoBuffers, dbClient)`:
  after audio archival, iterates `phasePhotoBuffers`, uploads each photo to S3 via
  `uploadPhotoToStorage`, collects URLs, writes `session_photos` to vault as
  `{ phase_1: [{mimeType, url}], ... }`.
- `handleSessionEnd`: passes `phasePhotoBuffers` to `concatAndArchiveAudio`.
- Imported `uploadPhotoToStorage` from `./lib/storage.js`.

#### `server/routes/session.js`
- Photo handling in `POST /:sessionId/audio-segment`: replaced base64-to-vault write
  with buffer push to `sessionState.phasePhotoBuffers[phase]`. Temp file deleted
  immediately after buffering, same as audio.
- Removed now-unused imports: `getPool`, `vaultRead`, `vaultSetNested`.

#### `package.json` (root)
- Added `"expo-image-manipulator": "~13.0.6"`.

#### `src/screens/LiveConsultationScreen.js`
- Added `import * as ImageManipulator from 'expo-image-manipulator'`.
- `handleMarker`: compresses each photo before appending to FormData (resize to max
  1280 px + JPEG quality 0.75). Photos already ≤ 1280 px skip resize.
- Fixed broken endpoint reference: `upload-audio` → `audio-segment` (the old endpoint
  was removed in the audio streaming redesign but the client was not updated).
- Removed stale `uploadResult.transcript` and `uploadResult.transcription_ms` handling
  (transcripts now arrive via WebSocket `stage_complete`, not the upload response).

#### `db/schema.sql`
- Updated `session_photos` comment block to show URL-based structure and explain the
  in-memory buffering pattern.

---

## Vault structure change

Before:
```json
"session_photos": {
  "phase_1": [{ "mimeType": "image/jpeg", "data": "<~2MB base64 string>" }]
}
```

After (written at session end, alongside audio):
```json
"session_photos": {
  "phase_1": [{ "mimeType": "image/jpeg", "url": "https://.../phase1_0.jpg" }]
}
```

---

## What does NOT change

- `buildAudioContent` and `buildMultimodalContent` in `llmClient.js` — unchanged.
  They still receive `[{mimeType, data}]` objects; the conversion from buffer to base64
  happens in `collectAllPhotos` before the call.
- All stage functions (H1, H2, D1, D2, D3, M1–M4) — unchanged. They receive photos
  as inline data, same as before.
- Photo upload endpoint (`POST /api/session/:id/audio-segment`) — photos continue to
  be sent in the same multipart request as audio, no new endpoint needed.
- Photo count limit (10 per phase) — unchanged.
- Supported formats (JPEG, PNG, WebP, HEIC) — unchanged.

---

## Failure behaviour

If photo upload to S3 fails at session end, the failure is logged per photo and the
session continues — audio archival and vault writes are not blocked. The vault
`session_photos` field will contain only the successfully uploaded photos. This matches
the audio archival behaviour (a phase audio failure is logged but does not abort the
others).

If the server crashes before session end, buffered photos are lost (same as audio
buffers). The clinical record (vault) is intact — only the media files are lost.

---

## Installation

After pulling this change:

```bash
npx expo install expo-image-manipulator
```

No server-side dependency changes — `uploadPhotoToStorage` uses the existing
`@supabase/supabase-js` client already in `server/lib/storage.js`.
