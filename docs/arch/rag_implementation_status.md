# RAG Implementation Status

Status: ready for database access.

## Completed

- Approved source corpus wired from `docs/clinical/RAG source`.
- Added `scripts/rag_source_manifest.json` for stable source labels.
- Added `data/rag_disease_aliases.json` for per-chunk disease inference.
- Updated `scripts/ingest_stg.py` to:
  - extract PDF/DOCX/TXT source material,
  - split documents into chunks,
  - infer `disease` from chunk heading/content rather than source filename,
  - infer section type (`treatment`, `dosing`, `referral`, etc.),
  - export preview JSONL before database ingestion,
  - skip duplicate chunks by `content_hash`,
  - replace prior chunks for a source when guidelines are updated,
  - check database/schema before embedding.
- Updated `db/schema.sql` with RAG metadata columns and indexes.
- Updated `management_stage.py` to store structured `stg_retrieval` audit metadata in the Vault and require real retrieved chunk citations in prescriptions.
- Added `requirements.txt` for the Python dependencies needed to run ingestion and the backend.

## Latest Dry Run

Command:

```bash
/opt/anaconda3/bin/python3 scripts/ingest_stg.py \
  --dir "docs/clinical/RAG source" \
  --manifest scripts/rag_source_manifest.json \
  --dry-run \
  --out tmp/stg_chunks_preview.jsonl
```

Result:

- Total chunks extracted: 1,478
- `ICMR_STW_MANUAL_V1_VOLUME_1`: 511 chunks
- `ICMR_STW_VOLUME_3_2022`: 482 chunks
- `ICMR_STW_VOLUME_4_2024`: 344 chunks
- `ICMR_STW_PTB_EPTB_2024`: 141 chunks

Disease tagging is now chunk-level. Broad/generic chunks remain untagged, while chunks whose heading/content mention a known condition receive a disease tag.

## Remaining Work After Database Access

1. Confirm Supabase/Postgres connection string.
2. Enable pgvector:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

3. Run `db/schema.sql` or the equivalent migration.
4. Ingest the approved corpus:

```bash
DATABASE_URL="postgresql://..." /opt/anaconda3/bin/python3 scripts/ingest_stg.py \
  --dir "docs/clinical/RAG source" \
  --manifest scripts/rag_source_manifest.json \
  --replace-source
```

5. Verify inserted chunks:

```sql
SELECT source, disease, section, count(*)
FROM stg_chunks
GROUP BY source, disease, section
ORDER BY source, disease, section;
```

6. Run retrieval quality checks for common and negative cases before clinical review.

Smoke-test command:

```bash
DATABASE_URL="postgresql://..." /opt/anaconda3/bin/python3 scripts/query_stg.py \
  --diagnosis tuberculosis
```
