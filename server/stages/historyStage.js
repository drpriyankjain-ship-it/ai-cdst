/**
 * CDST History Stage  [fixed pipeline]
 * ======================================
 * Two-call pipeline — no RAG:
 *
 *   Call 1: ~30s transcript → chief complaint extraction            (~700ms)
 *   Call 2: concepts + epi prior + visit type → questionnaire       (~1.3s, streaming)
 *
 * Direct port of history_stage.py
 */

import { vaultRead, vaultUpdate } from '../lib/db.js';
import { generateWithCascade, streamWithCascade, parseJsonResponse, responseText, buildMultimodalContent } from '../lib/llmClient.js';
import { MODEL_H1_CHIEF_COMPLAINT, MODEL_H2_QUESTIONNAIRE } from '../lib/modelConfig.js';
import { stateFromDistrictCode, loadBaselineDiseases, loadEpiPrior } from '../lib/epiUtils.js';

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

const SCHEMA_QUESTIONNAIRE = {
  type: 'object',
  properties: {
    opening_context:    { type: 'string' },
    known_and_verified: { type: 'array', items: { type: 'string' } },
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
                question:      { type: 'string' },
                follow_up:     { type: 'string' },
                discriminates: { type: 'string' },
              },
              required: ['question', 'follow_up', 'discriminates'],
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
    prior_encounter_flags: { type: 'array', items: { type: 'string' } },
    patient_record_fields: {
      type: 'object',
      properties: {
        past_medical_history: { type: 'array', items: { type: 'string' } },
        family_history:       { type: 'array', items: { type: 'string' } },
        social_history: {
          type: 'object',
          properties: {
            occupation:       { type: 'string' },
            living_situation: { type: 'string' },
            tobacco:          { type: 'string' },
            alcohol:          { type: 'string' },
          },
        },
        current_medications: { type: 'array', items: { type: 'string' } },
        allergies:           { type: 'array', items: { type: 'string' } },
        immunisation_flags:  { type: 'array', items: { type: 'string' } },
      },
      required: [
        'past_medical_history', 'family_history', 'social_history',
        'current_medications', 'allergies', 'immunisation_flags',
      ],
    },
  },
  required: [
    'opening_context', 'known_and_verified', 'sections',
    'mandatory_safety_questions', 'prior_encounter_flags', 'patient_record_fields',
  ],
};

// ---------------------------------------------------------------------------
// Fixed first-visit background history section
// ---------------------------------------------------------------------------

const FIRST_VISIT_HISTORY_QUESTIONS = {
  section_title: 'Background History',
  rationale: 'Standard first-visit intake — collected once per patient, seeds the permanent record. Fixed question set for consistent coverage.',
  questions: [
    { question: 'Do you have any long-term illness — like diabetes, high blood pressure, TB, asthma, epilepsy, or heart disease?', follow_up: 'How long have you had it? Are you on treatment for it?', discriminates: 'Past medical history — chronic conditions' },
    { question: 'Have you ever been admitted to hospital or had an operation?', follow_up: 'When was this, and what was it for?', discriminates: 'Past medical history — hospitalisations and surgery' },
    { question: 'Do any illnesses run in your family — your parents or brothers and sisters — like diabetes, TB, high blood pressure, or cancer?', follow_up: 'Which family member, and which illness?', discriminates: 'Family history' },
    { question: 'What work do you do?', follow_up: 'Any exposure to chemicals, dust, pesticides, or heavy lifting at work?', discriminates: 'Social history — occupation and occupational exposures' },
    { question: 'Do you use tobacco in any form — smoking, chewing, or gutka? Do you drink alcohol?', follow_up: 'How much, and for how long?', discriminates: 'Social history — tobacco and alcohol use' },
    { question: 'Are you taking any medicines at the moment — tablets, injections, syrups, or any traditional or herbal remedies?', follow_up: 'What is the name? What dose? How long have you been taking it?', discriminates: 'Current medications — including OTC and traditional' },
    { question: 'Have you ever had a bad reaction or allergy to any medicine or food?', follow_up: 'What happened — rash, swelling, breathing difficulty?', discriminates: 'Allergies and adverse drug reactions' },
  ],
};

// ---------------------------------------------------------------------------
// Call 1 — Extract chief complaint from ~30 second opening
// ---------------------------------------------------------------------------

export async function extractChiefComplaint(transcriptSegment, vaultContext, photos = []) {
  const demographics = vaultContext.demographics || {};
  const prompt = [
    'Extract the chief complaint from this brief nurse-patient consultation ' +
    'opening. The recording is approximately 30 seconds — the nurse asked ' +
    'name, age, village, chief complaint, and duration. Extract only what is explicitly stated.',
    `PATIENT DEMOGRAPHICS (from registration if any):\n${JSON.stringify(demographics, null, 2)}`,
    `TRANSCRIPT (phase 1, ~30 seconds):\n${transcriptSegment}`,
    photos.length > 0 ? 'The nurse has also attached clinical photos. Note any visible findings (rash, swelling, wound, etc.) in spontaneous_history and red_flags_mentioned if relevant.' : '',
    'INSTRUCTIONS:\n' +
    '- Extract only what is explicitly stated in the transcript\n' +
    '- patient_name, age, village: verbatim from the opening exchange\n' +
    '- duration: patient\'s own words — do not interpret or convert\n' +
    '- spontaneous_history: anything volunteered beyond the direct questions\n' +
    '- red_flags_mentioned: only what the patient explicitly stated\n' +
    '- This is ~30 seconds. Most fields will be null. Do not infer.',
  ].filter(Boolean).join('\n\n');

  const contents = buildMultimodalContent(prompt, photos);
  const { response, meta } = await generateWithCascade(
    MODEL_H1_CHIEF_COMPLAINT,
    contents,
    { thinkingConfig: { thinkingBudget: 0 }, responseMimeType: 'application/json', responseSchema: SCHEMA_CHIEF_COMPLAINT, maxOutputTokens: 600 },
  );
  const result = parseJsonResponse(responseText(response));
  return { result, meta };
}

// ---------------------------------------------------------------------------
// Call 2 — Generate questionnaire
// ---------------------------------------------------------------------------

export async function generateQuestionnaire(chiefComplaint, vaultContext, baselineLayer, epiLayer, patientRecord, photos = []) {
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

  const fieldLabels = {
    past_medical_history: '  past_medical_history: all chronic conditions, prior hospitalisations,\n    major illnesses, surgeries — ask specifically about diabetes, TB,\n    hypertension, heart disease, asthma, epilepsy',
    family_history: '  family_history: diabetes, hypertension, TB, cancer, heart disease\n    in first-degree relatives (parents, siblings, children)',
    social_history: '  social_history: occupation, living situation (joint/nuclear family),\n    tobacco use, alcohol use',
    current_medications: '  current_medications: ALL drugs — prescription, over-the-counter,\n    and traditional/herbal remedies — name, dose, and reason if known',
    allergies: '  allergies: drug allergies, food allergies, any known reactions\n    to medicines or other substances',
    immunisation_history: '  immunisation_history: tetanus status (especially if trauma),\n    pregnancy vaccines if applicable',
  };

  const historyInstruction = missingFields.length
    ? 'HISTORY FIELDS TO COLLECT THIS VISIT:\nThe following fields are missing from this patient\'s record.\nInclude questions to collect them — work them naturally into the interview.\n' +
      missingFields.filter(f => fieldLabels[f]).map(f => fieldLabels[f]).join('\n')
    : 'HISTORY VERIFICATION:\nAll history fields are recorded. Include a brief verification section:\n  \'Have any of your health conditions changed since your last visit?\'\n  \'Are you still taking the same medications?\'\n  \'Any new allergies or reactions to medicines?\'';

  const prompt = [
    `You are generating a structured interview questionnaire for a nurse in a remote rural clinic in ${stateName}, India. ` +
    `The nurse reads these questions directly to the patient during a structured interview.\n\nPATIENT RECORD STATUS:\n${knownContext}`,
    `PATIENT (from 30-second opening):\n${JSON.stringify(demographics, null, 2)}`,
    `CHIEF COMPLAINT:\n${JSON.stringify(chiefComplaint, null, 2)}`,
    spontaneousText,
    languageInstruction,
    baselineLayer,
    epiLayer,
    photos.length > 0 ? 'CLINICAL PHOTOS: The nurse has attached clinical photos. Include questions about any visible findings (e.g., describe the rash, when did the swelling start, etc.).' : '',
    'CLINICAL FRAMEWORK FOR CHIEF COMPLAINT SECTION:\n' +
    'Choose the framework that fits the presentation — do not force SOCRATES where it does not apply.\n' +
    '  Pain / acute symptoms   → SOCRATES\n  Gynaecological/obstetric → Menstrual/obstetric history\n' +
    '  Infertility              → Duration of trying, cycle regularity, prior pregnancies\n' +
    '  Chronic/constitutional  → Duration, progression, systemic features\n  Psychiatric/behavioural → Onset, triggers, sleep, function, safety\n\n' +
    'QUESTIONNAIRE DESIGN:\n- 4-8 sections depending on complexity\n- Each section: 3-5 questions\n' +
    '- Chief complaint section is ALWAYS first\n- Questions within each section: most to least discriminating\n' +
    '- Plain language — questions are read directly to the patient\n- follow_up: what to ask if the answer is yes or abnormal\n' +
    '- discriminates: brief nurse-only note — not read to patient\n\n' +
    historyInstruction + '\n\n' +
    'MANDATORY SAFETY QUESTIONS (always):\n- Female patients aged 12-50: current pregnancy status and LMP\n' +
    '- All patients: confirm current medications\n- All patients: confirm allergies\n- Any red flags from phase 1: follow up\n\n' +
    'known_and_verified: list confirmations for fields already in the record\npatient_record_fields: populate with questions to ASK — answers will come from the phase 2 transcript.',
  ].filter(Boolean).join('\n\n');

  const contents = buildMultimodalContent(prompt, photos);
  const { response, meta } = await generateWithCascade(
    MODEL_H2_QUESTIONNAIRE,
    contents,
    {
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: 'application/json',
      responseSchema: SCHEMA_QUESTIONNAIRE,
      maxOutputTokens: 8000,
    },
  );

  const questionnaire = parseJsonResponse(responseText(response));

  // Inject fixed background history section for first/partial visits
  if (missingFields.length) {
    if (!questionnaire.sections) questionnaire.sections = [];
    questionnaire.sections.push(FIRST_VISIT_HISTORY_QUESTIONS);
  }
  return { result: questionnaire, meta };
}

// ---------------------------------------------------------------------------
// Call 2 — Streaming variant
// ---------------------------------------------------------------------------

export async function* streamQuestionnaire(chiefComplaint, vaultContext, baselineLayer, epiLayer, patientRecord) {
  const demographics = vaultContext.demographics || {};
  const districtCode = (vaultContext.gps || {}).district_code || 'WB_UNKNOWN';
  const stateName = stateFromDistrictCode(districtCode);
  const lang = chiefComplaint.language_of_consultation || 'English';
  const languageInstruction = lang === 'English' ? '' :
    `LANGUAGE: The consultation is in ${lang}. After each question, add a romanised ${lang} translation in brackets.`;
  const { knownContext, missingFields } = buildPatientRecordContext(patientRecord);

  const prompt = [
    `Generate a structured interview questionnaire for a nurse in rural ${stateName}. ` +
    `Write it as clearly numbered sections with questions the nurse reads directly to the patient. Be concise — start immediately.\n\nPATIENT RECORD STATUS:\n${knownContext}`,
    `Patient: ${JSON.stringify(demographics)}`,
    `Chief complaint (primary): ${JSON.stringify(chiefComplaint.chief_complaint)}`,
    chiefComplaint.additional_complaints?.length ? `Additional complaints: ${JSON.stringify(chiefComplaint.additional_complaints)}` : '',
    languageInstruction,
    baselineLayer,
    epiLayer,
    'Clinical framework — choose by presentation type:\n  Pain/acute → SOCRATES\n  Gynaecological/obstetric → menstrual/obstetric history\n  Chronic/constitutional → duration, progression, systemic features',
    `Format: numbered sections with bullet questions. 4-8 sections, 3-5 questions each. Plain language. Primary complaint first. ` +
    (missingFields.length ? `Collect missing history fields: ${missingFields.join(', ')}.` : 'Verify existing history — confirm what has changed.'),
  ].filter(Boolean).join('\n\n');

  for await (const chunk of streamWithCascade(
    MODEL_H2_QUESTIONNAIRE,
    prompt,
    { maxOutputTokens: 1500 },
  )) {
    if (chunk.text) yield chunk.text;
  }

  // Append fixed background history section for first/partial visits
  if (missingFields.length) {
    const section = FIRST_VISIT_HISTORY_QUESTIONS;
    yield `\n\n${section.section_title.toUpperCase()}\n`;
    for (let i = 0; i < section.questions.length; i++) {
      const q = section.questions[i];
      yield `\n${i + 1}. ${q.question}\n`;
      if (q.follow_up) yield `   → If yes / abnormal: ${q.follow_up}\n`;
    }
  }
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
    prior_encounter_flags: [],
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
      if (!qn.discriminates) qn.discriminates = '';
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
  const gps = vaultContext.gps || {};
  const districtCode = gps.district_code || 'WB_UNKNOWN';
  const currentMonth = new Date().getMonth() + 1;
  const patientRecord = vaultContext.patient_record || {};
  const baselineLayer = loadBaselineDiseases();
  const epiLayer = loadEpiPrior(districtCode, currentMonth);

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
  let questionnaire = await generateQuestionnaire(chiefComplaint, vaultContext, baselineLayer, epiLayer, patientRecord);
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
