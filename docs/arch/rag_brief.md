# CDST — Clinical Decision Support Tool
## Engineering Brief: RAG Setup for the Management Agent

| Field | Detail |
|---|---|
| Prepared for | Software Engineering Team |
| Document type | Technical Implementation Brief |
| Component | Management Agent — RAG Pipeline |
| Stack | Python / FastAPI / Postgres + pgvector / sentence-transformers |
| Target region | West Bengal, India |
| Status | Ready for implementation |

---

## 1. Project overview

CDST is a mobile clinical decision support tool for nurses working in remote areas of West Bengal, India, where patients have no direct access to doctors. The app guides the nurse through a structured consultation and produces a triage decision, prescription, and risk-assessed management plan that a remote doctor reviews and authorises asynchronously.

### 1.1 Consultation workflow

Each consultation is a continuous audio session divided into three phases, separated by button presses (timestamp markers) from the nurse:

| Phase | What happens |
|---|---|
| Phase 1 (~30s) | Nurse records patient's initial complaint. History Agent generates a structured questionnaire based on chief complaint, GPS location, season, and prior encounter history. |
| Phase 2 (3–4 min) | Nurse conducts the full structured interview. Diagnosis Agent extracts medical concepts, generates a differential diagnosis (4–6 conditions), and produces clarifying questions and bedside observations for the nurse. |
| Phase 3 (1–2 min) | Nurse asks clarifying questions and records bedside findings. Management Agent takes over — this is the component this brief covers. |

### 1.2 Three-agent architecture

Each agent is an independent FastAPI service with its own LLM call pipeline. All agents share a single session document in Postgres (the Vault) — a JSONB record that accumulates outputs from each phase.

| Agent | Role |
|---|---|
| History Agent | Questionnaire generation from phase 1 transcript. No RAG — LLM general knowledge + Vault context. |
| Diagnosis Agent | Differential diagnosis from phase 2 transcript. No RAG — LLM general knowledge + epidemiological prior (IDSP data). |
| Management Agent | Provisional diagnosis, prescription, risk assessment, triage. Uses RAG — this is the subject of this brief. |

### 1.3 Data storage

Postgres is the primary database. Two components are relevant to RAG:

- **sessions table:** one JSONB document per consultation — the Vault. Holds the full session state accumulated across all three agents.
- **stg_chunks table:** the vector store. Holds embedded chunks of NHM Standard Treatment Guidelines and clinical protocols. Queried by the Management Agent using pgvector cosine similarity search.

---

## 2. Why RAG — and why only in the Management Agent

### 2.1 What RAG is used for

RAG (retrieval-augmented generation) is used in the Management Agent to retrieve authoritative, locally specific treatment protocol text from the NHM Standard Treatment Guidelines before the prescription is generated. The retrieved chunks ground the LLM's prescription in the actual STG rather than relying on the model's training data.

> **Core principle**
>
> The LLM does not recall the dose of artemether-lumefantrine by weight band from memory. It reads it from the retrieved STG chunk and cites the source. This is the only way to ensure prescriptions are locally validated, current, and auditable.

### 2.2 Why not in the History or Diagnosis Agents

RAG was considered for all three agents and deliberately excluded from History and Diagnosis for the following reasons:

| Agent | RAG decision and rationale |
|---|---|
| History Agent | No RAG. Questionnaire generation from a chief complaint draws on general clinical knowledge the LLM holds natively. The contextual signal comes from the Vault (GPS, season, prior encounters) — not retrieved documents. |
| Diagnosis Agent | No RAG. Differential generation and gap analysis (identifying discriminating bedside findings) are clinical reasoning tasks the LLM performs well natively. A neurological presentation in a malaria-endemic district correctly leads with neurological diagnoses — the LLM does not need an STG chunk to reason about UMN vs LMN signs. RAG was prototyped and removed because it added latency without improving output quality. |
| Management Agent | RAG required. Drug selection, dosing, contraindications, referral criteria, and formulary constraints are protocol-execution tasks — they must follow the retrieved, locally validated STG, not LLM recall. Errors here cause patient harm. |

### 2.3 What retrieval grounds in this agent

The Management Agent makes four sequential LLM calls. RAG retrieval feeds into Call 2 specifically:

- Drug of choice for the provisional diagnosis — per NHM STG first-line recommendation
- Weight-based dosing schedules — paediatric and adult weight bands
- Route, frequency, and duration — per STG protocol
- Contraindications — absolute and relative, including pregnancy and G6PD status
- Referral criteria — when the STG mandates hospital-level care
- Second-line alternatives — for when the first-line drug is not in the local formulary

> **What RAG does NOT do in this agent**
>
> RAG does not drive the provisional diagnosis decision — that is made by Call 2's LLM reasoning over the full differential from the Diagnosis Agent. RAG provides the treatment protocol text for the already-selected diagnosis. The risk assessment (Call 3) and triage decision (Call 4) also do not use RAG — they reason over structured outputs from Call 2.

---

## 3. Where RAG sits in the Management Agent pipeline

The Management Agent runs four LLM calls in sequence. RAG retrieval runs in parallel with Call 1 using `asyncio.gather` — it adds zero wall-clock latency.

| Step | What happens |
|---|---|
| Call 1 (~900ms) + RAG in parallel | Phase 3 transcript is parsed to extract clarifying findings (nurse's answers, bedside examination results, updated vitals). Simultaneously, RAG retrieval fires for the top 1–2 diagnoses from the differential table. |
| Call 2 (~2.5s) | Provisional diagnosis is selected and a fully specified prescription is generated. The retrieved STG chunks are injected into this prompt. The local formulary is also injected to constrain drug selection to what is actually available at the clinic. |
| Call 3 (~1.8s) | Five-dimension risk assessment: diagnostic uncertainty, iatrogenic risk, delay risk, complication watch, and mitigation plan. No RAG — pure LLM reasoning over structured Call 2 output. |
| Call 4 (~1.2s) | Triage decision (LOW/HIGH), patient instructions in plain language, and doctor handoff package. No RAG. |
| Rule engine (~0ms) | Deterministic safety gate — checks for hard stops (injectable drugs, allergy conflicts, infant age, pregnancy, low diagnostic confidence). Overrides the LLM tier if triggered. Never downgrades. |

---

## 4. RAG implementation — detailed setup guide

### 4.1 Database setup

The vector store lives in the same Postgres instance as the sessions table. Enable the pgvector extension and create the stg_chunks table:

```sql
-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- STG chunk table
CREATE TABLE stg_chunks (
    chunk_id    SERIAL PRIMARY KEY,
    source      TEXT NOT NULL,       -- e.g. 'NHM_STG_2023_malaria_ch3'
    disease     TEXT,                -- primary disease tag for filtered retrieval
    section     TEXT,                -- e.g. 'treatment' | 'dosing' | 'referral'
    content     TEXT NOT NULL,       -- the raw chunk text
    embedding   vector(384),         -- all-MiniLM-L6-v2 output dimension
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- ANN index for fast cosine similarity search
CREATE INDEX ON stg_chunks USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- Optional: filtered retrieval by disease or section
CREATE INDEX ON stg_chunks (disease);
CREATE INDEX ON stg_chunks (section);
```

> **IVFFlat index tuning**
>
> `lists = 100` is appropriate for up to ~100,000 chunks. If the STG corpus grows beyond that, increase `lists` proportionally (roughly `lists = sqrt(n_rows)`). At query time, set `probes = 10` for a good accuracy/speed tradeoff: `SET ivfflat.probes = 10;`

### 4.2 Source documents to embed

The following documents should be ingested into the vector store. All are publicly available from the Government of India or West Bengal health authorities:

| Document | Source and notes |
|---|---|
| NHM Standard Treatment Guidelines (STG) — all volumes | nhm.gov.in — core source. Cover malaria, TB, ARI, diarrhoeal diseases, pregnancy, neonatal care, NCDs, snake envenomation, and more. These are the primary clinical authority. |
| NVBDCP malaria treatment protocol | nvbdcp.gov.in — specific to artemisinin-based combination therapy (ACT) dosing by weight band, G6PD testing requirements before primaquine, drug-resistant falciparum protocols. |
| NHM kala-azar operational guidelines | nvbdcp.gov.in — liposomal amphotericin B dosing, PKDL treatment, referral criteria. |
| West Bengal state drug formulary | Obtain from West Bengal Health Department. Maps to drugs actually stocked at PHC/CHC level. This is the constraint list for the prescription — drugs not in the formulary should never be prescribed. |
| RNTCP/NTP TB treatment guidelines | nikshay.in — first and second line regimens, DOTS protocols, referral for MDR-TB. |
| WHO essential medicines list (India adaptation) | Supplementary source for drugs without NHM-specific protocol. |

> **Formulary is not part of the vector store**
>
> The local formulary (drugs available at the clinic) is a small structured JSON file, not an embedded document. It is injected directly into the Call 2 prompt as a list. It is **NOT** embedded into pgvector. The vector store is for clinical protocol text only. See `data/formulary_wb.json` in the project repository for the schema — each clinic will have its own version of this file reflecting its actual stock.

### 4.3 Chunking strategy

How you split the STG documents into chunks critically determines retrieval quality. Use the following strategy:

#### Chunk size

- Target 300–500 tokens per chunk (roughly 200–350 words)
- Minimum 150 tokens — shorter chunks lose clinical context
- Maximum 600 tokens — longer chunks dilute the similarity signal

#### Chunk boundaries — do not split mid-table or mid-dosing-schedule

The most important retrieval content — dosing tables, contraindication lists, referral criteria — is structured. Splitting a weight-band dosing table across two chunks means neither chunk is useful. Rules:

- Always split on section or subsection headings
- Never split a dosing table — keep the entire table in one chunk even if it exceeds 600 tokens
- Never split a numbered list of contraindications — keep the full list in one chunk
- Add 50-token overlap between adjacent chunks to preserve sentence context at boundaries

#### Metadata to store with each chunk

Every chunk must have these fields populated in the `stg_chunks` table:

- `source`: document name + chapter/section identifier (e.g. `'NHM_STG_2023_malaria_ch3_s2'`)
- `disease`: primary disease this chunk covers (e.g. `'Plasmodium falciparum malaria'`) — used for filtered retrieval
- `section`: semantic section type — one of: `'treatment'` | `'dosing'` | `'contraindications'` | `'referral'` | `'diagnosis'` | `'complications'` | `'general'`
- `content`: the raw chunk text exactly as it appears in the document

> **Why section metadata matters**
>
> The Management Agent retrieves treatment-focused chunks. A query for `'malaria treatment dose weight'` should preferentially retrieve chunks tagged `section='dosing'` or `section='treatment'` rather than epidemiology or diagnostic criteria sections. You can add a `WHERE section IN ('treatment','dosing','referral')` filter to the pgvector query to improve precision without hurting recall.

### 4.4 Embedding model

The current implementation uses `sentence-transformers/all-MiniLM-L6-v2` (384 dimensions). This is a reasonable starting point but has known limitations for clinical text:

| Model | Notes |
|---|---|
| all-MiniLM-L6-v2 (current) | General-purpose, fast, 384-dim. Works adequately for English clinical text. Does not handle Bengali-English code-switching or clinical abbreviations well. |
| pritamdeka/BioBERT-mnli-snli-scinli-scitail-mednli-stsb | Clinical domain fine-tuned. Better for medical terminology. 768-dim — requires updating the `vector(384)` column to `vector(768)`. |
| intfloat/multilingual-e5-base | Multilingual — handles Bengali-English mixing. 768-dim. Recommended if STG documents include Bengali text or if queries contain transliterated Bengali terms. |

To change the embedding model, update the vector dimension in the `CREATE TABLE` statement and re-embed the entire corpus. This is a one-time cost — do it before ingesting documents rather than after.

> **Recommendation**
>
> Start with `all-MiniLM-L6-v2` for the initial build — it is already installed and working. Plan a one-time migration to a clinical or multilingual model after the first evaluation of retrieval quality on real STG queries. Do not optimise prematurely.

### 4.5 Ingestion pipeline

Write a one-time ingestion script (`scripts/ingest_stg.py`). The pipeline is:

1. Load and parse the source PDF or HTML document
2. Split into chunks following the chunking strategy above
3. For each chunk: call `embedder.encode(chunk_text)` to get the 384-dim vector
4. Insert into `stg_chunks`: `content`, `embedding`, `source`, `disease`, `section`
5. After all chunks inserted, run `VACUUM ANALYZE stg_chunks` to update index statistics

```python
# Minimal ingestion example
from sentence_transformers import SentenceTransformer
import asyncpg, json

embedder = SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')

async def ingest_chunks(chunks: list[dict], conn):
    """
    chunks is a list of dicts:
    { content, source, disease, section }
    """
    texts = [c['content'] for c in chunks]
    embeddings = embedder.encode(texts, batch_size=32, show_progress_bar=True)

    await conn.executemany(
        '''INSERT INTO stg_chunks (content, source, disease, section, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)''',
        [
            (c['content'], c['source'], c['disease'],
             c['section'], json.dumps(emb.tolist()))
            for c, emb in zip(chunks, embeddings)
        ]
    )
```

> **Batch embedding**
>
> Encode in batches of 32 chunks, not one at a time. Batching uses GPU parallelism and is 10–20x faster for large corpora. `all-MiniLM-L6-v2` processes ~500 chunks/minute on CPU, ~5000/minute on GPU. A 200-page STG document produces roughly 400–600 chunks.

### 4.6 Retrieval query design

The `retrieve_treatment_protocols()` function in `management_agent.py` constructs queries for each top diagnosis. The current query template is:

```python
query = (
    f'treatment protocol dose duration route contraindications '
    f'referral criteria {diagnosis} NHM India STG'
)
```

This is intentionally verbose. The query includes the disease name AND the semantic context of what we want (treatment, dose, contraindications, referral). This improves retrieval precision over a bare disease name query.

#### Similarity threshold

The current threshold is `0.55` cosine similarity. Chunks below this score are excluded. This threshold was set conservatively:

- Too low (< 0.45): returns irrelevant chunks that dilute the context and confuse the LLM
- Too high (> 0.70): misses genuinely relevant chunks with slightly different vocabulary
- 0.55 is a reasonable starting point — tune it after evaluating retrieval quality on a sample of real queries

#### top_k per diagnosis

The current setting is `RAG_TOP_K = 8` chunks per diagnosis. With 2 diagnoses retrieved, the maximum context injected into Call 2 is 16 chunks. At 350 tokens per chunk, that is ~5600 tokens of retrieved context — manageable but on the larger side. If latency becomes an issue, reduce to `top_k = 5`.

### 4.7 Evaluation — how to know if retrieval is working

Before going live, evaluate retrieval quality with a test set of realistic clinical queries. The test set should cover:

- **Standard presentations:** fever + positive malaria RDT, diarrhoea + dehydration, productive cough + weight loss (TB), hypertension
- **Edge cases:** pregnancy + malaria, infant + fever, known penicillin allergy + respiratory infection
- **Negative cases:** neurological presentation (GBS, stroke) — retrieval should return few or no chunks above threshold

For each query, verify:

- The top 3 returned chunks are clinically relevant to the diagnosis and treatment question
- The top chunk contains the dosing schedule or treatment recommendation
- No irrelevant chunks (similarity > 0.55 for a completely unrelated disease) appear in the results
- The `stg_source` field in Call 2's output cites a real chunk from the retrieved set

> **Critical evaluation case**
>
> Run the GBS / difficulty walking case through the full pipeline. The Management Agent should retrieve zero or very few STG chunks for 'Guillain-Barré syndrome' since GBS treatment (IV immunoglobulin, plasmapheresis) is not in the NHM STG for PHC level. The agent should still produce a valid output — the prescription field should contain supportive care only and the triage tier should be HIGH with urgent referral. This tests that the pipeline degrades gracefully when retrieval returns nothing.

### 4.8 Keeping the corpus current

STGs are revised periodically — NHM typically releases updates annually. The following process should be in place:

- Assign a named clinical owner responsible for monitoring NHM/NVBDCP for guideline updates
- When an update is released, re-chunk and re-embed the updated document
- Delete old chunks: `DELETE FROM stg_chunks WHERE source LIKE 'NHM_STG_%_malaria%'` before inserting new ones — use the `source` field as the deletion key
- The `stg_source` citation field in the Vault links each prescription to the specific chunk version — this provides a full audit trail if a guideline changes
- Run the evaluation test set after every corpus update to verify retrieval quality has not degraded

### 4.9 Things that need human judgment before implementation

The following decisions cannot be made from the codebase alone and require input from the clinical lead or a medical officer before implementation:

| Decision | Why it needs a human |
|---|---|
| Which edition of the NHM STG to embed | Multiple editions exist. The clinical lead must confirm which edition is currently in use across West Bengal PHCs and CHCs. |
| West Bengal state drug formulary | The formulary file (`formulary_wb.json`) is currently a placeholder schema. A pharmacist or medical officer must supply the actual drug list for the target clinic type (PHC vs CHC). This list differs by facility. |
| G6PD testing availability | Primaquine for P. vivax malaria requires G6PD testing to avoid haemolysis. If G6PD RDT is not in the `bedside_tools.json` for a clinic, primaquine should not be in the prescription. Confirm G6PD RDT availability at target clinics. |
| Referral facility mapping | The rule engine outputs a referral facility type (PHC / CHC / district hospital). A real GPS-to-facility lookup is needed — which specific facility is nearest to which GPS coordinates. This is a data problem, not a code problem. |
| Similarity threshold tuning | The 0.55 cosine threshold was set without empirical evaluation. A clinician must review a sample of retrieved chunks and confirm they are relevant before the system goes live. The threshold may need raising or lowering. |
| Languages in the STG corpus | Some NHM documents are available in Bengali. If nurses enter queries that mix Bengali and English, a multilingual embedding model is required. Confirm the primary language of the STGs to be embedded. |

---

## 5. Relevant files in the repository

| File | Description |
|---|---|
| `management_agent.py` | Management Agent implementation. `retrieve_treatment_protocols()` is the RAG retrieval function. `RAG_TOP_K` and similarity threshold are constants at the top of the file. |
| `diagnosis_agent.py` | Diagnosis Agent — no RAG. Reference implementation for the three-call LLM pipeline pattern. |
| `db/schema.sql` | Postgres schema including the `stg_chunks` table definition with pgvector index. |
| `data/epi_prior_wb.json` | Epidemiological prior for all 23 WB districts across four seasonal buckets. Used by the Diagnosis Agent — not the Management Agent. |
| `data/bedside_tools.json` | Constraint list of tools available to a rural nurse. The Diagnosis Agent uses this to constrain clarifying questions. The Management Agent should use it to constrain non-pharmacological instructions. |
| `data/formulary_wb.json` | **PLACEHOLDER** — local formulary schema only. Must be populated with real drug stock data before going live. One file per clinic type (PHC / CHC). |
| `scripts/ingest_stg.py` | TO BE WRITTEN — ingestion script for embedding STG documents into `stg_chunks`. |

---

## 6. Implementation checklist

Work through these in order. Steps marked with `*` require clinical team input before proceeding.

- [ ] Enable pgvector on the Postgres instance: `CREATE EXTENSION IF NOT EXISTS vector`
- [ ] Run `db/schema.sql` to create the `stg_chunks` table and index
- [ ] `*` Confirm which NHM STG edition to use with the clinical lead
- [ ] Download all STG source documents (see Section 4.2 for list)
- [ ] Write `scripts/ingest_stg.py` following the chunking strategy in Section 4.3
- [ ] Run ingestion and verify chunk count and spot-check content quality
- [ ] `*` Populate `data/formulary_wb.json` with real drug stock for target clinic type
- [ ] `*` Confirm G6PD RDT availability and update `data/bedside_tools.json` if present
- [ ] Run the evaluation test set (Section 4.7) — check top-3 retrieval quality
- [ ] Tune similarity threshold based on evaluation results
- [ ] Run the GBS negative case — verify graceful degradation when retrieval returns nothing
- [ ] `*` Have a medical officer review 10 sample prescriptions generated by the full pipeline
- [ ] Set up annual reminder to check for NHM STG updates
