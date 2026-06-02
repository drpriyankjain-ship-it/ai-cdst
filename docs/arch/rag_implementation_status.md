# RAG Implementation Status

Status: live in Supabase; ready for broader retrieval evaluation.

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
- Updated the Node management stage retrieval path to use the same pgvector corpus, store `stg_retrieval`, prefer same-disease chunks, and avoid returning chunks from the wrong disease when disease-specific chunks are weak or absent.
- Added `requirements.txt` for the Python dependencies needed to run ingestion and the backend.
- Ingested the approved source corpus into Supabase `stg_chunks`.
- Rebuilt the pgvector IVFFlat index after ingestion and refreshed table statistics.

## Latest Ingestion

Command:

```bash
DATABASE_URL="postgresql://..." /opt/anaconda3/bin/python3 scripts/ingest_stg.py \
  --dir "docs/clinical/RAG source" \
  --manifest scripts/rag_source_manifest.json \
  --replace-source
```

Result:

- Total chunks extracted: 1,478
- Unique chunks inserted into Supabase: 1,426
- Exact duplicate chunks skipped: 52
- `ICMR_STW_MANUAL_V1_VOLUME_1`: 511 chunks
- `ICMR_STW_VOLUME_3_2022`: 482 chunks
- `ICMR_STW_VOLUME_4_2024`: 344 chunks
- `ICMR_STW_PTB_EPTB_2024`: 141 chunks

Disease tagging is now chunk-level. Broad/generic chunks remain untagged, while chunks whose heading/content mention a known condition receive a disease tag.

## Live Smoke Tests

- `tuberculosis`: retrieves TB guideline chunks, including a dosing chunk.
- `diarrhoea with dehydration`: retrieves same-disease dehydration/rehydration chunks after the same-disease fallback.
- `pneumonia lower respiratory tract infection`: retrieves same-disease oxygen/antibiotic/referral chunks after the same-disease fallback.
- `guillain-barre syndrome`: retrieves a referral/supportive-care chunk, which is the expected HIGH-risk behavior.
- `malaria`: returns no chunks with the current corpus instead of incorrectly returning TB chunks. Add the NVBDCP malaria protocol PDF before relying on malaria prescriptions.

## Remaining Work Before Clinical Use

1. Add missing disease-specific protocol PDFs, especially NVBDCP malaria ACT dosing and kala-azar guidance.
2. Re-run ingestion after adding each source:

```bash
DATABASE_URL="postgresql://..." /opt/anaconda3/bin/python3 scripts/ingest_stg.py \
  --dir "docs/clinical/RAG source" \
  --manifest scripts/rag_source_manifest.json \
  --replace-source
```

3. Verify inserted chunks:

```sql
SELECT source, disease, section, count(*)
FROM stg_chunks
GROUP BY source, disease, section
ORDER BY source, disease, section;
```

4. Run retrieval quality checks for common and negative cases before clinical review.

Smoke-test command:

```bash
DATABASE_URL="postgresql://..." /opt/anaconda3/bin/python3 scripts/query_stg.py \
  --diagnosis tuberculosis
```
