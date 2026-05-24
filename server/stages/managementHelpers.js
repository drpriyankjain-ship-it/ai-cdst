/**
 * CDST Management Stage — Helpers, Schemas, Rule Engine
 * ======================================================
 * Extracted from management_stage.py for modularity.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');

export const FORMULARY_PATH = join(DATA_DIR, 'formulary_wb.json');
export const BEDSIDE_TOOLS_PATH = join(DATA_DIR, 'bedside_tools.json');
export const ESCALATION_RULES_PATH = join(DATA_DIR, 'escalation_rules.json');
export const RAG_TOP_K = 8;
export const RAG_SIMILARITY_THRESHOLD = 0.55;
export const RAG_SECTION_FILTER = ['treatment', 'dosing', 'contraindications', 'referral', 'general'];
export const RAG_IVFFLAT_PROBES = 10;

let ESCALATION_RULES = {};
try { ESCALATION_RULES = JSON.parse(readFileSync(ESCALATION_RULES_PATH, 'utf-8')); } catch { console.warn('[WARN] Could not load escalation_rules.json'); }

export function loadFormulary() {
  return JSON.parse(readFileSync(FORMULARY_PATH, 'utf-8'));
}

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

export const SCHEMA_CLARIFYING_FINDINGS = {
  type: 'object',
  properties: {
    answers_to_clarifying_questions: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, answer: { type: 'string' } }, required: ['question', 'answer'] } },
    bedside_examination_findings: { type: 'array', items: { type: 'object', properties: { observation: { type: 'string' }, result: { type: 'string' } }, required: ['observation', 'result'] } },
    new_symptoms: { type: 'array', items: { type: 'string' } },
    vitals_found: {
      type: 'object', properties: {
        temperature_c: { type: 'number', nullable: true }, pulse_bpm: { type: 'number', nullable: true },
        systolic_bp_mmhg: { type: 'number', nullable: true }, spo2_pct: { type: 'number', nullable: true },
        rr_per_min: { type: 'number', nullable: true }, bgl_mmol: { type: 'number', nullable: true },
        gcs: { type: 'number', nullable: true }, weight_kg: { type: 'number', nullable: true },
        rdt_result: { type: 'string', nullable: true },
      },
    },
  },
  required: ['answers_to_clarifying_questions', 'bedside_examination_findings', 'new_symptoms', 'vitals_found'],
};

const PRESCRIPTION_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    drug: { type: 'string' }, dose: { type: 'string' }, route: { type: 'string' },
    frequency: { type: 'string' }, duration: { type: 'string' }, instructions: { type: 'string' },
    dose_basis: { type: 'string' }, stg_source: { type: 'string', nullable: true },
    for_problem: { type: 'integer' },
  },
  required: ['drug', 'dose', 'route', 'frequency', 'duration', 'for_problem'],
};

export const SCHEMA_PROBLEM_LIST = {
  type: 'object',
  properties: {
    problem_list: {
      type: 'array', items: {
        type: 'object', properties: {
          problem_number: { type: 'integer' }, problem_title: { type: 'string' },
          type: { type: 'string', enum: ['acute_new', 'established', 'incidental', 'deferred'] },
          assessment: {
            type: 'object', properties: {
              provisional_diagnosis: { type: 'string', nullable: true }, confidence: { type: 'string', nullable: true },
              rationale: { type: 'string', nullable: true }, condition: { type: 'string', nullable: true },
              current_status: { type: 'string', nullable: true }, finding: { type: 'string', nullable: true },
              severity: { type: 'string', nullable: true }, risk_level: { type: 'string', nullable: true },
              icd10_code: { type: 'string', nullable: true },
            }, required: ['icd10_code'],
          },
          plan: {
            type: 'object', properties: {
              prescription: { type: 'array', items: PRESCRIPTION_ITEM_SCHEMA },
              investigations: { type: 'array', items: { type: 'string' } },
              non_pharmacological: { type: 'array', items: { type: 'string' } },
              management_notes: { type: 'string', nullable: true },
            }, required: ['prescription', 'investigations', 'non_pharmacological'],
          },
        }, required: ['problem_number', 'problem_title', 'type', 'assessment', 'plan'],
      },
    },
    non_pharmacological_shared: { type: 'array', items: { type: 'string' } },
    formulary_substitutions: { type: 'array', items: { type: 'string' } },
  },
  required: ['problem_list', 'non_pharmacological_shared', 'formulary_substitutions'],
};

export const SCHEMA_RISK_ASSESSMENT = {
  type: 'object',
  properties: {
    diagnostic_uncertainty: {
      type: 'object', properties: {
        must_not_miss_still_in_play: { type: 'array', items: { type: 'object', properties: { diagnosis: { type: 'string' }, why_still_possible: { type: 'string' }, consequence_if_missed: { type: 'string' }, ruling_out_action: { type: 'string' } }, required: ['diagnosis', 'why_still_possible', 'consequence_if_missed', 'ruling_out_action'] } },
        confidence_in_provisional: { type: 'string', enum: ['high', 'moderate', 'low'] },
        uncertainty_mitigable: { type: 'boolean' },
      }, required: ['must_not_miss_still_in_play', 'confidence_in_provisional', 'uncertainty_mitigable'],
    },
    iatrogenic_risk: {
      type: 'object', properties: {
        risks: { type: 'array', items: { type: 'object', properties: { risk: { type: 'string' }, affected_by: { type: 'string' }, severity: { type: 'string', enum: ['low', 'moderate', 'high'] }, mitigation: { type: 'string' } }, required: ['risk', 'affected_by', 'severity', 'mitigation'] } },
        allergy_check: { type: 'string' }, interaction_check: { type: 'string' },
      }, required: ['risks', 'allergy_check', 'interaction_check'],
    },
    delay_risk: {
      type: 'object', properties: {
        time_sensitive: { type: 'boolean' }, safe_delay_window: { type: 'string' },
        rationale: { type: 'string' }, if_delayed_consequence: { type: 'string' },
      }, required: ['time_sensitive', 'safe_delay_window', 'rationale', 'if_delayed_consequence'],
    },
    complication_watch: {
      type: 'array', items: { type: 'object', properties: { complication: { type: 'string' }, warning_signs: { type: 'array', items: { type: 'string' } }, nurse_action: { type: 'string' }, timeframe: { type: 'string' } }, required: ['complication', 'warning_signs', 'nurse_action', 'timeframe'] },
    },
    mitigation_plan: {
      type: 'object', properties: {
        mitigable_risks: { type: 'array', items: { type: 'string' } },
        unmitigable_risks: { type: 'array', items: { type: 'string' } },
        home_monitoring: { type: 'array', items: { type: 'string' } },
        return_criteria: { type: 'array', items: { type: 'string' } },
        overall_risk_tier: { type: 'string', enum: ['LOW', 'HIGH'] },
        risk_tier_rationale: { type: 'string' },
      }, required: ['mitigable_risks', 'unmitigable_risks', 'home_monitoring', 'return_criteria', 'overall_risk_tier', 'risk_tier_rationale'],
    },
  },
  required: ['diagnostic_uncertainty', 'iatrogenic_risk', 'delay_risk', 'complication_watch', 'mitigation_plan'],
};

export const SCHEMA_TRIAGE_HANDOFF = {
  type: 'object',
  properties: {
    triage: {
      type: 'object', properties: {
        referral: { type: 'object', properties: { required: { type: 'boolean' }, urgency: { type: 'string' }, facility: { type: 'string' }, reason: { type: 'string' } }, required: ['required', 'urgency', 'facility', 'reason'] },
      }, required: ['referral'],
    },
    patient_instructions: {
      type: 'object', properties: {
        diagnosis_explained: { type: 'string' }, treatment_summary: { type: 'string' },
        do_list: { type: 'array', items: { type: 'string' } }, dont_list: { type: 'array', items: { type: 'string' } },
        return_criteria: { type: 'array', items: { type: 'string' } }, follow_up: { type: 'string' },
      }, required: ['diagnosis_explained', 'treatment_summary', 'do_list', 'dont_list', 'return_criteria', 'follow_up'],
    },
    doctor_handoff: {
      type: 'object', properties: {
        one_liner: { type: 'string' }, clinical_summary: { type: 'string' },
        differential_table: { type: 'string' }, key_risks_flagged: { type: 'array', items: { type: 'string' } },
        questions_for_doctor: { type: 'array', items: { type: 'string' } },
      }, required: ['one_liner', 'clinical_summary', 'differential_table', 'key_risks_flagged', 'questions_for_doctor'],
    },
  },
  required: ['triage', 'patient_instructions', 'doctor_handoff'],
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_CONFIDENCE = new Set(['high', 'moderate', 'low']);

function isDegenerate(s) {
  return s.length > 20 && new Set(s.replace(/[. ]/g, '')).size <= 2;
}

export function validateProblemList(raw) {
  const problems = raw.problem_list;
  if (!Array.isArray(problems)) { raw.problem_list = []; return raw; }

  for (let i = 0; i < problems.length; i++) {
    const p = problems[i];
    const label = p.problem_title || `problem ${i + 1}`;
    if (!p.problem_number) p.problem_number = i + 1;
    if (!p.problem_title) p.problem_title = `Problem ${i + 1}`;
    if (!p.type) p.type = 'acute_new';
    if (!p.assessment) p.assessment = {};
    if (!p.plan) p.plan = { prescription: [], investigations: [], non_pharmacological: [] };

    const a = p.assessment;
    const icd = a.icd10_code || '';
    if (isDegenerate(icd) || !icd) { a.icd10_code = 'R69'; } else { a.icd10_code = icd.slice(0, 10); }
    if (!VALID_CONFIDENCE.has(a.confidence || '')) a.confidence = 'moderate';

    for (const f of ['provisional_diagnosis', 'condition', 'finding', 'rationale', 'current_status', 'severity', 'risk_level']) {
      if (a[f] && typeof a[f] === 'string' && isDegenerate(a[f])) a[f] = null;
    }
  }
  if (!raw.non_pharmacological_shared) raw.non_pharmacological_shared = [];
  if (!raw.formulary_substitutions) raw.formulary_substitutions = [];
  return raw;
}

// ---------------------------------------------------------------------------
// Prescription serializer
// ---------------------------------------------------------------------------

export function buildPrescriptionIssued(allDrugs) {
  if (!allDrugs.length) return 'No drugs prescribed.';
  return allDrugs.map(item => {
    const parts = [item.drug, item.dose, item.route, item.frequency, item.duration ? `for ${item.duration}` : ''].filter(Boolean);
    let line = parts.join(' | ');
    if (item.for_problem != null) line += ` [problem #${item.for_problem}]`;
    if (item.instructions) line += ` — ${item.instructions}`;
    return line;
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Rule engine — deterministic gate
// ---------------------------------------------------------------------------

function toFloat(val) {
  if (val == null) return null;
  try { const n = parseFloat(String(val).trim().replace(',', '.')); return isNaN(n) ? null : n; } catch { return null; }
}

export function runRuleEngine(problemListOutput, triageOutput, demographics, vitals, redFlags, extractedConcepts, acuteConfidence) {
  const triggers = [];
  const problems = problemListOutput.problem_list || [];
  const dxNames = [];
  for (const p of problems) {
    const a = p.assessment || {};
    const name = a.provisional_diagnosis || a.condition || a.probable_cause || '';
    if (name) dxNames.push(name.toLowerCase());
  }
  const rxDrugs = problems.flatMap(p => (p.plan?.prescription || []).map(i => (i.drug || '').toLowerCase()));
  const age = demographics.age || 99;
  const sex = (demographics.sex || '').toUpperCase();
  const pregnancy = (demographics.pregnancy_status || '').toLowerCase();
  const vitalsWeight = vitals?.weight_kg;
  const weightKg = vitalsWeight != null ? vitalsWeight : demographics.weight_kg;

  // 1. Vital sign derangements
  if (vitals) {
    const vt = ESCALATION_RULES.vital_thresholds || {};
    const temp = toFloat(vitals.temperature_c), hr = toFloat(vitals.pulse_bpm);
    const sbp = toFloat(vitals.systolic_bp_mmhg), spo2 = toFloat(vitals.spo2_pct);
    const rr = toFloat(vitals.rr_per_min), bgl = toFloat(vitals.bgl_mmol), gcs = toFloat(vitals.gcs);

    if (spo2 != null && spo2 < (vt.spo2_critical_pct || 92)) triggers.push(`HYPOXIA: SpO2 ${spo2}% — respiratory support required`);
    if (sbp != null && sbp < (vt.systolic_bp_shock_mmhg || 90)) triggers.push(`SHOCK: Systolic BP ${sbp} mmHg — haemodynamic instability`);
    if (sbp != null && sbp >= (vt.systolic_bp_hypertensive_emergency_mmhg || 180)) triggers.push(`HYPERTENSIVE EMERGENCY: Systolic BP ${sbp} mmHg`);
    if (hr != null && hr > (vt.hr_tachycardia_bpm || 120)) triggers.push(`TACHYCARDIA: HR ${hr} bpm`);
    if (hr != null && hr < (vt.hr_bradycardia_bpm || 50)) triggers.push(`BRADYCARDIA: HR ${hr} bpm`);
    if (rr != null && rr > (vt.rr_distress_per_min || 30)) triggers.push(`RESPIRATORY DISTRESS: RR ${rr}/min`);
    if (rr != null && rr < (vt.rr_depression_per_min || 10)) triggers.push(`RESPIRATORY DEPRESSION: RR ${rr}/min`);
    if (temp != null && temp > (vt.temperature_hyperpyrexia_c || 40.0)) triggers.push(`HYPERPYREXIA: Temperature ${temp}°C`);
    if (temp != null && temp < (vt.temperature_hypothermia_c || 35.0)) triggers.push(`HYPOTHERMIA: Temperature ${temp}°C`);
    if (gcs != null && gcs < (vt.gcs_altered_consciousness || 15)) triggers.push(`ALTERED CONSCIOUSNESS: GCS ${gcs}/15`);
    if (bgl != null && bgl < (vt.bgl_hypoglycaemia_mmol || 3.0)) triggers.push(`SEVERE HYPOGLYCAEMIA: BGL ${bgl} mmol/L`);
    if (bgl != null && bgl > (vt.bgl_hyperglycaemia_mmol || 16.6)) triggers.push(`SEVERE HYPERGLYCAEMIA: BGL ${bgl} mmol/L`);
  }

  // 2. Red flag symptoms
  if (redFlags?.length) {
    const critTerms = (ESCALATION_RULES.critical_red_flag_terms || []).map(r => r.term.toLowerCase());
    for (const flag of redFlags) {
      const fl = flag.toLowerCase();
      if (critTerms.some(t => fl.includes(t))) triggers.push(`RED FLAG SYMPTOM: '${flag}'`);
    }
  }

  // 3. Diagnosis hard stops
  const highRiskDx = (ESCALATION_RULES.high_risk_diagnoses || []).map(d => d.name.toLowerCase());
  for (const hrd of highRiskDx) {
    if (dxNames.some(n => n.includes(hrd))) { triggers.push(`DIAGNOSIS HARD STOP: '${hrd}' requires hospital-level care`); break; }
  }

  // 4. Drug hard stops
  const injectables = (ESCALATION_RULES.injectable_drugs || []).map(i => i.name.toLowerCase());
  for (const drug of rxDrugs) { for (const inj of injectables) { if (drug.includes(inj)) triggers.push(`INJECTABLE DRUG: '${drug}' requires supervised administration`); } }

  // 5. Patient profile
  const pr = ESCALATION_RULES.patient_profile_rules || {};
  if (age < (pr.infant_age_years_threshold || 2)) triggers.push(`PATIENT AGE: infant under ${pr.infant_threshold_label || '2 years'}`);

  const pregSensitiveDx = (ESCALATION_RULES.pregnancy_sensitive_diagnoses || []).map(d => d.name.toLowerCase());
  const teratogenicDrugs = (ESCALATION_RULES.teratogenic_drugs || []).map(d => d.name.toLowerCase());
  const isSensitiveDx = pregSensitiveDx.some(pdx => dxNames.some(n => n.includes(pdx)));
  const hasTeratogen = teratogenicDrugs.some(u => rxDrugs.some(d => d.includes(u)));
  const minCb = pr.childbearing_age_min_years || 12, maxCb = pr.childbearing_age_max_years || 50;
  const isPregnant = ['pregnant', 'first trimester', 'second trimester', 'third trimester'].includes(pregnancy);
  const isUnknown = ['', 'unknown'].includes(pregnancy) && sex === 'F' && age >= minCb && age <= maxCb;

  if (isPregnant && (isSensitiveDx || hasTeratogen)) triggers.push('PREGNANCY: confirmed pregnancy with sensitive Dx/drug');
  else if (isUnknown && (isSensitiveDx || hasTeratogen)) triggers.push('CHILDBEARING AGE: pregnancy status unknown with sensitive Dx/drug');

  if (weightKg && weightKg < (pr.low_weight_kg_threshold || 5)) triggers.push(`LOW WEIGHT: patient weight < ${pr.low_weight_kg_threshold || 5}kg`);

  // 6. Allergy conflicts
  const reportedAllergies = (extractedConcepts || {}).allergies_reported || [];
  const knownAllergies = [...new Set([...(demographics.known_allergies || []), ...(Array.isArray(reportedAllergies) ? reportedAllergies : [])].map(a => a.toLowerCase()))];
  for (const drug of rxDrugs) { for (const allergy of knownAllergies) { if (allergy.includes(drug) || drug.includes(allergy)) triggers.push(`ALLERGY CONFLICT: '${drug}' conflicts with '${allergy}'`); } }

  // 7. Diagnostic confidence
  if ((acuteConfidence || 'high') === 'low') triggers.push('LOW DIAGNOSTIC CONFIDENCE: provisional diagnosis confidence is low');

  const llmTier = triageOutput?.triage?.tier || 'HIGH';
  const overrodeLlm = triggers.length > 0 && llmTier === 'LOW';
  const finalTier = triggers.length > 0 ? 'HIGH' : llmTier;
  if (overrodeLlm) console.log(`[RULE ENGINE] Overriding LLM tier LOW → HIGH. Triggers: ${triggers}`);

  return { final_risk_tier: finalTier, rules_triggered: triggers, overrode_llm: overrodeLlm, override_reason: overrodeLlm ? triggers.join('; ') : null };
}
