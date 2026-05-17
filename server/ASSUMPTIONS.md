# Assumptions Made During Backend Migration

## Architecture

1. **REST-first for mobile app**: The mobile app communicates exclusively via REST endpoints at port 3000. The WebSocket endpoint (`/session/ws`) is preserved for the full clinical pipeline but is not currently used by the mobile app.

2. **Single server**: Both the mobile app's REST API (auth, audio, dashboard, transcripts) and the CDST clinical pipeline (WebSocket + session REST) run on the same Express server at port 3000.

3. **Audio transcription via Gemini**: Since the mobile app uploads audio files (not streaming), we use Gemini's multimodal capabilities to transcribe audio instead of Deepgram real-time STT. Deepgram is still available for the WebSocket streaming path.

## Authentication

4. **OTP printed to console**: OTP codes are logged to the server console during development. In production, these should be sent via SMS gateway (e.g., Twilio, MSG91) or email.

5. **JWT tokens are self-contained**: User claims (user_id, email, role) are embedded in the JWT. No session table is used for REST auth.

6. **Password hashing**: bcryptjs with 10 salt rounds — standard for Node.js applications.

## Database

7. **New tables alongside existing schema**: `users` and `audio_records` tables are added via `db/schema_mobile.sql`. They do not modify the existing `sessions`, `patient_records`, `stg_chunks` tables from `db/schema.sql`.

8. **audio_records vs sessions**: The mobile app's audio uploads create `audio_records` (simple transcript + AI suggestion). The CDST pipeline creates `sessions` (full Vault with 3-stage clinical data). These are separate workflows that can converge later.

## Embedding Model

9. **@huggingface/transformers with MiniLM-L6-v2**: Using the same embedding model as the Python backend (`all-MiniLM-L6-v2`) for pgvector compatibility. First run downloads ~30MB model. Runs locally via ONNX — no API calls.

## Clinical Pipeline

10. **Identical clinical logic**: All prompts, schemas, validation rules, and the deterministic rule engine are direct ports from the Python code. No clinical logic was modified.

11. **Rule engine thresholds**: All vital sign thresholds, red flag terms, diagnosis hard stops, drug hard stops, and patient profile rules are loaded from `data/escalation_rules.json` — unchanged from the Python version.

12. **RAG retrieval**: pgvector cosine distance search with 0.55 similarity threshold and top-8 chunks per diagnosis — identical to Python.

## Mobile App Endpoints

13. **Endpoint mapping**: The following endpoints are implemented to match `src/services/apiService.js`:
    - `/api/auth/*` — register, login, OTP, password reset, consent
    - `/api/audio/upload` — multipart audio upload with Gemini transcription
    - `/api/audio/extract-proforma` — structured proforma extraction
    - `/api/audio/:id/prescribe` — generate prescription from transcript
    - `/api/audio/:id/retry-gemini` — re-run AI analysis
    - `/api/dashboard/summary` — dashboard counts
    - `/api/dashboard/patient-tasks` — task list
    - `/api/transcripts/*` — CRUD, grouping, Gemini suggestions, follow-up Q&A, flagging
    - `/api/session/:id/status` — session status
    - `/api/session/:id/doctor-auth` — doctor authorization
    - `/api/patient-record/:id` — patient record lookup

14. **No UI changes**: The mobile app's existing screens and navigation are not modified. All endpoint routes match the existing `apiService.js` expectations.

## Deleted Python Files

15. **Python backend removed**: The following Python files were deleted after conversion:
    - `orchestrator.py`, `history_stage.py`, `diagnosis_stage.py`, `management_stage.py`
    - `llm_client.py`, `model_config.py`, `epi_utils.py`
    - These are fully replaced by the `server/` directory.
