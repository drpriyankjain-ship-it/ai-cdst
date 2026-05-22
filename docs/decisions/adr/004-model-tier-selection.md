# ADR 004 — LLM Model Tier Selection for Pipeline Calls

**Date:** 2026-04-20
**Status:** Decided — implemented
**Raised by:** Priyank Jain

---

## Question

Which Gemini model should be used for each of the 9 pipeline calls, and how
should models be selected as the Gemini family evolves?

---

## Context

The pipeline makes 9 LLM calls across three stages. Each call has different
reasoning demands and latency constraints:

- History Stage fires at Marker A — first token must reach the nurse within ~1.5s.
- Diagnosis Stage fires at Marker B — streaming differential starts within 1.5s;
  structured JSON (needed for D3) must complete within ~8s.
- Management Stage fires at Marker C — full pipeline target is ~15s end-to-end.

The first complete validation run (run_001, 2026-04-20) used `gemini-2.5-pro`
for D2 (differential) and M2 (problem list + prescription). Observed latencies:

| Call | Model | Elapsed |
|---|---|---|
| D2 | gemini-2.5-pro | **35.0 s** |
| M2 | gemini-2.5-pro | **29.9 s** |

These were judged unacceptably high for the nurse-facing workflow.

---

## Model landscape as of 2026-04-20

| Model | API version | response_schema | Status |
|---|---|---|---|
| gemini-2.5-flash-lite | v1beta | Yes | Available, fast |
| gemini-2.5-flash | v1beta | Yes | Available, tested |
| gemini-2.5-pro | v1beta | Yes | Available, slow |
| gemini-3.0-flash | v1beta | — | 404 — not on v1beta |
| gemini-3.1-flash | v1beta | — | 404 — not on v1beta |
| gemini-3.1-pro | v1beta | — | 404 — not on v1beta |

The `response_schema` parameter (structured JSON output) is required by all 9
pipeline calls. The Gemini 3.x series is only available on API v1, which does
not support `response_schema`. Tested directly — all return 404 on v1beta.
They are therefore unusable in the current pipeline without a structural change.

---

## Options evaluated

### Option A — All calls on gemini-2.5-pro
**Rejected.** D2 and M2 run at 30–35s. This makes the Management Stage wall
clock ~70s, far exceeding the target. The nurse and doctor wait unacceptably
long for a triage decision.

### Option B — D2 and M2 on gemini-2.5-pro, remainder on flash-lite
**Rejected** (was run_001 config). D2 35s and M2 30s are the dominant latency
contributors. Pro adds reasoning depth but not enough to justify the wall clock
cost, especially since M2 is formulary-constrained (drug selection is bounded by
a JSON file, not open-ended LLM recall) and D2's structured output is validated
and schema-enforced downstream.

### Option C — gemini-3.1-flash as primary with 2.5-flash fallback
**Rejected — not yet viable.** 3.1-flash returns 404 on v1beta. It could become
the primary tier once Google makes it available on v1beta with `response_schema`
support. The cascade infrastructure is already in place to support this without
a code change — only a model_config.py update would be needed. See "Future" below.

### Option D — Three-tier model config with flash as TIER_STANDARD (chosen)
**Accepted.**

```
TIER_FAST     = ["gemini-2.5-flash-lite"]          # extraction, low reasoning
TIER_STANDARD = ["gemini-2.5-flash",               # complex reasoning, latency-sensitive
                  "gemini-2.5-flash-lite"]
TIER_BEST     = ["gemini-2.5-pro",                 # reserved for latency-tolerant tasks
                  "gemini-2.5-flash"]               # where maximum quality is required
```

D2 and M2 assigned to TIER_STANDARD (flash). All other calls on TIER_FAST (flash-lite).
TIER_BEST remains defined but no calls use it currently.

---

## Why flash is sufficient for D2 and M2

**D2 (differential generation):** The differential schema is 11 fields, always
validated by `validate_differential()` which fills safe defaults for any missing
fields. The epidemiological prior and must_not_miss list constrain the space. The
output is structured, not free-form prose. Flash models perform well on structured
clinical reasoning tasks of this type.

**M2 (problem list + prescription):** This is the most safety-critical call, but it
is also the most constrained. Drug selection is bounded by `formulary_wb.json`
injected directly into the prompt. Once STG RAG is ingested, treatment protocols
will further constrain choices. The LLM's primary job is to correctly identify
which formulary drug applies — not to reason from first principles about pharmacology.
The rule engine provides a deterministic safety backstop regardless of model quality.

The residual quality risk is real and will be assessed via systematic validation
runs (multiple patients, varied presentations, seasonal variation). If quality
regressions are observed on flash vs pro, specific calls can be promoted back to
TIER_BEST selectively.

---

## Decision

All 9 calls use `gemini-2.5-flash` or `gemini-2.5-flash-lite`. No calls on pro.

| Call | Tier | Model | Rationale |
|---|---|---|---|
| H1 | TIER_FAST | gemini-2.5-flash-lite | Extraction only — fixed schema fields |
| H2 | TIER_STANDARD | gemini-2.5-flash → flash-lite | Visit-type inference, SOCRATES, tailored multi-section intake |
| D1 | TIER_FAST | gemini-2.5-flash-lite | Extraction; uncertain_findings nuanced but schema-bounded |
| D2 | TIER_STANDARD | gemini-2.5-flash → flash-lite | Ranked clinical reasoning across 11 fields, epi priors |
| D3 | TIER_STANDARD | gemini-2.5-flash → flash-lite | DDx discrimination reasoning to select bedside-feasible questions |
| M1 | TIER_FAST | gemini-2.5-flash-lite | Extraction only |
| M2 | TIER_STANDARD | gemini-2.5-flash → flash-lite | Multi-problem reasoning, formulary-constrained prescription |
| M3 | TIER_STANDARD | gemini-2.5-flash → flash-lite | Five independent reasoning chains; drives triage tier |
| M4 | TIER_FAST | gemini-2.5-flash-lite | Synthesis/formatting of upstream outputs; triage tier passed in |

---

## Consequences

- D2 and M2 latency expected to drop from ~30–35s to ~5–8s (to be confirmed in run_002).
- Quality of D2 differential and M2 problem list must be re-validated against run_001
  baseline. Run_002 will provide the first flash quality comparison.
- TIER_BEST remains in model_config.py and can be assigned to specific calls if flash
  quality proves insufficient for any particular stage.

---

## Future — when to revisit

**Promote D2 or M2 to TIER_BEST (pro):** If systematic validation shows flash
producing clinically significant errors in differential ranking or prescribing that
pro avoids, promote the specific call. Do not promote both without evidence — latency
cost is real.

**Add gemini-3.x models as primaries:** Once Google makes 3.x models available on
v1beta with `response_schema` support, update `model_config.py` only:
```python
TIER_FAST     = ["gemini-3.1-flash", "gemini-2.5-flash-lite"]
TIER_STANDARD = ["gemini-3.1-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"]
TIER_BEST     = ["gemini-3.1-pro",   "gemini-2.5-pro",   "gemini-2.5-flash"]
```
No other code changes required — the cascade infrastructure handles fallback.
The test to run before promoting: the same `response_schema` smoke test in
`test_model_schema.py` (to be created) that was used to confirm 2.5-flash.
