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
├── history_stage.py            # Two-call pipeline, no RAG
├── diagnosis_stage.py          # Three-call pipeline, no RAG
├── management_stage.py         # Four-call pipeline, RAG in Call 2
├── epi_utils.py                # Shared epi utilities — imported by all three stages
├── orchestrator.py             # WebSocket session orchestrator — central component
├── data/
│   ├── epi_prior_wb.json       # All 23 WB districts, 4 seasonal buckets
│   ├── bedside_tools.json      # Constraint list for nurse-available tools
│   ├── formulary_wb.json       # SHC-HWC essential medicines (MoHFW Operational Guidelines, Annexures 1 & 2)
│   ├── escalation_rules.json   # Rule engine configuration (MO reviewed)
│   └── must_not_miss.json      # Must-not-miss diagnoses list (MO reviewed) — loaded by Diagnosis Stage
├── db/
│   └── schema.sql              # Postgres schema: sessions, stg_chunks,
│                               # patient_records, confirmed_encounters
├── docs/
│   ├── DECISIONS_OPEN.md       # All unresolved questions — grouped by who must answer them
│   ├── arch/
│   │   ├── cdst_full_pipeline.html           # Full system architecture diagram
│   │   └── continuous_stream_pipeline.html   # Audio streaming architecture diagram
│   ├── eng/
│   │   ├── rag_brief.md                      # Engineering brief for RAG setup
│   │   └── adr/
│   │       ├── README.md                     # ADR index — read before proposing architectural changes
│   │       ├── 001-agentic-patterns.md       # Which parts of the pipeline should be agentic vs fixed
│   │       └── 002-history-intake-approach.md # Fixed vs LLM-generated background history questions
│   └── clinical/
│       ├── MO_REVIEW_CHECKLIST.md            # Site onboarding checklist for Medical Officers
│       ├── bedside_tools_crosscheck.md       # Guideline citations for bedside_tools.json
│       ├── high_risk_escalation_rules.md     # Human-readable guide to escalation_rules.json
│       └── source-materials/                 # Raw source PDFs (MoHFW guidelines, STG volumes)
├── scripts/
│   └── ingest_stg.py           # STG embedding pipeline (chunk → embed → pgvector)
└── CLAUDE.md                   # This file
```

Note: all Python files are at the repo root (not in subdirectories). The tree above
shows logical grouping only.

---

## Tech stack

| Component | Choice |
|---|---|
| Backend | FastAPI (Python) |
| Database | Postgres + pgvector extension |
| Object storage | S3-compatible (audio files) |
| STT | Deepgram streaming WebSocket |
| LLM | Claude claude-sonnet-4-20250514 via Anthropic API |
| Embeddings | sentence-transformers/all-MiniLM-L6-v2 (384-dim) |
| Mobile | React Native |
| Auth | JWT, role-based: nurse / doctor / admin |
| Target region | All India (piloting in West Bengal — 23 districts) |

---

## The consultation flow

A single WebSocket opens when the nurse starts the session and stays open
until the session ends. Audio streams continuously to the server. Deepgram
transcribes it in real time. The nurse presses three buttons:

**Marker A** — ~30 seconds in. Patient has stated name, age, village, chief
complaint, duration. Nothing else is known. History Stage fires.
Target: questionnaire first token on screen within 1.5s.

**Marker B** — after 3-4 minute structured interview. Diagnosis Stage fires.
Target: differential starts streaming within 1.5s. Full pipeline ~5-6s.

**Marker C** — after 1-2 minute clarifying questions phase. Management Stage
fires. Full pipeline ~7-8s including rule engine.

Button presses send a lightweight JSON control message over the same WebSocket:
`{ "marker": "history_complete", "t": 94.3 }` where t is session-relative seconds.

The nurse never reviews or discards recordings. Audio is never stored as discrete
files during the session — it is a continuous stream. Post-session, the complete
audio is packaged and uploaded to S3 in the background (async, does not block the
nurse) with a 90-day retention policy.

---

## Session orchestrator (orchestrator.py)

**Built.** The central component — a FastAPI WebSocket server that owns the full
session lifecycle. All stage functions are called directly from the orchestrator
(not via HTTP); the orchestrator imports from history_stage, diagnosis_stage, and
management_stage.

### WebSocket protocol

**Client → Server:**
```
{ "type": "init",      "patient_id": "P-00123", "nurse_id": "N-001",
  "gps": { "district": "Murshidabad", "district_code": "WB_MSD",
           "lat": 24.18, "lng": 88.27 } }

{ "type": "reconnect", "session_id": "sess_abc123" }

{ "type": "audio",     "data": "<base64 opus chunk>", "t": 12.4 }

{ "type": "marker",    "marker": "history_complete|diagnosis_complete|management_complete",
  "t": 94.3 }

{ "type": "session_end",    "t": 742.0 }

{ "type": "audio_uploaded", "url": "s3://...", "codec": "opus",
  "duration_seconds": 742, "size_bytes": 1893422 }
```

**Server → Client:**
```
{ "type": "session_ready",   "session_id": "sess_abc123", "is_new_patient": true }
{ "type": "transcript",      "text": "...", "is_final": true }
{ "type": "stage_token",     "stage": "history|diagnosis", "token": "..." }
{ "type": "stage_complete",  "stage": "history|diagnosis|management", "data": {...} }
{ "type": "session_closed",  "risk_tier": "low|high" }
{ "type": "audio_confirmed" }
{ "type": "error",           "code": "AUTH_FAILED|SESSION_NOT_FOUND|...", "message": "..." }
```

### Authentication

JWT Bearer token in the Authorization header at WebSocket upgrade time.
Expected claims: `{ "nurse_id": "N-001", "role": "nurse", "clinic_id": "C-042" }`.
`JWT_SECRET` and `JWT_ALGORITHM` are environment variables.

### Session lifecycle

1. **Init** — client sends `init` with patient_id, nurse_id, GPS.
   Orchestrator loads patient record from `patient_records` (empty dict for new
   patients). Calls `vault_init()` to create the Vault document. Returns
   `session_ready` with a generated session_id.

2. **Audio stream** — client sends base64 opus chunks continuously. Orchestrator
   decodes and forwards bytes to Deepgram. Each chunk is appended to a server-side
   ring buffer (last ~60s, 600-element deque) for reconnect replay.

3. **Deepgram transcripts** — `DeepgramConnection` class receives final and interim
   transcript events. Final transcripts are appended to `state.transcript_full` in
   memory and flushed to `sessions.data.transcript_full` in Postgres via
   `vault_append_transcript()` (uses `jsonb_set` + string concat, not a full rewrite).

4. **Marker A (history_complete)** — orchestrator snapshots `transcript_full` as
   `phase_1_end`. Writes `marker_a_at` and `transcript_segments.phase_1` to Vault.
   Fires two concurrent asyncio tasks:
   - `stream_questionnaire()` — tokens streamed to client as `stage_token` messages
   - `generate_questionnaire()` + `validate_questionnaire()` — structured JSON written
     to Vault; `patient_record_stub` also written for Diagnosis Stage to use
   First token reaches nurse within ~800ms of button press.

5. **Marker B (diagnosis_complete)** — slices phase 2 transcript (marker A → B).
   Writes to Vault. Fires two concurrent tasks:
   - `stream_differential()` — tokens to client
   - `generate_differential()` + `validate_differential()` — structured DDx to Vault
   Then runs `generate_clarifying_questions()` sequentially (needs the validated DDx).
   All three writes go to Vault before `stage_complete` is sent.

6. **Marker C (management_complete)** — slices phase 3 transcript (marker B → C).
   Calls `run_management_stage()` which handles all four LLM calls, RAG, the rule
   engine, and Vault writes internally. On completion, the risk tier is written to
   Vault and HIGH risk cases trigger `_notify_doctor()` (stub — replace with FCM/SMS).

7. **Reconnect** — client sends `{ "type": "reconnect", "session_id": "..." }`.
   Orchestrator checks the in-memory `_active` registry; if the server restarted,
   rebuilds `SessionState` from the Vault via `SessionState.from_vault()`. Client
   then flushes its ring buffer of audio chunks which are forwarded to a fresh
   Deepgram connection.

8. **Session end** — writes `session_ended_at`, `session_duration_seconds`, and
   final `transcript_segments` to Vault. Closes Deepgram. Audio upload is the
   device's responsibility; when it calls `audio_uploaded`, the Vault receives
   the S3 URL and a `retain_until` date (90 days from upload).

### REST endpoints on the orchestrator

- `GET  /session/{id}/status` — returns stage completion status and risk tier
  (used by the doctor review queue)
- `POST /session/{id}/doctor-auth` — doctor records approve / modify / reject
  with optional notes and modified prescription
- `GET  /health` — liveness check

### Deepgram stub mode

If `DEEPGRAM_API_KEY` is not set, `DeepgramConnection` runs as a no-op stub.
Audio is received from the client and buffered, but nothing is transcribed.
This allows local development and testing without a live Deepgram account.

---

## The three stages

### History Stage (history_stage.py)  [fixed pipeline]

**Two LLM calls, no RAG.**

Call 1 (~700ms): Extracts chief complaint from the ~30s phase 1 transcript.
At this point only name, age, village, chief complaint, and duration are known.
Nothing else. The schema has many null fields by design.

Call 2 (~1.3s, streaming): Generates a structured contextualised questionnaire.
Uses `build_patient_record_context()` to determine field by field what is already
known vs what needs to be collected. A new patient gets a full intake (past medical
history, family history, social history, medications, allergies). A returning patient
gets a short verification pass for changed fields only. The nurse never specifies
visit type — the agent reasons it from the patient record state.

The questionnaire output includes `patient_record_fields` — a structured object
the Diagnosis Stage's concept extractor uses as a schema for what to populate
from the phase 2 transcript.

Key function: `build_patient_record_context(patient_record)` returns:
- `known_context`: formatted string of what the record already contains
- `missing_fields`: list of field names that need to be collected this visit

### Diagnosis Stage (diagnosis_stage.py)  [fixed pipeline]

**Three LLM calls, no RAG.**

Call 1 (~900ms): Extracts structured medical concepts from the phase 2 transcript.
Negatives are as important as positives. Ambiguous or qualified patient answers
(e.g. "sometimes", "not sure") are captured separately in `uncertain_findings`
rather than collapsed into positives or negatives. Prior encounter history is read
from `patient_record.encounters` in the Vault. Output written to Vault independently.

Call 2 (~3.2s, streaming): Generates ranked differential (4-6 conditions) using
LLM general knowledge + two-layer epidemiological prior. No RAG. Layer 1 is a
checklist of common presentations to consider — not a mandatory anchor. The
presenting complaint always dominates both layers. `discriminating_tests` records
all clinically relevant investigations (bedside, lab, or imaging); Call 3 filters
to what is bedside-feasible.

Call 3 (~1.4s, streaming): Generates gap analysis and clarifying questions,
constrained to tools in `bedside_tools.json`. `uncertain_findings` from Call 1
are surfaced as priority re-ask candidates if discriminating for the differential.

**Must-not-miss diagnoses** are loaded at runtime from `data/must_not_miss.json`
(34 diagnoses across 8 categories, MO-maintained). Any diagnosis on this list is
flagged `must_not_miss=true` in the differential regardless of probability ranking.

**Canonical differential schema — 11 fields, always present:**
`rank`, `disease`, `icd10_code`, `probability`, `supporting_features`, `against`,
`must_not_miss`, `regionally_specific`, `reasoning`, `discriminating_tests`
(all test types — bedside, lab, imaging), `referral_required`.

`validate_differential()` runs after every LLM differential call. Missing fields
get safe defaults and a logged warning. `icd10_code` default is `R69` (illness
unspecified). This ensures all downstream consumers receive a predictable structure.

### Management Stage (management_stage.py)  [fixed pipeline — planned: agentic]

**Four LLM calls, RAG in Call 2.**

Call 1 (~900ms) + RAG retrieval run in parallel via `asyncio.gather`:
- Call 1 extracts clarifying findings from phase 3 transcript
- RAG retrieves STG treatment protocol chunks for top 1-2 diagnoses from the DDx

Call 2 (~2.5s, streaming): Generates provisional diagnosis and fully specified
prescription. STG context from RAG grounds the prescription. Local formulary
constrains drug selection to what is actually stocked at the clinic.
Prescription must cite `stg_source` for each drug.

Call 3 (~1.8s): Five-dimension risk assessment — no RAG, pure LLM reasoning:
1. Diagnostic uncertainty — what if the provisional Dx is wrong?
2. Iatrogenic risk — risk of the treatment itself (allergy check, interactions)
3. Delay risk — consequence of waiting for doctor auth
4. Complication watch — what to monitor for
5. Mitigation plan — what resolves each risk; what cannot be mitigated remotely

overall_risk_tier = HIGH if ANY unmitigable risk exists, or delay window < 2 hours.

Call 4 (~1.2s, streaming): Triage decision, patient instructions in plain language,
doctor handoff package. `prescription_issued` in the handoff copies every drug
verbatim from Call 2 — exact drug, dose, route, frequency, duration.
`treatment_summary` in patient instructions translates the prescription into
plain language — every drug, every dose, nothing omitted.

**Rule engine** runs deterministically after Call 4. Can only escalate LOW → HIGH,
never downgrade. This logic has been extracted into a separate, data-driven configuration
file (`escalation_rules.json`). This allows Medical Officers (MOs) to curate and update
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
clarifying_findings, provisional_diagnosis, risk_assessment, triage_output,
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
The `MONTH_TO_SEASON` dict maps month numbers to season keys.
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

Two tables serve different purposes:

`sessions` — full raw session JSONB, forever, immutable. The audit trail.

`patient_records` — compact structured summary per patient. Written only from
confirmed encounters. This is what the History Stage reads at the next visit.
Contains: demographics, known_conditions, known_allergies, current_medications,
family_history, social_history, encounters (last 5 confirmed), significant_history.

**Critical:** The orchestrator loads the patient record from `patient_records`
at session start and writes it into the Vault under `patient_record`. The History
History Stage reads `vault_context["patient_record"]` — empty dict for new patients.

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

**Vector store:** `stg_chunks` table in Postgres with pgvector.
Schema: `chunk_id, source, disease, section, content, embedding vector(384)`.
IVFFlat index with lists=100 for ANN search. Similarity threshold: 0.55.
Top-k: 8 chunks per diagnosis, max 2 diagnoses = 16 chunks max in prompt.

**Documents to embed** (see `docs/rag_brief.md` for full detail):
- NHM Standard Treatment Guidelines — all volumes
- NVBDCP malaria treatment protocol (ACT dosing by weight band)
- NHM kala-azar operational guidelines
- West Bengal state drug formulary (SHC-HWC level — populated from MoHFW Operational Guidelines)
- RNTCP/NTP TB treatment guidelines

**Formulary is NOT in the vector store.** It is a small JSON file injected
directly into the Call 2 prompt. One file per clinic type (PHC vs CHC).
`data/formulary_wb.json` contains the SHC-HWC essential medicines list sourced
from MoHFW Operational Guidelines (Annexures 1 & 2). Per-clinic stock availability
should be verified before going live.

---

## Doctor authorization

**LOW risk:** Async doctor review. Nurse proceeds with treatment plan.
Doctor reviews within 4 hours. No response = ratified.

**HIGH risk:** Synchronous. Nurse calls doctor or refers immediately.
Do not proceed without doctor contact.

The rule engine is deterministic. It overrides the LLM tier (LOW→HIGH only).
Every triggered rule is logged to the Vault with the specific reason.

Doctor-facing interface (not yet built): review queue sorted by urgency,
each case showing the one-liner, full differential, prescription, risk flags,
and questions for doctor. One-tap approve / modify / reject.

---

## Audio architecture

Continuous WebSocket stream — no discrete files during session.
The nurse never reviews or discards recordings.

Post-session:
- Device packages complete session audio as a single Opus file (16kHz, mono)
- Background service uploads to S3
- Vault stores reference: `audio.url`, `audio.upload_status`, `audio.retain_until`
- 90-day lifecycle policy on S3 bucket
- Transcript stored permanently in Vault; audio deleted after 90 days

Reconnection: device maintains a ring buffer of recent chunks with
session-relative timestamps. On reconnect, flushes buffered chunks to server
in order with accurate timestamps before resuming live stream.

The server-side `DeepgramConnection` opens a fresh Deepgram WebSocket on reconnect.
The orchestrator's `SessionState` persists in the `_active` registry for the server
process lifetime; if the server restarted, it rebuilds state from the Vault.

---

## STG ingest pipeline (scripts/ingest_stg.py)

**Built.** A CLI tool that chunks STG documents, embeds them with MiniLM-L6-v2,
and inserts into the `stg_chunks` pgvector table. Run once per new document set;
safe to re-run (exact duplicates are skipped by content fingerprint).

### Supported input formats
- `.txt` — plain text
- `.pdf` — extracted via pdfplumber (page by page)
- `.docx` — extracted via python-docx (paragraph by paragraph)

### Chunking strategy
Target: ~350 tokens per chunk with 50-token overlap. Section headings are detected
by pattern (ALL CAPS, numbered headings `1.2 Treatment of...`, short lines ending
with `:`). Chunks respect section boundaries; sections shorter than one chunk are
kept whole. Trivially short chunks (<10 words) are dropped.

Each chunk is tagged with:
- `source` — document identifier, e.g. `NHM_STG_2023_MALARIA`
- `disease` — primary disease tag for filtered retrieval, e.g. `malaria`
- `section` — detected section heading, e.g. `Treatment of Uncomplicated Malaria`

### Usage

```bash
# Single document:
python scripts/ingest_stg.py --file docs/nhm_stg_malaria.pdf --disease malaria

# Whole directory with a disease map JSON:
python scripts/ingest_stg.py --dir docs/stg/ --disease-map scripts/disease_map.json

# Dry run — prints chunks without touching the DB:
python scripts/ingest_stg.py --file docs/nhm_stg_malaria.pdf --disease malaria --dry-run
```

`disease_map.json` maps filename stem → disease tag:
```json
{ "nhm_stg_malaria": "malaria", "nvbdcp_kala_azar": "kala-azar", "rntcp_tb": "tuberculosis" }
```

### Documents to ingest (in priority order)
1. NHM Standard Treatment Guidelines — all volumes
2. NVBDCP malaria treatment protocol (ACT dosing by weight band) — CRITICAL for Rx
3. NHM kala-azar operational guidelines
4. RNTCP/NTP TB treatment guidelines
5. West Bengal state protocol addenda (if any)

**Do not ingest `formulary_wb.json`** — the formulary is a small JSON file injected
directly into Management Stage Call 2 prompts. It does not go in the vector store.

### After ingestion
Verify with a direct Postgres query:
```sql
SELECT disease, count(*) FROM stg_chunks GROUP BY disease ORDER BY count DESC;
```
The Management Stage uses similarity threshold 0.55 and retrieves top-8 chunks per
diagnosis (max 2 diagnoses = 16 chunks per Call 2 prompt).

---

## Outstanding questions

All open decisions — including the three blocking questions below — are tracked
with full context in [`docs/DECISIONS_OPEN.md`](docs/DECISIONS_OPEN.md), grouped
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

## What still needs building

### Backend — core pipeline
- [x] Session orchestrator (orchestrator.py — WebSocket, STT integration, marker routing, Vault init)
- [x] STT integration (DeepgramConnection class inside orchestrator.py)
- [ ] Patient records service — write confirmed encounters back to `patient_records`
      after the three confirmation gates pass (currently only read is implemented)
- [ ] Confirmation pipeline (monitor RDT results, treatment response, doctor auth;
      write to `confirmed_encounters` and update `patient_records`)
- [ ] Audio post-session upload — device uploads directly to S3; orchestrator records
      the URL when the device sends `audio_uploaded`. Retry logic is on the device.

### Backend — safety and data
- [x] Doctor authorization API (POST /session/{id}/doctor-auth — approve/modify/reject)
- [ ] Audit log (append-only record of every stage call with inputs, outputs, Vault snapshot)
- [x] STG ingestion pipeline (scripts/ingest_stg.py — chunk, embed, insert into pgvector)
- [ ] Formulary service (admin update UI, per-clinic JSON management)
- [ ] Layer 3 epi prior query (aggregate confirmed_encounters by district/season)
- [ ] Doctor notification service (replace _notify_doctor() stub in orchestrator.py
      with real FCM / SMS gateway integration)

### Mobile (React Native)
- [ ] WebSocket audio client (continuous stream, marker events, ring buffer)
- [ ] Session registration flow (patient lookup / create, demographics capture)
- [ ] Streaming display — questionnaire, differential, triage output
- [ ] Post-session audio upload (background service, retry on failure, calls audio_uploaded)
- [ ] Nurse UI: triage decision screen, patient instruction sheet

### Doctor-facing
- [ ] Doctor review app / interface (reads GET /session/{id}/status, calls POST doctor-auth)
- [ ] Push notifications for HIGH risk cases (implement _notify_doctor in orchestrator.py)
- [ ] Async review queue with urgency sorting

---

## Design discussions and rejected alternatives

The `docs/eng/adr/` folder contains Architecture Decision Records — analyses of options
considered, paths not taken, and the reasoning behind them. Each ADR is numbered,
dated, and immutable once written.

**Read the relevant ADR before proposing architectural changes to any component
it covers.** This prevents re-litigating decisions that have already been worked
through.

| ADR | Topic |
|---|---|
| [001-agentic-patterns.md](docs/eng/adr/001-agentic-patterns.md) | Which parts of the pipeline should be agentic vs fixed; trade-offs for this use case |
| [002-history-intake-approach.md](docs/eng/adr/002-history-intake-approach.md) | Fixed vs LLM-generated background history questions; Option A implemented, Option C deferred to before field pilots |

See [`docs/eng/adr/README.md`](docs/eng/adr/README.md) for the ADR index.

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

---

## Key files already built

| File | Status | Notes |
|---|---|---|
| history_stage.py | Complete | Two-call, no RAG, gap-aware; imports from here into orchestrator |
| diagnosis_stage.py | Complete | Three-call, no RAG, validated schema; imports from here into orchestrator |
| management_stage.py | Complete | Four-call, RAG, rule engine; called via run_management_stage() |
| epi_utils.py | Complete | Shared module: DISTRICT_CODE_TO_STATE, state_from_district_code(), MONTH_TO_SEASON, load_baseline_diseases(), load_epi_prior() — imported by all three stages |
| orchestrator.py | Complete | WebSocket session lifecycle, Deepgram STT, all marker handlers, doctor-auth REST API |
| scripts/ingest_stg.py | Complete | CLI to chunk/embed/insert STG docs; run before first session |
| db/schema.sql | Complete | sessions, stg_chunks, patient_records, confirmed_encounters |
| data/epi_prior_wb.json | Complete | All 23 WB districts, 4 seasons, sourced from IDSP/NVBDCP |
| data/bedside_tools.json | Complete | Nurse-available tools constraint list |
| data/formulary_wb.json | Complete | SHC-HWC essential medicines from MoHFW Operational Guidelines Annexures 1 & 2 |
| data/must_not_miss.json | Complete | 34 must-not-miss diagnoses across 8 categories; loaded by Diagnosis Stage at runtime |
| data/escalation_rules.json | Complete | Rule engine config — vital thresholds, red flags, diagnosis/drug hard-stops |
| docs/DECISIONS_OPEN.md | Complete | All unresolved questions grouped by owner (Product, MO, Engineering) |
| docs/eng/rag_brief.md | Complete | Engineering brief for RAG setup |
| docs/eng/adr/README.md | Complete | ADR index — read before proposing architectural changes |
| docs/arch/cdst_full_pipeline.html | Complete | Full system architecture diagram |
| docs/arch/continuous_stream_pipeline.html | Complete | Audio streaming architecture diagram |
| docs/clinical/MO_REVIEW_CHECKLIST.md | Complete | Step-by-step site onboarding checklist for Medical Officers |
| docs/clinical/bedside_tools_crosscheck.md | Complete | Guideline citations for bedside_tools.json |
| docs/clinical/high_risk_escalation_rules.md | Complete | Human-readable guide to escalation_rules.json |
