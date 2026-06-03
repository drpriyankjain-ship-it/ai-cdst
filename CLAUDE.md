# CDST — Clinical Decision Support Tool
## Architecture Reference for Claude Code

This document is the authoritative record of all design decisions made during
architecture and initial development. Read this before writing any code.

---

## What this system does

A mobile app for nurses working in remote rural West Bengal, India, where patients
have no direct access to doctors. The nurse conducts a structured audio consultation.
The app transcribes audio continuously, fires three pipeline stages at specific moments,
and produces a triage decision, prescription, and risk-assessed management plan that
a remote doctor reviews asynchronously.

---

## Repository structure

```
cdst/
├── server/                         # Live Node.js backend (Express + express-ws)
│   ├── index.js                    # Entry point — port 3000, mounts routes + WS
│   ├── orchestrator.js             # WebSocket session orchestrator — central component
│   ├── stages/
│   │   ├── historyStage.js         # Two-call pipeline, no RAG
│   │   ├── diagnosisStage.js       # Three-call pipeline, no RAG
│   │   ├── managementStage.js      # Four-call pipeline, RAG in Call 2
│   │   └── managementHelpers.js    # Validation, rule engine, schema constants
│   ├── lib/
│   │   ├── llmClient.js            # Shared Gemini client (reads GEMINI_API_KEY)
│   │   ├── modelConfig.js          # LLM model assignments for all 9 pipeline calls — edit here
│   │   ├── epiUtils.js             # Shared epi utilities
│   │   ├── db.js                   # Postgres/Supabase connection pool + vault helpers
│   │   ├── auth.js                 # JWT sign/verify middleware
│   │   ├── email.js                # OTP email delivery
│   │   └── storage.js              # S3-compatible audio storage
│   ├── routes/
│   │   ├── auth.js                 # POST /api/auth/...
│   │   ├── audio.js                # POST /api/audio/... (audio upload + transcription)
│   │   ├── session.js              # GET/POST /api/session/...
│   │   ├── dashboard.js            # GET /api/dashboard/...
│   │   └── transcripts.js          # GET /api/transcripts/...
│   └── scripts/
│       ├── setupDb.js              # Create all tables + indexes against Supabase/Postgres
│       └── seedUser.js             # Seed a test user
├── src/                            # React Native mobile app (Expo 54)
│   ├── screens/                    # LiveConsultationScreen, HistoryPage, TranscriptPage, etc.
│   ├── components/                 # Shared UI components
│   ├── navigation/                 # AppNavigator, AuthNavigator
│   ├── services/                   # wsService.js, apiService.js, authService.js
│   ├── context/AuthContext.js
│   └── styles/
├── web/                            # Vanilla JS web frontend (served by server/index.js)
│   ├── index.html
│   ├── app.js / audio.js / api.js / styles.css
│   └── screens/                    # dashboard, login, record, history, about
├── data/
│   ├── epi_prior_wb.json           # All 23 WB districts, 4 seasonal buckets
│   ├── bedside_tools.json          # Constraint list for nurse-available tools
│   ├── formulary_wb.json           # SHC-HWC essential medicines (MoHFW Operational Guidelines, Annexures 1 & 2)
│   ├── escalation_rules.json       # Rule engine configuration (MO reviewed)
│   ├── must_not_miss.json          # Must-not-miss diagnoses list (MO reviewed) — loaded by Diagnosis Stage
│   └── rag_disease_aliases.json    # Disease alias map for STG ingestion disease tagging
├── db/
│   └── schema.sql                  # Postgres schema reference
├── docs/
│   ├── decisions/
│   │   ├── DECISIONS_OPEN.md       # All unresolved questions — grouped by who must answer them
│   │   └── adr/
│   │       ├── README.md           # ADR index — read before proposing architectural changes
│   │       ├── 001-agentic-patterns.md
│   │       ├── 002-history-intake-approach.md
│   │       ├── 003-problem-oriented-management.md
│   │       ├── 004-model-tier-selection.md
│   │       └── 005-diagnosis-stage-ttft.md
│   ├── arch/
│   │   ├── cdst_full_pipeline.html           # Full system architecture diagram
│   │   ├── continuous_stream_pipeline.html   # Audio streaming architecture diagram
│   │   ├── cdst_engineering_overview.html    # Engineering overview diagram
│   │   ├── rag_brief.md                      # Engineering brief for RAG setup
│   │   └── rag_implementation_status.md      # Corpus ingestion status and smoke test results
│   ├── clinical/
│   │   ├── MO_REVIEW_CHECKLIST.md            # Site onboarding checklist for Medical Officers
│   │   ├── bedside_tools_crosscheck.md       # Guideline citations for bedside_tools.json
│   │   ├── high_risk_escalation_rules.md     # Human-readable guide to escalation_rules.json
│   │   ├── RAG source/                       # Approved source PDFs for STG ingestion
│   │   └── source-materials/                 # Raw MoHFW guideline PDFs
│   └── validation/
│       ├── validation_1_english.txt          # Test transcript (patient FKP1192)
│       └── run_NNN_<patient>_<date>.md       # Per-run narrative notes
├── scripts/
│   ├── ingest_stg.py               # STG embedding pipeline (chunk → embed → pgvector)
│   ├── query_stg.py                # Smoke-test retrieval against the live corpus
│   └── rag_source_manifest.json    # Stable source labels for the ingestion pipeline
├── evals/
│   └── validate_pipeline.py        # End-to-end pipeline eval harness
├── python_pipeline/                # Archived — original Python implementation. Not in active use.
│                                   # Live pipeline is server/. Do not make changes here.
├── App.js                          # React Native entry point
└── CLAUDE.md                       # This file
```

---

## Tech stack

| Component | Choice |
|---|---|
| Backend | Node.js — Express + express-ws |
| Database | Postgres + pgvector (hosted on Supabase) |
| Object storage | S3-compatible (audio files) |
| STT | Deepgram streaming WebSocket |
| LLM | Gemini via Google Gemini API (`@google/genai` SDK) — model assignments in `server/lib/modelConfig.js` |
| Embeddings | sentence-transformers/all-MiniLM-L6-v2 (384-dim) |
| Mobile | React Native (Expo 54) |
| Web | Vanilla JS — served as static files by the Node.js server |
| Auth | JWT (HS256), role-based: nurse / doctor / admin; OTP email verification |
| Target region | All India (piloting in West Bengal — 23 districts) |

---

## The consultation flow

A single WebSocket opens when the nurse starts the session and stays open
until the session ends. Audio is uploaded in chunks via REST (`/api/audio/`),
transcribed via Deepgram, and the transcript is accumulated server-side.
The nurse presses three buttons:

**Marker A** — ~30 seconds in. Patient has stated name, age, village, chief
complaint, duration. Nothing else is known. History Stage fires.
Target: questionnaire on screen within 1.5s.
Actual measured: H1 ~0.9s + H2 ~1.3s = full questionnaire in ~2.2s. No streaming.

**Marker B** — after 3-4 minute structured interview. Diagnosis Stage fires.
Target: differential within 1.5s. Actual: D1 ~4.9s + D2 ~3.2s + D3 ~1.4s = ~9.5s total.
Target not met; see ADR 005 for options.

**Marker C** — after 1-2 minute clarifying questions phase. Management Stage
fires. Full pipeline ~22s (M3+M4 run in parallel).

Button presses send a lightweight JSON control message over the same WebSocket:
`{ "type": "marker", "marker": "history_complete", "t": 94.3 }` where t is
session-relative seconds.

The nurse never reviews or discards recordings. Audio is uploaded in chunks during
the session and assembled post-session. The complete audio is uploaded to S3 in the
background (async, does not block the nurse) with a 3650-day (10-year) retention policy.

---

## Session orchestrator (server/orchestrator.js)

The central component — an Express WebSocket server that owns the full session
lifecycle. All stage functions are called directly from the orchestrator (not via
HTTP); the orchestrator imports from historyStage, diagnosisStage, and managementStage.

### WebSocket protocol

**Client → Server:**
```
{ "type": "init",      "patient_id": "P-00123", "nurse_id": "N-001",
  "gps": { "district": "Murshidabad", "district_code": "WB_MSD",
           "lat": 24.18, "lng": 88.27 } }

{ "type": "marker",    "marker": "history_complete|diagnosis_complete|management_complete",
  "t": 94.3 }

{ "type": "session_end",    "t": 742.0 }

{ "type": "audio_uploaded", "url": "s3://...", "codec": "opus",
  "duration_seconds": 742, "size_bytes": 1893422 }

{ "type": "pong",           "ping_ts": 1234567890 }

{ "type": "transcription_timing", "transcription_ms": 340 }
```

**Server → Client:**
```
{ "type": "session_ready",   "session_id": "sess_abc123", "is_new_patient": true }
{ "type": "ping",            "ping_ts": 1234567890 }
{ "type": "transcript",      "text": "...", "is_final": true }
{ "type": "stage_complete",  "stage": "history|diagnosis|management", "data": {...} }
{ "type": "session_closed",  "risk_tier": "low|high" }
{ "type": "audio_confirmed" }
{ "type": "error",           "code": "AUTH_FAILED|SESSION_NOT_FOUND|...", "message": "..." }
```

Note: there are no `stage_token` streaming messages. All stage calls are
non-streaming — the full structured result arrives in `stage_complete`.
Audio is not sent over the WebSocket; it goes via REST (`POST /api/audio/`).

### Authentication

JWT Bearer token accepted from the `Authorization` header OR from a `?token=`
query parameter at WebSocket upgrade time (React Native WebSocket does not
reliably send custom headers).
`JWT_SECRET` and `JWT_ALGORITHM` are environment variables.

### Session lifecycle

1. **Init** — client sends `init` with patient_id, nurse_id, GPS.
   Orchestrator loads patient record from `patient_records` (empty object for new
   patients). Calls `vaultInit()` to create the Vault document. Returns
   `session_ready` with a generated session_id, then immediately sends a `ping`
   to measure network RTT.

2. **Audio** — audio chunks are uploaded via `POST /api/audio/` (REST, not
   WebSocket). The route appends transcript segments to the Vault. Each upload
   response includes transcription timing which the client reports back via
   `transcription_timing`.

3. **Deepgram transcripts** — `DeepgramClient` receives final and interim
   transcript events. Final transcripts are appended to `state.transcriptFull` in
   memory and flushed to `sessions.data.transcript_full` in Postgres via
   `vaultAppendTranscript()`.

4. **Marker A (history_complete)** — reads phase 1 transcript from Vault.
   Writes `marker_a_at` to Vault. Runs History Stage sequentially:
   - H1: extracts chief complaint
   - H2: generates questionnaire + validates it; writes to Vault
   Sends `stage_complete` with the full questionnaire JSON.

5. **Marker B (diagnosis_complete)** — reads phase 2 transcript from Vault.
   Writes `marker_b_at`. Runs Diagnosis Stage sequentially:
   - D1: extracts medical concepts; updates pregnancy status in demographics if found
   - D2: generates differential; writes to Vault
   - D3: generates clarifying questions (needs validated DDx); writes to Vault
   Sends `stage_complete` with differential + clarifying questions.

6. **Marker C (management_complete)** — reads phase 3 transcript from Vault.
   Writes `marker_c_at`. Runs Management Stage (`runManagementStage`):
   - M1 + RAG retrieval in parallel via `Promise.all`
   - M2: problem list + prescription
   - M3 + M4 in parallel via `Promise.all`
   - Rule engine: deterministic safety check
   Sends `stage_complete` with `triage_output`, `risk_tier`, `problem_list`,
   `risk_assessment`. HIGH risk triggers `notifyDoctor()` (stub — replace with FCM/SMS).
   On completion, writes a `patient_log` row and a `session_metrics` aggregate.

7. **Session end** — writes `session_ended_at`, `session_duration_seconds`, and
   final `transcript_segments` to Vault. Audio upload is the device's
   responsibility; when it calls `audio_uploaded`, the Vault receives the S3 URL
   and a `retain_until` date (3650 days / 10 years from upload).

### REST endpoints

- `POST /api/auth/...` — login, register, OTP verification
- `POST /api/audio/...` — audio chunk upload and transcription
- `GET  /api/session/:id/status` — stage completion status and risk tier
- `POST /api/session/:id/doctor-auth` — approve / modify / reject with optional notes
- `GET  /api/dashboard/...` — case list for doctor review queue
- `GET  /api/transcripts/...` — session transcript retrieval
- `GET  /health` — liveness check

---

## The three stages

### History Stage (server/stages/historyStage.js)  [fixed pipeline]

**Two LLM calls, no RAG.**

Call 1 (~900ms): Extracts chief complaint from the ~30s phase 1 transcript.
At this point only name, age, village, chief complaint, and duration are known.
Nothing else. The schema has many null fields by design.

Call 2 (~1.3s): Generates a structured contextualised questionnaire.
Uses `buildPatientRecordContext()` to determine field by field what is already
known vs what needs to be collected. A new patient gets a full intake (past medical
history, family history, social history, medications, allergies). A returning patient
gets a short verification pass for changed fields only. The nurse never specifies
visit type — the stage reasons it from the patient record state.

Supports clinical photos: if `session_photos` are present in the Vault, they are
passed as multimodal content to both H1 and H2 calls via `buildMultimodalContent()`.

The questionnaire output includes `patient_record_fields` — a structured object
the Diagnosis Stage's concept extractor uses as a schema for what to populate
from the phase 2 transcript.

### Diagnosis Stage (server/stages/diagnosisStage.js)  [fixed pipeline]

**Three LLM calls, no RAG.**

Call 1 (~900ms): Extracts structured medical concepts from the phase 2 transcript.
Negatives are as important as positives. Ambiguous or qualified patient answers
(e.g. "sometimes", "not sure") are captured separately in `uncertain_findings`
rather than collapsed into positives or negatives. Prior encounter history is read
from `patient_record.encounters` in the Vault. If pregnancy status is detected,
it is immediately written to `demographics.pregnancy_status` in the Vault before D2
runs (pregnancy affects differential and rule engine).

Call 2 (~3.2s): Generates ranked differential (4-6 conditions) using
LLM general knowledge + two-layer epidemiological prior. No RAG. Layer 1 is a
checklist of common presentations to consider — not a mandatory anchor. The
presenting complaint always dominates both layers. `discriminating_tests` records
all clinically relevant investigations (bedside, lab, or imaging); Call 3 filters
to what is bedside-feasible.

Call 3 (~1.4s): Generates gap analysis and clarifying questions,
constrained to tools in `bedside_tools.json`. `uncertain_findings` from Call 1
are surfaced as priority re-ask candidates if discriminating for the differential.

**Must-not-miss diagnoses** are loaded at runtime from `data/must_not_miss.json`
(34 diagnoses across 8 categories, MO-maintained). The flag is enforced
**deterministically** in `validateDifferential()` via bidirectional substring
matching — not by LLM instruction. This ensures the flag is reliably set even
when model outputs vary across versions or providers.

**Canonical differential schema — 11 fields, always present:**
`rank`, `disease`, `icd10_code`, `probability`, `supporting_features`, `against`,
`must_not_miss`, `regionally_specific`, `reasoning`, `discriminating_tests`
(all test types — bedside, lab, imaging), `referral_required`.

`validateDifferential()` runs after every LLM differential call. Missing fields
get safe defaults and a logged warning. `icd10_code` default is `R69` (illness
unspecified). The must_not_miss override is one-directional: it can only set
`true`, never downgrade a model-returned `true` to `false`.

### Management Stage (server/stages/managementStage.js)  [fixed pipeline — planned: agentic]

**Four LLM calls, RAG in Call 2.**

Call 1 (~900ms) + RAG retrieval run in parallel via `Promise.all`:
- Call 1 extracts clarifying findings from phase 3 transcript
- RAG retrieves STG chunks for ALL DDx diagnoses + known established conditions
  (provisional diagnosis not yet determined; any DDx entry could be selected)

Call 2 (~6.5s): Generates a **problem list** — all distinct clinical issues
in the encounter: the acute presenting complaint plus any established conditions,
incidental findings, or deferred items. Each problem has type
(`acute_new | established | incidental | deferred`), an assessment, and a plan.
Every prescription item carries a `for_problem` attribution integer.
STG context from RAG grounds the prescription. Local formulary constrains drug
selection. `stg_source` must be cited per drug. Output key: `problem_list`.

`validateProblemList()` runs after Call 2. Sanitizes degenerate ICD-10 strings
(e.g. repetition loops from constrained generation), truncates oversized fields,
fills missing required fields with safe defaults, and normalises confidence values.
Analogous to `validateDifferential()` in the Diagnosis Stage.

Diagnostic confidence (`high|moderate|low`) is extracted directly from Call 2's
`problem_list[first_acute].assessment.confidence` in JavaScript and passed to the
rule engine as `acuteConfidence` — not re-derived from Call 3 to avoid LLM relay errors.

**Calls 3 and 4 run in parallel via `Promise.all`** — both depend only on Call 2.

Call 3 (~8s): Five-dimension risk assessment — no RAG, pure LLM reasoning:
1. Diagnostic uncertainty — what if the acute provisional Dx is wrong?
2. Iatrogenic risk — risk of ALL prescribed drugs across ALL problems
3. Delay risk — consequence of waiting for doctor auth
4. Complication watch — what to monitor for
5. Mitigation plan — what resolves each risk; what cannot be mitigated remotely
Output: `mitigation_plan.overall_risk_tier` (LOW|HIGH) and `risk_tier_rationale`.

Call 4 (~7s): Patient instructions in plain language, referral assessment, doctor
handoff package. Does NOT receive Call 3's risk assessment as input — runs in
parallel. `prescription_issued` is built in JavaScript from Call 2's `problem_list` —
not LLM-generated — so the authoritative drug record cannot be paraphrased or have
items dropped.

**Rule engine** runs deterministically after both Call 3 and Call 4 complete. Can
only escalate LOW → HIGH, never downgrade. After the rule engine runs, JavaScript
injects into Call 4's output:
- `triage.tier` — final tier from rule engine
- `triage.action` — canonical nurse instruction string (not LLM-generated)
- `triage.rationale` — from Call 3's `mitigation_plan.risk_tier_rationale`
- `doctor_handoff.authorization_required_by` — computed from final tier

These fields are injected from deterministic sources rather than LLM-generated
because they are the primary safety-critical decisions the nurse acts on. This logic
has been extracted into a separate, data-driven configuration file
(`escalation_rules.json`). This allows Medical Officers (MOs) to curate and update
clinical policies, vital thresholds, red flags, and sensitive scenarios (like pregnancy)
independently of code deployments.
Hard stops configured in the JSON include:
- Vital sign derangements (hypoxia, shock, etc.)
- Red flag symptoms (convulsions, unconsciousness, etc.)
- High-risk diagnosis names (sepsis, eclampsia, GBS, cord compression, etc.)
- Injectable/teratogenic drugs (artesunate, oxytocin, magnesium sulphate, etc.)
- Infant under 2 years, low weight < 5kg
- Pregnancy (any trimester) — conditional based on JSON flags (escalates if diagnosis is pregnancy-sensitive or drug is teratogenic)
- Allergy conflict between prescribed drug and known allergies
- Low diagnostic confidence

---

## The Vault

One JSONB document per session in the `sessions` table. All stages read from
and write to it incrementally. Never modified after session close — immutable
audit trail.

Key fields:
```
demographics, gps, patient_record,
transcript_full, transcript_segments (phase_1, phase_2, phase_3),
marker_a_at, marker_b_at, marker_c_at (session-relative seconds),
chief_complaint, extracted_concepts, questionnaire,
differential_table, clarifying_questions,
clarifying_findings, problem_list, risk_assessment, triage_output,
stg_retrieval: { context, chunks_by_disease, ... },  — RAG audit metadata
session_photos: { phase_1: [...], phase_2: [...], phase_3: [...] },
audio: { url, codec, duration_seconds, upload_status, retain_until },
risk_tier, doctor_auth_status,
confirmation: { rdt_result, treatment_response, doctor_agreed,
                confidence_weight, committed_to_layer3 }
```

---

## The epidemiological prior — three layers

**Layer 1** — hardcoded string of common WB primary care presentations.
Injected directly into History and Diagnosis Stage prompts. Never retrieved.

**Layer 2** — `data/epi_prior_wb.json`. District + seasonal bucket lookup.
All 23 WB districts. Four seasons: winter (Dec-Feb), pre_monsoon (Mar-May),
monsoon (Jun-Sep), post_monsoon (Oct-Nov). Weights are relative (0-1),
NOT absolute incidence rates. Sources: IDSP, NVBDCP, ICMR-NICED.
The `MONTH_TO_SEASON` map maps month numbers to season keys.
If district not found: returns empty string, logs a warning, agent continues.

**Layer 3** — `confirmed_encounters` table. The app's own accumulating encounter
data. Written ONLY after multi-gate confirmation pipeline clears:
- Gate 1: RDT or test result received
- Gate 2: treatment response documented at follow-up
- Gate 3: doctor agreed with diagnosis
Confidence weight: 0.5 (treatment response only) → 1.0 (all three gates).
Provisional diagnoses NEVER influence Layer 3 or patient records.

---

## Patient records

`sessions` — full raw session JSONB, forever, immutable. The audit trail.

`patient_records` — compact structured summary per patient. Written only from
confirmed encounters. This is what the History Stage reads at the next visit.
Contains: demographics, known_conditions, known_allergies, current_medications,
family_history, social_history, encounters (last 5 confirmed), significant_history.

`users` — app user accounts (nurses, doctors, admins). Email + password with OTP
verification. Distinct from `patient_records` — users are staff, not patients.

`patient_log` — written after each Marker C completion. Stores the proforma
(questionnaire), clarifying questions, and management plan as distinct JSONB columns
per session, linked to patient_id.

**Critical:** The orchestrator loads the patient record from `patient_records`
at session start and writes it into the Vault under `patient_record`. The History
Stage reads `vaultContext.patient_record` — empty object for new patients.

Past medical history, medications, allergies, and family/social history are
collected during the phase 2 interview (questionnaire phase), NOT upfront.
In rural settings patients arrive with no records. The questionnaire collects
what is missing for this patient and seeds the permanent record.

---

## RAG — Management Stage only

RAG is used ONLY in the Management Stage Call 2. Not in History or Diagnosis Stages.

**Why only Management Stage:** Drug selection, dosing, contraindications, and
referral criteria must follow the retrieved locally-validated STG, not LLM recall.
A hallucinated drug dose causes patient harm. The Diagnosis Stage's differential
generation and gap analysis uses LLM general clinical knowledge, which is reliable
for this task and does not benefit from retrieval.

**Vector store:** `stg_chunks` table in Postgres/Supabase with pgvector.
Schema: `chunk_id, source, disease, section, content, content_hash, embedding vector(384)`.
IVFFlat index with lists=100 for ANN search. Similarity threshold: 0.55.
Same-disease fallback threshold: 0.40. Top-k: 8 chunks per diagnosis.

`stg_retrieval` audit metadata (chunks retrieved, diseases queried, source citations)
is stored in the Vault per session so prescriptions can be traced back to source chunks.

**Current corpus (1,426 chunks in Supabase):** ICMR STW volumes 1, 3, 4, and
PTB/EPTB guidelines. See `docs/arch/rag_implementation_status.md` for ingestion
details and smoke test results.

**Missing — do not rely on prescriptions for these conditions:**
- NVBDCP malaria ACT protocol (CRITICAL for malaria Rx dosing)
- NHM kala-azar operational guidelines
- RNTCP/NTP TB treatment guidelines
- WB state protocol addenda

**Formulary is NOT in the vector store.** It is a small JSON file injected
directly into the Call 2 prompt. One file per clinic type (PHC vs CHC).
`data/formulary_wb.json` contains the SHC-HWC essential medicines list sourced
from MoHFW Operational Guidelines (Annexures 1 & 2). Per-clinic stock availability
should be verified before going live.

---

## Doctor authorization

**LOW risk:** Async doctor review. Nurse proceeds with treatment plan.
Doctor reviews within 24 hours. No response = ratified.

**HIGH risk:** Synchronous. Nurse calls doctor or refers immediately.
Do not proceed without doctor contact.

The rule engine is deterministic. It overrides the LLM tier (LOW→HIGH only).
Every triggered rule is logged to the Vault with the specific reason.

Doctor-facing interface (not yet built): review queue sorted by urgency,
each case showing the one-liner, full differential, prescription, risk flags,
and questions for doctor. One-tap approve / modify / reject.

---

## STG ingest pipeline (scripts/ingest_stg.py)

**Built.** CLI tool — chunks STG documents (~350 tokens, 50-token overlap), embeds
with MiniLM-L6-v2, inserts into `stg_chunks` pgvector table. Infers disease tags
from chunk heading/content using `data/rag_disease_aliases.json`. Infers section
type (`treatment`, `dosing`, `referral`, etc.). Safe to re-run — exact duplicates
skipped by `content_hash`. Source replacement via `--replace-source`.

```bash
DATABASE_URL="postgresql://..." python3 scripts/ingest_stg.py \
  --dir "docs/clinical/RAG source" \
  --manifest scripts/rag_source_manifest.json \
  --replace-source
```

Smoke-test retrieval:
```bash
DATABASE_URL="postgresql://..." python3 scripts/query_stg.py --diagnosis tuberculosis
```

Priority ingestion order: NHM STG all volumes, NVBDCP malaria ACT protocol
(CRITICAL for Rx), NHM kala-azar guidelines, RNTCP/NTP TB guidelines,
WB state protocol addenda.

**Do not ingest `formulary_wb.json`** — injected directly into Call 2 prompts, not the vector store.

Retrieval parameters: similarity threshold 0.55, same-disease fallback 0.40,
top-8 chunks per diagnosis.

---

## Outstanding questions

All open decisions are tracked with full context in
[`docs/decisions/DECISIONS_OPEN.md`](docs/decisions/DECISIONS_OPEN.md), grouped
by who needs to answer them (Product/Clinical Lead, Medical Officer, Engineering).

The three questions that must be resolved before building the remaining components:

**1. Patient identity and registration**
How does the app know who the patient is at session start? Does the nurse
search by name/village? Is there a patient ID card or number? Or is a new
record created by default with duplicate merging later? This affects how the
orchestrator loads the patient record.

**2. Nurse UI — post-management output**
After the Management Stage completes, what does the nurse physically do?
Can she add notes before the case goes to the doctor? Can she flag
disagreement with the recommendation? This affects the Management Stage
output schema and doctor interface design.

**3. Standing orders — the most consequential clinical question**
For LOW risk cases, can the nurse dispense medication immediately (before
doctor reviews), operating under standing orders? Or does she always wait
for doctor approval before handing over drugs, even for LOW risk?
The answer determines how the triage output is framed to the nurse and
the entire authorization flow design.

---

## Design discussions and rejected alternatives

The `docs/decisions/adr/` folder contains Architecture Decision Records — analyses
of options considered, paths not taken, and the reasoning behind them. Each ADR is
numbered, dated, and immutable once written.

**Read the relevant ADR before proposing architectural changes to any component
it covers.** This prevents re-litigating decisions that have already been worked
through.

| ADR | Topic |
|---|---|
| [001-agentic-patterns.md](docs/decisions/adr/001-agentic-patterns.md) | Which parts of the pipeline should be agentic vs fixed; trade-offs for this use case |
| [002-history-intake-approach.md](docs/decisions/adr/002-history-intake-approach.md) | Fixed vs LLM-generated background history questions; Option A implemented, Option C deferred to before field pilots |
| [003-problem-oriented-management.md](docs/decisions/adr/003-problem-oriented-management.md) | Single-diagnosis vs problem_list with type discriminator; problem_list chosen |
| [004-model-tier-selection.md](docs/decisions/adr/004-model-tier-selection.md) | Which Gemini model per call; 2.5-flash chosen; 3.x models excluded (implicit thinking overhead) |
| [005-diagnosis-stage-ttft.md](docs/decisions/adr/005-diagnosis-stage-ttft.md) | D-stage 1.5s TTFT target; speculative streaming deferred to after field pilots |

See [`docs/decisions/adr/README.md`](docs/decisions/adr/README.md) for the full ADR index.

---

## Design principles — do not revisit without strong reason

These decisions were made deliberately and should not be changed without
explicit discussion:

- **Continuous WebSocket, not discrete file uploads.** Button presses are
  timestamp markers, not file boundaries. This eliminates STT latency for
  stages 2 and 3.

- **No RAG in History or Diagnosis Stages.** LLM general clinical knowledge
  is sufficient and reliable for differential generation and gap analysis.
  RAG belongs in the Management Stage where it governs prescriptions.

- **Three separate stages, not one.** Each stage has a single bounded job.
  Failures are isolated. Each call is debuggable independently.

- **Deterministic rule engine, not LLM for safety decisions.** Rules are
  versioned, clinician-maintained, auditable, and deploy independently of
  app releases.

- **Layer 3 epi prior written only from confirmed encounters.** Provisional
  diagnoses never influence the epidemiological prior or patient records.
  The confirmation pipeline is the gate.

- **Vault is append-only after session close.** It is the immutable clinical
  record and audit trail. Never modify a closed session document.

- **Differential schema has 11 required fields, always validated.** Missing
  fields get safe defaults. Downstream consumers never handle missing fields.

- **Formulary is a JSON file, not a vector store.** It is small, structured,
  and injected directly into prompts. It must be per-clinic and kept current.

- **No parallel streaming + structured calls.** An earlier design ran a streaming
  LLM call for nurse display alongside a separate non-streaming call for structured
  JSON, with both running in parallel. This was removed: the two calls could diverge
  silently, showing the nurse output that differed from the structured record.
  All pipeline calls are now non-streaming; the full structured result is sent in
  `stage_complete`.

- **Safety-critical output fields are injected from deterministic sources, not relayed by LLM.**
  `triage.tier`, `triage.action`, `triage.rationale`, `authorization_required_by`, and
  `must_not_miss` flags are set in JavaScript from the rule engine and `validate*()`
  functions — not passed through an LLM call. LLM relay introduces paraphrasing and
  omission risk on the fields a nurse acts on most directly.
