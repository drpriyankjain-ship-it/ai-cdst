# Medical Officer Review Checklist — Site Onboarding

**Purpose:** Before a clinical site goes live, the designated Medical Officer
must review and formally approve all files listed below. These files govern
clinical behaviour — escalation thresholds, prescribable drugs, available
bedside tools, and must-not-miss diagnoses.

**Instructions:** Work through each section in order. For each file, review
the linked document, verify the content against local clinical practice and
facility capabilities, and record your sign-off in the `_metadata` block of
the relevant JSON file. Changes to clinical content require MO annotation —
do not edit JSON directly; raise a request with the engineering team.

---

## Step 1 — Escalation Rules

**File:** `data/escalation_rules.json`
**Human-readable guide:** [docs/clinical/high_risk_escalation_rules.md](high_risk_escalation_rules.md)

Review:
- [ ] Vital sign thresholds (SpO2, BP, HR, RR, temperature, GCS, glucose)
- [ ] Red flag symptoms list
- [ ] Diagnosis hard-stops (22 diagnoses across 6 categories)
- [ ] Medication hard-stops (injectable and teratogenic drugs)
- [ ] Patient profile exclusions (infants, low weight, pregnancy conditions)

Any threshold or diagnosis that does not apply to this facility's referral
capability should be flagged with a note. The rule engine can only escalate
LOW → HIGH — it never downgrades.

**Sign-off:** Record name, title, and date in `escalation_rules.json` → `_metadata`.

---

## Step 2 — Must-Not-Miss Diagnoses

**File:** `data/must_not_miss.json`

Review:
- [ ] All 34 diagnoses are appropriate for this facility's patient population
- [ ] Any region-specific additions required (e.g. local endemic conditions
      not already listed)
- [ ] Any entries that are not clinically relevant at this facility level
      (note: err on the side of inclusion — false positive escalations are
      safer than missed diagnoses)

**Sign-off:** Record name, title, and date in `must_not_miss.json` → `_metadata`.

---

## Step 3 — Formulary

**File:** `data/formulary_wb.json`
**Source:** MoHFW Operational Guidelines for HWC, Annexures 1 & 2

Review:
- [ ] Verify each drug is actually stocked at this facility
- [ ] Mark any drugs listed as unavailable at this site
- [ ] Confirm dosing forms match what is stocked (e.g. tablet vs suspension)
- [ ] Note any drugs that require specific storage conditions unavailable
      at this facility (cold chain, etc.)

The formulary constrains what the Management Stage can prescribe. An out-of-stock
drug listed as available will result in prescriptions the nurse cannot dispense.

**Action required:** Supply a verified per-clinic stock list to the engineering
team before activation. This is the most site-specific file in the system.

**Sign-off:** Record name, title, and date in `formulary_wb.json` → `_metadata`.

---

## Step 4 — Bedside Tools

**File:** `data/bedside_tools.json`
**Guideline crosscheck:** [docs/clinical/bedside_tools_crosscheck.md](bedside_tools_crosscheck.md)

Review:
- [ ] Confirm all listed tools are physically present and functional at this
      facility
- [ ] Pulse oximeter — confirmed present? (retained despite guideline gap;
      remove from JSON if not available)
- [ ] Peak flow meter — confirm availability
- [ ] Malaria RDT, dengue RDT, urine pregnancy test — confirm stock levels
      adequate for expected patient volume
- [ ] HemoCue / haemoglobin meter — confirm present and calibrated

The Diagnosis Stage constrains discriminating tests to this list. Missing tools
mean the gap analysis will suggest tests the nurse cannot perform.

**Sign-off:** Record name, title, and date in `bedside_tools.json` → `_metadata`
(add `_metadata` block if not present).

---

## Step 5 — Epidemiological Prior

**File:** `data/epi_prior_wb.json`
**Scope:** All 23 West Bengal districts, 4 seasonal buckets

Review:
- [ ] Locate this facility's district in the file
- [ ] Review the seasonal disease weights for each of the 4 seasons
- [ ] Flag any diseases with incorrect weights for local conditions
      (weights are relative 0-1, sourced from IDSP/NVBDCP)
- [ ] Flag any endemic conditions missing from the district's entry

The epi prior modifies the Diagnosis Stage differential — it elevates locally
prevalent diseases where the presentation is compatible. Incorrect weights
can bias the differential without being clinically appropriate.

**Raise with engineering team** if corrections are needed. Do not edit the JSON
directly.

---

## Final sign-off

Once all five steps are complete and corrections have been returned to the
engineering team:

| Item | Reviewed by | Title | Date | Changes requested |
|---|---|---|---|---|
| Escalation rules | | | | Y / N |
| Must-not-miss list | | | | Y / N |
| Formulary | | | | Y / N |
| Bedside tools | | | | Y / N |
| Epi prior (district) | | | | Y / N |

**Site name:** ___________________________

**District code:** ___________________________

**Activation approved:** Y / N

**Notes:**
