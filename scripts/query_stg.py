"""
Run a RAG retrieval smoke test against an ingested stg_chunks table.

Usage:
  DATABASE_URL="postgresql://..." python scripts/query_stg.py --diagnosis tuberculosis
  DATABASE_URL="postgresql://..." python scripts/query_stg.py --diagnosis "diarrhoea with dehydration" --top-k 5
"""

import argparse
import asyncio
import json
import os
from pathlib import Path

import asyncpg
from sentence_transformers import SentenceTransformer


EMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
RAG_SIMILARITY_THRESHOLD = 0.55
RAG_DISEASE_FALLBACK_THRESHOLD = 0.48
RAG_SECTION_FILTER = ["treatment", "dosing", "contraindications", "referral", "general"]
ALIASES_PATH = Path(__file__).resolve().parents[1] / "data" / "rag_disease_aliases.json"


def resolve_canonical_disease(text: str) -> str | None:
    try:
        aliases = json.loads(ALIASES_PATH.read_text())
    except FileNotFoundError:
        return None

    haystack = text.lower()
    best: tuple[str, str] | None = None
    for disease, needles in aliases.items():
        for needle in needles:
            needle = needle.lower()
            if needle in haystack and (best is None or len(needle) > len(best[1])):
                best = (disease, needle)
    return best[0] if best else None


async def query_chunks(diagnosis: str, top_k: int, database_url: str) -> list[asyncpg.Record]:
    model = SentenceTransformer(EMBED_MODEL)
    query = (
        "treatment protocol dose duration route contraindications referral criteria "
        f"{diagnosis} NHM India STG"
    )
    canonical_disease = resolve_canonical_disease(diagnosis)
    embedding = model.encode(query, normalize_embeddings=True).tolist()

    conn = await asyncpg.connect(database_url)
    try:
        await conn.execute("SET ivfflat.probes = 10")
        rows = await conn.fetch(
            """
            SELECT chunk_id, source, disease, section, content,
                   1 - (embedding <=> $1::vector) AS similarity
            FROM stg_chunks
            WHERE embedding IS NOT NULL
              AND section = ANY($3::text[])
              AND 1 - (embedding <=> $1::vector) >= $4
              AND (
                $5::text IS NULL
                OR lower(coalesce(disease, '')) = lower($5)
                OR disease IS NULL
              )
            ORDER BY
              CASE
                WHEN lower(coalesce(disease, '')) = lower($5) THEN 0
                WHEN disease IS NULL THEN 1
                ELSE 2
              END,
              embedding <=> $1::vector
            LIMIT $2
            """,
            str(embedding),
            top_k,
            RAG_SECTION_FILTER,
            RAG_SIMILARITY_THRESHOLD,
            canonical_disease,
        )
        has_same_disease = canonical_disease and any((r["disease"] or "").lower() == canonical_disease for r in rows)
        if canonical_disease and not has_same_disease:
            fallback = await conn.fetch(
                """
                SELECT chunk_id, source, disease, section, content,
                       1 - (embedding <=> $1::vector) AS similarity
                FROM stg_chunks
                WHERE embedding IS NOT NULL
                  AND section = ANY($3::text[])
                  AND lower(coalesce(disease, '')) = lower($5)
                  AND 1 - (embedding <=> $1::vector) >= $4
                ORDER BY embedding <=> $1::vector
                LIMIT $2
                """,
                str(embedding),
                top_k,
                RAG_SECTION_FILTER,
                RAG_DISEASE_FALLBACK_THRESHOLD,
                canonical_disease,
            )
            if fallback:
                rows = fallback
        return rows
    finally:
        await conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Retrieve STG chunks for a diagnosis.")
    parser.add_argument("--diagnosis", required=True, help="Diagnosis or presentation to query.")
    parser.add_argument("--top-k", default=5, type=int, help="Number of chunks to display.")
    parser.add_argument("--db", default=os.environ.get("DATABASE_URL"), help="Supabase/Postgres connection URL.")
    args = parser.parse_args()

    if not args.db:
        parser.error("Set DATABASE_URL or pass --db.")

    rows = asyncio.run(query_chunks(args.diagnosis, args.top_k, args.db))
    if not rows:
        print(f"No STG chunks met similarity threshold for: {args.diagnosis}")
        return

    print(f"Top retrieved chunks for: {args.diagnosis}\n")
    for i, row in enumerate(rows, start=1):
        preview = " ".join(row["content"].split())[:350]
        print(
            f"{i}. similarity={row['similarity']:.3f} "
            f"source={row['source']} chunk={row['chunk_id']} "
            f"disease={row['disease'] or '(untagged)'} section={row['section']}"
        )
        print(f"   {preview}\n")


if __name__ == "__main__":
    main()
