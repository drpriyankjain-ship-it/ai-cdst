# CDST — Clinical Decision Support Tool
## Architecture Reference for Claude Code

This document is the authoritative record of all design decisions made during
architecture and initial development. Read this before writing any code.

---

## What this system does

A mobile app for nurses working in remote rural West Bengal, India, where patients
have no direct access to doctors. The nurse conducts a structured audio consultation.
The app transcribes audio continuously, fires three AI agents at specific moments,
and produces a triage decision, prescription, and risk-assessed management plan that
a remote doctor reviews asynchronously.

---

## Repository structure

```
cdst/
├── agents/
│   ├── history_agent.py        # Two-call pipeline, no RAG
│   ├── diagnosis_agent.py      # Three-call pipeline, no RAG
│   └── management_agent.py     # Four-call pipeline, RAG in Call 2
├── data/
│   ├── epi_prior_wb.json       # All 23 WB districts, 4 seasonal buckets
│   ├── bedside_tools.json      # Constraint list for nurse-available tools
│   └── formulary_wb.json       # PLACEHOLDER — needs real drug stock data
├── db/
│   └── schema.sql              # Postgres schema: sessions, stg_chunks,
│                               # patient_records, confirmed_encounters
├── scripts/
│   └── ingest_stg.py           # TO BE WRITTEN — STG embedding pipeline
└── CLAUDE.md                   # This file
```

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
| Target region | West Bengal, India — 23 districts |

---

## The consultation flow

A single WebSocket opens when the nurse starts the session and stays open
until the session ends. Audio streams continuously to the server. Deepgram
transcribes it in real time. The nurse presses three buttons:

**Marker A** — ~30 seconds in. Patient has stated name, age, village, chief
complaint, duration. Nothing else is known. History Agent fires.
Target: questionnaire first token on screen within 1.5s.

**Marker B** — after 3-4 minute structured interview. Diagnosis Agent fires.
Target: differential starts streaming within 1.5s. Full pipeline ~5-6s.

**Marker C** — after 1-2 minute clarifying questions phase. Management Agent
fires. Full pipeline ~7-8s including rule engine.

Button presses send a lightweight JSON control message over the same WebSocket:
`{ "marker": "history_complete", "t": 94.3 }` where t is session-relative seconds.

The nurse never reviews or discards recordings. Audio is never stored as discrete
files during the session — it is a continuous stream. Post-session, the complete
audio is packaged and uploaded to S3 in the background (async, does not block the
nurse) with a 90-day retention policy.

---

## Session orchestrator — what it must do

This is the most important remaining component. It must:

1. Open the WebSocket connection when the nurse starts a session
2. Look up the patient in `patient_records` by patient ID and load their record
   into the Vault under `vault_context["patient_record"]` (empty dict for new patients)
3. Initialise the Vault session document in Postgres with demographics, GPS,
   timestamp, and the loaded patient record
4. Stream audio chunks to Deepgram; receive rolling transcript; accumulate it in
   the Vault under `transcript_full`
5. Maintain a local ring buffer for reconnection — if the WebSocket drops, buffer
   audio chunks with session-relative timestamps and flush on reconnect
6. On marker A event: slice transcript at marker A timestamp, fire History Agent,
   stream questionnaire back to mobile client
7. On marker B event: slice transcript from marker A to marker B, fire Diagnosis
   Agent, stream differential back to mobile client
8. On marker C event: slice transcript from marker B to marker C, fire Management
   Agent, stream triage output back to mobile client
9. After Management Agent + rule engine complete: write final risk tier and
   doctor_auth_status to Vault; trigger doctor notification
10. On session end: trigger async audio upload to S3; write session_ended_at to Vault

---

## The three agents

### History Agent (agents/history_agent.py)

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
the Diagnosis Agent's concept extractor uses as a schema for what to populate
from the phase 2 transcript.

Key function: `build_patient_record_context(patient_record)` returns:
- `known_context`: formatted string of what the record already contains
- `missing_fields`: list of field names that need to be collected this visit

### Diagnosis Agent (agents/diagnosis_agent.py)

**Three LLM calls, no RAG.**

Call 1 (~900ms): Extracts structured medical concepts from the phase 2 transcript.
Negatives are as important as positives. Output is written to Vault independently.

Call 2 (~3.2s, streaming): Generates ranked differential (4-6 conditions) using
LLM general knowledge + two-layer epidemiological prior. No RAG. The epi prior
correctly contributes nothing for neurological or other non-endemic presentations
— the presenting complaint always dominates.

Call 3 (~1.4s, streaming): Generates bedside gap analysis and clarifying questions,
constrained to tools in `bedside_tools.json`. Never suggests labs or imaging.

**Canonical differential schema — 11 fields, always present:**
`rank`, `disease`, `icd10_code`, `probability`, `supporting_features`, `against`,
`must_not_miss`, `regionally_specific`, `reasoning`, `discriminating_tests`
(bedside only), `referral_required`.

`validate_differential()` runs after every LLM differential call. Missing fields
get safe defaults and a logged warning. `icd10_code` default is `R69` (illness
unspecified). This ensures all downstream consumers receive a predictable structure.

### Management Agent (agents/management_agent.py)

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
never downgrade. Hard stops include:
- High-risk diagnosis names (sepsis, eclampsia, GBS, cord compression, etc.)
- Injectable drugs (artesunate, oxytocin, magnesium sulphate, etc.)
- Infant under 2 months
- Pregnancy (any trimester)
- Allergy conflict between prescribed drug and known allergies
- Low diagnostic confidence

---

## The Vault

One JSONB document per session in the `sessions` table. All agents read from
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
Injected directly into History and Diagnosis Agent prompts. Never retrieved.

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
confirmed encounters. This is what the History Agent reads at the next visit.
Contains: demographics, known_conditions, known_allergies, current_medications,
family_history, social_history, encounters (last 5 confirmed), significant_history.

**Critical:** The orchestrator loads the patient record from `patient_records`
at session start and writes it into the Vault under `patient_record`. The History
Agent reads `vault_context["patient_record"]` — empty dict for new patients.

Past medical history, medications, allergies, and family/social history are
collected during the phase 2 interview (questionnaire phase), NOT upfront.
In rural settings patients arrive with no records. The questionnaire collects
what is missing for this patient and seeds the permanent record.

---

## RAG — Management Agent only

RAG is used ONLY in the Management Agent Call 2. Not in History or Diagnosis Agents.

**Why only Management Agent:** Drug selection, dosing, contraindications, and
referral criteria must follow the retrieved locally-validated STG, not LLM recall.
A hallucinated drug dose causes patient harm. The Diagnosis Agent's differential
generation and gap analysis uses LLM general clinical knowledge, which is reliable
for this task and does not benefit from retrieval.

**Vector store:** `stg_chunks` table in Postgres with pgvector.
Schema: `chunk_id, source, disease, section, content, embedding vector(384)`.
IVFFlat index with lists=100 for ANN search. Similarity threshold: 0.55.
Top-k: 8 chunks per diagnosis, max 2 diagnoses = 16 chunks max in prompt.

**Documents to embed** (see `docs/rag_brief.docx` for full detail):
- NHM Standard Treatment Guidelines — all volumes
- NVBDCP malaria treatment protocol (ACT dosing by weight band)
- NHM kala-azar operational guidelines
- West Bengal state drug formulary ← CRITICAL, currently placeholder
- RNTCP/NTP TB treatment guidelines

**Formulary is NOT in the vector store.** It is a small JSON file injected
directly into the Call 2 prompt. One file per clinic type (PHC vs CHC).
`data/formulary_wb.json` is currently a placeholder schema — must be populated
with real drug stock before going live.

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

---

## Outstanding questions — answer before building these components

These three questions were explicitly deferred and must be resolved before
implementing the relevant components:

**1. Patient identity and registration**
How does the app know who the patient is at session start? Does the nurse
search by name/village? Is there a patient ID card or number? Or is a new
record created by default with duplicate merging later? This affects how the
orchestrator loads the patient record.

**2. Nurse UI — post-management output**
After the Management Agent completes, what does the nurse physically do?
Can she add notes before the case goes to the doctor? Can she flag
disagreement with the recommendation? This affects the Management Agent
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
- [ ] Session orchestrator (WebSocket, STT integration, marker routing, Vault init)
- [ ] STT integration (Deepgram WebSocket client, rolling transcript accumulation)
- [ ] Patient records service (load at session start, write on confirmation)
- [ ] Confirmation pipeline (monitor RDT results, treatment response, doctor auth)
- [ ] Audio post-session upload service (background, S3, retry logic)

### Backend — safety and data
- [ ] Doctor authorization API (review queue, approve/modify/reject endpoints)
- [ ] Audit log (append-only, every agent call with inputs/outputs/Vault snapshot)
- [ ] STG ingestion pipeline (scripts/ingest_stg.py — chunk, embed, insert)
- [ ] Formulary service (admin update UI, per-clinic JSON management)
- [ ] Layer 3 epi prior query (aggregate confirmed_encounters by district/season)

### Mobile (React Native)
- [ ] WebSocket audio client (continuous stream, marker events, ring buffer)
- [ ] Session registration flow (patient lookup / create, demographics capture)
- [ ] Streaming display — questionnaire, differential, triage output
- [ ] Post-session audio upload (background service, retry on failure)
- [ ] Nurse UI: triage decision screen, patient instruction sheet

### Doctor-facing
- [ ] Doctor review app / interface
- [ ] Push notifications for HIGH risk cases
- [ ] Async review queue with urgency sorting

---

## Design principles — do not revisit without strong reason

These decisions were made deliberately and should not be changed without
explicit discussion:

- **Continuous WebSocket, not discrete file uploads.** Button presses are
  timestamp markers, not file boundaries. This eliminates STT latency for
  agents 2 and 3.

- **No RAG in History or Diagnosis Agents.** LLM general clinical knowledge
  is sufficient and reliable for differential generation and gap analysis.
  RAG belongs in the Management Agent where it governs prescriptions.

- **Three separate agents, not one.** Each agent has a single bounded job.
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
| agents/history_agent.py | Complete | Two-call, no RAG, gap-aware |
| agents/diagnosis_agent.py | Complete | Three-call, no RAG, validated schema |
| agents/management_agent.py | Complete | Four-call, RAG, rule engine |
| db/schema.sql | Complete | sessions, stg_chunks, patient_records, confirmed_encounters |
| data/epi_prior_wb.json | Complete | All 23 WB districts, 4 seasons, sourced from IDSP/NVBDCP |
| data/bedside_tools.json | Complete | Nurse-available tools constraint list |
| data/formulary_wb.json | Placeholder | Schema only — needs real drug stock data |
| docs/rag_brief.docx | Complete | Engineering brief for RAG setup |
| docs/cdst_full_pipeline.html | Complete | Full system architecture diagram |
| docs/continuous_stream_pipeline.html | Complete | Audio streaming architecture diagram |
| docs/cdst_backend_architecture.html | Complete | Backend layer diagram |
