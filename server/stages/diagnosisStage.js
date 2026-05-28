/**
 * CDST Diagnosis Stage  [fixed pipeline]
 * ========================================
 * Three-call pipeline — no RAG:
 *
 *   Call 1: transcript segment → extracted medical concepts       (~900ms)
 *   Call 2: concepts + epi prior → ranked differential (DDx)     (~3.2s, streaming)
 *   Call 3: DDx + bedside tools → gap analysis + clarifying Qs   (~1.4s)
 *
 * Direct port of diagnosis_stage.py
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { vaultRead, vaultUpdate, vaultSetNested } from '../lib/db.js';
import { generateWithCascade, parseJsonResponse, responseText } from '../lib/llmClient.js';
import { MODEL_D1_CONCEPTS, MODEL_D2_DIFFERENTIAL, MODEL_D3_CLARIFYING } from '../lib/modelConfig.js';
import { stateFromDistrictCode, loadBaselineDiseases, loadEpiPrior } from '../lib/epiUtils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');

// ---------------------------------------------------------------------------
// Must-not-miss list (loaded once at startup)
// ---------------------------------------------------------------------------

let _mustNotMissLower = [];
try {
  const data = JSON.parse(readFileSync(join(DATA_DIR, 'must_not_miss.json'), 'utf-8'));
  _mustNotMissLower = data.diagnoses.map(d => d.name.toLowerCase());
} catch {
  console.warn('[WARN] Could not load must_not_miss.json — flags will not be enforced');
}

let _pregnancySensitiveDx = new Set();
try {
  const rules = JSON.parse(readFileSync(join(DATA_DIR, 'escalation_rules.json'), 'utf-8'));
  _pregnancySensitiveDx = new Set((rules.pregnancy_sensitive_diagnoses || []).map(d => d.name.toLowerCase()));
} catch {
  console.warn('[WARN] Could not load pregnancy_sensitive_diagnoses from escalation_rules.json — pregnancy gate uses fallback');
}

let _bedsideTools = null;
try {
  _bedsideTools = JSON.parse(readFileSync(join(DATA_DIR, 'bedside_tools.json'), 'utf-8'));
} catch {
  console.warn('[WARN] Could not load bedside_tools.json — clarifying questions will have no tool list');
}

function isMustNotMiss(diseaseName) {
  const d = diseaseName.toLowerCase();
  return _mustNotMissLower.some(mnm => mnm.includes(d) || d.includes(mnm));
}

// ---------------------------------------------------------------------------
// Differential validation
// ---------------------------------------------------------------------------

const VALID_PROBABILITY = new Set(['high', 'moderate', 'low']);
const FIELD_DEFAULTS = {
  rank: 0, disease: 'Unknown', icd10_code: 'R69', probability: 'low',
  supporting_features: [], against: [], must_not_miss: false,
  regionally_specific: false, reasoning: 'No reasoning provided',
  discriminating_tests: [], referral_required: false,
};

export function validateDifferential(ddx) {
  const validated = [];
  for (let i = 0; i < ddx.length; i++) {
    const entry = ddx[i];
    const label = entry.disease || `entry ${i}`;
    const clean = {};
    for (const field of Object.keys(FIELD_DEFAULTS)) {
      let val = entry[field];
      if (val == null) {
        console.log(`[DDX SCHEMA] '${label}' missing '${field}' — using default`);
        clean[field] = FIELD_DEFAULTS[field];
      } else if (field === 'probability' && !VALID_PROBABILITY.has(val)) {
        console.log(`[DDX SCHEMA] '${label}' invalid probability '${val}' — normalising to 'moderate'`);
        clean[field] = 'moderate';
      } else {
        clean[field] = val;
      }
    }
    if (isMustNotMiss(label)) {
      if (!clean.must_not_miss) console.log(`[DDX SCHEMA] '${label}' matched must_not_miss list — overriding to true`);
      clean.must_not_miss = true;
    }
    validated.push(clean);
  }
  validated.sort((a, b) => a.rank - b.rank);
  return validated;
}

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const SCHEMA_MEDICAL_CONCEPTS = {
  type: 'object',
  properties: {
    chief_complaint: { type: 'string' },
    symptoms: {
      type: 'array', items: {
        type: 'object', properties: {
          name: { type: 'string' }, duration: { type: 'string', nullable: true },
          severity: { type: 'string', nullable: true }, character: { type: 'string', nullable: true },
        }, required: ['name'],
      },
    },
    negatives: { type: 'array', items: { type: 'string' } },
    risk_factors: { type: 'array', items: { type: 'string' } },
    vitals_reported: {
      type: 'object', properties: {
        temperature_c: { type: 'number', nullable: true }, pulse_bpm: { type: 'number', nullable: true },
        systolic_bp_mmhg: { type: 'number', nullable: true }, spo2_pct: { type: 'number', nullable: true },
        rr_per_min: { type: 'number', nullable: true }, bgl_mmol: { type: 'number', nullable: true },
        gcs: { type: 'number', nullable: true },
      },
    },
    red_flags: { type: 'array', items: { type: 'string' } },
    pregnancy_status: { type: 'string', nullable: true },
    lmp: { type: 'string', nullable: true },
    uncertain_findings: {
      type: 'array', items: {
        type: 'object', properties: { topic: { type: 'string' }, patient_response: { type: 'string' } },
        required: ['topic', 'patient_response'],
      },
    },
    past_medical_history: { type: 'array', items: { type: 'string' } },
    current_medications: { type: 'array', items: { type: 'string' } },
    allergies_reported: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'chief_complaint', 'symptoms', 'negatives', 'risk_factors',
    'vitals_reported', 'red_flags', 'pregnancy_status',
    'lmp', 'uncertain_findings', 'past_medical_history',
    'current_medications', 'allergies_reported',
  ],
};

const DDX_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    rank: { type: 'integer' }, disease: { type: 'string' }, icd10_code: { type: 'string' },
    probability: { type: 'string', enum: ['high', 'moderate', 'low'] },
    supporting_features: { type: 'array', items: { type: 'string' } },
    against: { type: 'array', items: { type: 'string' } },
    must_not_miss: { type: 'boolean' }, regionally_specific: { type: 'boolean' },
    reasoning: { type: 'string' },
    discriminating_tests: { type: 'array', items: { type: 'string' } },
    referral_required: { type: 'boolean' },
  },
  required: ['rank', 'disease', 'icd10_code', 'probability', 'supporting_features',
    'against', 'must_not_miss', 'regionally_specific', 'reasoning', 'discriminating_tests', 'referral_required'],
};

const SCHEMA_DIFFERENTIAL = {
  type: 'object',
  properties: { differential: { type: 'array', items: DDX_ITEM_SCHEMA } },
  required: ['differential'],
};

const SCHEMA_CLARIFYING_QS = {
  type: 'object',
  properties: {
    clinical_summary: { type: 'string' },
    key_uncertainty: { type: 'string' },
    clarifying_questions: {
      type: 'array', items: {
        type: 'object', properties: {
          question: { type: 'string' },
          discriminates_between: { type: 'array', items: { type: 'string' } },
          if_yes_favours: { type: 'string' }, if_no_favours: { type: 'string' },
          priority: { type: 'integer' },
        },
        required: ['question', 'discriminates_between', 'if_yes_favours', 'if_no_favours', 'priority'],
      },
    },
    bedside_observations: {
      type: 'array', items: {
        type: 'object', properties: {
          observation: { type: 'string' }, tool_required: { type: 'string' },
          discriminates_between: { type: 'array', items: { type: 'string' } },
          finding_and_meaning: { type: 'string' }, priority: { type: 'integer' },
        },
        required: ['observation', 'tool_required', 'discriminates_between', 'finding_and_meaning', 'priority'],
      },
    },
  },
  required: ['clinical_summary', 'key_uncertainty', 'clarifying_questions', 'bedside_observations'],
};

// ---------------------------------------------------------------------------
// Call 1 — Concept extraction
// ---------------------------------------------------------------------------

export async function extractMedicalConcepts(transcriptSegment, vaultContext) {
  const demographics = vaultContext.demographics || {};
  const priorEncounters = (vaultContext.patient_record || {}).encounters || [];
  const priorText = priorEncounters.length
    ? JSON.stringify(priorEncounters.slice(-3), null, 2)
    : 'No prior encounters recorded.';

  const prompt = [
    'Extract structured medical concepts from this nurse-patient interview transcript.',
    `PATIENT DEMOGRAPHICS:\n${JSON.stringify(demographics, null, 2)}`,
    `PRIOR ENCOUNTER SUMMARY (last 3 visits):\n${priorText}`,
    `TRANSCRIPT (phase 2 interview):\n${transcriptSegment}`,
    'INSTRUCTIONS:\n' +
    '- Extract only what is explicitly stated or clearly implied\n' +
    '- Negatives are as important as positives — list all denied symptoms\n' +
    '- Do not infer or assume anything not present in the transcript\n' +
    '- vitals_reported: return NUMERIC JSON numbers only.\n' +
    '  temperature_c: convert to °C before returning. If >50 assume °F and convert: (F−32)×5/9.\n' +
    '  All other vitals: strip units as-is.\n' +
    '  Null for any vital sign not explicitly mentioned.\n' +
    '- red_flags: list verbatim any alarming symptom or finding explicitly stated. Empty list [] if none.\n' +
    '- pregnancy_status: MANDATORY for any female patient aged 12-50.\n' +
    '  Set to \'pregnant\'/\'not_pregnant\'/\'postpartum\' from explicit statements.\n' +
    '  Set to \'unknown\' if the topic was not raised. Null for male patients or age outside 12-50.\n' +
    '- lmp: record verbatim if stated; null otherwise\n' +
    '- uncertain_findings: list any topic where the patient\'s answer was ambiguous.\n' +
    '- risk_factors: list ALL patient-level risk factors and epidemiological exposures explicitly mentioned:\n' +
    '  clinical risk factors (age, sex, BMI, smoking, alcohol, occupation, comorbidities),\n' +
    '  epidemiological context (recent travel, household contacts with illness, TB in family,\n' +
    '  pilgrimage/crowd exposure, occupational chemical exposure, living in flood-prone area).\n' +
    '  Empty [] if none stated.\n' +
    '- past_medical_history: list chronic/past conditions explicitly mentioned. Empty [] if none.\n' +
    '- current_medications: list drugs currently taking with dose if stated. Empty [] if none.\n' +
    '- allergies_reported: list allergens with reaction. Empty [] if none.',
  ].join('\n\n');

  const response = await generateWithCascade(
    MODEL_D1_CONCEPTS, prompt,
    { thinkingConfig: { thinkingBudget: 0 }, responseMimeType: 'application/json', responseSchema: SCHEMA_MEDICAL_CONCEPTS, maxOutputTokens: 4000 },
  );
  return parseJsonResponse(responseText(response));
}

// ---------------------------------------------------------------------------
// Call 2 — Differential diagnosis
// ---------------------------------------------------------------------------

export async function generateDifferential(concepts, vaultContext, baselineLayer, epiLayer) {
  const demographics = vaultContext.demographics || {};
  const districtCode = (vaultContext.gps || {}).district_code || 'WB_UNKNOWN';
  const stateName = stateFromDistrictCode(districtCode);

  const prompt = [
    `You are a clinical decision support system assisting a nurse in rural ${stateName}, India.\nGenerate a differential diagnosis for the patient below.`,
    `PATIENT:\n${JSON.stringify(demographics, null, 2)}`,
    `EXTRACTED CLINICAL CONCEPTS:\n${JSON.stringify(concepts, null, 2)}`,
    baselineLayer,
    epiLayer || '(No Layer 2 modifier — district not found in epi prior)',
    'INSTRUCTIONS:\n- Generate 4-6 differential diagnoses ranked by probability\n' +
    '- Layer 1 lists common primary care presentations — include any compatible.\n' +
    '- Layer 2 epi prior elevates endemic diseases where compatible — never overrides presenting complaint\n' +
    '- must_not_miss=true for any diagnosis where missing it could cause rapid deterioration or death\n' +
    `- regionally_specific=true for diseases with elevated ${stateName} prevalence\n` +
    '- referral_required=true for any diagnosis needing hospital-level care\n' +
    '- discriminating_tests: list all relevant tests (bedside, lab, or imaging)\n' +
    '- icd10_code: most specific applicable ICD-10 code\n' +
    '- Base reasoning ONLY on features present — never assume unstated findings',
  ].join('\n\n');

  const response = await generateWithCascade(
    MODEL_D2_DIFFERENTIAL, prompt,
    { thinkingConfig: { thinkingBudget: 0 }, responseMimeType: 'application/json', responseSchema: SCHEMA_DIFFERENTIAL, maxOutputTokens: 8000 },
  );
  return validateDifferential(parseJsonResponse(responseText(response)).differential);
}

// ---------------------------------------------------------------------------
// Call 3 — Clarifying questions
// ---------------------------------------------------------------------------

function pregnancyRelevance(ddx, concepts, vaultContext) {
  const demographics = vaultContext.demographics || {};
  const age = demographics.age || 99;
  const sex = (demographics.sex || '').toUpperCase();
  const pregnancyStatus = (concepts.pregnancy_status || demographics.pregnancy_status || '').toLowerCase();
  const statusUnknown = ['', 'unknown'].includes(pregnancyStatus);

  if (sex !== 'F' || age < 12 || age > 50) return { needsLmpQuestion: false, statusUnknown: false };
  if (!statusUnknown) return { needsLmpQuestion: false, statusUnknown: false };

  const dxNames = ddx.map(d => (d.disease || '').toLowerCase()).join(' ');
  const relevant = [..._pregnancySensitiveDx].some(term => dxNames.includes(term));
  return { needsLmpQuestion: relevant, statusUnknown: true };
}

export async function generateClarifyingQuestions(ddx, concepts, vaultContext) {
  const availableTools = _bedsideTools;
  const districtCode = (vaultContext.gps || {}).district_code || 'WB_UNKNOWN';
  const stateName = stateFromDistrictCode(districtCode);
  const lang = (vaultContext.chief_complaint || {}).language_of_consultation || 'English';
  const languageInstruction = lang === 'English' ? '' :
    `LANGUAGE: The consultation is in ${lang}. After each clarifying question, add a romanised ${lang} translation in brackets.`;

  const topDiagnoses = ddx.slice(0, 3).map(d => d.disease);
  const mustNotMiss = ddx.filter(d => d.must_not_miss).map(d => d.disease);
  const needsReferral = ddx.filter(d => d.referral_required).map(d => d.disease);
  const { needsLmpQuestion } = pregnancyRelevance(ddx, concepts, vaultContext);

  const pregnancyInstruction = needsLmpQuestion
    ? 'MANDATORY PREGNANCY CLARIFICATION (priority 1):\nPregnancy status was not established. Include as first clarifying question (priority 1):\n  question: "When did your last period start? Are you pregnant, or could you be pregnant?"\n  discriminates_between: list all pregnancy-sensitive diagnoses\n  priority: 1 — renumber all other questions starting from 2\n'
    : '';

  const instructions = [
    'INSTRUCTIONS:\n- Generate 3-5 clarifying questions ranked by discriminating power\n' +
    '- Generate 2-4 bedside observations ranked by discriminating power\n' +
    '- Priority 1 = the single finding that would most change the ranking\n' +
    '- Must-not-miss diagnoses must be screened for even if probability is low\n' +
    '- Questions must be phrased simply enough for any patient to understand\n' +
    '- Observations must use ONLY tools from the available list below\n' +
    '- Never suggest labs, imaging, LP, ECG, or any hospital-level investigation\n' +
    `AVAILABLE BEDSIDE TOOLS:\n${JSON.stringify(availableTools, null, 2)}`,
    pregnancyInstruction,
    languageInstruction,
  ].filter(Boolean).join('\n\n');

  const prompt = [
    `You are designing a targeted clinical assessment for a nurse in a remote rural clinic in ${stateName}. ` +
    'Prioritise questions and observations that are highest-yield.',
    `CURRENT DIFFERENTIAL (ranked):\n${JSON.stringify(ddx, null, 2)}`,
    `TOP DIAGNOSES TO DISCRIMINATE: ${JSON.stringify(topDiagnoses)}`,
    `MUST-NOT-MISS (screen regardless): ${JSON.stringify(mustNotMiss)}`,
    `REFERRAL-REQUIRED DIAGNOSES: ${JSON.stringify(needsReferral)}`,
    `CLINICAL FEATURES ALREADY KNOWN:\n${JSON.stringify(concepts, null, 2)}`,
    `UNCERTAIN FINDINGS:\n${concepts.uncertain_findings?.length ? JSON.stringify(concepts.uncertain_findings, null, 2) : 'None — all answers were clear.'}`,
    instructions,
  ].join('\n\n');

  const response = await generateWithCascade(
    MODEL_D3_CLARIFYING, prompt,
    { thinkingConfig: { thinkingBudget: 0 }, responseMimeType: 'application/json', responseSchema: SCHEMA_CLARIFYING_QS, maxOutputTokens: 4000 },
  );

  const result = parseJsonResponse(responseText(response));

  // Safety net: inject LMP question deterministically if needed and LLM omitted it
  if (needsLmpQuestion) {
    const existingQs = result.clarifying_questions || [];
    const lmpPresent = existingQs.some(q =>
      q.question.toLowerCase().includes('period') ||
      q.question.toLowerCase().includes('lmp') ||
      q.question.toLowerCase().includes('pregnant')
    );
    if (!lmpPresent) {
      const pregnancySensitiveInDdx = ddx
        .filter(d => [..._pregnancySensitiveDx].some(t => d.disease.toLowerCase().includes(t)))
        .map(d => d.disease);
      const lmpQ = {
        question: 'When did your last period start? Are you pregnant, or could you be pregnant?',
        discriminates_between: pregnancySensitiveInDdx.length ? pregnancySensitiveInDdx : topDiagnoses,
        if_yes_favours: 'obstetric or pregnancy-modified diagnosis',
        if_no_favours: 'non-obstetric diagnosis',
        priority: 1,
      };
      for (const q of existingQs) q.priority = (q.priority || 1) + 1;
      result.clarifying_questions = [lmpQ, ...existingQs];
      console.log('[PREGNANCY GATE] LMP clarifying question injected deterministically');
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runDiagnosisStage(sessionId, transcriptSegment, dbClient) {
  const vaultContext = await vaultRead(dbClient, sessionId);
  const gps = vaultContext.gps || {};
  const districtCode = gps.district_code || 'WB_UNKNOWN';
  const currentMonth = new Date().getMonth() + 1;
  const baselineLayer = loadBaselineDiseases();
  const epiLayer = loadEpiPrior(districtCode, currentMonth);

  // Call 1
  console.log(`[${sessionId}] Call 1: extracting medical concepts`);
  const concepts = await extractMedicalConcepts(transcriptSegment, vaultContext);
  await vaultUpdate(dbClient, sessionId, { extracted_concepts: concepts });

  // Backfill pregnancy_status into demographics
  const extractedPregnancy = concepts.pregnancy_status;
  let ctx = vaultContext;
  if (extractedPregnancy != null) {
    await vaultSetNested(dbClient, sessionId, ['demographics', 'pregnancy_status'], extractedPregnancy);
    if (concepts.lmp) await vaultSetNested(dbClient, sessionId, ['demographics', 'lmp'], concepts.lmp);
    console.log(`[${sessionId}] Pregnancy status extracted: ${extractedPregnancy} (LMP: ${concepts.lmp})`);
    ctx = await vaultRead(dbClient, sessionId);
  } else {
    console.log(`[${sessionId}] pregnancy_status not applicable for this patient`);
  }

  // Call 2
  console.log(`[${sessionId}] Call 2: generating differential`);
  const ddx = await generateDifferential(concepts, ctx, baselineLayer, epiLayer);
  await vaultUpdate(dbClient, sessionId, { differential_table: ddx });

  // Call 3
  console.log(`[${sessionId}] Call 3: generating clarifying questions`);
  const clarifying = await generateClarifyingQuestions(ddx, concepts, ctx);
  await vaultUpdate(dbClient, sessionId, {
    clarifying_questions: clarifying,
    diagnosis_stage_status: 'complete',
    diagnosis_stage_completed_at: new Date().toISOString(),
  });

  console.log(`[${sessionId}] Diagnosis stage complete`);
  return { session_id: sessionId, concepts, ddx, clarifying };
}
