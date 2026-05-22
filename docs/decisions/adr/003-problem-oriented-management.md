# ADR 003 — Problem-Oriented Management Stage

**Date:** 2026-04-18
**Status:** Decided — implemented
**Raised by:** Priyank Jain

---

## Question

Should the Management Stage support one provisional diagnosis per encounter, or a
structured problem list covering all distinct clinical issues the patient presents with?

---

## Context

The original Management Stage assumed one chief complaint → one DDx → one provisional
diagnosis → one prescription. Clinical reality is that patients — especially in rural
primary care settings — present with multiple issues at different levels of certainty
and urgency simultaneously.

Example that motivated this change: a 52-year-old man presents with 5 days of productive
cough and fever. On examination the nurse also finds pallor, learns he stopped metformin
3 months ago for GI side effects (BGL today 11.2 mmol/L), and notes a family history of
colorectal cancer. Single-problem model produces a pneumonia prescription and ignores
the rest. A clinically complete encounter must address: (1) acute respiratory illness
needing antibiotics, (2) probable anaemia needing investigation, (3) poorly controlled
diabetes needing restart of metformin, (4) family history flagged for later follow-up.

"Usually 1, sometimes 2, occasionally more" — frequent enough that the architecture must
handle it, but rare enough that single-problem visits must degrade gracefully.

---

## Options evaluated

### Option A — Keep single-diagnosis model
Status: **Rejected**

Simple, low-latency. But structurally unable to represent the clinical reality of
multi-problem encounters. The nurse sees an incomplete plan; the doctor handoff omits
active conditions; the prescription record is fragmented.

### Option B — Split Call 2: parallel diagnosis call + prescription call
Status: **Rejected**

Proposed during design: generate provisional diagnosis first, then run prescription
generation and risk assessment in parallel. Rejected because the risk assessment
(Call 3) requires the complete prescription to evaluate iatrogenic risk, allergy
conflicts, and drug-drug interactions. Parallelising produces an incomplete safety
assessment.

### Option C — `problem_list` with type discriminator (chosen)
Status: **Implemented**

Replace the single-object `provisional_diagnosis` with a `problem_list` array.
Each problem has a `type` field that acts as a discriminator:

- `acute_new`: new acute presentation requiring diagnosis — draws from the DDx
- `established`: known condition from patient record or interview — draws from
  known_conditions + current_medications + past_medical_history
- `incidental`: finding discovered this visit (not previously known)
- `deferred`: family history or risk factor noted but not acted on today

Assessment shape varies by type. Every prescription item carries `for_problem`
(integer attribution). This allows downstream consumers (rule engine, Call 3, Call 4,
doctor UI) to aggregate all drugs across all problems for safety checks.

---

## Decision

Option C — `problem_list` schema, implemented in Management Stage Call 2 onwards.
Maximum 4 problems. Problem #1 is always the acute presenting complaint.
Single-problem visits produce a one-element list — behaviour is identical to the prior
single-diagnosis model for that case.

---

## Consequences

**Positive:**
- Clinically complete management plan covers all active issues
- Rule engine allergy/injectable checks fire against all prescribed drugs, not just
  acute problem drugs
- Doctor handoff `prescription_issued` contains the authoritative medication list
  across all problems — nothing omitted
- `acute_problem_confidence` field in Call 3 output lets the rule engine read confidence
  without parsing the full problem_list structure

**Negative / constraints:**
- Diagnosis Stage gap: Call 1 extracts a single `chief_complaint` string; Call 2 (DDx)
  and Call 3 (clarifying questions) are focused on the primary complaint. Secondary
  complaints are implicitly present in `extracted_concepts.symptoms` and
  `additional_complaints` from the History Stage but have no dedicated DDx. Management
  Stage Call 2 reasons over these without a structured differential for the secondary
  issues. This is acceptable for established and incidental problems; a full
  multi-complaint DDx requires a future Diagnosis Stage overhaul.
- `max_tokens` in Call 2 increased from 2000 to 3000 to accommodate the larger schema.

**Scope boundary:**
Diagnosis Stage Call 2 (DDx generation) and Call 3 (clarifying questions) unchanged.
They remain focused on the acute chief complaint. If a second acute complaint also
requires its own DDx (e.g. simultaneous fever and severe headache each needing their
own workup), a future ADR should address multi-complaint Diagnosis Stage design.
