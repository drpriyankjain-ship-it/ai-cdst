"""
Run a RAG retrieval smoke test against an ingested stg_chunks table.

Usage:
  DATABASE_URL="postgresql://..." python scripts/query_stg.py --diagnosis tuberculosis
  DATABASE_URL="postgresql://..." python scripts/query_stg.py --diagnosis "diarrhoea with dehydration" --top-k 5
"""

import argparse
import asyncio
import os

import asyncpg
from sentence_transformers import SentenceTransformer


EMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
RAG_SIMILARITY_THRESHOLD = 0.55
RAG_SECTION_FILTER = ["treatment", "dosing", "contraindications", "referral", "general"]


async def query_chunks(diagnosis: str, top_k: int, database_url: str) -> list[asyncpg.Record]:
    model = SentenceTransformer(EMBED_MODEL)
    query = (
        "treatment protocol dose duration route contraindications referral criteria "
        f"{diagnosis} NHM India STG"
    )
    embedding = model.encode(query, normalize_embeddings=True).tolist()

    conn = await asyncpg.connect(database_url)
    try:
        await conn.execute("SET ivfflat.probes = 10")
        return await conn.fetch(
            """
            SELECT chunk_id, source, disease, section, content,
                   1 - (embedding <=> $1::vector) AS similarity
            FROM stg_chunks
            WHERE embedding IS NOT NULL
              AND section = ANY($3::text[])
              AND 1 - (embedding <=> $1::vector) >= $4
            ORDER BY
              CASE
                WHEN lower(coalesce(disease, '')) = lower($5) THEN 0
                WHEN disease IS NOT NULL AND lower($5) LIKE '%' || lower(disease) || '%' THEN 1
                ELSE 2
              END,
              embedding <=> $1::vector
            LIMIT $2
            """,
            str(embedding),
            top_k,
            RAG_SECTION_FILTER,
            RAG_SIMILARITY_THRESHOLD,
            diagnosis,
        )
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
