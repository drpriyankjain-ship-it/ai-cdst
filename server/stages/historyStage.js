/**
 * CDST History Stage  [fixed pipeline]
 * ======================================
 * Two-call pipeline — no RAG:
 *
 *   Call 1: ~30s transcript → chief complaint extraction            (~700ms)
 *   Call 2: patient record + chief complaint → questionnaire        (single structured call, TIER_FAST)
 *
 * Direct port of history_stage.py
 */

import { vaultRead, vaultUpdate } from '../lib/db.js';
import { generateWithCascade, parseJsonResponse, responseText } from '../lib/llmClient.js';
import { MODEL_H1_CHIEF_COMPLAINT, MODEL_H2_QUESTIONNAIRE } from '../lib/modelConfig.js';
import { stateFromDistrictCode } from '../lib/epiUtils.js';

// ---------------------------------------------------------------------------
// Patient record context builder
// ---------------------------------------------------------------------------

export function buildPatientRecordContext(patientRecord) {
  if (!patientRecord || Object.keys(patientRecord).length === 0) {
    const missing = [
      'past_medical_history', 'family_history', 'social_history',
      'current_medications', 'allergies', 'immunisation_history',
    ];
    return { knownContext: 'NEW PATIENT — no prior records exist.', missingFields: missing };
  }

  const missing = [];
  const lines = ['EXISTING PATIENT RECORD:'];

  // Encounter history
  const encounters = patientRecord.encounters || [];
  const confirmed = encounters.filter(e => (e.confidence_weight || 0) >= 0.5 || e.confirmed);
  if (confirmed.length) {
    lines.push(`  Prior visits: ${confirmed.length} confirmed encounter(s)`);
    for (const e of confirmed.slice(-3)) {
      lines.push(
        `    ${e.date || '?'}: ` +
        `${e.confirmed_diagnosis || e.provisional_diagnosis || '?'} — ` +
        `Rx: ${e.treatment || '?'} — outcome: ${e.outcome || '?'}`
      );
    }
  } else {
    lines.push('  Prior visits: none confirmed yet');
  }

  // Past medical history
  const pmh = patientRecord.known_conditions || [];
  if (pmh.length) lines.push(`  Known conditions: ${pmh.join(', ')}`);
  else { missing.push('past_medical_history'); lines.push('  Known conditions: NOT YET RECORDED'); }

  // Allergies
  const allergies = patientRecord.known_allergies || [];
  if (allergies.length) lines.push(`  Allergies: ${allergies.join(', ')}`);
  else { missing.push('allergies'); lines.push('  Allergies: NOT YET RECORDED'); }

  // Current medications
  const meds = patientRecord.current_medications || [];
  if (meds.length) lines.push(`  Current medications: ${meds.join(', ')}`);
  else { missing.push('current_medications'); lines.push('  Current medications: NOT YET RECORDED'); }

  // Family history
  const fhx = patientRecord.family_history || [];
  if (fhx.length) lines.push(`  Family history: ${fhx.join(', ')}`);
  else { missing.push('family_history'); lines.push('  Family history: NOT YET RECORDED'); }

  // Social history
  const soc = patientRecord.social_history || {};
  if (Object.keys(soc).length) {
    lines.push(
      `  Social history: occupation=${soc.occupation || '?'}, ` +
      `tobacco=${soc.tobacco || '?'}, alcohol=${soc.alcohol || '?'}`
    );
  } else {
    missing.push('social_history');
    lines.push('  Social history: NOT YET RECORDED');
  }

  // Significant history
  const sig = patientRecord.significant_history || [];
  if (sig.length) {
    lines.push('  Significant history:');
    for (const s of sig.slice(-3)) lines.push(`    - ${s}`);
  }

  return { knownContext: lines.join('\n'), missingFields: missing };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isComplaintMissing(chiefComplaint) {
  const value = (chiefComplaint.chief_complaint || '').trim().toLowerCase();
  if (!value) return true;
  const empty = new Set(['unknown', 'unclear', 'not stated', 'not mentioned', 'n/a', 'none']);
  return empty.has(value);
}

// Build patient_record_fields deterministically — avoids a second LLM call
// and eliminates divergence between what the nurse sees and what the vault stores.
function buildPatientRecordFields() {
  return {
    past_medical_history: [],
    family_history:       [],
    social_history:       {},
    current_medications:  [],
    allergies:            [],
    immunisation_flags:   [],
  };
}

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const SCHEMA_CHIEF_COMPLAINT = {
  type: 'object',
  properties: {
    patient_name:             { type: 'string', nullable: true },
    age:                      { type: 'string', nullable: true },
    village:                  { type: 'string', nullable: true },
    chief_complaint:          { type: 'string', nullable: true },
    additional_complaints:    { type: 'array', items: { type: 'string' } },
    duration:                 { type: 'string', nullable: true },
    severity_if_mentioned:    { type: 'string', nullable: true },
    spontaneous_history:      { type: 'array', items: { type: 'string' } },
    red_flags_mentioned:      { type: 'array', items: { type: 'string' } },
    language_of_consultation: { type: 'string' },
  },
  required: [
    'patient_name', 'age', 'village', 'chief_complaint',
    'additional_complaints', 'duration', 'severity_if_mentioned',
    'spontaneous_history', 'red_flags_mentioned', 'language_of_consultation',
  ],
};

// patient_record_fields: built deterministically after the call, not by LLM.
// known_and_verified: removed — not used downstream.
// discriminates: removed — no consumer.
const SCHEMA_QUESTIONNAIRE = {
  type: 'object',
  properties: {
    opening_context: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          section_title: { type: 'string' },
          rationale:     { type: 'string' },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                question:  { type: 'string' },
                follow_up: { type: 'string' },
              },
              required: ['question', 'follow_up'],
            },
          },
        },
        required: ['section_title', 'rationale', 'questions'],
      },
    },
    mandatory_safety_questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { question: { type: 'string' }, reason: { type: 'string' } },
        required: ['question', 'reason'],
      },
    },
  },
  required: [
    'opening_context', 'sections',
    'mandatory_safety_questions',
  ],
};

// ---------------------------------------------------------------------------
// Fixed first-visit background history section
// ---------------------------------------------------------------------------

const FIRST_VISIT_HISTORY_QUESTIONS = {
  section_title: 'Background History',
  rationale: 'Standard first-visit intake — collected once per patient, seeds the permanent record. Fixed question set for consistent coverage.',
  questions: [
    { question: 'Do you have any long-term illness — like diabetes, high blood pressure, TB, asthma, epilepsy, or heart disease?', follow_up: 'How long have you had it? Are you on treatment for it?' },
    { question: 'Have you ever been admitted to hospital or had an operation?', follow_up: 'When was this, and what was it for?' },
    { question: 'Do any illnesses run in your family — your parents or brothers and sisters — like diabetes, TB, high blood pressure, or cancer?', follow_up: 'Which family member, and which illness?' },
    { question: 'What work do you do?', follow_up: 'Any exposure to chemicals, dust, pesticides, or heavy lifting at work?' },
    { question: 'Do you use tobacco in any form — smoking, chewing, or gutka? Do you drink alcohol?', follow_up: 'How much, and for how long?' },
    { question: 'Are you taking any medicines at the moment — tablets, injections, syrups, or any traditional or herbal remedies?', follow_up: 'What is the name? What dose? How long have you been taking it?' },
    { question: 'Have you ever had a bad reaction or allergy to any medicine or food?', follow_up: 'What happened — rash, swelling, breathing difficulty?' },
  ],
};

// ---------------------------------------------------------------------------
// Call 1 — Extract chief complaint from ~30 second opening
// ---------------------------------------------------------------------------

export async function extractChiefComplaint(transcriptSegment, vaultContext) {
  const demographics = vaultContext.demographics || {};
  const prompt = [
    'Extract the chief complaint from this brief nurse-patient consultation ' +
    'opening. The recording is approximately 30 seconds — the nurse asked ' +
    'name, age, village, chief complaint, and duration. Extract only what is explicitly stated.',
    `PATIENT DEMOGRAPHICS (from registration if any):\n${JSON.stringify(demographics, null, 2)}`,
    `TRANSCRIPT (phase 1, ~30 seconds):\n${transcriptSegment}`,
    'INSTRUCTIONS:\n' +
    '- Extract only what is explicitly stated in the transcript\n' +
    '- patient_name, age, village: verbatim from the opening exchange\n' +
    '- duration: patient\'s own words — do not interpret or convert\n' +
    '- spontaneous_history: anything volunteered beyond the direct questions\n' +
    '- red_flags_mentioned: only what the patient explicitly stated\n' +
    '- This is ~30 seconds. Most fields will be null. Do not infer.',
  ].join('\n\n');

  const response = await generateWithCascade(
    MODEL_H1_CHIEF_COMPLAINT,
    prompt,
    { thinkingConfig: { thinkingBudget: 0 }, responseMimeType: 'application/json', responseSchema: SCHEMA_CHIEF_COMPLAINT, maxOutputTokens: 600 },
  );
  return parseJsonResponse(responseText(response));
}

// ---------------------------------------------------------------------------
// Call 2 — Generate questionnaire (single structured call)
// patient_record_fields is built deterministically after the call — not by LLM.
// ---------------------------------------------------------------------------

export async function generateQuestionnaire(chiefComplaint, vaultContext, patientRecord) {
  const demographics = vaultContext.demographics || {};
  const districtCode = (vaultContext.gps || {}).district_code || 'WB_UNKNOWN';
  const stateName = stateFromDistrictCode(districtCode);
  const lang = chiefComplaint.language_of_consultation || 'English';
  const languageInstruction = lang === 'English' ? '' :
    `LANGUAGE: The consultation is in ${lang}. After each question, add a romanised ${lang} translation in brackets — ` +
    `for example: 'Do you have fever? (jwor hochhe?)' for Bengali, 'Do you have fever? (bukhaar hai?)' for Hindi. ` +
    `Use plain everyday words in the translation — not medical terminology.`;

  const { knownContext, missingFields } = buildPatientRecordContext(patientRecord);
  const spontaneous = chiefComplaint.spontaneous_history || [];
  const spontaneousText = spontaneous.length
    ? 'VOLUNTEERED IN PHASE 1 (patient mentioned unprompted):\n' + spontaneous.map(s => `  - ${s}`).join('\n')
    : '';

  const historyFieldDescriptions = {
    past_medical_history: 'past_medical_history — chronic conditions, hospitalisations, surgeries (ask: DM, HTN, TB, asthma, epilepsy, heart disease)',
    family_history:        'family_history — DM, HTN, TB, cancer, heart disease in first-degree relatives',
    social_history:        'social_history — occupation, tobacco use, alcohol use',
    current_medications:   'current_medications — all drugs including OTC and traditional/herbal (name, dose, duration)',
    allergies:             'allergies — drug and food allergies, any adverse reactions to medicines',
    immunisation_history:  'immunisation_history — tetanus status; pregnancy vaccines if applicable',
  };

  const historyInstruction = missingFields.length
    ? 'HISTORY FIELDS TO COLLECT THIS VISIT:\nWork these into the interview naturally:\n' +
      missingFields.filter(f => historyFieldDescriptions[f]).map(f => `  ${historyFieldDescriptions[f]}`).join('\n')
    : 'HISTORY VERIFICATION:\nAll history fields are on record. Include a brief verification section — confirm what may have changed: conditions, medications, allergies.';

  const prompt = [
    `You are generating a structured interview questionnaire for a nurse in a remote rural clinic in ${stateName}, India. ` +
    `The nurse reads these questions directly to the patient.\n\nPATIENT RECORD STATUS:\n${knownContext}`,
    `PATIENT (from 30-second opening):\n${JSON.stringify(demographics, null, 2)}`,
    `CHIEF COMPLAINT:\n${JSON.stringify(chiefComplaint, null, 2)}`,
    spontaneousText,
    languageInstruction,
    'QUESTIONNAIRE STRUCTURE:\n\n' +
    'Section 1 — History of Presenting Complaint (8–12 questions, always required):\n' +
    'Use the appropriate framework for the chief complaint:\n' +
    '  Pain / acute symptoms    → SOCRATES (site, onset, character, radiation, associations,\n' +
    '                             timing, exacerbating/relieving factors, severity)\n' +
    '  Fever                    → onset, pattern, rigors, sweats, focal symptoms\n' +
    '  Respiratory              → onset, progression, sputum, haemoptysis, exertional component\n' +
    '  Gynaecological/obstetric → LMP, cycle regularity, obstetric history, discharge, pain\n' +
    '  Chronic/constitutional   → duration, progression, weight loss, appetite, night sweats\n' +
    '  Psychiatric/behavioural  → onset, triggers, sleep, function, safety\n' +
    'After the framework questions, add 2–3 questions that discriminate between the most likely differentials.\n' +
    'If additional_complaints is non-empty, extend Section 1 to cover each one — or open a separate HPI section if the second complaint is distinctly different (e.g. fever + pleuritic chest pain warrants two sections; fever + fatigue does not).\n\n' +
    'Section 2 — Associated Symptoms (3–4 questions, always required):\n' +
    'Key positives and negatives most discriminating for the differentials. Do not repeat Section 1 questions.\n\n' +
    'Section 3 — Functional Impact (2 questions, always required):\n' +
    'How is the illness affecting daily life — mobility, eating, drinking, work?\n' +
    'Trajectory since onset: better, worse, or the same?\n\n' +
    'Additional sections (2–3 questions each, include only if clinically indicated):\n' +
    '  Relevant systems review — urinary symptoms for fever, neuro for headache, etc.\n' +
    '  Obstetric/menstrual history — if gynaecological causes are in the differential.\n\n' +
    '- Plain language — questions are read directly to the patient\n' +
    '- follow_up: what to ask if the answer is yes or abnormal\n' +
    '- Do not generate questions about medications, allergies, PMH, or family/social history — covered separately\n' +
    '- Maximum 25 questions across all LLM-generated sections — only ask what is clinically relevant\n\n' +
    historyInstruction + '\n\n' +
    'MANDATORY SAFETY QUESTIONS (always include):\n' +
    '- Female patients aged 12–50: current pregnancy status and LMP\n' +
    '- All patients: confirm current medications and allergies',
  ].filter(Boolean).join('\n\n');

  const response = await generateWithCascade(
    MODEL_H2_QUESTIONNAIRE,
    prompt,
    {
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: 'application/json',
      responseSchema: SCHEMA_QUESTIONNAIRE,
      maxOutputTokens: 4000,
    },
  );

  const questionnaire = parseJsonResponse(responseText(response));

  // Inject patient_record_fields deterministically — not from LLM output.
  questionnaire.patient_record_fields = buildPatientRecordFields();

  // Append fixed background history section for first/partial visits.
  if (missingFields.length) {
    if (!questionnaire.sections) questionnaire.sections = [];
    questionnaire.sections.push(FIRST_VISIT_HISTORY_QUESTIONS);
  }

  return questionnaire;
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

export function validateQuestionnaire(q) {
  const defaults = {
    visit_type: 'first_visit',
    opening_context: 'Conduct the structured interview below.',
    sections: [],
    mandatory_safety_questions: [],

    patient_record_fields: {
      past_medical_history: [], family_history: [], social_history: {},
      current_medications: [], allergies: [], immunisation_flags: [],
    },
  };

  for (const [field, def] of Object.entries(defaults)) {
    if (!(field in q)) {
      console.log(`[QUESTIONNAIRE WARNING] Missing field '${field}' — using default`);
      q[field] = def;
    }
  }

  for (let i = 0; i < (q.sections || []).length; i++) {
    const s = q.sections[i];
    if (!s.section_title) s.section_title = `Section ${i + 1}`;
    if (!s.questions) s.questions = [];
    if (!s.rationale) s.rationale = '';
    for (const qn of s.questions) {
      if (!qn.question) qn.question = '[Question text missing]';
      if (!qn.follow_up) qn.follow_up = '';
    }
  }

  const prf = q.patient_record_fields || {};
  q.patient_record_fields = prf;
  if (!prf.past_medical_history) prf.past_medical_history = [];
  if (!prf.family_history) prf.family_history = [];
  if (!prf.social_history) prf.social_history = {};
  if (!prf.current_medications) prf.current_medications = [];
  if (!prf.allergies) prf.allergies = [];
  if (!prf.immunisation_flags) prf.immunisation_flags = [];

  return q;
}

// ---------------------------------------------------------------------------
// Patient record extraction
// ---------------------------------------------------------------------------

export function extractPatientRecordUpdate(questionnaire, chiefComplaint, sessionId) {
  const prf = questionnaire.patient_record_fields || {};
  return {
    session_id: sessionId,
    chief_complaint_summary: chiefComplaint.chief_complaint || '',
    history_fields_to_collect: Object.keys(prf),
    status: 'pending — awaiting phase 2 transcript extraction',
  };
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runHistoryStage(sessionId, transcriptSegment, dbClient) {
  const vaultContext = await vaultRead(dbClient, sessionId);
  const patientRecord = vaultContext.patient_record || {};

  // Call 1
  console.log(`[${sessionId}] History stage Call 1: extracting chief complaint`);
  const chiefComplaint = await extractChiefComplaint(transcriptSegment, vaultContext);
  await vaultUpdate(dbClient, sessionId, { chief_complaint: chiefComplaint });

  // Nudge path
  if (isComplaintMissing(chiefComplaint)) {
    console.log(`[${sessionId}] History stage: chief complaint missing — nudge sent, Call 2 skipped`);
    await vaultUpdate(dbClient, sessionId, {
      history_stage_status: 'nudge_required',
      nudge_reason: 'chief_complaint_missing',
    });
    return {
      session_id: sessionId,
      nudge: true,
      nudge_message: 'Chief complaint was not captured clearly. Please ask the patient to describe their problem again and press Marker A once more.',
    };
  }

  // Call 2
  console.log(`[${sessionId}] History stage Call 2: generating questionnaire`);
  let questionnaire = await generateQuestionnaire(chiefComplaint, vaultContext, patientRecord);
  questionnaire = validateQuestionnaire(questionnaire);

  const patientRecordStub = extractPatientRecordUpdate(questionnaire, chiefComplaint, sessionId);

  await vaultUpdate(dbClient, sessionId, {
    chief_complaint: chiefComplaint,
    questionnaire,
    patient_record_stub: patientRecordStub,
    history_stage_status: 'complete',
    history_stage_completed_at: new Date().toISOString(),
  });

  const missing = ['past_medical_history', 'family_history', 'social_history', 'current_medications', 'allergies']
    .filter(f => !patientRecord[f]);
  console.log(`[${sessionId}] History stage complete — missing fields to collect: ${missing.length ? missing.join(', ') : 'none — verification only'}`);

  return { session_id: sessionId, chief_complaint: chiefComplaint, questionnaire, patient_record_stub: patientRecordStub };
}
