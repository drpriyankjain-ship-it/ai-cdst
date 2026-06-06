# Audio Architecture Redesign — Short-Segment Streaming + Direct Gemini Audio

**Status:** Implemented  
**Branch:** main  
**Date:** 2026-06-02  
**Author:** Priyank Jain

---

## Summary

Remove Deepgram entirely. Replace real-time STT with a short-segment audio streaming
approach where the app records in 12-second m4a segments, uploads each segment to
the server immediately, and the server passes the full phase audio directly to Gemini
at each marker press (H1, D1, M1 calls). Gemini transcribes and reasons in a single
call. Full-session audio is archived to S3-compatible object storage at session end
as one concatenated file per phase.

---

## Motivation

1. **Deepgram is redundant.** H1, D1, and M1 are already LLM calls. Gemini natively
   accepts audio input and can transcribe and reason in one pass. Running Deepgram in
   parallel just to produce a text transcript that is then passed to Gemini adds latency,
   cost, and a second network dependency.

2. **Nurses do not need a real-time transcript display.** The UI shows stage outputs
   (questionnaire, differential, management plan) — not a running transcription. The
   transcript is an audit artifact, not a nurse-facing feature.

3. **Audio must be preserved at phase granularity** for clinical audit. Phase-level
   files (not individual segments) are the right archival unit.

---

## Architecture

### Recording loop (app)

- App records in 12-second m4a segments using `expo-av`.
- Each completed segment is uploaded immediately via REST to the server. Recording
  continues uninterrupted — the upload is background, non-blocking.
- The app tracks `currentPhase` (1 / 2 / 3). Segments are tagged with their phase
  at upload time.
- At each marker press, the app force-closes the in-progress segment early
  (calling `stopAndUnloadAsync()` then immediately restarting recording). This ensures
  no audio falls across a phase boundary.
- At session end, the app has all segment files locally. It triggers S3 upload
  (see below) and deletes local files after server confirmation.

### Server-side segment buffer

- New REST endpoint: `POST /session/:id/audio-segment` — accepts `phase`, `segment_index`,
  and the audio file. Reads the file into a Buffer. Appends to
  `state.phaseAudioBuffers[phase]` (an array of Buffers per phase, held in memory for
  the session lifetime).
- Segments are not stored to disk on the server beyond the temp file created by the
  multipart upload handler (deleted immediately after buffering).

### Gemini audio calls (H1, D1, M1)

m4a files cannot be byte-concatenated (the moov atom contains absolute byte offsets).
Rather than requiring ffmpeg for the pipeline calls, the server passes each segment as
a separate `inlineData` audio part in the Gemini content array. Gemini processes
multiple audio parts in sequence and treats them as a continuous recording.

New helper in `server/lib/llmClient.js`:

```js
buildAudioContent(prompt, audioBuffers, mimeType = 'audio/mp4', photos = [])
```

- `audioBuffers`: array of Buffers, one per segment
- Builds a parts array: `[seg0_inlineData, seg1_inlineData, ..., photos..., text_prompt]`
- Falls back to `buildMultimodalContent(prompt, photos)` if `audioBuffers` is empty

All three phase sizes are well within Gemini's 20 MB inline limit:

| Phase | Duration | Approx. size @ 64 kbps mono |
|-------|----------|-----------------------------|
| Phase 1 (Marker A) | ~30 s | ~240 KB |
| Phase 2 (Marker B) | ~3–4 min | ~1.5–2 MB |
| Phase 3 (Marker C) | ~1–2 min | ~0.5–1 MB |

### Transcript output from H1 / D1 / M1

Gemini is already processing the full phase audio for each call. A `transcript` field
is added to the JSON output schema for H1, D1, and M1. Gemini outputs a verbatim
transcription of the audio alongside its structured clinical extraction — no second call,
no extra audio processing cost.

The transcript is written to the Vault under `transcript_segments.phase_1`,
`transcript_segments.phase_2`, `transcript_segments.phase_3` — the same keys that
Deepgram previously populated. Downstream stage calls that read transcript text for
context (H2, D2, D3, M2, M3, M4) continue to work unchanged.

**Note:** Gemini transcription quality for Hindi/Bengali-accented medical speech must
be validated against Deepgram's medical model output before relying on it clinically.
Run comparison sessions during initial field pilot.

### S3 archival (session end)

Individual segments cannot be byte-concatenated into a valid m4a. The server uses
`fluent-ffmpeg` (with `@ffmpeg-installer/ffmpeg`) to produce one properly muxed m4a
file per phase before uploading to S3.

Upload paths:
```
sessions/{sessionId}/phase1.m4a
sessions/{sessionId}/phase2.m4a
sessions/{sessionId}/phase3.m4a
```

The Vault `audio` field is updated with the three S3 URLs and `retain_until` (3650 days
from upload date). When all three uploads confirm, the server sends `audio_confirmed`
over the WebSocket. The app deletes local segment files on receipt.

Fallback: if ffmpeg concat fails for a phase, the server uploads the segments individually
(`phase1_001.m4a`, `phase1_002.m4a`, …) and records a `manifest.json` alongside them.
This ensures audio is never lost even if concatenation fails.

### Fallback (marker pressed, buffer empty)

1. **First attempt fails** (buffer empty or Gemini error): server sends `retry_marker`
   to client. App prompts nurse to press again.
2. **Second attempt fails**: for Marker A / H1 only, server returns a static generic
   proforma (`data/generic_proforma.json`) — covers presenting complaint (SOCRATES),
   associated symptoms, functional impact, pregnancy/LMP, medications, allergies. Session
   continues; nurse uses the generic questionnaire.
3. **D1 / M1 second failure**: no meaningful generic fallback exists for differential
   or management. Server returns a structured error with nurse instruction:
   *"AI analysis unavailable — use clinical judgment. This consultation is flagged for
   full doctor review."* Session continues; doctor review queue is notified immediately.

---

## Files changed

### New files

| File | Purpose |
|------|---------|
| `data/generic_proforma.json` | Static fallback questionnaire for H1 failure — SOCRATES, associated symptoms, functional impact, pregnancy/LMP, medications, allergies |

### Modified files

#### `server/lib/llmClient.js`
- Added and exported `buildAudioContent(prompt, audioBuffers, mimeType, photos)`.
- Builds a Gemini parts array: `[seg0_inlineData, seg1_inlineData, …, photos…, text_prompt]`.
- Falls back to `buildMultimodalContent(prompt, photos)` when `audioBuffers` is empty.

#### `server/stages/historyStage.js`
- `extractChiefComplaint(transcriptSegment, …)` → `extractChiefComplaint(audioBuffers, …)`
- Prompt updated to address audio directly.
- `SCHEMA_CHIEF_COMPLAINT`: `"transcript"` field added (verbatim phase 1 transcription).
- Orchestrator writes returned `transcript` to `transcript_segments.phase_1` in Vault.

#### `server/stages/diagnosisStage.js`
- `extractMedicalConcepts(transcriptSegment, …)` → `extractMedicalConcepts(audioBuffers, …)`
- Same pattern as H1.
- `SCHEMA_MEDICAL_CONCEPTS`: `"transcript"` field added → written to `transcript_segments.phase_2`.

#### `server/stages/managementHelpers.js`
- `SCHEMA_CLARIFYING_FINDINGS`: `"transcript"` field added.

#### `server/stages/managementStage.js`
- `extractClarifyingFindings(transcriptSegment, …)` → `extractClarifyingFindings(audioBuffers, …)`
- Uses `buildAudioContent()`.
- `runManagementStage(sessionId, transcriptSegment, …)` → `runManagementStage(sessionId, audioBuffers, …)`
- Returned `transcript` written to `transcript_segments.phase_3` in Vault.

#### `server/orchestrator.js`
- **Removed:** `DeepgramClient`, `startDeepgramSTT()`, `DEEPGRAM_API_KEY`, `DEEPGRAM_LANGUAGE`,
  `vaultAppendTranscript()` calls, `transcript_full` in-memory accumulation, `ringBuffer`,
  `phase1End`/`phase2End` slice tracking, `static fromVault()`.
- **Added imports:** `fs`, `os`, `path`, `uploadAudioToStorage`.
- **Exported `_active` Map** so the session route can look up the active session by ID.
- **`SessionState` — new fields:** `phaseAudioBuffers: { 1: [], 2: [], 3: [] }`,
  `currentPhase: 1`, `markerRetryCount: { 1: 0, 2: 0, 3: 0 }`.
- **`handleMarkerA`:** passes `state.phaseAudioBuffers[1]` to `runHistoryStage()`; retry
  logic (empty buffer → `retry_marker` WS message; second failure → generic proforma);
  sets `state.currentPhase = 2`.
- **`handleMarkerB`:** same pattern with `phaseAudioBuffers[2]`; `currentPhase = 3`.
- **`handleMarkerC`:** same pattern with `phaseAudioBuffers[3]`.
- **Added `concatAndArchiveAudio(sessionId, phaseAudioBuffers, dbClient)`:** fires at
  session end; uses `fluent-ffmpeg` to produce one properly muxed `phase_N.m4a` per phase;
  uploads each to Supabase Storage under `sessions/{sessionId}/phase{N}.m4a`; updates
  Vault `audio` field with three phase URLs, `upload_status: 'complete'`, and
  `retain_until` (3650 days from upload). Falls back to uploading the first segment if
  ffmpeg is unavailable.
- **`handleSessionEnd`:** fires `concatAndArchiveAudio()` async in background after
  closing session.

#### `server/routes/session.js`
- Replaced `POST /:sessionId/upload-audio` (which ran Gemini transcription per segment)
  with `POST /:sessionId/audio-segment`.
- New endpoint: reads audio into Buffer, deletes temp file, looks up active session via
  the exported `_active` Map, appends to `sessionState.phaseAudioBuffers[phase]`.
- Photos still handled here (stored as base64 in Vault), unchanged.
- Returns `{ ok: true, phase, segment_index, buffered_segments }`.

#### `server/package.json`
- Removed: `"@deepgram/sdk": "^5.0.0"`
- Added: `"fluent-ffmpeg": "^2.1.3"`, `"@ffmpeg-installer/ffmpeg": "^1.1.0"`

#### `src/services/apiService.js`
- Added `uploadAudioSegment(sessionId, phase, segmentIndex, uri, photoUris = [])`.
- Posts to `/api/session/{sessionId}/audio-segment` with multipart form data.
- 30-second timeout per segment.

#### `src/screens/RecordPage.js`
- Added `SEGMENT_DURATION_MS = 12000` constant and extracted `RECORDING_OPTIONS`.
- Added refs: `segmentTimerRef`, `segmentIndexRef`, `segmentUrisRef`, `segmentUploadCountRef`.
- Added `uploadSegmentBackground(uri, index)` — fire-and-forget upload via existing
  `uploadAudio` (REST-based flow; session-based flow uses `apiService.uploadAudioSegment`).
- Added `startNextSegment()` — creates recording, schedules rotation at 12 s, recurses.
- `startRecording()` now resets segment state and calls `startNextSegment()`.
- `handleStopRecording()` clears segment timer, stops loop, collects final segment URI,
  uploads it background, then continues with existing photo-prompt/upload flow.
- Cleanup added to navigation `useEffect`.

**Note on RecordPage vs LiveConsultationScreen:** `RecordPage.js` is the legacy REST-based
recording flow. The session/WebSocket flow uses `LiveConsultationScreen` (not yet updated).
`uploadAudioSegment()` is available in `apiService.js` for LiveConsultationScreen to use.

#### `CLAUDE.md`
- Removed Deepgram references from tech stack and session lifecycle.
- Updated consultation flow, session lifecycle, and REST endpoints to reflect the
  short-segment approach.

---

## New dependencies

| Package | Where | Purpose |
|---------|-------|---------|
| `fluent-ffmpeg` | server | m4a concatenation for S3 archival |
| `@ffmpeg-installer/ffmpeg` | server | Bundles ffmpeg binary (no host install required) |

No new mobile dependencies. `expo-av` already supports the recording API needed.

---

## What does NOT change

- H2, D2, D3, M2, M3, M4 — take structured data inputs, unchanged.
- Vault schema keys — `transcript_segments.phase_1/2/3` now written from Gemini
  output rather than Deepgram, but the keys are the same.
- WebSocket protocol — markers, session init, `stage_complete`, `session_closed`
  messages unchanged.
- RAG, rule engine, formulary injection, risk assessment — unchanged.
- `modelConfig.js` — all TIER_FAST models (H1/D1/M1) support audio inline input.
- `thinkingBudget: 0` remains on H1/D1/M1 — keeps latency low.

---

## Implementation order (all complete)

1. ✅ `server/lib/llmClient.js` — `buildAudioContent()` helper
2. ✅ `server/stages/historyStage.js` — H1 signature + prompt + transcript field
3. ✅ `server/stages/diagnosisStage.js` — D1 same pattern
4. ✅ `server/stages/managementHelpers.js` — transcript field in SCHEMA_CLARIFYING_FINDINGS
5. ✅ `server/stages/managementStage.js` — M1 same pattern
6. ✅ `server/orchestrator.js` — Deepgram removed, phase buffers, retry logic, ffmpeg archival
7. ✅ `server/routes/session.js` — `audio-segment` buffer endpoint (replaced `upload-audio`)
8. ✅ `server/package.json` — Deepgram removed, fluent-ffmpeg + ffmpeg-installer added
9. ✅ `data/generic_proforma.json` — fallback questionnaire
10. ✅ `src/services/apiService.js` — `uploadAudioSegment()`
11. ✅ `src/screens/RecordPage.js` — rolling segment recording loop
12. ✅ `CLAUDE.md` — documentation updated

---

## Open questions (not blocking implementation)

- **Transcription quality:** Validate Gemini ASR quality for Hindi/Bengali-accented
  medical speech before relying on `transcript_segments` for anything clinical.
  Compare against archived Deepgram output on the same sessions during field pilot.

- **ffmpeg on server:** `@ffmpeg-installer/ffmpeg` bundles a static binary (~60 MB).
  If the deployment environment has ffmpeg available as a system binary, switch to
  that to reduce bundle size.

- **Segment size tuning:** 12 seconds at 64 kbps mono = ~96 KB per segment. This
  means Phase 2 (~3–4 min) generates ~15–20 segments. If the per-segment upload
  overhead becomes measurable on a poor rural connection, consider increasing to 20s
  segments.
