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

  # Directory with explicit source labels and fallback disease tags:
  python scripts/ingest_stg.py --dir "docs/clinical/RAG source" --manifest scripts/rag_source_manifest.json

  # Dry run (print chunks, no DB write):
  python scripts/ingest_stg.py --file docs/nhm_stg_malaria.pdf --disease malaria --dry-run

  # Export extracted chunks for inspection, no DB write:
  python scripts/ingest_stg.py --dir "docs/clinical/RAG source" --manifest scripts/rag_source_manifest.json --dry-run --out tmp/stg_chunks_preview.jsonl

disease_map.json format:
  { "nhm_stg_malaria": "malaria", "nvbdcp_kala_azar": "kala-azar", ... }

rag_source_manifest.json format:
  {
    "filename_stem": {
      "source": "ICMR_STW_TB_2024_PTB_EPTB",
      "disease": "tuberculosis"
    }
  }

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
from collections import Counter
import hashlib
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
DISEASE_ALIASES_PATH = Path("data/rag_disease_aliases.json")
CHUNK_TOKENS  = 350     # target chunk size in approximate tokens
OVERLAP_TOKENS = 50     # overlap between consecutive chunks
WORDS_PER_TOKEN = 0.75  # rough conversion: 1 token ≈ 0.75 words
BATCH_SIZE    = 32      # embedding batch size

# Approximate word counts derived from token targets
CHUNK_WORDS   = int(CHUNK_TOKENS  / WORDS_PER_TOKEN)   # ~467 words
OVERLAP_WORDS = int(OVERLAP_TOKENS / WORDS_PER_TOKEN)  # ~67 words

_embedder: SentenceTransformer | None = None
_disease_aliases: dict[str, list[str]] | None = None


def get_embedder() -> SentenceTransformer:
    global _embedder
    if _embedder is None:
        _embedder = SentenceTransformer(EMBED_MODEL)
    return _embedder


def load_disease_aliases(path: Path = DISEASE_ALIASES_PATH) -> dict[str, list[str]]:
    global _disease_aliases
    if _disease_aliases is None:
        if path.exists():
            with path.open(encoding="utf-8") as f:
                _disease_aliases = json.load(f)
        else:
            _disease_aliases = {}
    return _disease_aliases


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class Chunk:
    source:   str           # e.g. "NHM_STG_2023_malaria"
    disease:  Optional[str] # primary disease tag for filtered retrieval
    section:  str           # treatment | dosing | contraindications | referral | diagnosis | complications | general
    content:  str           # chunk text
    embedding: list[float] = field(default_factory=list)

    @property
    def content_hash(self) -> str:
        return hashlib.md5(f"{self.source}\n{self.content}".encode("utf-8")).hexdigest()


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


def infer_section_type(heading: str, text: str) -> str:
    """
    Map free-form STG headings to the small section taxonomy used at retrieval time.
    The original heading remains in the chunk content; this field is for filtering.
    """
    haystack = f"{heading}\n{text[:600]}".lower()
    if any(k in haystack for k in ("dose", "dosage", "weight band", "mg/kg", "schedule")):
        return "dosing"
    if any(k in haystack for k in ("contraindication", "do not use", "avoid", "caution", "pregnancy", "g6pd")):
        return "contraindications"
    if any(k in haystack for k in ("refer", "referral", "hospital", "emergency", "admit")):
        return "referral"
    if any(k in haystack for k in ("treatment", "management", "therapy", "drug of choice", "first line", "second line")):
        return "treatment"
    if any(k in haystack for k in ("diagnosis", "investigation", "test", "clinical features")):
        return "diagnosis"
    if any(k in haystack for k in ("complication", "severe", "danger sign", "warning sign")):
        return "complications"
    return "general"


def infer_disease_tag(
    heading: str,
    text: str,
    fallback_disease: Optional[str] = None,
) -> Optional[str]:
    """
    Infer the disease tag from the chunk itself, not from the source document.

    Broad STW volumes cover many diseases, so a source-level disease tag would be
    misleading. Disease-specific documents can still provide a fallback in the
    manifest for chunks whose text only says "treatment" or "follow-up".
    """
    aliases = load_disease_aliases()
    if not aliases:
        return fallback_disease

    haystack = f"{heading}\n{text}".lower()
    best_disease = fallback_disease
    best_score = 0

    for disease, terms in aliases.items():
        score = 0
        for term in terms:
            term_l = term.lower()
            pattern = r"(?<![a-z0-9])" + re.escape(term_l) + r"(?![a-z0-9])"
            matches = len(re.findall(pattern, haystack))
            if not matches:
                continue
            # Heading mentions are more likely to be the chunk topic.
            heading_boost = 3 if re.search(pattern, heading.lower()) else 1
            score += matches * heading_boost

        if score > best_score:
            best_disease = disease
            best_score = score

    return best_disease if best_score > 0 else fallback_disease


def extract_chunks(path: Path, source: str, fallback_disease: Optional[str]) -> list[Chunk]:
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
            section_type = infer_section_type(section_label, chunk_text)
            disease = infer_disease_tag(section_label, chunk_text, fallback_disease)
            if len(chunk_text.split()) < 10:   # skip trivially short chunks
                continue
            chunks.append(Chunk(
                source  = source,
                disease = disease,
                section = section_type,
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
    embeddings = get_embedder().encode(
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

async def ensure_stg_schema(conn: asyncpg.Connection) -> None:
    """Keep older local databases compatible with the current RAG schema."""
    await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS stg_chunks (
            chunk_id SERIAL PRIMARY KEY,
            source TEXT NOT NULL,
            disease TEXT,
            section TEXT,
            content TEXT NOT NULL,
            content_hash TEXT,
            embedding vector(384),
            created_at TIMESTAMPTZ DEFAULT now()
        )
        """
    )
    await conn.execute("ALTER TABLE stg_chunks ADD COLUMN IF NOT EXISTS section TEXT DEFAULT 'general'")
    await conn.execute("ALTER TABLE stg_chunks ADD COLUMN IF NOT EXISTS content_hash TEXT")
    await conn.execute("UPDATE stg_chunks SET content_hash = md5(source || E'\\n' || content) WHERE content_hash IS NULL")
    await conn.execute("ALTER TABLE stg_chunks ALTER COLUMN content_hash SET NOT NULL")
    await conn.execute("CREATE INDEX IF NOT EXISTS stg_chunks_disease_idx ON stg_chunks (disease)")
    await conn.execute("CREATE INDEX IF NOT EXISTS stg_chunks_section_idx ON stg_chunks (section)")
    await conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS stg_chunks_source_content_hash_idx ON stg_chunks (source, content_hash)")
    await conn.execute(
        """
        CREATE INDEX IF NOT EXISTS stg_chunks_embedding_idx
        ON stg_chunks USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
        """
    )


async def insert_chunks(chunks: list[Chunk], conn: asyncpg.Connection) -> int:
    """
    Bulk-insert chunks into stg_chunks.
    Skips exact duplicates (same source + content hash).
    Returns count of rows inserted.
    """
    inserted = 0
    await ensure_stg_schema(conn)
    for chunk in tqdm(chunks, desc="Inserting into stg_chunks"):
        row = await conn.fetchrow(
            """
            INSERT INTO stg_chunks (source, disease, section, content, content_hash, embedding)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (source, content_hash) DO NOTHING
            RETURNING chunk_id
            """,
            chunk.source,
            chunk.disease,
            chunk.section,
            chunk.content,
            chunk.content_hash,
            str(chunk.embedding),   # pgvector accepts '[0.1, 0.2, ...]' string format
        )
        if row:
            inserted += 1

    return inserted


async def delete_sources(sources: set[str], conn: asyncpg.Connection) -> int:
    """Delete all chunks for the given source labels before re-ingesting an update."""
    if not sources:
        return 0
    status = await conn.execute(
        "DELETE FROM stg_chunks WHERE source = ANY($1::text[])",
        list(sources),
    )
    return int(status.split()[-1])


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def resolve_disease_map(path: Optional[str]) -> dict[str, str]:
    if not path:
        return {}
    with open(path) as f:
        return json.load(f)


def resolve_manifest(path: Optional[str]) -> dict[str, dict]:
    if not path:
        return {}
    with open(path) as f:
        return json.load(f)


def print_chunk_summary(chunks: list[Chunk]) -> None:
    by_source = Counter(c.source for c in chunks)
    by_disease = Counter(c.disease or "(untagged)" for c in chunks)
    by_section = Counter(c.section for c in chunks)

    print("\nChunk summary by source:")
    for source, count in by_source.most_common():
        print(f"  {source:32s} {count:5d}")

    print("\nChunk summary by disease:")
    for disease, count in by_disease.most_common():
        print(f"  {disease:32s} {count:5d}")

    print("\nChunk summary by section:")
    for section, count in by_section.most_common():
        print(f"  {section:32s} {count:5d}")


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
        "--manifest",
        help="JSON file mapping filename stem → {source, disease}. disease is only a fallback tag.",
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
        "--out",
        help="Write extracted chunk metadata/content to a JSONL file for inspection.",
    )
    parser.add_argument(
        "--replace-source",
        action="store_true",
        help="Delete existing chunks for the source label(s) before inserting.",
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
    manifest = resolve_manifest(args.manifest)

    all_chunks: list[Chunk] = []
    for file_path in files:
        stem    = file_path.stem
        manifest_entry = manifest.get(stem, {})
        source  = (
            args.source
            or manifest_entry.get("source")
            or stem.upper().replace(" ", "_").replace("-", "_")
        )
        fallback_disease = args.disease if args.disease is not None else manifest_entry.get("disease", disease_map.get(stem))

        print(f"\nProcessing: {file_path.name} — source={source} fallback_disease={fallback_disease}")
        chunks = extract_chunks(file_path, source, fallback_disease)
        print(f"  → {len(chunks)} chunks extracted")
        all_chunks.extend(chunks)

    if not all_chunks:
        print("No chunks extracted. Nothing to do.")
        return

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with out_path.open("w", encoding="utf-8") as f:
            for i, c in enumerate(all_chunks, start=1):
                f.write(json.dumps({
                    "n": i,
                    "source": c.source,
                    "disease": c.disease,
                    "section": c.section,
                    "content_hash": c.content_hash,
                    "word_count": len(c.content.split()),
                    "content": c.content,
                }, ensure_ascii=False) + "\n")
        print(f"\nWrote {len(all_chunks)} chunks to {out_path}")

    if args.dry_run:
        print(f"\n{'─' * 60}")
        print(f"DRY RUN — {len(all_chunks)} chunks (not written to DB)\n")
        print_chunk_summary(all_chunks)
        print("")
        for i, c in enumerate(all_chunks[:5]):
            print(f"[{i+1}] source={c.source} disease={c.disease} section={c.section!r}")
            print(f"     {c.content[:120]}…\n")
        if len(all_chunks) > 5:
            print(f"  … and {len(all_chunks) - 5} more chunks")
        return

    import asyncio

    async def run():
        conn     = await asyncpg.connect(dsn=args.db)
        try:
            await ensure_stg_schema(conn)
            if args.replace_source:
                sources = {chunk.source for chunk in all_chunks}
                deleted = await delete_sources(sources, conn)
                print(f"Deleted {deleted} existing rows for source(s): {', '.join(sorted(sources))}")

            # Embed only after the DB/schema check succeeds, so setup failures are cheap.
            embed_chunks(all_chunks)
            inserted = await insert_chunks(all_chunks, conn)
        finally:
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
