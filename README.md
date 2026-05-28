# CDST — Clinical Decision Support Tool

A mobile-first clinical decision support system for nurses conducting remote
consultations in rural West Bengal, India. Patients have no direct access to
doctors. The nurse conducts a structured audio consultation; three pipeline stages
produce a triage decision, prescription, and risk-assessed management plan
that a remote doctor reviews asynchronously.

---

## How the system works

A single WebSocket session opens when the nurse starts a consultation. Audio
streams continuously to the server and is transcribed in real time. The nurse
presses three buttons at defined moments:

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
├── server/                     # Active backend — all pipeline changes go here
│   ├── index.js                # Express entry point
│   ├── orchestrator.js         # WebSocket session orchestrator
│   ├── railway.json            # Railway deployment config
│   ├── lib/
│   │   ├── auth.js             # JWT authentication
│   │   ├── db.js               # Postgres connection + vault helpers
│   │   ├── epiUtils.js         # Shared epidemiological utilities
│   │   ├── llmClient.js        # Shared Gemini client
│   │   └── modelConfig.js      # LLM model assignments for all 9 pipeline calls
│   ├── routes/
│   │   ├── auth.js             # Auth endpoints
│   │   ├── session.js          # Session status + doctor auth
│   │   ├── audio.js            # Audio upload
│   │   ├── dashboard.js        # Doctor review queue
│   │   └── transcripts.js      # Transcript retrieval
│   └── stages/
│       ├── historyStage.js     # Two-call pipeline, no RAG
│       ├── diagnosisStage.js   # Three-call pipeline, no RAG
│       ├── managementStage.js  # Four-call pipeline, RAG in Call 2
│       └── managementHelpers.js # Rule engine, prescription builder, validators
├── src/                        # React Native mobile app (Expo)
│   ├── screens/                # App screens
│   ├── services/               # apiService, wsService, authService
│   ├── navigation/             # AppNavigator, AuthNavigator
│   ├── components/             # Shared UI components
│   └── context/                # AuthContext
├── App.js                      # React Native root
├── app.json                    # Expo config
├── data/                       # Clinical data — used by server/ at runtime
│   ├── epi_prior_wb.json       # All 23 WB districts, 4 seasonal buckets
│   ├── bedside_tools.json      # Constraint list for nurse-available diagnostic tools
│   ├── formulary_wb.json       # SHC-HWC essential medicines (MoHFW Operational Guidelines)
│   ├── escalation_rules.json   # Rule engine configuration (MO-maintained)
│   └── must_not_miss.json      # Must-not-miss diagnoses list (MO-maintained)
├── db/
│   └── schema.sql              # Postgres schema
├── docs/
│   ├── decisions/
│   │   ├── DECISIONS_OPEN.md   # All unresolved questions grouped by owner
│   │   └── adr/                # Architecture Decision Records
│   ├── arch/                   # System and streaming architecture diagrams
│   └── clinical/               # MO review checklist, bedside tool citations, escalation guide
└── python_pipeline/            # ARCHIVED — reference only, do not edit
    ├── scripts/ingest_stg.py   # STG embedding pipeline (chunk → embed → pgvector)
    └── evals/validate_pipeline.py
```

---

## Tech stack

| Component | Choice |
|-----------|--------|
| Backend | Express (Node.js) — `server/` |
| Database | Postgres + pgvector |
| Object storage | S3-compatible |
| LLM | Gemini via Google Gemini API — model assignments in `server/lib/modelConfig.js` |
| Embeddings | sentence-transformers/all-MiniLM-L6-v2 (384-dim) |
| Mobile | React Native (Expo) — `src/` |
| Auth | JWT — roles: nurse / doctor / admin |

---

## Getting started

### Prerequisites

- Node.js 20+
- Postgres with pgvector extension
- Python 3.11+ (for STG ingestion only — not required to run the server)
- API keys: `GEMINI_API_KEY`
- JWT config: `JWT_SECRET`, `JWT_ALGORITHM`
- Database: `DATABASE_URL`

### Install dependencies

```bash
# Server
cd server && npm install

# Mobile app
npm install
```

### Database setup

```bash
psql -U postgres -f db/schema.sql
```

### Ingest STG documents (required before first session)

The Management Stage uses RAG over Standard Treatment Guidelines. Run this
once before going live. Requires Python + the archived pipeline's dependencies.

```bash
cd python_pipeline

# Single document
python scripts/ingest_stg.py --file ../docs/nhm_stg_malaria.pdf --disease malaria

# Whole directory with a disease map
python scripts/ingest_stg.py --dir ../docs/stg/ --disease-map scripts/disease_map.json

# Dry run — prints chunks without touching the DB
python scripts/ingest_stg.py --file ../docs/nhm_stg_malaria.pdf --disease malaria --dry-run
```

Verify ingestion:

```sql
SELECT disease, count(*) FROM stg_chunks GROUP BY disease ORDER BY count DESC;
```

**Priority order for ingestion:** NHM STG (all volumes) → NVBDCP malaria ACT
protocol → NHM kala-azar guidelines → RNTCP/NTP TB guidelines → WB state addenda.

Do not ingest `formulary_wb.json` — it is injected directly into prompts, not
stored in the vector store.

### Run the server

```bash
cd server && node index.js
```

---

## The three stages

### History Stage (`server/stages/historyStage.js`)
Two LLM calls, no RAG. Fires at Marker A.
1. Extracts chief complaint from the ~30s phase 1 transcript
2. Generates a contextualised intake questionnaire — full intake for new patients,
   short verification pass for returning patients

First token on screen within ~1.2s of button press.

### Diagnosis Stage (`server/stages/diagnosisStage.js`)
Three LLM calls, no RAG. Fires at Marker B.
1. Extracts structured medical concepts (negatives as important as positives;
   uncertain findings captured separately in `uncertain_findings`)
2. Generates ranked differential (4-6 conditions) with two-layer epidemiological prior
3. Generates bedside gap analysis and clarifying questions (constrained to `bedside_tools.json`)

Differential output always has 11 required fields. `validateDifferential()` fills
safe defaults for any missing fields so downstream consumers never handle nulls.
Must-not-miss diagnoses are loaded from `data/must_not_miss.json` at runtime and
flagged deterministically — not by LLM instruction.

### Management Stage (`server/stages/managementStage.js`)
Four LLM calls, RAG in Call 2. Fires at Marker C.
1. Extracts clarifying findings from phase 3 transcript (runs in parallel with RAG retrieval)
2. Problem list — all distinct clinical issues with assessment, plan, and STG-grounded prescription
3. Five-dimension risk assessment (diagnostic uncertainty, iatrogenic, delay, complications, mitigation)
4. Triage decision, patient instructions, doctor handoff package

Calls 3 and 4 run in parallel. After both complete, a deterministic rule engine
runs. It can only escalate LOW → HIGH, never downgrade. Rules are configured in
`escalation_rules.json` and maintained by Medical Officers independently of code.

---

## Safety architecture

- **Deterministic rule engine** — hard escalation rules for vital derangements,
  red flag symptoms, high-risk diagnoses, teratogenic/injectable drugs, infants
  under 2, pregnancy, allergy conflicts, and low diagnostic confidence. Data-driven
  and MO-maintained via `data/escalation_rules.json`.
- **Formulary constraint** — drug selection is constrained to `formulary_wb.json`
  (SHC-HWC essential medicines). Per-clinic stock should be verified before going live.
- **STG-grounded prescriptions** — every drug must cite `stg_source` from retrieved
  Standard Treatment Guidelines. Drug record is built deterministically in JS —
  not LLM-generated — to prevent paraphrasing or omission.
- **Safety-critical fields are injected, not relayed** — `triage.tier`,
  `triage.action`, `triage.rationale`, and `must_not_miss` flags are set by the
  rule engine and validator functions, not passed through an LLM call.
- **Layer 3 epi prior confirmation-gated** — the app's own encounter data only
  influences the epidemiological prior after three gates: RDT result, treatment
  response, doctor agreement. Provisional diagnoses never influence it.
- **Vault is immutable after session close** — the session JSONB document is the
  permanent clinical and audit record.

---

## Doctor authorization flow

| Risk tier | Flow |
|-----------|------|
| LOW | Nurse proceeds with treatment plan. Doctor reviews async within 24 hours. No response = ratified. |
| HIGH | Synchronous. Nurse calls doctor or refers immediately. Do not proceed without doctor contact. |

Doctor API:
- `GET /session/{id}/status` — stage completion status and risk tier
- `POST /session/{id}/doctor-auth` — approve / modify / reject with optional notes

---

## What is and isn't built

### Complete
- Session orchestrator (WebSocket lifecycle, marker routing, Vault)
- All three pipeline stages (history, diagnosis, management)
- Doctor authorization API
- STG ingestion pipeline (Python — `python_pipeline/scripts/`)
- React Native mobile app (screens, WebSocket client, audio upload)
- Postgres schema (`sessions`, `stg_chunks`, `patient_records`, `confirmed_encounters`, `patient_log`)
- Epidemiological prior data (all 23 WB districts, 4 seasons)
- Formulary data (SHC-HWC essential medicines from MoHFW Operational Guidelines)
- Rule engine (`data/escalation_rules.json`) with 5 hard-stop categories
- Must-not-miss diagnoses list (34 diagnoses across 8 categories)

### Not yet built
- Patient records write-back (requires confirmation pipeline)
- Confirmation pipeline (RDT result → treatment response → doctor agreement → Layer 3)
- Doctor notification service (replace `_notifyDoctor()` stub with FCM/SMS)
- Doctor review interface (mobile-friendly queue with one-tap approve/modify/reject)
- Site Administrator Portal (MO sign-off for clinical config files)
- Nurse preference personalisation (language/verbosity settings)

---

## Architecture decisions

The [`docs/decisions/adr/`](docs/decisions/adr/) folder contains Architecture Decision Records.
Read the relevant ADR before proposing changes to any component it covers.

| ADR | Topic |
|-----|-------|
| [001-agentic-patterns.md](docs/decisions/adr/001-agentic-patterns.md) | Agentic vs fixed pipeline design trade-offs |
| [002-history-intake-approach.md](docs/decisions/adr/002-history-intake-approach.md) | Fixed vs LLM-generated background history questions |
| [003-problem-oriented-management.md](docs/decisions/adr/003-problem-oriented-management.md) | Single-diagnosis vs problem_list with type discriminator |
| [004-model-tier-selection.md](docs/decisions/adr/004-model-tier-selection.md) | Gemini model tier per call; thinking suppression |
| [005-diagnosis-stage-ttft.md](docs/decisions/adr/005-diagnosis-stage-ttft.md) | D-stage TTFT target; speculative streaming deferred |

Open questions are tracked in [`docs/decisions/DECISIONS_OPEN.md`](docs/decisions/DECISIONS_OPEN.md).

Key decisions not up for re-discussion without strong reason:
- Continuous WebSocket, not discrete file uploads
- No RAG in History or Diagnosis Stages
- Three separate stages, not one monolithic pipeline
- Deterministic rule engine (not LLM) for safety escalation
- Formulary as a JSON file, not in the vector store
- Layer 3 epi prior written only from confirmed encounters
- Safety-critical output fields injected from deterministic sources, not LLM-relayed

See [CLAUDE.md](CLAUDE.md) for the full architecture reference including
WebSocket protocol, Vault schema, latency measurements, and all outstanding
design questions that must be resolved before building remaining components.
