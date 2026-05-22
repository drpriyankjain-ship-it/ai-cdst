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
| [003 — Problem-Oriented Management Stage](003-problem-oriented-management.md) | Decided — implemented | Single-diagnosis model vs problem_list with type discriminator; problem_list chosen; Diagnosis Stage multi-complaint DDx is known gap for future work |
| [004 — Model Tier Selection](004-model-tier-selection.md) | Decided — implemented | Which Gemini model per call; flash chosen for D2/M2 over pro; 3.x models deferred until v1beta supports response_schema |
| [005 — Diagnosis Stage Time-to-First-Token](005-diagnosis-stage-ttft.md) | Deferred — options recorded | D stage 1.5s TTFT target never met; speculative D2 streaming is the main candidate; revisit after field pilots |

---

## How to write a new ADR

1. Copy the structure of an existing ADR: date, status, question, context,
   options evaluated (with verdicts), decision, consequences.
2. Number sequentially: `003-short-topic-name.md`.
3. Add a row to the table above.
4. ADRs are immutable once written — if a decision is later reversed, write
   a new ADR that supersedes the old one; do not edit the original.
