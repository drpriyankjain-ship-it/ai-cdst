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
├── history_stage.py        # Two-call pipeline (chief complaint → questionnaire)
├── diagnosis_stage.py      # Three-call pipeline (concepts → DDx → gap analysis)
├── management_stage.py     # Four-call pipeline (RAG-grounded Rx, risk, triage)
├── orchestrator.py         # FastAPI WebSocket server — central component
├── data/
│   ├── epi_prior_wb.json   # Epidemiological priors — all 23 WB districts, 4 seasons
│   ├── bedside_tools.json  # Constraint list for nurse-available diagnostic tools
│   ├── formulary_wb.json   # SHC-HWC essential medicines (MoHFW Operational Guidelines)
│   ├── escalation_rules.json # Deterministic rule engine config (MO-maintained)
│   └── must_not_miss.json  # Must-not-miss diagnoses list (MO-maintained)
├── db/
│   └── schema.sql          # Postgres schema
├── docs/
│   ├── DECISIONS_OPEN.md   # All unresolved questions — grouped by who must answer them
│   ├── arch/               # System and audio streaming architecture diagrams
│   ├── eng/
│   │   ├── rag_brief.md    # Engineering brief for RAG setup
│   │   └── adr/            # Architecture Decision Records (read before proposing changes)
│   └── clinical/
│       ├── MO_REVIEW_CHECKLIST.md  # Site onboarding checklist for Medical Officers
│       ├── bedside_tools_crosscheck.md
│       ├── high_risk_escalation_rules.md
│       └── source-materials/       # Raw source PDFs (MoHFW guidelines, STG volumes)
└── scripts/
    └── ingest_stg.py       # STG embedding pipeline (chunk → embed → pgvector)
```

All Python files are at the repo root, not in subdirectories.

---

## Tech stack

| Component | Choice |
|-----------|--------|
| Backend | FastAPI (Python) |
| Database | Postgres + pgvector |
| Object storage | S3-compatible |
| STT | Deepgram streaming WebSocket |
| LLM | Claude claude-sonnet-4-20250514 (Anthropic API) |
| Embeddings | sentence-transformers/all-MiniLM-L6-v2 (384-dim) |
| Mobile | React Native |
| Auth | JWT — roles: nurse / doctor / admin |

---

## Getting started

### Prerequisites

- Python 3.11+
- Postgres with pgvector extension
- API keys: `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY` (optional — see stub mode below)
- JWT config: `JWT_SECRET`, `JWT_ALGORITHM`

### Install dependencies

```bash
pip install -r requirements.txt
```

### Database setup

```bash
psql -U postgres -f db/schema.sql
```

### Ingest STG documents (required before first session)

The Management Stage uses RAG over Standard Treatment Guidelines. Ingest
documents before running sessions:

```bash
# Single document
python scripts/ingest_stg.py --file docs/nhm_stg_malaria.pdf --disease malaria

# Whole directory with a disease map
python scripts/ingest_stg.py --dir docs/stg/ --disease-map scripts/disease_map.json

# Dry run — prints chunks without touching the DB
python scripts/ingest_stg.py --file docs/nhm_stg_malaria.pdf --disease malaria --dry-run
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
uvicorn orchestrator:app --host 0.0.0.0 --port 8000
```

**Deepgram stub mode:** If `DEEPGRAM_API_KEY` is not set, the server runs with a
no-op STT stub. Audio is received and buffered but not transcribed. Use this for
local development without a live Deepgram account.

---

## The three stages

### History Stage (`history_stage.py`)
Two LLM calls, no RAG. Fires at Marker A.
1. Extracts chief complaint from the ~30s phase 1 transcript
2. Generates a contextualised intake questionnaire — full intake for new patients,
   short verification pass for returning patients

### Diagnosis Stage (`diagnosis_stage.py`)
Three LLM calls, no RAG. Fires at Marker B.
1. Extracts structured medical concepts (negatives as important as positives)
2. Generates ranked differential (4-6 conditions) with epidemiological prior
3. Generates bedside gap analysis and clarifying questions (constrained to `bedside_tools.json`)

Differential output always has 11 required fields. `validate_differential()` fills
safe defaults for any missing fields so downstream consumers never handle nulls.
Must-not-miss diagnoses are loaded from `data/must_not_miss.json` at runtime.

### Management Stage (`management_stage.py`)
Four LLM calls, RAG in Call 2. Fires at Marker C.
1. Extracts clarifying findings from phase 3 transcript (runs in parallel with RAG retrieval)
2. Provisional diagnosis + fully specified prescription (STG-grounded, formulary-constrained)
3. Five-dimension risk assessment (diagnostic uncertainty, iatrogenic, delay, complications, mitigation)
4. Triage decision, patient instructions, doctor handoff package

After Call 4, a deterministic rule engine runs. It can only escalate LOW → HIGH,
never downgrade. Rules are configured in `escalation_rules.json` and maintained
by Medical Officers independently of code deployments.

---

## Safety architecture

- **Deterministic rule engine** — hard escalation rules for vital derangements,
  red flag symptoms, high-risk diagnoses, teratogenic/injectable drugs, infants
  under 2, pregnancy, allergy conflicts, and low diagnostic confidence. Rules are
  data-driven and MO-maintained.
- **Formulary constraint** — drug selection is constrained to `formulary_wb.json`
  (SHC-HWC essential medicines). Per-clinic stock availability should be verified
  before going live.
- **STG-grounded prescriptions** — every drug in the prescription must cite
  `stg_source` from the retrieved Standard Treatment Guidelines.
- **Layer 3 epi prior** — the app's own encounter data only influences the
  epidemiological prior after passing three confirmation gates (RDT result,
  treatment response, doctor agreement). Provisional diagnoses never influence it.
- **Vault is immutable after session close** — the session JSONB document is the
  permanent clinical and audit record. Never modified post-close.

---

## Doctor authorization flow

| Risk tier | Flow |
|-----------|------|
| LOW | Nurse proceeds with treatment plan. Doctor reviews async within 4 hours. No response = ratified. |
| HIGH | Synchronous. Nurse calls doctor or refers immediately. Do not proceed without doctor contact. |

Doctor API:
- `GET /session/{id}/status` — stage completion status and risk tier
- `POST /session/{id}/doctor-auth` — approve / modify / reject with optional notes

---

## What is and isn't built

### Complete
- Session orchestrator (WebSocket lifecycle, Deepgram STT, marker routing, Vault)
- All three stages (history, diagnosis, management)
- Doctor authorization API
- STG ingestion pipeline
- Postgres schema
- Epidemiological prior data (all 23 WB districts, 4 seasons)
- Formulary data (SHC-HWC essential medicines)
- Rule engine (escalation_rules.json)

### Not yet built
- Patient records write-back (confirmation pipeline gate)
- Confirmation pipeline (RDT → treatment response → doctor agreement → Layer 3)
- Audit log (append-only per-call record)
- Doctor notification service (replace `_notify_doctor()` stub with FCM/SMS)
- Formulary admin UI (per-clinic JSON management)
- Mobile app (React Native — audio client, session registration, streaming display, upload)
- Doctor review interface

---

## Architecture decisions

The `docs/eng/adr/` folder contains Architecture Decision Records. Read the
relevant ADR before proposing changes to any component it covers — decisions
there have already been worked through.

| ADR | Topic |
|-----|-------|
| [001-agentic-patterns.md](docs/eng/adr/001-agentic-patterns.md) | Agentic vs fixed pipeline design trade-offs |
| [002-history-intake-approach.md](docs/eng/adr/002-history-intake-approach.md) | Fixed vs LLM-generated background history questions |

Open questions and decisions still pending are tracked in [`docs/DECISIONS_OPEN.md`](docs/DECISIONS_OPEN.md).

Key decisions that are not up for re-discussion without strong reason:
- Continuous WebSocket, not discrete file uploads
- No RAG in History or Diagnosis Stages
- Three separate stages, not one monolithic pipeline
- Deterministic rule engine (not LLM) for safety escalation
- Formulary as a JSON file, not in the vector store
- Layer 3 epi prior written only from confirmed encounters

See [CLAUDE.md](CLAUDE.md) for the full architecture reference including
WebSocket protocol, Vault schema, and all outstanding design questions that
must be resolved before implementing the remaining components.
