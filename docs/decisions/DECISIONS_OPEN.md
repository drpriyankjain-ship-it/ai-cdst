# Open Decisions

All unresolved questions that are blocking or will block specific components.
Grouped by who needs to provide the answer. Remove an item when resolved and
record the decision in the relevant ADR or CLAUDE.md section.

---

## Needs: Product / Clinical Lead

These questions define behaviour that affects both the clinical workflow and
the software design. Engineers cannot unilaterally resolve them.

### 1. Patient identity and registration
**Blocking:** Session orchestrator — patient record loading at session start.

How does the nurse identify the patient at session start?
- Search by name and village?
- Scan / enter a patient ID card number?
- New record created by default, with duplicate merging later?

The answer determines how `orchestrator.py` loads `patient_records` and whether
a registration step exists in the mobile UI before the session begins.

---

### 2. Nurse UI — post-management output
**Blocking:** Management Stage output schema; doctor interface design.

After the Management Stage completes, what can the nurse do before the case
reaches the doctor?
- Can she add notes or observations?
- Can she flag disagreement with the AI recommendation?
- Does she see the full risk assessment or a simplified summary?

---

### 3. Standing orders — most consequential clinical question
**Blocking:** Triage output framing; entire doctor authorisation flow.

For LOW risk cases, can the nurse dispense medication immediately (before doctor
reviews), operating under standing orders? Or does she always wait for doctor
approval before handing over drugs — even for LOW risk?

This single answer determines how the triage output is framed to the nurse and
the design of the full authorisation workflow.

---

## Needs: Medical Officer (sign-off)

These items are ready for clinical review. No engineering work is blocked — but
the system cannot go live at any site without these approvals.

### 4. Escalation rules sign-off
**Document:** [docs/clinical/high_risk_escalation_rules.md](../clinical/high_risk_escalation_rules.md)
**Status:** Blank sign-off fields — MO has not yet formally reviewed.

The Medical Officer must review all thresholds, red flag symptoms, diagnosis
hard-stops, and medication hard-stops, then sign the document before site
activation.

---

### 5. Must-not-miss diagnosis list sign-off
**Document:** [data/must_not_miss.json](../../data/must_not_miss.json)
**Status:** Drafted by engineering. Requires MO clinical review.

34 diagnoses across 8 categories. MO should confirm inclusions, exclusions,
and any region-specific additions before the first site goes live.

---

### 6. Bedside tools list sign-off
**Document:** [docs/clinical/bedside_tools_crosscheck.md](../clinical/bedside_tools_crosscheck.md)
**Status:** Guideline crosscheck complete. Requires MO confirmation for each site.

Per-site verification needed: pulse oximeter availability confirmed; otoscope
excluded; peak flow meter listed but availability should be verified per clinic.

---

### 7. Formulary population
**File:** [data/formulary_wb.json](../../data/formulary_wb.json)
**Status:** Seeded from MoHFW Operational Guidelines Annexures 1 & 2. Requires
per-clinic stock verification before going live.

A pharmacist or MO must confirm actual drug stock at each target clinic.
The formulary governs what Management Stage Call 2 can prescribe — stocking
discrepancies directly affect prescription safety.

---

## Needs: Engineering

These are internal engineering tasks with no external dependency.

### 8. Option B — targeted Diagnosis Stage extraction
**Blocking:** Must be complete before field pilots. See [ADR 002](adr/002-history-intake-approach.md).

The History Stage currently uses fixed background history questions (Option A)
to ensure PMH, FHx, SHx, medications, and allergies are always asked.
Option B adds targeted per-field extraction in the Diagnosis Stage so the
Concept Extractor captures answers to known, predictable questions reliably.

Option C (A + B together) is the target. Option B is the missing half.

---

### 9. RAG corpus and threshold decisions
**Document:** [docs/arch/rag_brief.md](../arch/rag_brief.md) §4.9

Six items requiring human judgment before the RAG pipeline is production-ready:

| Item | Decision needed |
|---|---|
| NHM STG edition | Which edition to embed — confirm with clinical lead |
| G6PD test availability | Affects primaquine prescribability at target clinics |
| Referral facility mapping | GPS district code → nearest FRU — data problem, not code |
| Similarity threshold | 0.55 is conservative; tune empirically with real STG corpus |
| Bengali STG documents | If Bengali-language STGs exist, multilingual embedding model required |
| Formulary source | Verify formulary_wb.json against actual district drug supply |

---

### 10. Management Stage RAG — make tool-driven
**Not blocking MVP. Recommended before scale.** See [ADR 001](adr/001-agentic-patterns.md).

Current retrieval is hardcoded: top-2 diagnoses, top-8 chunks, 0.55 threshold.
ADR 001 recommends making this tool-driven (LLM decides which diagnoses need
retrieval and whether to re-query if the first retrieval is thin).
Tools needed: `retrieve_stg()`, `check_formulary()`, `flag_drug_interaction()`.

---

### 11. Confirmation pipeline — design agentically
**Not blocking MVP. Required for Layer 3 epi prior.** See [ADR 001](adr/001-agentic-patterns.md).

The confirmation pipeline (monitors RDT results, treatment response, doctor
agreement, then commits to `confirmed_encounters`) is not yet built.
ADR 001 recommends designing this as an agentic background process —
it is the best candidate in the system for agentic patterns.

---

## Future build (no current blocker)

### Site Administrator Onboarding Portal

A lightweight web interface for the Medical Officer to review and formally approve
all clinical config files before a site goes live. Presents each file in
human-readable form (not raw JSON) for review, annotation, and sign-off. Replaces
the currently blank `reviewed_by` / `sign_off_notes` fields in each `_metadata`
block with a formal approval workflow.

Design constraint: read-only review + approve/reject — MOs do not edit JSON
directly in the UI. Edits go through engineering; the portal is the approval gate.

Files requiring MO sign-off: `escalation_rules.json`, `must_not_miss.json`,
`formulary_wb.json`, `bedside_tools.json`, `epi_prior_wb.json`.

See also: [docs/clinical/MO_REVIEW_CHECKLIST.md](../clinical/MO_REVIEW_CHECKLIST.md)
for the manual equivalent of this workflow (used until the portal is built).

---

### Nurse-facing output preference personalisation

Per-nurse language and verbosity preferences captured at first login via an
example-picker UI — not abstract toggles, but concrete side-by-side samples of
actual system output that the nurse picks between.

**Preference dimensions:**
- Output language: English / vernacular (native script) / romanised vernacular / bilingual
- Response style: action-focused terse ("Check SpO2. Ask about fever duration.") vs
  explanatory (includes brief clinical reasoning behind each recommendation)

**Implementation:** preferences stored per `nurse_id` (new `user_preferences` table
or column on the users table). Orchestrator loads the profile at session start and
injects a style instruction block into the system prompt for all three stages.
Preferences updatable at any time from a settings screen.

**Why example-picker not toggles:** rural nurses vary widely in English literacy and
prior training. "Verbose" vs "concise" is meaningless without a concrete example.
Showing rendered output samples makes the choice unambiguous.
