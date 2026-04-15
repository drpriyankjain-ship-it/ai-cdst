# ADR 001 — Agentic Patterns Analysis

**Date:** 2026-04-15
**Status:** Decision recorded — no immediate implementation
**Raised by:** Priyank Jain

---

## Question

Which parts of the CDST workflow, if any, should be made agentic (tool-using,
self-correcting, dynamically branching) rather than fixed LLM pipelines?

---

## Context

The current "agents" (History, Diagnosis, Management) are fixed multi-call LLM
pipelines — not agentic in the technical sense. True agentic behavior involves
tool use, dynamic branching based on intermediate outputs, self-correction loops,
and autonomous planning.

The system has hard latency constraints: History Agent must deliver first token
within 1.5s of Marker A, Diagnosis Agent within 1.5s of Marker B. The rule engine
is deterministic by design for patient safety.

---

## Options evaluated

### 1. Management Agent RAG retrieval — tool-driven

**Current:** Hardcoded top-2 diagnoses, top-8 chunks, 0.55 similarity threshold.

**Agentic version:** LLM decides which diagnoses need retrieval, how many chunks
are sufficient, and whether to re-query with a different search term if the first
retrieval is thin. Tools would be:
- `retrieve_stg(disease, query, k)`
- `check_formulary(drug_name)`
- `flag_drug_interaction(drug_a, drug_b, patient_allergies)`

**Verdict: Worth doing.** Management Agent has no first-token latency SLA (7-8s
total is already acceptable). This is the highest-stakes output in the system —
a dynamically retrieved weight-band dosing table for a paediatric malaria case is
materially safer than a hardcoded retrieval that may miss it.

---

### 2. Diagnosis Agent — self-correcting differential

**Agentic version:** After generating the differential, agent checks whether it
missed a regionally endemic condition and self-corrects.

**Verdict: Not worth it.** The 1.5s first-token target on Marker B cannot
accommodate a correction loop. The epi prior (layers 1 and 2) already handles
regional weighting. Fixed 3-call pipeline is the right trade-off.

---

### 3. Confirmation pipeline — agentic monitoring

**Current:** Not yet built.

**Agentic version:** Background agent that wakes up, inspects whether new gate
data has arrived (RDT result, treatment response, doctor agreement), decides
whether a case is ready to commit to `confirmed_encounters`, and handles partial
confirmations with the correct confidence weight.

**Verdict: Best candidate in the whole system.** Fully asynchronous, no latency
pressure, involves genuine multi-step reasoning over uncertain state, and directly
improves the quality of the Layer 3 epi prior over time. Should be designed
agentically when built.

---

### 4. Doctor review assistant — tool-augmented

**Agentic version:** Doctor's interface has an assistant that can answer "what
does the STG say about this dose?" by calling retrieval tools on demand.

**Verdict: Moderate benefit.** Not autonomous — doctor stays in the loop — but
reduces friction during async review. Low priority until the doctor UI is built.

---

### 5. Rule engine — never agentic

**Verdict: Do not change.** An LLM deciding whether to escalate a patient with
SpO2 < 90% is a patient safety failure mode. The rule engine's value is that its
behavior is guaranteed, versioned, clinician-auditable, and deployable independently.

---

## Summary of decisions

| Component | Decision | Reason |
|---|---|---|
| Management Agent RAG | Make tool-driven when refactoring | Highest stakes, no latency SLA, material quality gain |
| Diagnosis Agent | Keep fixed pipeline | 1.5s first-token SLA rules out loops |
| History Agent | Keep fixed pipeline | 1.5s first-token SLA, simple task |
| Confirmation pipeline | Design agentically when built | Async, no latency pressure, genuinely uncertain state |
| Rule engine | Never agentic | Patient safety — must remain deterministic |
| Doctor review | Tool-augmented when doctor UI is built | Moderate benefit, low priority |

---

## General trade-offs noted

| Dimension | Agentic | Fixed pipeline |
|---|---|---|
| Latency | Worse — loops add round trips | Predictable, meets 1.5s targets |
| Safety | Harder to audit | Auditable, rule engine stays clean |
| Rx quality | Better — self-correct, re-retrieve | Dependent on first retrieval |
| Nurse trust | Unpredictability is risky in field | Consistent behavior builds trust |
| Cost | More LLM calls per session | Fixed cost per session |
| Debuggability | Hard to reproduce failures | Vault captures every call |
