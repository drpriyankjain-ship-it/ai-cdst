# CDST — Clinical Decision Support Tool

A mobile-first clinical decision support system for nurses conducting remote
consultations in rural West Bengal, India. Patients have no direct access to
doctors. The nurse conducts a structured audio consultation; three pipeline stages
produce a triage decision, prescription, and risk-assessed management plan
that a remote doctor reviews asynchronously.

---

## How the system works

A single WebSocket session opens when the nurse starts a consultation. Audio
streams continuously to the server and is transcribed in real time via
Deepgram. The nurse presses three buttons at defined moments:

| Marker | When | Stage fired | Output |
|--------|------|-------------|--------|
| A | ~30s in — chief complaint stated | History Stage | Contextualised intake questionnaire |
| B | After 3-4 min structured interview | Diagnosis Stage | Ranked differential, bedside gap analysis |
| C | After 1-2 min clarifying phase | Management Stage | Prescription, risk assessment, triage decision |

The complete session is packaged post-session and uploaded to S3. A remote
doctor reviews the output asynchronously (or synchronously for HIGH risk cases).

---

## Repository layout

```
cdst/
├── server/                     # Live Node.js backend (Express + WebSocket)
│   ├── index.js                # Entry point — Express server, port 3000
│   ├── orchestrator.js         # WebSocket session orchestrator
│   ├── stages/
│   │   ├── historyStage.js     # Two-call pipeline (chief complaint → questionnaire)
│   │   ├── diagnosisStage.js   # Three-call pipeline (concepts → DDx → gap analysis)
│   │   ├── managementStage.js  # Four-call pipeline (RAG-grounded Rx, risk, triage)
│   │   └── managementHelpers.js
│   ├── lib/
│   │   ├── llmClient.js        # Gemini client
│   │   ├── modelConfig.js      # LLM model assignments for all 9 pipeline calls
│   │   ├── epiUtils.js         # Epidemiological prior utilities
│   │   ├── db.js               # Postgres/Supabase connection pool
│   │   ├── auth.js             # JWT middleware
│   │   ├── email.js            # OTP email delivery
│   │   └── storage.js          # S3-compatible audio storage
│   ├── routes/
│   │   ├── auth.js             # POST /api/auth/...
│   │   ├── audio.js            # POST /api/audio/...
│   │   ├── session.js          # GET/POST /api/session/...
│   │   ├── dashboard.js        # GET /api/dashboard/...
│   │   └── transcripts.js      # GET /api/transcripts/...
│   └── scripts/
│       ├── setupDb.js          # Create all tables and indexes against Supabase/Postgres
│       └── seedUser.js         # Seed a test user
├── src/                        # React Native mobile app (Expo)
│   ├── screens/                # LiveConsultationScreen, HistoryPage, TranscriptPage, etc.
│   ├── components/             # Shared UI components
│   ├── navigation/             # AppNavigator, AuthNavigator
│   ├── services/               # wsService.js, apiService.js, authService.js
│   ├── context/AuthContext.js
│   └── styles/
├── web/                        # Vanilla JS web frontend (served by server/index.js)
│   ├── index.html
│   ├── app.js
│   ├── audio.js
│   ├── api.js
│   ├── styles.css
│   └── screens/                # dashboard, login, record, history, about
├── data/
│   ├── epi_prior_wb.json       # Epidemiological priors — all 23 WB districts, 4 seasons
│   ├── bedside_tools.json      # Constraint list for nurse-available diagnostic tools
│   ├── formulary_wb.json       # SHC-HWC essential medicines (MoHFW Operational Guidelines)
│   ├── escalation_rules.json   # Deterministic rule engine config (MO-maintained)
│   ├── must_not_miss.json      # Must-not-miss diagnoses list (MO-maintained)
│   └── rag_disease_aliases.json # Disease alias map used during STG ingestion
├── db/
│   └── schema.sql              # Postgres schema (reference)
├── docs/
│   ├── decisions/
│   │   ├── DECISIONS_OPEN.md   # All unresolved questions — grouped by who must answer them
│   │   └── adr/                # Architecture Decision Records (read before proposing changes)
│   ├── arch/
│   │   ├── cdst_full_pipeline.html         # Full system architecture diagram
│   │   ├── continuous_stream_pipeline.html # Audio streaming architecture diagram
│   │   ├── cdst_engineering_overview.html  # Engineering overview diagram
│   │   ├── rag_brief.md                    # Engineering brief for RAG setup
│   │   └── rag_implementation_status.md    # RAG corpus ingestion status and smoke test results
│   ├── clinical/
│   │   ├── MO_REVIEW_CHECKLIST.md          # Site onboarding checklist for Medical Officers
│   │   ├── bedside_tools_crosscheck.md
│   │   ├── high_risk_escalation_rules.md
│   │   ├── RAG source/                     # Approved source PDFs for STG ingestion
│   │   └── source-materials/               # Raw MoHFW guideline PDFs
│   └── validation/
│       ├── validation_1_english.txt        # Test transcript (patient FKP1192)
│       └── run_NNN_<patient>_<date>.md     # Per-run pipeline validation notes
├── scripts/
│   ├── ingest_stg.py           # STG embedding pipeline (chunk → embed → pgvector)
│   ├── query_stg.py            # Smoke-test retrieval against the live corpus
│   └── rag_source_manifest.json # Stable source labels for the ingestion pipeline
├── python_pipeline/            # Archived — original Python implementation (not in active use)
├── evals/
│   └── validate_pipeline.py    # End-to-end pipeline eval harness
├── App.js                      # React Native entry point
└── package.json                # Expo / React Native dependencies
```

---

## Tech stack

| Component | Choice |
|-----------|--------|
| Backend | Node.js — Express + express-ws |
| Database | Postgres + pgvector (hosted on Supabase) |
| Object storage | S3-compatible |
| STT | Deepgram streaming WebSocket |
| LLM | Gemini via Google Gemini API (`google-genai` SDK) |
| Embeddings | sentence-transformers/all-MiniLM-L6-v2 (384-dim) |
| Mobile | React Native (Expo 54) |
| Web | Vanilla JS — served as static files by the Node.js server |
| Auth | JWT — roles: nurse / doctor / admin; OTP email verification |

---

## Getting started

### Prerequisites

- Node.js 18+
- Python 3.11+ (for STG ingestion scripts only)
- Postgres with pgvector extension (or a Supabase project)
- API keys: `GEMINI_API_KEY`, `DEEPGRAM_API_KEY`
- JWT config: `JWT_SECRET`, `JWT_ALGORITHM`
- Database: `DATABASE_URL`
- Email (OTP): `EMAIL_USER`, `EMAIL_PASS`

### Install dependencies

```bash
# Node.js server + mobile app
npm install

# Python (ingestion scripts only)
pip install -r requirements.txt
```

### Database setup

Run the setup script against your Supabase/Postgres instance:

```bash
DATABASE_URL="postgresql://..." node server/scripts/setupDb.js
```

This creates all tables (`sessions`, `patient_records`, `stg_chunks`,
`confirmed_encounters`, `users`, `audio_records`) and the pgvector IVFFlat index.

### Ingest STG documents (required before first session)

The Management Stage uses RAG over Standard Treatment Guidelines. Source PDFs
live in `docs/clinical/RAG source/`. Ingest them before running sessions:

```bash
DATABASE_URL="postgresql://..." python3 scripts/ingest_stg.py \
  --dir "docs/clinical/RAG source" \
  --manifest scripts/rag_source_manifest.json \
  --replace-source
```

Verify ingestion:

```sql
SELECT source, disease, section, count(*)
FROM stg_chunks
GROUP BY source, disease, section
ORDER BY source, disease, section;
```

Smoke-test retrieval:

```bash
DATABASE_URL="postgresql://..." python3 scripts/query_stg.py --diagnosis tuberculosis
```

**Current corpus (1,426 chunks):** ICMR STW volumes 1, 3, 4, and PTB/EPTB
guidelines. Malaria (NVBDCP) and kala-azar protocols are not yet ingested —
do not rely on management stage drug recommendations for these conditions.

**Priority ingestion order:** NHM STG (all volumes) → NVBDCP malaria ACT
protocol (CRITICAL for Rx) → NHM kala-azar guidelines → RNTCP/NTP TB guidelines
→ WB state addenda.

Do not ingest `formulary_wb.json` — it is injected directly into prompts, not
the vector store.

### Run the server

```bash
node server/index.js
```

Server starts on port 3000. WebSocket at `ws://localhost:3000/session/ws`.
The web frontend is served as static files from the same process.

**Deepgram stub mode:** If `DEEPGRAM_API_KEY` is not set, the server runs with
a no-op STT stub. Use this for local development without a live Deepgram account.

### Run the mobile app

```bash
npm start          # Expo dev server
npm run android    # Android
npm run ios        # iOS
```

---

## The three stages

All stage implementations live in `server/stages/`. The archived Python
originals are in `python_pipeline/` for reference only.

### History Stage (`server/stages/historyStage.js`)
Two LLM calls, no RAG. Fires at Marker A.
1. Extracts chief complaint from the ~30s phase 1 transcript
2. Generates a contextualised intake questionnaire — full intake for new patients,
   short verification pass for returning patients

Target TTFT: <1.5s. Measured: ~1.2s (H1 ~0.9s + H2 streaming).

### Diagnosis Stage (`server/stages/diagnosisStage.js`)
Three LLM calls, no RAG. Fires at Marker B.
1. Extracts structured medical concepts (negatives as important as positives)
2. Generates ranked differential (4-6 conditions) with epidemiological prior
3. Generates bedside gap analysis and clarifying questions (constrained to `bedside_tools.json`)

Differential output always has 11 required fields. `validate_differential()` fills
safe defaults for any missing fields. Must-not-miss diagnoses are loaded from
`data/must_not_miss.json` at runtime and enforced deterministically — not by LLM
instruction.

Target TTFT: <1.5s. Measured: ~5.2s (D1 blocks ~4.9s). See ADR 005.

### Management Stage (`server/stages/managementStage.js`)
Four LLM calls, RAG in Call 2. Fires at Marker C.
1. Extracts clarifying findings from phase 3 transcript (runs in parallel with RAG retrieval)
2. Problem list + fully specified prescription (STG-grounded, formulary-constrained)
3. Five-dimension risk assessment (diagnostic uncertainty, iatrogenic, delay, complications, mitigation)
4. Triage decision, patient instructions, doctor handoff package

After Call 4, a deterministic rule engine runs. It can only escalate LOW → HIGH,
never downgrade. Rules are configured in `escalation_rules.json` and maintained
by Medical Officers independently of code deployments.

Target TTFT: <2.5s. Measured: ~2.4s (M1+RAG ~2.1s + M2 streaming).

---

## Safety architecture

- **Deterministic rule engine** — hard escalation rules for vital derangements,
  red flag symptoms, high-risk diagnoses, teratogenic/injectable drugs, infants
  under 2, pregnancy, allergy conflicts, and low diagnostic confidence. Rules are
  data-driven and MO-maintained (`escalation_rules.json`).
- **Formulary constraint** — drug selection is constrained to `formulary_wb.json`
  (SHC-HWC essential medicines). Per-clinic stock availability should be verified
  before going live.
- **STG-grounded prescriptions** — every drug in the prescription must cite
  `stg_source` from retrieved Standard Treatment Guidelines. The `stg_retrieval`
  audit metadata is stored in the Vault per session.
- **Layer 3 epi prior** — the app's own encounter data only influences the
  epidemiological prior after passing three confirmation gates (RDT result,
  treatment response, doctor agreement). Provisional diagnoses never influence it.
- **Vault is immutable after session close** — the session JSONB document is the
  permanent clinical and audit record. Never modified post-close.
- **Safety-critical fields set deterministically** — `triage.tier`, `triage.action`,
  `triage.rationale`, `authorization_required_by`, and `must_not_miss` flags are
  injected from the rule engine and `validate_*()` functions, never relayed by LLM.

---

## Doctor authorization flow

| Risk tier | Flow |
|-----------|------|
| LOW | Nurse proceeds with treatment plan. Doctor reviews async within 4 hours. No response = ratified. |
| HIGH | Synchronous. Nurse calls doctor or refers immediately. Do not proceed without doctor contact. |

Doctor API:
- `GET /api/session/:id/status` — stage completion status and risk tier
- `POST /api/session/:id/doctor-auth` — approve / modify / reject with optional notes

---

## What is and isn't built

### Complete
- Session orchestrator (Node.js — WebSocket lifecycle, Deepgram STT, marker routing, Vault)
- All three pipeline stages (Node.js)
- Doctor authorization API
- User auth with OTP email verification
- STG ingestion pipeline (Python scripts)
- RAG corpus ingested (ICMR STW volumes 1, 3, 4, PTB/EPTB — 1,426 chunks in Supabase)
- Postgres schema + Supabase setup script
- Epidemiological prior data (all 23 WB districts, 4 seasons)
- Formulary data (SHC-HWC essential medicines)
- Rule engine (`escalation_rules.json`)
- Mobile app (React Native / Expo — audio client, session flow, streaming display)
- Web frontend (dashboard, consultation recording, history, transcripts)

### Not yet built
- Missing RAG sources — NVBDCP malaria ACT protocol and NHM kala-azar guidelines
  not yet ingested; management stage Rx unreliable for these conditions
- Patient records write-back (confirmation pipeline gate)
- Confirmation pipeline (RDT → treatment response → doctor agreement → Layer 3)
- Doctor notification service (replace `_notify_doctor()` stub with FCM/SMS)
- Formulary admin UI (per-clinic JSON management)
- Doctor review interface

---

## Architecture decisions

The `docs/decisions/adr/` folder contains Architecture Decision Records. Read the
relevant ADR before proposing changes to any component it covers.

| ADR | Topic |
|-----|-------|
| [001-agentic-patterns.md](docs/decisions/adr/001-agentic-patterns.md) | Agentic vs fixed pipeline design trade-offs |
| [002-history-intake-approach.md](docs/decisions/adr/002-history-intake-approach.md) | Fixed vs LLM-generated background history questions |
| [003-problem-oriented-management.md](docs/decisions/adr/003-problem-oriented-management.md) | Single-diagnosis vs problem_list with type discriminator |
| [004-model-tier-selection.md](docs/decisions/adr/004-model-tier-selection.md) | Gemini model tier assignments per pipeline call |
| [005-diagnosis-stage-ttft.md](docs/decisions/adr/005-diagnosis-stage-ttft.md) | D-stage 1.5s TTFT target — speculative streaming deferred to after field pilots |

Open questions and decisions still pending are tracked in
[`docs/decisions/DECISIONS_OPEN.md`](docs/decisions/DECISIONS_OPEN.md).

Key decisions not up for re-discussion without strong reason:
- Continuous WebSocket, not discrete file uploads
- No RAG in History or Diagnosis Stages
- Three separate stages, not one monolithic pipeline
- Deterministic rule engine (not LLM) for safety escalation
- Formulary as a JSON file, not in the vector store
- Layer 3 epi prior written only from confirmed encounters

See [CLAUDE.md](CLAUDE.md) for the full architecture reference including
WebSocket protocol, Vault schema, and all outstanding design questions that
must be resolved before implementing the remaining components.
