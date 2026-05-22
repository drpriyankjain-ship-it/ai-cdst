# Urgent Escalation & Referral Rules — Rural PHC → FRU
**Notice to Medical Officers (MOs):**
This document contains the *exact* list of conditions, vital signs, and red flag symptoms that trigger an automatic, immediate, non-overridable escalation to the HIGH risk tier in the AI Clinical Decision Support Tool (CDST).

If any of these triggers are met, the nurse will be instructed to immediately coordinate referral to the First Referral Unit (FRU) or higher. 

**Instructions:**
1. Please review each section below.
2. Cross out any items that do not require immediate referral from a rural clinic without a doctor present.
3. Add any missing conditions, drugs, or symptoms that *should* dictate a mandatory referral.
4. Adjust the numeric thresholds as necessary.
5. Provide this marked-up text back to the engineering team.

---

## 1. Vital Sign Thresholds
*If a patient’s vital signs breach any of the following, they are immediately flagged for referral.*

- **Hypoxia:** SpO2 < 92%
- **Shock:** Systolic BP < 90 mmHg
- **Hypertensive Emergency:** Systolic BP ≥ 180 mmHg
- **Tachycardia:** HR > 120 bpm
- **Bradycardia:** HR < 50 bpm
- **Respiratory Distress:** RR > 30 /min
- **Respiratory Depression:** RR < 10 /min
- **Hyperpyrexia:** Temperature > 40.0 °C
- **Hypothermia:** Temperature < 35.0 °C
- **Altered Consciousness:** GCS < 15
- **Severe Hypoglycaemia:** Blood Glucose < 3.0 mmol/L
- **Severe Hyperglycaemia:** Blood Glucose > 16.6 mmol/L

## 2. Red Flag Symptoms
*If a patient complains of or presents with any of the following, they are immediately escalated.*
- Unable to walk / paralysis / limb weakness
- Vomiting blood / coughing blood / black stool
- Seizures / fitting / convulsing
- Unconscious / unresponsive
- Unable to breathe
- Rigid / board-like abdomen
- Facial droop / slurred speech
- Sudden severe headache
- Sudden loss of bladder or bowel control

## 3. Diagnosis Hard-Stops
*If the AI assesses any of the following as the most likely provisional diagnosis, the case is immediately escalated.*

**Infectious / Systemic**
- Sepsis, septic shock
- Severe malaria, cerebral malaria
- Meningitis, encephalitis
- Cholera (severe)
- Diphtheria
- Tetanus, rabies

**Obstetric / Gynaecological**
- Eclampsia, pre-eclampsia (severe)
- Ectopic pregnancy
- Antepartum / postpartum haemorrhage
- Obstructed labour
- Postpartum sepsis

**Cardiopulmonary**
- Acute myocardial infarction / unstable angina
- Acute pulmonary oedema
- Respiratory failure
- Anaphylaxis
- Aortic dissection

**Neurological**
- Stroke
- Status epilepticus
- Guillain-Barré syndrome
- Acute flaccid paralysis (AFP)
- Cord compression

**Metabolic / Endocrine**
- Diabetic ketoacidosis (DKA) / Hyperosmolar hyperglycaemic state (HHS)
- Addisonian crisis

**Surgical / GI**
- Acute abdomen (perforation, torsion)
- Bowel obstruction / intussusception
- Peritonitis

## 4. Medication Hard-Stops
*If the AI drafts a prescription containing any of the following injectable or high-risk drugs, a doctor MUST authorize the prescription before it can be dispensed.*

- Artesunate, quinine (IV/IM)
- Ceftriaxone (IV/IM)
- Oxytocin, magnesium sulphate
- Dexamethasone, adrenaline
- Morphine, diazepam, phenobarbitone (controlled drugs/seizure management)
- Hydralazine, labetalol (IV)

## 5. Patient Profile Exclusions
*Certain vulnerable demographics carry a blanket requirement for doctor review prior to prescribing any medication.*

- **Infants:** Any child under 2 years of age.
- **Low Weight:** Any patient < 5 kg.
- **Pregnancy (Known):** Females with a *confirmed* pregnancy **AND** the AI is diagnosing a pregnancy-sensitive condition (e.g. eclampsia, ectopic pregnancy, antepartum haemorrhage, malaria, UTI, hypertension) **OR** the AI is attempting to prescribe a known teratogen (e.g. doxycycline, ibuprofen, valproate, ACE inhibitors). Pregnant women presenting with conditions that are **not** pregnancy-sensitive are managed using the same rules as the general population and do **not** require a blanket doctor review solely on account of pregnancy.
- **Unconfirmed Pregnancy (Childbearing Age):** Females aged 12-50 whose pregnancy status is *unknown* **AND** the AI is diagnosing a pregnancy-sensitive condition (e.g. ectopic pregnancy, hyperemesis, malaria, UTI) **OR** the AI is attempting to prescribe a known teratogen (e.g. doxycycline, ibuprofen, valproate, ACE inhibitors).

---

## Sign-Off

**Reviewed By (Name & Title):** _______________________________________

**Date:** ___________________

**Modifications Requested?**   [  ] YES    [  ] NO 

*(If YES, please list requested modifications below or supply an annotated copy of this document).*

___________________________________________________________________
___________________________________________________________________
___________________________________________________________________
