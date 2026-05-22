/* NurseAI Web — History Screen */
import api from '../api.js';
import { showToast } from '../app.js';

let histData = { transcripts: [], plans: [], expanded: {}, planExpanded: {} };

export function initHistory(container) {
  container.innerHTML = '<div class="loading-container"><div class="spinner"></div></div>';
  fetchHistory(container);
}

export function refreshHistory() {
  api.clearCache();
  const container = document.getElementById('page-history');
  fetchHistory(container);
}

async function fetchHistory(container) {
  const [trR, plR] = await Promise.all([
    api.getGroupedTranscripts(),
    api.getManagementPlanHistory(),
  ]);
  histData.transcripts = trR.success ? (trR.data || []) : [];
  histData.plans = plR.success ? (plR.data || []) : [];
  render(container);
}

function render(container) {
  const groups = groupByDate(histData.transcripts);
  container.innerHTML = `
    <div class="logo-card">
      <div class="logo-header">
        <div class="logo-icon"><ion-icon name="time"></ion-icon></div>
        <div>
          <div class="logo-title">History</div>
          <div class="logo-subtitle">Past recordings & plans</div>
        </div>
      </div>
    </div>

    <div class="history-section">
      <div class="gemini-title">Recording History</div>
      ${histData.transcripts.length === 0
        ? '<div class="empty-state"><ion-icon name="document-text-outline"></ion-icon><p>No recordings yet</p></div>'
        : groups.map(g => `
          <div class="history-date-header">${g.label}</div>
          ${g.items.map(renderTranscriptCard).join('')}
        `).join('')}
    </div>

    ${histData.plans.length > 0 ? `
    <div class="history-section">
      <div class="gemini-title">Management Plan History</div>
      ${histData.plans.map(renderPlanCard).join('')}
    </div>` : ''}
  `;
  bindEvents(container);
}

function renderTranscriptCard(item) {
  const isExp = histData.expanded[item.id];
  const statusClass = item.status === 'completed' ? 'status-completed' : item.status === 'flagged' ? 'status-flagged' : 'status-pending';
  const statusText = item.status || 'pending';
  const time = item.created_at ? new Date(item.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '';

  return `
    <div class="history-card" data-action="toggle-transcript" data-id="${item.id}">
      <div class="history-card-header">
        <div>
          <div class="history-card-patient">${esc(item.patientName || item.patient_name || 'Unknown')}</div>
          <div class="history-card-id">ID: ${esc(item.patientId || item.patient_id || 'N/A')}</div>
        </div>
        <span class="status-badge ${statusClass}">${statusText}</span>
      </div>
      <div class="history-preview">${esc(item.content || item.transcript || 'No content')}</div>
      ${isExp ? `<div class="diagnosis-card" style="margin-top:8px"><div class="diagnosis-content">${esc(item.content || item.transcript || '')}</div></div>` : ''}
      <div class="history-time">${time}</div>
    </div>
  `;
}

function renderPlanCard(plan) {
  const isExp = histData.planExpanded[plan.id];
  let mgmt, riskTier;
  try { mgmt = typeof plan.management_plan === 'string' ? JSON.parse(plan.management_plan) : (plan.management_plan || {}); } catch { mgmt = {}; }
  riskTier = mgmt.risk_tier || 'unknown';
  const riskClass = riskTier === 'HIGH' ? 'risk-high' : riskTier === 'LOW' ? 'risk-low' : 'risk-unknown';
  const dateStr = plan.created_at ? new Date(plan.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const triage = mgmt.triage_output;
  const triageText = triage ? (triage.one_liner || triage.action || '') : '';

  return `
    <div class="history-card" data-action="toggle-plan" data-id="${plan.id}">
      <div class="history-card-header">
        <div>
          <div class="history-card-patient">${esc(plan.patient_name || plan.patient_id || 'Unknown')}</div>
          <div class="history-card-id">ID: ${esc(plan.patient_id || 'N/A')}</div>
        </div>
        <span class="risk-badge ${riskClass}">${riskTier}</span>
      </div>
      <div class="mgmt-source">
        <ion-icon name="${plan.source === 'live' ? 'pulse' : 'cloud-upload'}"></ion-icon>
        <span class="mgmt-source-text">${plan.source === 'live' ? 'Live Consultation' : 'Audio Upload'}</span>
        <span class="mgmt-date">${dateStr}</span>
      </div>
      ${triageText ? `<div class="history-preview">${esc(triageText)}</div>` : ''}
      ${isExp ? renderExpandedPlan(plan, mgmt) : ''}
    </div>
  `;
}

function renderExpandedPlan(plan, mgmt) {
  let proforma, clarifying, problemList;
  try { proforma = typeof plan.proforma === 'string' ? JSON.parse(plan.proforma) : plan.proforma; } catch { proforma = null; }
  try { clarifying = typeof plan.clarifying_questions === 'string' ? JSON.parse(plan.clarifying_questions) : plan.clarifying_questions; } catch { clarifying = null; }
  problemList = mgmt.problem_list;

  return `<div class="mgmt-expanded">
    ${proforma ? `<div class="mgmt-sub"><div class="mgmt-sub-title">Proforma</div><div class="mgmt-sub-content">${esc(typeof proforma === 'string' ? proforma : JSON.stringify(proforma, null, 2))}</div></div>` : ''}
    ${clarifying ? `<div class="mgmt-sub"><div class="mgmt-sub-title">Clarifying Questions</div><div class="mgmt-sub-content">${esc(typeof clarifying === 'string' ? clarifying : JSON.stringify(clarifying, null, 2))}</div></div>` : ''}
    ${problemList ? `<div class="mgmt-sub"><div class="mgmt-sub-title">Problem List</div><div class="mgmt-sub-content">${esc(typeof problemList === 'string' ? problemList : JSON.stringify(problemList, null, 2))}</div></div>` : ''}
  </div>`;
}

function bindEvents(container) {
  container.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const id = target.dataset.id;
    if (target.dataset.action === 'toggle-transcript') {
      histData.expanded[id] = !histData.expanded[id];
      render(container);
    }
    if (target.dataset.action === 'toggle-plan') {
      histData.planExpanded[id] = !histData.planExpanded[id];
      render(container);
    }
  });
}

function groupByDate(items) {
  const groups = {};
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  items.forEach(item => {
    const d = item.created_at ? new Date(item.created_at).toDateString() : 'Unknown';
    let label = d;
    if (d === today) label = 'Today';
    else if (d === yesterday) label = 'Yesterday';
    else label = item.created_at ? new Date(item.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : 'Unknown';
    if (!groups[label]) groups[label] = [];
    groups[label].push(item);
  });
  return Object.entries(groups).map(([label, items]) => ({ label, items }));
}

function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
