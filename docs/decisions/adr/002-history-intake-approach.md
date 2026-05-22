# ADR 002 — History Intake: Fixed vs LLM-Generated Questions

**Date:** 2026-04-16
**Status:** Decided
**Decider:** Priyank Jain

---

## Context

The History Stage generates a questionnaire for the nurse after the patient states
their chief complaint (~30 seconds). The questionnaire covers two jobs:

1. **Chief complaint characterisation** — SOCRATES or equivalent framework,
   dynamic per presentation
2. **Background history intake** — PMH, FHx, SHx, current medications, allergies

Job 2 is only needed when fields are missing from the patient record (i.e. first
visit or partial record). The question was: should these questions be LLM-generated
dynamically, or fixed and hardcoded?

The system is audio-first. The nurse reads questions from the screen and the
patient answers verbally. There is no structured form — all data is captured
through the spoken interview and extracted from the transcript by the Diagnosis Stage.

---

## Problem

The original design asked the LLM to generate background history questions based
on `field_labels` instructions injected into the Call 2 prompt. This introduced
two reliability problems:

1. **Variability** — LLM-generated questions differ between sessions. The same
   field (e.g. family history) may be asked with different phrasing, emphasis,
   or depth depending on the chief complaint context.

2. **Coverage gaps** — the LLM optimises for the presenting complaint. On a busy
   first visit it may compress or omit background history questions to keep the
   questionnaire within the 3-4 minute target. Fields marked as missing are not
   guaranteed to be asked.

For a permanent patient record seeded from this single encounter, missed fields
have lasting consequences — they appear as unknowns on every future visit.

---

## Options considered

### Option A — Fixed background history section (chosen)
Hardcode a standard set of PMH/FHx/SHx/medications/allergies questions.
Inject this section verbatim into the questionnaire output after the LLM
generates the chief complaint section. The nurse always sees the same
background history questions on a first visit, in the same order.

**Pros:**
- Guaranteed coverage of all background history fields on every first visit
- Consistent phrasing — extraction from transcript is more reliable when
  questions are predictable
- No prompt engineering required for this section
- Clinician-reviewable — questions are in code, not in a prompt

**Cons:**
- Fixed questions may not integrate smoothly with the preceding LLM-generated
  section (tonal shift, some repetition possible if LLM already asked a field)
- Does not adapt to what the patient may have already volunteered in phase 1

### Option B — More robust LLM extraction in Diagnosis Stage
Keep dynamic generation, but make the Diagnosis Stage extract history fields
more reliably (targeted per-field extraction rather than one broad parse).

**Pros:** Preserves natural interview flow, adapts to what was already said.

**Cons:** Fixes the downstream problem, not the upstream one. A field that was
never asked cannot be extracted. Root cause is not addressed.

### Option C — Both A and B
Belt and braces: fixed intake questions ensure the field is asked; targeted
extraction ensures the answer is captured.

**Cons:** More work. Option B requires changes to diagnosis_stage.py.

---

## Decision

**Option A now. Option C is the target.**

Option A is implemented in `history_stage.py`:
- `FIRST_VISIT_HISTORY_QUESTIONS` — module-level constant, 6 questions covering
  PMH (chronic conditions + hospitalisations), FHx, SHx (occupation/tobacco/alcohol),
  current medications (including OTC and traditional), and allergies.
- Injected into `generate_questionnaire()` output when `missing_fields` is non-empty.
- Appended as formatted plain text to `stream_questionnaire()` output so the
  nurse sees it on screen.

Option B (targeted extraction in Diagnosis Stage) is deferred. It should be
implemented before the system goes to field pilots — consistent intake questions
make this significantly easier because the extractor can look for answers to
known, predictable questions rather than parsing freeform narrative.

---

## Consequences

- Every new patient gets the same 6 background history questions, regardless of
  chief complaint. This adds ~60-90 seconds to the interview.
- The LLM-generated chief complaint section remains dynamic and framework-selected.
- If the patient already volunteered a history item in phase 1 (e.g. "I am
  diabetic"), the fixed question will still be asked. The nurse can skip it
  with a brief "already told us — noted." This is acceptable — double-checking
  is safe; missing it is not.
- The fixed question set should be reviewed by a clinician before field pilots
  and versioned as part of the codebase. Changes require code review, not just
  prompt editing — this is intentional.

---

## Review trigger

Revisit this decision if:
- Option B (targeted Diagnosis Stage extraction) is implemented — at that point
  consider whether fixed questions are still necessary or whether dynamic
  generation with reliable extraction is sufficient
- Field pilots reveal that the fixed section disrupts interview flow in
  specific presentation types
- The question set needs localisation (e.g. different occupation categories
  for urban vs rural settings)
