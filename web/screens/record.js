/* NurseAI Web — Record / Consultation Screen */
import api from '../api.js';
import { showToast, showModal, hideModal, setCurrentPatient } from '../app.js';
import { startRecording, stopRecording, isCurrentlyRecording, formatDuration } from '../audio.js';

const PROFORMA_DIABETES = `1. Diagnosis Background\nAsk the patient:\nWhen were you first diagnosed with diabetes? Capture duration in years or months.\nDo you know which type of diabetes you have — Type 1, Type 2, or gestational?\nHave you ever been hospitalized because of diabetes? If yes, when and why?\n\n2. Current Symptoms\nAsk specifically and document response:\nAre you urinating more frequently than usual?\nAre you feeling excessive thirst?\nAre you feeling increased hunger?\nHave you had any recent weight change? If yes, record how many kilograms and over what time period.\nAre you feeling fatigue?\nAny blurred vision?\nAny tingling or numbness in hands or feet?\nAny wounds that are taking longer than usual to heal?\nAny recurrent infections in the last 6 months?\n\n3. Home Sugar Monitoring (Capture Exact Numbers)\nAsk clearly:\nDo you check your blood sugar at home?\nWhat is your usual fasting blood sugar reading? Record in mg/dL.\nWhat is your usual post-meal blood sugar reading? Record in mg/dL.\nWhat was your most recent blood sugar reading? Record value and date.\nWhen was your last HbA1c test?\nWhat was the HbA1c percentage?\nLow sugar screening:\nHave you had episodes of low blood sugar?\nWhat was the lowest value recorded?\nHow often do these episodes occur?\nWhat symptoms do you get during low sugar?\n\n4. Medication Details (Precise Dosing Required)\nAsk in detail:\nWhat diabetes medicines are you currently taking? Record exact drug names.\nWhat is the dose of each medicine?\nHow many times per day do you take it?\nIf on insulin:\nWhat type of insulin are you using?\nHow many units do you take in the morning?\nHow many units do you take in the afternoon?\nHow many units do you take at night?\nDo you ever skip insulin doses?\nAsk about adherence clearly:\nHow many doses do you miss per week on average?\n\n5. Complication Screening\nKidney:\nHave you had kidney tests recently?\nWhat was your last serum creatinine value?\nHave you ever been told you have protein in urine?\nEye:\nWhen was your last eye examination?\nWere you told you have diabetic retinopathy?\nNerve:\nDo you have burning pain in feet?\nLoss of sensation?\nAny balance issues?\nHeart:\nAny chest pain?\nAny shortness of breath on exertion?\nFoot:\nAny foot ulcers currently?\nAny past amputations?\n\n6. Vital and Clinical Measurements (To Measure Now)\nThe app should remind the nurse to capture:\nCurrent weight in kilograms.\nHeight in centimeters.\nCalculate BMI.\nBlood pressure.\nPulse rate.\nRespiratory rate.\n\n7. Lab Values (If Available – Capture Exact Numbers)\nAsk:\nWhat was your last fasting blood sugar lab value?\nWhat was your last post-prandial value?\nWhat was your HbA1c?\nWhat were your cholesterol values?\nWhat was your serum creatinine?\nWas urine albumin tested? What was the result?\n\n8. Lifestyle Quantification\nAsk in measurable terms:\nHow many minutes per day do you exercise?\nHow many days per week?\nHow many cigarettes per day?\nHow many alcoholic drinks per week?\nHow many hours of sleep per night?`;

const PROFORMA_HYPERTENSION = `1. Opening\nAre you here for blood pressure follow-up or new symptoms?\nSince when are you having these complaints?\n\n2. Current Symptoms\nHeadache?\nDizziness?\nBlurred vision?\nChest pain?\nPalpitations?\nShortness of breath?\nSwelling in legs?\nOr no symptoms?\nHas anything worsened recently?\nHave you ever had very high BP requiring emergency visit?\n\n3. Past Illness\nDo you have diabetes?\nHeart disease or previous heart attack?\nStroke?\nKidney disease?\nThyroid problems?\nAny other illness?\n\n4. Medicines\nWhat BP medicines are you taking?\nDo you take them regularly?\nAny side effects?\nAny other medicines including herbal?\n\n5. Family History\nDoes anyone in your family have high blood pressure?\nFamily history of diabetes?\nStroke?\nHeart attack?\nKidney disease?\n\n6. Lifestyle\nDo you smoke?\nDo you drink alcohol?\nHow would you describe your diet? High salt? Normal? Low salt?\nDo you exercise?\nHow stressed are you — low, moderate, high?\n\n7. Organ Damage Screening\nAny vision changes?\nChest pressure?\nBreathlessness while lying flat?\nSwelling in feet?\nLess urine or frothy urine?\nEpisodes of weakness or difficulty speaking?\n\n8. Monitoring\nDo you check BP at home?\nWhat was your last BP reading?`;

const PROFORMA_FEVER = `1. Opening\nWhat brings you in today?\nSince when have you had fever?\nHave you measured your temperature? What was the highest reading?\nDoes the fever stay all day or come and go?\nIs it higher in the evening?\n\n2. Associated Symptoms\nDo you get chills or shivering?\nBody pain?\nFeeling weak or unusually tired?\nHeadache?\nAny confusion or fits?\nSore throat?\nCough?\nDifficulty breathing?\nStomach pain?\nVomiting or nausea?\nLoose motions?\nBurning while passing urine?\nAny skin rashes?\nJoint pains?\n\n3. Exposure & Travel\nHas anyone around you had fever recently?\nAny mosquito bites?\nContact with animals like cattle, dogs, or rodents?\nHave you travelled in the last 4 weeks?\nAny exposure to dirty water or flooding?\n\n4. Medical Background\nHave you had similar fever before?\nDo you have diabetes?\nHigh blood pressure?\nHeart problems?\nAsthma?\nThyroid issues?\nKidney disease?\nHIV or low immunity?\nAny recent dental procedure?\nHave you had your spleen removed?\n\n5. Medication History\nAre you taking any regular medicines?\nHave you taken antibiotics for this fever?\nHave you taken paracetamol or ibuprofen?\nAny herbal or traditional medicines?\n\n6. Immunization & Other Important Points\nHave you taken COVID vaccine?\nTyphoid vaccine?\nAny recent surgery?\n(If female) When was your last menstrual period?\nAre you able to drink fluids?\nIs your urine output normal?\n\n7. Red Flag Screening (Ask Directly)\nAre you feeling extremely weak?\nAny confusion?\nIs your fever very high (above 103°F)?\nNeck stiffness or light hurting your eyes?\nNot passing urine?\nSevere breathing difficulty?\nAny bleeding`;

const PROFORMAS = [
  { id: 'diabetes', title: 'Diabetes', content: PROFORMA_DIABETES },
  { id: 'hypertension', title: 'Hypertension', content: PROFORMA_HYPERTENSION },
  { id: 'fever', title: 'Fever', content: PROFORMA_FEVER },
];

let st = {
  patientName: '', patientId: '',
  recording: false, uploading: false, answerRecording: false, submitting: false,
  recSec: 0, ansSec: 0,
  diagnosisText: '', audioRecordId: null,
  firstBlob: null, autoProforma: '', genAutoProforma: false,
  generatedProforma: null, proformaQuery: '', createQuery: '',
  genProforma: false,
};
let container = null;

export function initRecord(el) {
  container = el;
  render();
}
export function onRecordPageShow() { /* no-op, state persists */ }

function render() {
  if (!container) return;
  const proformas = getFilteredProformas();
  container.innerHTML = `<div class="record-content"><div class="record-inner">
    ${renderProformaSection(proformas)}
    ${st.autoProforma || st.genAutoProforma ? renderAutoProforma() : ''}
    ${st.diagnosisText ? renderDiagnosis() : ''}
    <div class="mic-container ${st.recording ? 'recording' : ''}">
      <ion-icon name="${st.recording ? 'mic' : 'mic-outline'}"></ion-icon>
    </div>
    <div class="page-title">${st.recording ? 'Recording...' : 'Ready to Record'}</div>
    <div class="page-subtitle">${st.recording ? 'Tap stop when finished' : 'Enter patient details below to start recording'}</div>
    ${!st.recording ? renderForm() : renderRecordingInfo()}
    ${renderButtons()}
  </div></div>`;
  bindRecordEvents();
}

function renderProformaSection(proformas) {
  return `<div class="proforma-section">
    <div class="section-title">Search Proforma</div>
    <div class="proforma-search">
      <ion-icon name="search-outline"></ion-icon>
      <input id="proforma-search" placeholder="Search proforma" value="${esc(st.proformaQuery)}">
    </div>
    <div class="proforma-create">
      <ion-icon name="sparkles-outline"></ion-icon>
      <input id="proforma-create-input" placeholder="Create proforma (e.g., rash and fever)" value="${esc(st.createQuery)}">
      <button class="btn btn-primary btn-sm" id="proforma-create-btn" ${!st.createQuery.trim() || st.genProforma ? 'disabled' : ''}>
        ${st.genProforma ? 'Creating...' : 'Create'}
      </button>
    </div>
    <div class="proforma-list">
      ${proformas.map(p => `
        <div class="proforma-item" data-action="open-proforma" data-id="${p.id}">
          <span class="proforma-item-text">${esc(p.title)}</span>
          <ion-icon name="chevron-forward"></ion-icon>
        </div>
      `).join('')}
      ${proformas.length === 0 ? '<div class="proforma-empty">No proformas found.</div>' : ''}
    </div>
  </div>`;
}

function renderAutoProforma() {
  return `<div class="auto-proforma-section">
    <div class="auto-proforma-header"><ion-icon name="document-text"></ion-icon><span>Auto-Generated Proforma</span></div>
    ${st.genAutoProforma
      ? '<div class="answer-submitting"><div class="spinner"></div><span>Generating proforma from recording...</span></div>'
      : `<div class="diagnosis-card"><div class="diagnosis-content">${esc(st.autoProforma)}</div></div>`}
  </div>`;
}

function renderDiagnosis() {
  let actionHtml;
  if (st.answerRecording) {
    actionHtml = `<div class="answer-recording">
      <div class="answer-indicator"><ion-icon name="mic"></ion-icon><span class="answer-timer">${formatDuration(st.ansSec)}</span><span class="answer-label">Recording answers...</span></div>
      <button class="btn btn-danger btn-block" id="stop-answer-btn"><ion-icon name="stop"></ion-icon> Stop & Submit</button>
    </div>`;
  } else if (st.submitting) {
    actionHtml = '<div class="answer-submitting"><div class="spinner"></div><span>Generating prescription...</span></div>';
  } else {
    actionHtml = '<button class="btn btn-primary btn-block" id="start-answer-btn"><ion-icon name="mic-outline"></ion-icon> Answer</button>';
  }
  return `<div class="diagnosis-section">
    <div class="diagnosis-header"><ion-icon name="medkit"></ion-icon><span>Diagnostic Assessment</span></div>
    <div class="diagnosis-subtitle">Review the assessment below, then tap "Answer" to record your responses to the clarifying questions.</div>
    <div class="diagnosis-card"><div class="diagnosis-content">${esc(st.diagnosisText)}</div></div>
    ${actionHtml}
  </div>`;
}

function renderForm() {
  return `<div class="form-container">
    <div class="input-group">
      <label class="input-label">Patient Name *</label>
      <div class="input-wrapper"><ion-icon name="person-outline"></ion-icon>
        <input id="patient-name" placeholder="Enter patient name" value="${esc(st.patientName)}">
      </div>
    </div>
    <div class="input-group">
      <label class="input-label">Patient ID *</label>
      <div class="input-wrapper"><ion-icon name="id-card-outline"></ion-icon>
        <input id="patient-id" placeholder="Enter patient ID" value="${esc(st.patientId)}">
      </div>
    </div>
  </div>`;
}

function renderRecordingInfo() {
  return `<div class="recording-info" style="width:100%;max-width:400px;margin-bottom:20px;">
    <div class="recording-info-row"><ion-icon name="person"></ion-icon><span class="recording-info-text">${esc(st.patientName)}</span></div>
    <div class="recording-info-row"><ion-icon name="id-card"></ion-icon><span class="recording-info-text">ID: ${esc(st.patientId)}</span></div>
    <div class="recording-info-row"><ion-icon name="time-outline" style="color:#DC2626"></ion-icon><span class="recording-timer-text">${formatDuration(st.recSec)}</span></div>
  </div>`;
}

function renderButtons() {
  const canStart = st.patientName.trim() && st.patientId.trim();
  if (st.recording && st.recSec >= 30 && !st.firstBlob) {
    return `<div class="btn-row" style="max-width:500px;width:100%;">
      <button class="record-btn recording" id="stop-rec-btn" ${st.uploading ? 'disabled' : ''}><ion-icon name="stop"></ion-icon>${st.uploading ? 'Uploading...' : 'Stop'}</button>
      <button class="record-btn" style="background:#059669" id="gen-proforma-btn" ${st.genAutoProforma ? 'disabled' : ''}><ion-icon name="document-text-outline"></ion-icon>${st.genAutoProforma ? 'Generating...' : 'Proforma'}</button>
    </div>`;
  }
  if (st.recording) {
    return `<button class="record-btn recording" id="stop-rec-btn" ${st.uploading ? 'disabled' : ''}><ion-icon name="stop"></ion-icon>${st.uploading ? 'Uploading...' : 'Stop Recording'}</button>`;
  }
  const dis = !canStart || st.uploading || (st.diagnosisText && st.audioRecordId);
  return `<button class="record-btn ${dis ? 'disabled' : ''}" id="start-rec-btn" ${dis ? 'disabled' : ''}>
    <ion-icon name="mic"></ion-icon>${st.uploading ? 'Uploading...' : 'Start Recording'}
  </button>`;
}

function bindRecordEvents() {
  // Proforma search
  const searchEl = container.querySelector('#proforma-search');
  if (searchEl) searchEl.addEventListener('input', e => { st.proformaQuery = e.target.value; render(); });
  const createInput = container.querySelector('#proforma-create-input');
  if (createInput) createInput.addEventListener('input', e => { st.createQuery = e.target.value; render(); });
  const createBtn = container.querySelector('#proforma-create-btn');
  if (createBtn) createBtn.addEventListener('click', handleCreateProforma);

  // Patient fields
  const nameEl = container.querySelector('#patient-name');
  if (nameEl) nameEl.addEventListener('input', e => { st.patientName = e.target.value; });
  const idEl = container.querySelector('#patient-id');
  if (idEl) idEl.addEventListener('input', e => { st.patientId = e.target.value; });

  // Record buttons
  container.querySelector('#start-rec-btn')?.addEventListener('click', handleStartRecording);
  container.querySelector('#stop-rec-btn')?.addEventListener('click', handleStopRecording);
  container.querySelector('#gen-proforma-btn')?.addEventListener('click', handleGenAutoProforma);
  container.querySelector('#start-answer-btn')?.addEventListener('click', handleStartAnswer);
  container.querySelector('#stop-answer-btn')?.addEventListener('click', handleStopAnswer);

  // Proforma items
  container.querySelectorAll('[data-action="open-proforma"]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const all = st.generatedProforma ? [st.generatedProforma, ...PROFORMAS] : PROFORMAS;
      const p = all.find(x => x.id === id);
      if (p) showProformaModal(p);
    });
  });
}

function getFilteredProformas() {
  const q = st.proformaQuery.trim().toLowerCase();
  const all = st.generatedProforma ? [st.generatedProforma, ...PROFORMAS] : PROFORMAS;
  if (!q) return all;
  return all.filter(p => p.title.toLowerCase().includes(q));
}

async function handleCreateProforma() {
  const symptoms = st.createQuery.trim();
  if (!symptoms) return;
  st.genProforma = true; render();
  const r = await api.generateProforma(symptoms);
  st.genProforma = false;
  if (r.success && r.data?.content) {
    const title = symptoms.length > 48 ? symptoms.slice(0, 45) + '...' : symptoms;
    st.generatedProforma = { id: `ai-${Date.now()}`, title: `AI: ${title}`, content: r.data.content };
    st.createQuery = '';
  } else {
    showToast(r.error || 'Failed to generate proforma', 'error');
  }
  render();
}

async function handleStartRecording() {
  if (!st.patientName.trim() || !st.patientId.trim()) {
    showToast('Please enter Patient Name and ID', 'error'); return;
  }
  // Check existing patient
  try {
    const check = await api.checkPatientExists(st.patientId.trim());
    if (check.success && check.data?.exists) {
      const proceed = await showExistingPatientModal(check.data.patientName);
      if (!proceed) return;
      if (check.data.patientName) st.patientName = check.data.patientName;
    }
  } catch {}
  // Consent
  const agreed = await showConsentModal();
  if (!agreed) return;
  // Save patient
  setCurrentPatient({ patientName: st.patientName.trim(), patientId: st.patientId.trim() });
  // Start
  const ok = await startRecording((sec) => { st.recSec = sec; render(); });
  if (ok) { st.recording = true; st.recSec = 0; render(); }
  else showToast('Failed to start recording. Check microphone permissions.', 'error');
}

async function handleStopRecording() {
  st.recording = false;
  const result = await stopRecording();
  if (!result || !result.blob || result.blob.size < 1000) {
    showToast('Recording too short', 'error'); render(); return;
  }
  render();
  showPhotoModal(result.blob);
}

async function handleGenAutoProforma() {
  // Stop current recording, save blob, start new, send first to extract proforma
  st.genAutoProforma = true;
  const result = await stopRecording();
  if (!result?.blob) { st.genAutoProforma = false; showToast('Failed to capture audio', 'error'); render(); return; }
  st.firstBlob = result.blob;
  // Restart recording
  const ok = await startRecording((sec) => { st.recSec = sec; render(); });
  if (!ok) { st.genAutoProforma = false; showToast('Failed to restart recording', 'error'); }
  render();
  // Extract proforma in background
  try {
    const r = await api.extractProforma(result.blob, st.patientId.trim());
    st.genAutoProforma = false;
    if (r.success) {
      st.autoProforma = r.data?.data?.proformaText || r.data?.proformaText || '';
    } else {
      showToast(r.error || 'Proforma extraction failed', 'error');
    }
  } catch { st.genAutoProforma = false; }
  render();
}

function showPhotoModal(audioBlob) {
  showModal(`
    <div class="modal-title">Attach Photo?</div>
    <div class="modal-subtitle">You can add a patient photo before uploading. This is optional.</div>
    <button class="photo-option primary" id="upload-no-photo">Upload Without Photo</button>
    <label class="photo-option" id="choose-photo-label">Choose Photo
      <input type="file" accept="image/*" class="file-input-hidden" id="photo-file-input">
    </label>
    <button class="photo-option destructive" id="discard-recording">Don't Upload</button>
  `);
  document.getElementById('upload-no-photo').onclick = () => { hideModal(); uploadAudio(audioBlob, null); };
  document.getElementById('photo-file-input').onchange = (e) => {
    const file = e.target.files[0];
    if (file) { hideModal(); uploadAudio(audioBlob, file); }
  };
  document.getElementById('discard-recording').onclick = () => { hideModal(); };
}

async function uploadAudio(audioBlob, photoFile) {
  st.uploading = true; render();
  try {
    const fd = new FormData();
    const ext = audioBlob.type?.includes('mp4') ? '.m4a' : '.webm';
    if (st.firstBlob) {
      const ext1 = st.firstBlob.type?.includes('mp4') ? '.m4a' : '.webm';
      fd.append('audio', st.firstBlob, `recording${ext1}`);
      fd.append('audio2', audioBlob, `recording2${ext}`);
    } else {
      fd.append('audio', audioBlob, `recording${ext}`);
    }
    if (photoFile) fd.append('photo', photoFile);
    fd.append('patientName', st.patientName.trim());
    fd.append('patientId', st.patientId.trim());

    const r = await api.uploadAudio(fd);
    if (r.success) {
      const payload = r.data?.data || {};
      if (payload.geminiGenerated === false && payload.geminiErrorCode === 'RATE_LIMIT') {
        showToast('Gemini is busy. Please try again in 60 seconds.', 'error');
      } else {
        st.audioRecordId = payload.id;
        st.diagnosisText = payload.diagnosisText || '';
        st.firstBlob = null;
        st.autoProforma = '';
      }
    } else {
      showToast(r.error || 'Upload failed', 'error');
    }
  } catch (e) {
    showToast('Upload error: ' + e.message, 'error');
  }
  st.uploading = false; render();
}

async function handleStartAnswer() {
  const ok = await startRecording((sec) => { st.ansSec = sec; render(); });
  if (ok) { st.answerRecording = true; st.ansSec = 0; render(); }
  else showToast('Failed to start recording', 'error');
}

async function handleStopAnswer() {
  st.answerRecording = false;
  const result = await stopRecording();
  if (!result?.blob || result.blob.size < 500) {
    showToast('Recording too short', 'error'); render(); return;
  }
  st.submitting = true; render();
  try {
    const r = await api.submitClarifyingAnswers(st.audioRecordId, result.blob);
    if (r.success) {
      st.diagnosisText = '';
      st.audioRecordId = null;
      showToast('Prescription generated successfully!', 'success');
      // Check for missing data
      await checkMissingData();
    } else {
      showToast(r.error || 'Failed to generate prescription', 'error');
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
  st.submitting = false; render();
}

async function checkMissingData() {
  try {
    const r = await api.getLatestGeminiSuggestion({ patientName: st.patientName.trim(), patientId: st.patientId.trim() });
    if (!r.success) return;
    const content = r.data?.content || '';
    const missingKeys = parseMissingFields(content);
    if (missingKeys.length > 0) {
      showMissingDataModal(missingKeys, r.data?.id);
    }
  } catch {}
}

function parseMissingFields(content) {
  if (!content) return [];
  const lower = content.toLowerCase();
  const idx = lower.indexOf('8. missing data');
  if (idx === -1) return [];
  const after = content.slice(idx).split(/tone:/i)[0] || content.slice(idx);
  const matches = new Set();
  const text = after.toLowerCase();
  if (text.includes('spo2') || text.includes('sp02')) matches.add('spo2');
  if (text.includes('bp') || text.includes('blood pressure')) matches.add('bp');
  if (text.includes('hr') || text.includes('heart rate')) matches.add('hr');
  if (text.includes('rr') || text.includes('respiratory rate')) matches.add('rr');
  if (text.includes('weight')) matches.add('weight');
  if (text.includes('height')) matches.add('height');
  if (text.includes('bmi')) matches.add('bmi');
  if (text.includes('age')) matches.add('age');
  if (text.includes('gender') || text.includes('sex')) matches.add('gender');
  if (text.includes('occupation')) matches.add('occupation');
  return Array.from(matches);
}

function showMissingDataModal(keys, suggestionId) {
  const labels = { age:'Age',gender:'Gender',occupation:'Occupation',spo2:'SpO2',bp:'BP',hr:'HR',rr:'RR',weight:'Weight',height:'Height',bmi:'BMI' };
  const demoKeys = keys.filter(k => ['age','gender','occupation'].includes(k));
  const vitalKeys = keys.filter(k => !['age','gender','occupation'].includes(k));
  const fieldsHtml = (ks) => ks.map(k => `
    <div class="modal-field">
      <label class="modal-label">${labels[k] || k} *</label>
      <input class="modal-input" data-key="${k}" placeholder="${labels[k] || k}" ${['age','spo2','hr','rr'].includes(k) ? 'inputmode="numeric"' : ''}>
    </div>
  `).join('');

  showModal(`
    <div class="modal-title">Missing Patient Data</div>
    <div class="modal-subtitle">Recording submitted. Please fill all missing demographics and vitals.</div>
    ${demoKeys.length ? '<div class="modal-section-title">Demographics</div>' + fieldsHtml(demoKeys) : ''}
    ${vitalKeys.length ? '<div class="modal-section-title">Vitals</div>' + fieldsHtml(vitalKeys) : ''}
    <button class="btn btn-primary btn-block" id="submit-missing-btn">Save and Continue</button>
  `);

  document.getElementById('submit-missing-btn').onclick = async () => {
    const inputs = document.querySelectorAll('.modal-input[data-key]');
    const payload = {};
    let valid = true;
    inputs.forEach(inp => {
      if (!inp.value.trim()) valid = false;
      payload[inp.dataset.key] = inp.value.trim();
    });
    if (!valid) { showToast('Please fill all fields', 'error'); return; }
    if (suggestionId) {
      const msg = ['Updated patient demographics and vitals:', ...Object.entries(payload).map(([k,v]) => `${labels[k]||k}: ${v}`)].join('\n');
      await api.followupGeminiSuggestion(suggestionId, msg, st.patientId.trim());
    }
    hideModal();
    showToast('Patient data saved', 'success');
  };
}

function showConsentModal() {
  return new Promise(resolve => {
    showModal(`
      <div class="consent-title">Informed Consent</div>
      <div class="consent-body">Note: please inform the patient that NurseAI is right now only collecting data for research purposes and the organisation will try its best to protect the data yet in case of leaks/hacking the organisation is not liable.</div>
      <div class="consent-actions">
        <button class="consent-cancel" id="consent-cancel">Cancel</button>
        <button class="consent-agree" id="consent-agree">Agree & Start</button>
      </div>
    `);
    document.getElementById('consent-cancel').onclick = () => { hideModal(); resolve(false); };
    document.getElementById('consent-agree').onclick = () => { hideModal(); resolve(true); };
  });
}

function showExistingPatientModal(existingName) {
  return new Promise(resolve => {
    showModal(`
      <div class="existing-header">
        <div class="existing-icon"><ion-icon name="person-circle"></ion-icon></div>
        <div class="consent-title">Existing Patient Found</div>
      </div>
      <div class="existing-text">This Patient ID is already registered to <strong>${esc(existingName)}</strong>.<br><br>Do you want to edit the ID for a new patient or proceed with recording for ${esc(existingName)}?</div>
      <div class="consent-actions">
        <button class="btn btn-secondary btn-sm" id="exist-edit">Edit ID</button>
        <button class="btn btn-primary btn-sm" id="exist-proceed">Proceed</button>
      </div>
    `);
    document.getElementById('exist-edit').onclick = () => { hideModal(); st.patientId = ''; render(); resolve(false); };
    document.getElementById('exist-proceed').onclick = () => { hideModal(); resolve(true); };
  });
}

function showProformaModal(proforma) {
  showModal(`
    <div class="modal-title">${esc(proforma.title)}</div>
    ${st.recording ? `<div class="proforma-recording-banner"><ion-icon name="mic"></ion-icon><span>${formatDuration(st.recSec)}</span></div>` : ''}
    <div class="proforma-modal-content">${esc(proforma.content)}</div>
    <div class="proforma-modal-actions">
      ${st.recording ? `<button class="btn btn-danger" id="proforma-stop-rec"><ion-icon name="stop"></ion-icon> Stop Recording</button>` : ''}
      <button class="btn btn-primary" style="flex:1" id="proforma-close">Close</button>
    </div>
  `);
  document.getElementById('proforma-close').onclick = hideModal;
  document.getElementById('proforma-stop-rec')?.addEventListener('click', () => { hideModal(); handleStopRecording(); });
}

function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
