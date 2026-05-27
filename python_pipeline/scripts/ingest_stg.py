"""
STG Embedding Pipeline
======================
Chunks Standard Treatment Guideline documents, embeds them with
sentence-transformers/all-MiniLM-L6-v2, and inserts into the
stg_chunks pgvector table. Run this once per new document set,
or re-run after adding new STGs.

Supported input formats:
  .txt   — plain text (one section per file recommended)
  .pdf   — extracted via pdfplumber page by page
  .docx  — extracted via python-docx paragraph by paragraph

Chunking strategy:
  Target: 300-400 tokens per chunk with 50-token overlap.
  Chunks respect section boundaries where possible.
  Each chunk tagged with: source, disease, section.

Usage:
  # Single file:
  python scripts/ingest_stg.py --file docs/nhm_stg_malaria.pdf --disease malaria

  # Directory of files (uses filename stem as source, disease from --disease-map):
  python scripts/ingest_stg.py --dir docs/stg/ --disease-map scripts/disease_map.json

  # Dry run (print chunks, no DB write):
  python scripts/ingest_stg.py --file docs/nhm_stg_malaria.pdf --disease malaria --dry-run

disease_map.json format:
  { "nhm_stg_malaria": "malaria", "nvbdcp_kala_azar": "kala-azar", ... }

Documents to ingest (see docs/rag_brief.docx for full guidance):
  - NHM Standard Treatment Guidelines — all volumes
  - NVBDCP malaria treatment protocol (ACT dosing by weight band)
  - NHM kala-azar operational guidelines
  - West Bengal state drug formulary [NOTE: formulary is NOT in the vector store —
    it is a small JSON file injected directly into prompts. Do not ingest it here.]
  - RNTCP/NTP TB treatment guidelines
  - Any state-specific protocol addenda

Dependencies:
    pip install asyncpg pgvector sentence-transformers pdfplumber python-docx tqdm
"""

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import asyncpg
from sentence_transformers import SentenceTransformer
from tqdm import tqdm

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DATABASE_URL  = os.environ.get("DATABASE_URL", "postgresql://localhost/cdst")
EMBED_MODEL   = "sentence-transformers/all-MiniLM-L6-v2"
CHUNK_TOKENS  = 350     # target chunk size in approximate tokens
OVERLAP_TOKENS = 50     # overlap between consecutive chunks
WORDS_PER_TOKEN = 0.75  # rough conversion: 1 token ≈ 0.75 words
SIMILARITY_THRESHOLD = 0.55   # must match management_agent.py RAG config
BATCH_SIZE    = 32      # embedding batch size

# Approximate word counts derived from token targets
CHUNK_WORDS   = int(CHUNK_TOKENS  / WORDS_PER_TOKEN)   # ~467 words
OVERLAP_WORDS = int(OVERLAP_TOKENS / WORDS_PER_TOKEN)  # ~67 words

embedder = SentenceTransformer(EMBED_MODEL)


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class Chunk:
    source:   str           # e.g. "NHM_STG_2023_malaria"
    disease:  Optional[str] # primary disease tag for filtered retrieval
    section:  str           # section heading if detected, else "body"
    content:  str           # chunk text
    embedding: list[float] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Text extraction
# ---------------------------------------------------------------------------

def extract_text_txt(path: Path) -> list[tuple[str, str]]:
    """Returns list of (section_heading, text) from a plain text file."""
    text = path.read_text(encoding="utf-8", errors="replace")
    return _split_by_headings(text)


def extract_text_pdf(path: Path) -> list[tuple[str, str]]:
    """Extract text from PDF page by page, preserving section structure."""
    try:
        import pdfplumber
    except ImportError:
        print("pdfplumber not installed. Run: pip install pdfplumber", file=sys.stderr)
        sys.exit(1)

    pages = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            text = page.extract_text()
            if text:
                pages.append(text)

    full_text = "\n".join(pages)
    return _split_by_headings(full_text)


def extract_text_docx(path: Path) -> list[tuple[str, str]]:
    """Extract text from DOCX, grouping by heading paragraphs."""
    try:
        from docx import Document
    except ImportError:
        print("python-docx not installed. Run: pip install python-docx", file=sys.stderr)
        sys.exit(1)

    doc = Document(path)
    sections: list[tuple[str, str]] = []
    current_heading = "Introduction"
    current_paras: list[str] = []

    heading_styles = {
        "Heading 1", "Heading 2", "Heading 3",
        "Heading1", "Heading2", "Heading3",
    }

    for para in doc.paragraphs:
        if para.style.name in heading_styles and para.text.strip():
            if current_paras:
                sections.append((current_heading, " ".join(current_paras)))
            current_heading = para.text.strip()
            current_paras = []
        elif para.text.strip():
            current_paras.append(para.text.strip())

    if current_paras:
        sections.append((current_heading, " ".join(current_paras)))

    return sections


def _split_by_headings(text: str) -> list[tuple[str, str]]:
    """
    Detect section headings (ALL CAPS lines or lines ending in ':' that are
    short) and split text into (heading, body) pairs.
    Falls back to treating the whole text as a single section.
    """
    heading_pattern = re.compile(
        r"^(?:"
        r"[A-Z][A-Z\s\-\/]{4,}|"          # ALL CAPS heading
        r"\d+[\.\d]*\s+[A-Z][^\n]{0,80}|" # Numbered heading: 1.2 Treatment of...
        r"[A-Z][^\n]{0,60}:[ \t]*$"        # Short line ending with colon
        r")$",
        re.MULTILINE,
    )

    lines    = text.splitlines()
    sections: list[tuple[str, str]] = []
    heading  = "Introduction"
    body: list[str] = []

    for line in lines:
        if heading_pattern.match(line.strip()) and len(line.strip()) > 5:
            if body:
                sections.append((heading, " ".join(body)))
            heading = line.strip().rstrip(":")
            body    = []
        else:
            stripped = line.strip()
            if stripped:
                body.append(stripped)

    if body:
        sections.append((heading, " ".join(body)))

    return sections if sections else [("body", text)]


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------

def chunk_section(heading: str, text: str) -> list[tuple[str, str]]:
    """
    Split a section into overlapping chunks of ~CHUNK_WORDS words.
    Returns list of (section_label, chunk_text).
    Short sections that fit in one chunk are returned as-is.
    """
    words = text.split()
    if len(words) <= CHUNK_WORDS:
        return [(heading, text)]

    chunks: list[tuple[str, str]] = []
    start  = 0
    part   = 1

    while start < len(words):
        end        = min(start + CHUNK_WORDS, len(words))
        chunk_text = " ".join(words[start:end])
        label      = f"{heading} (part {part})" if start > 0 else heading
        chunks.append((label, chunk_text))
        start += CHUNK_WORDS - OVERLAP_WORDS
        part  += 1

    return chunks


def extract_chunks(path: Path, source: str, disease: Optional[str]) -> list[Chunk]:
    """
    Full extraction + chunking pipeline for one document.
    Returns a flat list of Chunk objects ready for embedding.
    """
    suffix = path.suffix.lower()

    if suffix == ".txt":
        sections = extract_text_txt(path)
    elif suffix == ".pdf":
        sections = extract_text_pdf(path)
    elif suffix in (".docx", ".doc"):
        sections = extract_text_docx(path)
    else:
        print(f"Unsupported format: {suffix} — skipping {path.name}", file=sys.stderr)
        return []

    chunks: list[Chunk] = []
    for heading, body in sections:
        if not body.strip():
            continue
        for section_label, chunk_text in chunk_section(heading, body):
            if len(chunk_text.split()) < 10:   # skip trivially short chunks
                continue
            chunks.append(Chunk(
                source  = source,
                disease = disease,
                section = section_label,
                content = chunk_text,
            ))

    return chunks


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------

def embed_chunks(chunks: list[Chunk]) -> None:
    """Embed all chunks in-place using batched inference."""
    texts = [c.content for c in chunks]
    print(f"Embedding {len(texts)} chunks in batches of {BATCH_SIZE}…")
    embeddings = embedder.encode(
        texts,
        batch_size   = BATCH_SIZE,
        show_progress_bar = True,
        normalize_embeddings = True,   # cosine similarity via dot product
    )
    for chunk, emb in zip(chunks, embeddings):
        chunk.embedding = emb.tolist()


# ---------------------------------------------------------------------------
# Database insertion
# ---------------------------------------------------------------------------

async def insert_chunks(chunks: list[Chunk], conn: asyncpg.Connection) -> int:
    """
    Bulk-insert chunks into stg_chunks.
    Skips exact duplicates (same source + content hash).
    Returns count of rows inserted.
    """
    inserted = 0
    for chunk in tqdm(chunks, desc="Inserting into stg_chunks"):
        # Check for exact duplicate by source + first 200 chars of content
        existing = await conn.fetchval(
            """
            SELECT chunk_id FROM stg_chunks
            WHERE source = $1 AND left(content, 200) = $2
            LIMIT 1
            """,
            chunk.source,
            chunk.content[:200],
        )
        if existing:
            continue

        await conn.execute(
            """
            INSERT INTO stg_chunks (source, disease, section, content, embedding)
            VALUES ($1, $2, $3, $4, $5)
            """,
            chunk.source,
            chunk.disease,
            chunk.section,
            chunk.content,
            str(chunk.embedding),   # pgvector accepts '[0.1, 0.2, ...]' string format
        )
        inserted += 1

    return inserted


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def resolve_disease_map(path: Optional[str]) -> dict[str, str]:
    if not path:
        return {}
    with open(path) as f:
        return json.load(f)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Chunk, embed, and ingest STG documents into pgvector."
    )
    source_group = parser.add_mutually_exclusive_group(required=True)
    source_group.add_argument("--file", help="Single document to ingest")
    source_group.add_argument("--dir",  help="Directory of documents to ingest")

    parser.add_argument(
        "--disease",
        help="Disease tag for this document (e.g. 'malaria'). Used with --file.",
    )
    parser.add_argument(
        "--disease-map",
        help="JSON file mapping filename stem → disease tag. Used with --dir.",
    )
    parser.add_argument(
        "--source",
        help="Source label override (default: filename stem in UPPER_SNAKE_CASE).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print chunks without writing to the database.",
    )
    parser.add_argument(
        "--db",
        default=DATABASE_URL,
        help="Postgres DSN (default: DATABASE_URL env var or postgresql://localhost/cdst).",
    )

    args = parser.parse_args()

    # Gather files to process
    if args.file:
        files = [Path(args.file)]
    else:
        dir_path = Path(args.dir)
        if not dir_path.is_dir():
            print(f"Directory not found: {args.dir}", file=sys.stderr)
            sys.exit(1)
        files = [
            p for p in dir_path.iterdir()
            if p.suffix.lower() in (".txt", ".pdf", ".docx", ".doc")
        ]
        if not files:
            print(f"No supported documents found in {args.dir}", file=sys.stderr)
            sys.exit(1)

    disease_map = resolve_disease_map(args.disease_map)

    all_chunks: list[Chunk] = []
    for file_path in files:
        stem    = file_path.stem
        source  = args.source or stem.upper().replace(" ", "_").replace("-", "_")
        disease = args.disease or disease_map.get(stem)

        print(f"\nProcessing: {file_path.name} — source={source} disease={disease}")
        chunks = extract_chunks(file_path, source, disease)
        print(f"  → {len(chunks)} chunks extracted")
        all_chunks.extend(chunks)

    if not all_chunks:
        print("No chunks extracted. Nothing to do.")
        return

    if args.dry_run:
        print(f"\n{'─' * 60}")
        print(f"DRY RUN — {len(all_chunks)} chunks (not written to DB)\n")
        for i, c in enumerate(all_chunks[:5]):
            print(f"[{i+1}] source={c.source} disease={c.disease} section={c.section!r}")
            print(f"     {c.content[:120]}…\n")
        if len(all_chunks) > 5:
            print(f"  … and {len(all_chunks) - 5} more chunks")
        return

    # Embed
    embed_chunks(all_chunks)

    # Insert
    import asyncio

    async def run():
        conn     = await asyncpg.connect(dsn=args.db)
        inserted = await insert_chunks(all_chunks, conn)
        await conn.close()
        print(f"\nDone — {inserted} new rows inserted ({len(all_chunks) - inserted} duplicates skipped)")

        # Print stats
        conn2 = await asyncpg.connect(dsn=args.db)
        total = await conn2.fetchval("SELECT count(*) FROM stg_chunks")
        by_disease = await conn2.fetch(
            "SELECT disease, count(*) AS n FROM stg_chunks GROUP BY disease ORDER BY n DESC"
        )
        await conn2.close()

        print(f"\nstg_chunks table: {total} total rows")
        for row in by_disease:
            print(f"  {row['disease'] or '(untagged)':30s}  {row['n']:5d} chunks")

    asyncio.run(run())


if __name__ == "__main__":
    main()
