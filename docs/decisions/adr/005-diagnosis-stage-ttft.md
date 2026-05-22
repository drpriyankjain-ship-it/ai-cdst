# ADR 005 — Diagnosis Stage Time-to-First-Token

**Date:** 2026-04-23  
**Status:** Decision deferred — options recorded for future discussion  
**Raised by:** Priyank Jain

---

## Question

The Diagnosis Stage has a 1.5s time-to-first-token target (differential starts streaming within 1.5s of Marker B). This has never been met across any validation run. The structural reason is that D1 (concept extraction, ~4–5s) must complete before D2 (differential generation) can start. What architectural changes could close this gap, and what are the tradeoffs?

---

## Context

Measured TTFT per stage at current performance (run_005, 2.5-flash, thinking suppressed):

| Stage | Blocking call | Wall time | Streaming starts | Actual TTFT |
|-------|--------------|-----------|-----------------|-------------|
| History    | H1 extraction  | 0.9s  | H2 streaming  | ~1.2s ✓  |
| Diagnosis  | D1 extraction  | 4.9s  | D2 streaming  | ~5.2s ✗  |
| Management | M1 + RAG       | 2.1s  | M2 streaming  | ~2.4s     |

The History Stage meets its 1.5s target because H1 (chief complaint extraction from a 30-second transcript) is a lightweight call. The Diagnosis Stage misses by 3.5× because D1 must process a 3–4 minute phase 2 transcript and produce 13 structured fields before D2 can begin.

The 1.5s target for Diagnosis was set before per-call timings were measured and may need to be revised as a product decision independent of architecture.

---

## Options evaluated

### Option A — Speculative streaming (deferred)

Start a streaming D2 call directly from the raw phase 2 transcript immediately on Marker B, while D1 runs in parallel in the background:

```
Marker B press:
  ↳ stream_differential_speculative(raw_transcript)  ← no D1 dependency; ~0.3s TTFT
  ↳ extract_medical_concepts(transcript)              ← runs in parallel; feeds D3 and vault

After D1 completes:
  ↳ generate_differential(d1_concepts)  ← structured JSON; feeds D3 and vault
  ↳ D1 output written to vault
  ↳ speculative stream discarded or replaced on screen
```

The nurse sees a provisional differential within ~0.3s of Marker B. When the structured D2 completes (~5–7s later), the display is updated.

**Pros:**
- Meets the 1.5s UX target without shortening D1
- D1 quality is preserved; D3 and vault still receive the structured concepts

**Cons:**
- Provisional differential is LLM-generated from raw transcript without structured concept extraction — it may be less precise than the final D2 (e.g. lower quality `against` fields, less precise `supporting_features`)
- The nurse may see a different ranking in the provisional vs. final differential, which could be confusing if the display replacement is jarring
- Adds a third LLM call to the Diagnosis Stage (D2-speculative, D1, D2-final). The speculative call is display-only and costs tokens even when D2-final quickly replaces it
- D3 (clarifying questions) still can't start until D2-final completes — the structural benefit is purely UX latency, not pipeline throughput
- Implementation complexity: need to manage two concurrent D2 calls, a "replace" event over the WebSocket, and handle the case where D1 changes the differential materially

**Verdict:** Not implemented. Revisit before field pilots when nurse UX feedback is available.

### Option B — Revise the TTFT target

The 1.5s target for Diagnosis Stage was aspirational and set without empirical timing data. A revised target of 4–6s may be more realistic given the phase 2 transcript length (273 lines / ~3 minutes of audio) and the structured extraction required.

In clinical terms: the nurse presses Marker B after completing a 3–4 minute interview. A 5s wait to see the differential is likely acceptable in practice. The more important latency constraint is whether the clarifying questions (D3) are ready before the nurse needs them — D3 completes ~5.5s after D2, so total D stage completion (~17s from Marker B) is the operative metric for the nurse's workflow.

**Verdict:** No decision taken. Requires field observation of nurse workflow to determine whether a 5s TTFT causes observable workflow friction.

### Option C — Lightweight D1 pre-extraction

Replace D1 with a two-pass approach:
1. Fast pre-pass: extract only the chief complaint(s) and vital signs (~1s, TIER_FAST)
2. Full D1: extract all 13 structured fields (~4s, TIER_FAST) — runs in parallel with D2-fast

D2 uses the pre-pass output for a lightweight streaming differential within ~1.5s, then updates with the full D1 output.

**Verdict:** Similar complexity to Option A with no clear advantage. Effectively the same speculative execution pattern, packaged differently.

---

## Decision

No structural change at this time. The 1.5s target for Diagnosis Stage is noted as aspirational rather than hard. Option A (speculative streaming) is the most promising path if UX research confirms the 5s wait is a meaningful friction point for nurses.

Before implementing Option A, the following should be answered:
1. Field observation: does a 5s pause at Marker B cause nurses to wait idly, or do they naturally use that time for documentation / patient interaction?
2. Display design: how would the app signal to the nurse that a provisional result is being replaced? A jarring differential swap mid-read could erode trust.
3. Token cost: the speculative streaming call adds ~$0.001 per consultation — acceptable at scale?

---

## Consequences

- D stage TTFT (~5.2s) is accepted as current baseline
- The 1.5s target in CLAUDE.md and the orchestrator comments should be annotated as aspirational pending field data
- This ADR should be revisited once field pilots begin and nurse workflow timing is observed directly
