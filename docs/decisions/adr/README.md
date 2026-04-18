# Architecture Decision Records

Decisions that were considered, alternatives that were rejected, and the
reasoning behind each choice. These records are immutable once written.

**Read the relevant ADR before proposing changes to any component it covers.**
This prevents re-litigating decisions that have already been worked through.

---

| ADR | Status | Question decided |
|---|---|---|
| [001 — Agentic Patterns](001-agentic-patterns.md) | Recorded, no immediate implementation | Which pipeline components should be agentic vs fixed; Management Stage RAG and confirmation pipeline are the best candidates |
| [002 — History Intake Approach](002-history-intake-approach.md) | Decided — Option A implemented, Option C deferred | Fixed vs LLM-generated background history questions; fixed questions (Option A) chosen now, targeted extraction (Option B) required before field pilots |

---

## How to write a new ADR

1. Copy the structure of an existing ADR: date, status, question, context,
   options evaluated (with verdicts), decision, consequences.
2. Number sequentially: `003-short-topic-name.md`.
3. Add a row to the table above.
4. ADRs are immutable once written — if a decision is later reversed, write
   a new ADR that supersedes the old one; do not edit the original.
