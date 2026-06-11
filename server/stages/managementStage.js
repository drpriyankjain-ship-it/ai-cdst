/**
 * CDST Management Stage — Pipeline (Calls 1-4 + RAG + streaming)
 * ================================================================
 * Direct port of management_stage.py
 */

import { vaultRead, vaultUpdate, insertLlmResult } from '../lib/db.js';
import { generateWithCascade, parseJsonResponse, responseText, buildAudioContent } from '../lib/llmClient.js';
import { MODEL_M1_FINDINGS, MODEL_M2_PRESCRIPTION, MODEL_M3_RISK, MODEL_M4_TRIAGE } from '../lib/modelConfig.js';
import { stateFromDistrictCode } from '../lib/epiUtils.js';
import {
  SCHEMA_CLARIFYING_FINDINGS, SCHEMA_PROBLEM_LIST, SCHEMA_RISK_ASSESSMENT, SCHEMA_TRIAGE_HANDOFF,
  RAG_TOP_K, RAG_SIMILARITY_THRESHOLD, RAG_DISEASE_FALLBACK_THRESHOLD,
  RAG_SECTION_FILTER, RAG_IVFFLAT_PROBES,
  loadFormulary, resolveCanonicalDisease, validateProblemList, buildPrescriptionIssued, runRuleEngine,
} from './managementHelpers.js';

// Embedder — lazy loaded
let _embedder = null;
async function getEmbedder() {
  if (!_embedder) {
    const { pipeline } = await import('@huggingface/transformers');
    _embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return _embedder;
}

// ---------------------------------------------------------------------------
// RAG — STG treatment protocol retrieval
// ---------------------------------------------------------------------------

export async function retrieveTreatmentProtocols(dbClient, diagnoses, topK = RAG_TOP_K) {
  const uniqueDiagnoses = [...new Set(
    diagnoses.map(d => String(d || '').trim()).filter(Boolean)
  )];
  const sections = [];
  const retrievedChunks = [];

  try {
    await dbClient.query(`SET ivfflat.probes = ${RAG_IVFFLAT_PROBES}`);
  } catch (err) {
    console.warn(`[RAG] Unable to set ivfflat.probes: ${err.message}`);
  }

  for (const diagnosis of uniqueDiagnoses) {
    const query = `treatment protocol dose duration route contraindications referral criteria ${diagnosis} NHM India STG`;
    const canonicalDisease = resolveCanonicalDisease(diagnosis);
    let queryEmbedding;
    try {
      const embedder = await getEmbedder();
      const output = await embedder(query, { pooling: 'mean', normalize: true });
      queryEmbedding = Array.from(output.data);
    } catch (err) {
      console.warn(`[RAG] Embedding failed for '${diagnosis}': ${err.message}`);
      continue;
    }

    const vector = JSON.stringify(queryEmbedding);
    const queryArgs = [vector, topK, RAG_SECTION_FILTER, RAG_SIMILARITY_THRESHOLD, canonicalDisease];
    let res = await dbClient.query(
      `SELECT content, source, disease, section, chunk_id,
              1 - (embedding <=> $1::vector) AS similarity
       FROM stg_chunks
       WHERE embedding IS NOT NULL
         AND section = ANY($3::text[])
         AND 1 - (embedding <=> $1::vector) >= $4
         AND (
           $5::text IS NULL
           OR lower(coalesce(disease, '')) = lower($5)
           OR disease IS NULL
         )
       ORDER BY CASE
           WHEN lower(coalesce(disease, '')) = lower($5) THEN 0
           WHEN disease IS NULL THEN 1
           ELSE 2
         END,
         embedding <=> $1::vector
       LIMIT $2`,
      queryArgs
    );

    const hasSameDisease = canonicalDisease && res.rows.some(r => (r.disease || '').toLowerCase() === canonicalDisease);
    if (canonicalDisease && !hasSameDisease) {
      const fallback = await dbClient.query(
        `SELECT content, source, disease, section, chunk_id,
                1 - (embedding <=> $1::vector) AS similarity
         FROM stg_chunks
         WHERE embedding IS NOT NULL
           AND section = ANY($3::text[])
           AND lower(coalesce(disease, '')) = lower($5)
           AND 1 - (embedding <=> $1::vector) >= $4
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        [vector, topK, RAG_SECTION_FILTER, RAG_DISEASE_FALLBACK_THRESHOLD, canonicalDisease]
      );
      if (fallback.rows.length) res = fallback;
    }

    if (res.rows.length) {
      retrievedChunks.push(...res.rows.map(r => ({
        query_diagnosis: diagnosis,
        source: r.source,
        chunk_id: r.chunk_id,
        disease: r.disease,
        resolved_disease: canonicalDisease,
        section: r.section,
        similarity: Number(r.similarity),
      })));
      const chunks = res.rows.map(r => `[${r.source} / chunk ${r.chunk_id} / ${r.section || 'general'} | similarity ${parseFloat(r.similarity).toFixed(2)}]\n${r.content}`).join('\n\n');
      sections.push(`=== ${diagnosis} ===\n${chunks}`);
    }
  }
  if (!sections.length) console.log('[RAG WARNING] No STG chunks retrieved.');
  return {
    context: sections.join('\n\n'),
    chunks: retrievedChunks,
    diagnoses_queried: uniqueDiagnoses,
    similarity_threshold: RAG_SIMILARITY_THRESHOLD,
    disease_fallback_threshold: RAG_DISEASE_FALLBACK_THRESHOLD,
    section_filter: RAG_SECTION_FILTER,
  };
}

// ---------------------------------------------------------------------------
// Call 1 — Extract clarifying findings
// ---------------------------------------------------------------------------

export async function extractClarifyingFindings(audioBuffers, vaultContext) {
  const prompt = [
    'Listen to this audio recording of the phase 3 clarifying questions exchange (~1-2 minutes). ' +
    'Extract structured clinical findings from what is said.',
    `PHASE 2 EXTRACTED CONCEPTS:\n${JSON.stringify(vaultContext.extracted_concepts || {}, null, 2)}`,
    `CLARIFYING QUESTIONS THAT WERE ASKED:\n${JSON.stringify(vaultContext.clarifying_questions || {}, null, 2)}`,
    'INSTRUCTIONS:\n' +
    '- transcript: verbatim transcription of everything spoken in the audio\n' +
    '- Match answers to the specific clarifying questions where possible\n' +
    '- Record all bedside examination findings\n' +
    '- Only extract what is explicitly stated in the audio\n' +
    '- vitals_found: return NUMERIC JSON numbers only. Null for any vital not measured.',
  ].join('\n\n');

  const contents = buildAudioContent(prompt, audioBuffers, 'audio/mp4');
  const { response, meta } = await generateWithCascade(MODEL_M1_FINDINGS, contents, {
    systemInstruction: 'You are a clinical data extraction tool. Extract only what is explicitly stated.',
    responseMimeType: 'application/json', responseSchema: SCHEMA_CLARIFYING_FINDINGS, maxOutputTokens: 2500,
  });
  return { result: parseJsonResponse(responseText(response)), meta };
}

// ---------------------------------------------------------------------------
// Call 2 — Provisional diagnosis + prescription
// ---------------------------------------------------------------------------

export async function generateProvisionalDiagnosisAndRx(clarifyingFindings, vaultContext, stgContext, formulary) {
  const demographics = vaultContext.demographics || {};
  const ddx = vaultContext.differential_table || [];
  const concepts = vaultContext.extracted_concepts || {};
  const priorEncounters = (vaultContext.patient_record || {}).encounters || [];
  const additionalComplaints = (vaultContext.chief_complaint || {}).additional_complaints || [];

  const stgSection = stgContext
    ? `RETRIEVED STG TREATMENT PROTOCOLS:\n${stgContext}`
    : 'WARNING: No STG chunks retrieved. Prescription based on LLM knowledge only.';

  const ragHierarchy = 'RETRIEVED CONTENT RULES:\n' +
    '  1. LOCAL FORMULARY — binding constraint; prescribe ONLY drugs listed there\n' +
    '  2. Retrieved STG chunks — follow for dose, route, duration\n' +
    '  3. Standard clinical knowledge — fill gaps not covered by chunks\n' +
    'If a chunk conflicts with the formulary, use the formulary-available alternative.';

  const prompt = [
    `PATIENT:\n${JSON.stringify(demographics, null, 2)}`,
    `PRIOR ENCOUNTERS (last 3):\n${priorEncounters.length ? JSON.stringify(priorEncounters.slice(-3), null, 2) : 'No prior encounters.'}`,
    `WORKING DIFFERENTIAL:\n${JSON.stringify(ddx, null, 2)}`,
    `PHASE 2 CLINICAL CONCEPTS:\n${JSON.stringify(concepts, null, 2)}`,
    `ADDITIONAL COMPLAINTS: ${additionalComplaints.length ? JSON.stringify(additionalComplaints) : 'None reported.'}`,
    `PHASE 3 CLARIFYING FINDINGS:\n${JSON.stringify(clarifyingFindings, null, 2)}`,
    stgSection, ragHierarchy,
    `LOCAL FORMULARY (available drugs only):\n${JSON.stringify(formulary, null, 2)}`,
    'INSTRUCTIONS:\n- Build a problem list of ALL distinct clinical issues (max 4)\n' +
    '- Problem #1 is always the acute presenting complaint\n' +
    '- Classify each: acute_new | established | incidental | deferred\n' +
    '- for_problem is mandatory on every prescription item\n' +
    '- Prescribe ONLY drugs present in the local formulary\n' +
    '- Do NOT prescribe any drug the patient is allergic to\n' +
    '- stg_source must use the exact SOURCE / chunk N citation from the retrieved text, or null\n' +
    '- If no retrieved STG chunk supports a drug dose, prefer supportive care plus doctor review/referral over inventing a protocol-specific dose\n' +
    '- If weight-based dosing needed, use vitals_found weight > demographics weight',
  ].join('\n\n');

  const { response, meta } = await generateWithCascade(MODEL_M2_PRESCRIPTION, prompt, {
    systemInstruction: 'You are a clinical decision support system generating provisional diagnoses and prescriptions for nurse-managed consultations in rural India. Patient safety takes precedence.',
    responseMimeType: 'application/json', responseSchema: SCHEMA_PROBLEM_LIST, maxOutputTokens: 10000,
  });
  return { result: validateProblemList(parseJsonResponse(responseText(response))), meta };
}

// ---------------------------------------------------------------------------
// Call 3 — Risk assessment
// ---------------------------------------------------------------------------

export async function generateRiskAssessment(problemListOutput, clarifyingFindings, vaultContext) {
  const demographics = vaultContext.demographics || {};
  const ddx = vaultContext.differential_table || [];
  const concepts = vaultContext.extracted_concepts || {};
  const knownAllergies = [...new Set([...(demographics.known_allergies || []), ...(concepts.allergies_reported || [])].map(a => a.toLowerCase()))];
  const currentMeds = [...new Set([...(demographics.current_medications || []), ...(concepts.current_medications || [])])];
  const acuteProblems = (problemListOutput.problem_list || []).filter(p => p.type === 'acute_new');
  const allDrugs = (problemListOutput.problem_list || []).flatMap(p => p.plan?.prescription || []);

  const prompt = [
    'Perform a five-dimension risk assessment for this clinical management plan.',
    `PATIENT:\n${JSON.stringify(demographics, null, 2)}`,
    `KNOWN ALLERGIES: ${JSON.stringify(knownAllergies)}`,
    `CURRENT MEDICATIONS: ${JSON.stringify(currentMeds)}`,
    `FULL DIFFERENTIAL TABLE:\n${JSON.stringify(ddx, null, 2)}`,
    `PROBLEM LIST:\n${JSON.stringify(problemListOutput, null, 2)}`,
    `ACUTE PROBLEM(S):\n${JSON.stringify(acuteProblems, null, 2)}`,
    `ALL PRESCRIBED DRUGS:\n${JSON.stringify(allDrugs, null, 2)}`,
    `CLARIFYING FINDINGS:\n${JSON.stringify(clarifyingFindings, null, 2)}`,
    'INSTRUCTIONS:\nAssess all five dimensions:\n' +
    '1. DIAGNOSTIC UNCERTAINTY — which must-not-miss diagnoses remain possible?\n' +
    '2. IATROGENIC RISK — assess ALL drugs, check allergy/interaction conflicts\n' +
    '3. DELAY RISK — consequence of waiting up to 24 hours for async doctor review\n' +
    '4. COMPLICATION WATCH — warning signs with specific nurse actions\n' +
    '5. MITIGATION PLAN — set overall_risk_tier HIGH only if: (a) the patient requires hospital-level care now, or (b) a 24-hour delay in doctor review carries genuine risk of serious harm or death. Set LOW if the nurse can safely administer the prescribed oral treatment and monitor the patient while the doctor reviews within 24 hours. Stable presentations manageable with oral medication and nursing care should be LOW.',
  ].join('\n\n');

  const { response, meta } = await generateWithCascade(MODEL_M3_RISK, prompt, {
    systemInstruction: 'You are a clinical decision support system performing risk assessment for nurse-managed consultations in rural India. LOW means the nurse can safely proceed with the prescribed plan and the doctor reviews asynchronously within 24 hours — no doctor response within 24 hours ratifies the plan. HIGH means the case cannot wait: the patient needs hospital-level care now, or a 24-hour delay in doctor involvement carries genuine risk of serious harm or death. A deterministic rule engine runs after your output and will escalate LOW→HIGH when hard clinical thresholds are crossed — your job is calibrated clinical judgement, not defensive escalation. Common stable presentations manageable with oral medication and nurse monitoring should be LOW.',
    responseMimeType: 'application/json', responseSchema: SCHEMA_RISK_ASSESSMENT, maxOutputTokens: 2500,
  });
  return { result: parseJsonResponse(responseText(response)), meta };
}

// ---------------------------------------------------------------------------
// Call 4 — Triage + patient instructions + doctor handoff
// ---------------------------------------------------------------------------

export async function generateTriageAndHandoff(problemListOutput, vaultContext) {
  const demographics = { ...(vaultContext.demographics || {}) };
  const cc = vaultContext.chief_complaint || {};
  if (!demographics.age && cc.age) demographics.age = cc.age;
  if (!demographics.sex && cc.sex) demographics.sex = cc.sex;
  if (!demographics.name && cc.patient_name) demographics.name = cc.patient_name;
  const ddx = vaultContext.differential_table || [];
  const stateName = stateFromDistrictCode((vaultContext.gps || {}).district_code || 'WB_UNKNOWN');
  const allDrugs = (problemListOutput.problem_list || []).flatMap(p => p.plan?.prescription || []);
  const prescriptionIssued = buildPrescriptionIssued(allDrugs);
  const lang = (vaultContext.chief_complaint || {}).language_of_consultation || 'English';
  const langInst = lang === 'English' ? '' :
    `LANGUAGE: patient_instructions must include romanised ${lang} translations in brackets.`;

  const prompt = [
    'Generate the triage referral assessment, patient instructions, and doctor handoff package.',
    `PATIENT:\n${JSON.stringify(demographics, null, 2)}`,
    `PROBLEM LIST:\n${JSON.stringify(problemListOutput, null, 2)}`,
    `ALL PRESCRIBED DRUGS:\n${JSON.stringify(allDrugs, null, 2)}`,
    `PRESCRIPTION RECORD:\n${prescriptionIssued}`,
    `FULL DIFFERENTIAL:\n${JSON.stringify(ddx.slice(0, 3), null, 2)}`,
    langInst,
    'INSTRUCTIONS:\n' +
    'TRIAGE REFERRAL: assess if patient needs referral to higher facility.\n' +
    'PATIENT INSTRUCTIONS: plain language, include every drug with dose.\n' +
    'DOCTOR HANDOFF: one_liner, clinical_summary, key_risks, questions — English only.',
  ].filter(Boolean).join('\n\n');

  const { response, meta } = await generateWithCascade(MODEL_M4_TRIAGE, prompt, {
    systemInstruction: 'You are a clinical decision support system generating triage decisions. Never downgrade a risk tier.',
    responseMimeType: 'application/json', responseSchema: SCHEMA_TRIAGE_HANDOFF, maxOutputTokens: 3000,
  });
  const result = parseJsonResponse(responseText(response));
  if (!result.doctor_handoff) result.doctor_handoff = {};
  result.doctor_handoff.prescription_issued = prescriptionIssued;
  return { result, meta };
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runManagementStage(sessionId, audioBuffers, dbClient) {
  const vaultContext = await vaultRead(dbClient, sessionId);
  const demographics = vaultContext.demographics || {};
  const ddx = vaultContext.differential_table || [];
  const formulary = loadFormulary();

  try {
    // All DDx diagnoses for RAG
    const allDdxDiagnoses = ddx.filter(d => d.disease).map(d => d.disease);
    const knownConditions = demographics.known_conditions || [];
    const ragDiagnoses = [...allDdxDiagnoses, ...(Array.isArray(knownConditions) ? knownConditions.filter(Boolean) : [])];

    // Call 1 + RAG in parallel
    console.log(`[${sessionId}] Call 1: extracting clarifying findings + RAG retrieval`);
    let t0 = Date.now();
    const [m1Result, stgRetrieval] = await Promise.all([
      extractClarifyingFindings(audioBuffers, vaultContext),
      retrieveTreatmentProtocols(dbClient, ragDiagnoses),
    ]);
    const clarifyingFindings = m1Result.result;
    await insertLlmResult(dbClient, sessionId, 'M1_clarifying_findings', 'management', 6, clarifyingFindings, { ...m1Result.meta, latency_ms: Date.now() - t0 });
    await vaultUpdate(dbClient, sessionId, {
      clarifying_findings: clarifyingFindings,
      stg_retrieval: stgRetrieval,
    });

    // Call 2
    console.log(`[${sessionId}] Call 2: generating problem list`);
    const t1 = Date.now();
    const m2Result = await generateProvisionalDiagnosisAndRx(clarifyingFindings, vaultContext, stgRetrieval.context, formulary);
    const problemListOutput = m2Result.result;
    await insertLlmResult(dbClient, sessionId, 'M2_problem_list', 'management', 7, problemListOutput, { ...m2Result.meta, latency_ms: Date.now() - t1 });
    await vaultUpdate(dbClient, sessionId, { problem_list: problemListOutput });

    const firstAcute = (problemListOutput.problem_list || []).find(p => p.type === 'acute_new');
    const acuteConfidence = (firstAcute?.assessment?.confidence) || 'high';

    // Calls 3 + 4 in parallel
    console.log(`[${sessionId}] Calls 3+4: risk assessment and triage handoff (parallel)`);
    const t2 = Date.now();
    const [m3Result, m4Result] = await Promise.all([
      generateRiskAssessment(problemListOutput, clarifyingFindings, vaultContext),
      generateTriageAndHandoff(problemListOutput, vaultContext),
    ]);
    const riskAssessment = m3Result.result;
    const triageOutput = m4Result.result;
    await insertLlmResult(dbClient, sessionId, 'M3_risk_assessment', 'management', 8, riskAssessment, { ...m3Result.meta, latency_ms: Date.now() - t2 });
    await insertLlmResult(dbClient, sessionId, 'M4_triage_handoff', 'management', 9, triageOutput, { ...m4Result.meta, latency_ms: Date.now() - t2 });
    await vaultUpdate(dbClient, sessionId, { risk_assessment: riskAssessment });

    // Rule engine gate
    console.log(`[${sessionId}] Rule engine: deterministic safety check`);
    const vitals = { ...(vaultContext.extracted_concepts?.vitals_reported || {}) };
    for (const [key, val] of Object.entries(clarifyingFindings.vitals_found || {})) {
      if (key !== 'rdt_result' && val != null) vitals[key] = val;
    }
    const redFlags = vaultContext.extracted_concepts?.red_flags || [];
    const ruleResult = runRuleEngine(problemListOutput, riskAssessment, demographics, vitals, redFlags, vaultContext.extracted_concepts || {}, acuteConfidence);

    // Inject deterministic fields
    const finalTier = ruleResult.final_risk_tier;
    const hoursToAuth = finalTier === 'HIGH' ? 0 : 24;
    const authDeadline = hoursToAuth === 0
      ? 'IMMEDIATE — do not proceed without doctor contact'
      : new Date(Date.now() + hoursToAuth * 3600000).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });

    if (!triageOutput.triage) triageOutput.triage = {};
    triageOutput.triage.tier = finalTier;
    triageOutput.triage.action = finalTier === 'HIGH'
      ? 'Call the referring doctor immediately. Do not dispense any medication until you have spoken to the doctor.'
      : 'Proceed with the prescribed treatment plan. The doctor will review this case within 24 hours.';
    triageOutput.triage.rationale = riskAssessment.mitigation_plan?.risk_tier_rationale || '';
    triageOutput.triage.rule_engine = ruleResult;
    if (!triageOutput.doctor_handoff) triageOutput.doctor_handoff = {};
    triageOutput.doctor_handoff.authorization_required_by = authDeadline;

    await vaultUpdate(dbClient, sessionId, {
      triage_output: triageOutput, management_stage_status: 'complete',
      management_stage_completed_at: new Date().toISOString(),
      risk_tier: ruleResult.final_risk_tier, doctor_auth_status: 'pending',
    });

    console.log(`[${sessionId}] Management stage complete. Risk tier: ${ruleResult.final_risk_tier}`);
    return { session_id: sessionId, clarifying_findings: clarifyingFindings, problem_list: problemListOutput, risk_assessment: riskAssessment, triage: triageOutput, rule_engine: ruleResult };
  } catch (e) {
    console.error(`[${sessionId}] Management stage failed: ${e.message}`);
    try { await vaultUpdate(dbClient, sessionId, { management_stage_status: 'failed', management_stage_error: e.message, management_stage_failed_at: new Date().toISOString() }); } catch {}
    throw e;
  }
}

