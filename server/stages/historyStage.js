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
import { generateWithCascade, parseJsonResponse, responseText, buildAudioContent, buildMultimodalContent } from '../lib/llmClient.js';
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
  const empty = new Set([
    'unknown', 'unclear', 'not stated', 'not mentioned', 'n/a', 'none',
    'insufficient_information', 'insufficient information',
    'no medical complaint', 'no complaint', 'not a medical consultation',
  ]);
  return empty.has(value);
}

// ---------------------------------------------------------------------------
// Patient record fields builder
// ---------------------------------------------------------------------------

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
    transcript:               { type: 'string' },
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
    'transcript', 'patient_name', 'age', 'village', 'chief_complaint',
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

export async function extractChiefComplaint(audioBuffers, vaultContext, photos = []) {
  const demographics = vaultContext.demographics || {};
  const prompt = [
    'Listen to this audio recording of a nurse-patient consultation opening (~30 seconds). ' +
    'The nurse asked name, age, village, chief complaint, and duration. ' +
    'Extract only what is explicitly stated.',
    `PATIENT DEMOGRAPHICS (from registration if any):\n${JSON.stringify(demographics, null, 2)}`,
    photos.length > 0 ? 'The nurse has also attached clinical photos. Note any visible findings (rash, swelling, wound, etc.) in spontaneous_history and red_flags_mentioned if relevant.' : '',
    'INSTRUCTIONS:\n' +
    '- transcript: verbatim transcription of everything spoken in the audio\n' +
    '- Extract only what is explicitly stated in the audio\n' +
    '- patient_name, age, village: verbatim from the opening exchange\n' +
    '- duration: patient\'s own words — do not interpret or convert\n' +
    '- spontaneous_history: anything volunteered beyond the direct questions\n' +
    '- red_flags_mentioned: only what the patient explicitly stated\n' +
    '- This is ~30 seconds. Most fields will be null. Do not infer.\n' +
    '\n' +
    'CRITICAL — INSUFFICIENT INFORMATION RULE:\n' +
    '- If the transcript does NOT contain any medical complaint, health symptom, or clinical information — ' +
    'set chief_complaint to "INSUFFICIENT_INFORMATION" and leave all other fields null/empty.\n' +
    '- Examples of non-medical content: casual conversation, greetings only, background noise, ' +
    'unrelated topics (weather, food, politics), silence, or unintelligible audio.\n' +
    '- Do NOT invent or guess a medical complaint. If no health problem is discussed, say so.',
  ].filter(Boolean).join('\n\n');

  const contents = buildAudioContent(prompt, audioBuffers, 'audio/mp4', photos);
  const { response, meta } = await generateWithCascade(
    MODEL_H1_CHIEF_COMPLAINT,
    contents,
    { thinkingConfig: { thinkingBudget: 0 }, responseMimeType: 'application/json', responseSchema: SCHEMA_CHIEF_COMPLAINT, maxOutputTokens: 800 },
  );
  const result = parseJsonResponse(responseText(response));
  return { result, meta };
}

// ---------------------------------------------------------------------------
// Call 2 — Generate questionnaire
// ---------------------------------------------------------------------------

export async function generateQuestionnaire(chiefComplaint, vaultContext, patientRecord, photos = []) {
  const demographics = vaultContext.demographics || {};
  const districtCode = (vaultContext.gps || {}).district_code || 'WB_UNKNOWN';
  const stateName = stateFromDistrictCode(districtCode);
  const lang = chiefComplaint.language_of_consultation || 'English';
  const languageInstruction = lang === 'English' ? '' :
    `LANGUAGE: The consultation is in ${lang}. Write questions in English only. ` +
    `After each key clinical term or symptom word, add the romanised ${lang} word in brackets — ` +
    `for example: 'Do you have fever (bukhaar)?' or 'Any swelling (sujan) in your legs?' ` +
    `Only romanize the specific symptom/body-part words, not the entire question.`;

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
    photos.length > 0 ? 'CLINICAL PHOTOS: The nurse has attached clinical photos. Include questions about any visible findings (e.g., describe the rash, when did the swelling start, etc.).' : '',
    'QUESTIONNAIRE STRUCTURE:\n\n' +
    'Section 1 — History of Presenting Complaint (8–12 questions, always required):\n' +
    'Use the appropriate framework for the chief complaint:\n' +
    '  Pain / acute symptoms    → SOCRATES (site, onset, character, radiation, associations,\n' +
    '                             timing, exacerbating/relieving factors, severity)\n' +
    '  Skin / dermatological    → site, onset, spread, itch/pain, discharge, triggers\n' +
    '  GI / abdominal           → site, onset, character, radiation, bowel habit, vomiting,\n' +
    '                             blood in stool/vomit, diet relationship\n' +
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
    '- Maximum 25 questions across all LLM-generated sections — only ask what is clinically relevant\n' +
    '- Do not include any explanation or rationale per question — question and follow_up only\n\n' +
    historyInstruction + '\n\n' +
    'MANDATORY SAFETY QUESTIONS (always include):\n' +
    '- Female patients aged 12–50: current pregnancy status and LMP\n' +
    '- All patients: confirm current medications and allergies',
  ].filter(Boolean).join('\n\n');

  const contents = buildMultimodalContent(prompt, photos);
  const { response, meta } = await generateWithCascade(
    MODEL_H2_QUESTIONNAIRE,
    contents,
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

  // Inject fixed background history section for first/partial visits
  if (missingFields.length) {
    if (!questionnaire.sections) questionnaire.sections = [];
    questionnaire.sections.push(FIRST_VISIT_HISTORY_QUESTIONS);
  }
  return { result: questionnaire, meta };
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

export async function runHistoryStage(sessionId, audioBuffers, dbClient) {
  const vaultContext = await vaultRead(dbClient, sessionId);
  const patientRecord = vaultContext.patient_record || {};

  // Call 1
  console.log(`[${sessionId}] History stage Call 1: extracting chief complaint`);
  const chiefComplaint = await extractChiefComplaint(audioBuffers, vaultContext);
  await vaultUpdate(dbClient, sessionId, { chief_complaint: chiefComplaint });

  // Nudge path
  if (isComplaintMissing(chiefComplaint)) {
    console.log(`[${sessionId}] History stage: chief complaint missing/insufficient — nudge sent, Call 2 skipped`);
    await vaultUpdate(dbClient, sessionId, {
      history_stage_status: 'nudge_required',
      nudge_reason: 'chief_complaint_missing',
    });
    return {
      session_id: sessionId,
      nudge: true,
      nudge_message: 'The recording did not contain enough medical information to proceed. Please ask the patient to clearly describe their health problem, symptoms, and how long they have had them, then try again.',
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
