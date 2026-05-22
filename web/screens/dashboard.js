/* NurseAI Web — Dashboard Screen */
import api from '../api.js';
import { showToast, showModal, hideModal } from '../app.js';

let dashData = { summary: null, suggestions: [], plans: [], expanded: {}, planExpanded: {} };

export function initDashboard(container) {
  container.innerHTML = '<div class="loading-container"><div class="spinner"></div></div>';
  fetchAll(container);
}

export function refreshDashboard() {
  api.clearCache();
  const container = document.getElementById('page-dashboard');
  fetchAll(container);
}

async function fetchAll(container) {
  const [sumR, gemR, mgmtR] = await Promise.all([
    api.getDashboardSummary(),
    api.getGeminiSuggestions(),
    api.getManagementPlans(),
  ]);
  dashData.summary = sumR.success ? sumR.data : { pending: 0, done: 0 };
  dashData.suggestions = gemR.success ? (gemR.data || []).slice(0, 10) : [];
  dashData.plans = mgmtR.success ? (mgmtR.data || []) : [];
  render(container);
}

function render(container) {
  const s = dashData.summary || { pending: 0, done: 0 };
  container.innerHTML = `
    <div class="logo-card">
      <div class="logo-header">
        <div class="logo-icon"><ion-icon name="document-text"></ion-icon></div>
        <div>
          <div class="logo-title">NurseAI</div>
          <div class="logo-subtitle">Clinical Assistant</div>
        </div>
      </div>
    </div>

    <div class="summary-row">
      <div class="summary-card pending">
        <div class="summary-count">${s.pending || 0}</div>
        <div class="summary-label">Pending</div>
      </div>
      <div class="summary-card done">
        <div class="summary-count">${s.done || 0}</div>
        <div class="summary-label">Done</div>
      </div>
    </div>

    <div class="gemini-section">
      <div class="gemini-title">Gemini Suggestions</div>
      ${dashData.suggestions.length === 0
        ? '<div class="card"><div class="gemini-empty">No pending suggestions yet.</div></div>'
        : dashData.suggestions.map(renderSuggestionCard).join('')}
    </div>

    ${dashData.plans.length > 0 ? `
    <div class="mgmt-section">
      <div class="mgmt-title">Management Plans</div>
      ${dashData.plans.map(renderPlanCard).join('')}
    </div>` : ''}
  `;
  bindEvents(container);
}

function renderSuggestionCard(item) {
  const isExp = dashData.expanded[item.id];
  const followupsHtml = (item.followups || []).map(f => `
    <div class="followup-item">
      <div class="followup-q"><ion-icon name="chatbubble-ellipses"></ion-icon><span>Q: ${esc(f.question)}</span></div>
      <div class="followup-a"><ion-icon name="medical"></ion-icon><span>A: ${esc(f.answer)}</span></div>
    </div>
  `).join('');

  return `
    <div class="gemini-card" data-action="toggle-suggestion" data-id="${item.id}">
      <div class="gemini-card-header">
        <div>
          <div class="gemini-patient">${esc(item.patientName || 'Unknown')} (ID: ${esc(item.patientId || 'N/A')})</div>
          ${item.verificationStatus === 'verified' ? '<div class="verified-badge"><ion-icon name="shield-checkmark"></ion-icon><span>Verified</span></div>' : ''}
        </div>
        <button class="flag-btn" data-action="flag" data-id="${item.id}" data-flagged="${item._flagged || false}">
          ${item._flagged ? 'Flagged' : 'Flag for review'}
        </button>
      </div>
      <div class="gemini-content ${isExp ? '' : 'collapsed'}">${esc(item.content || '')}</div>
      ${isExp && followupsHtml ? `<div class="followups">${followupsHtml}</div>` : ''}
      <div class="gemini-hint">${isExp ? 'Tap to collapse' : 'Tap to expand'}</div>
      ${isExp ? `
      <div class="ask-ai">
        <div class="ask-ai-label">Ask AI</div>
        <div class="ask-ai-row">
          <textarea class="ask-ai-input" data-id="${item.id}" placeholder="Ask a follow-up question..." rows="1"></textarea>
          <button class="btn btn-primary btn-sm" data-action="ask-ai" data-id="${item.id}">Send</button>
        </div>
      </div>` : ''}
    </div>
  `;
}

function renderPlanCard(plan) {
  const isExp = dashData.planExpanded[plan.id];
  let mgmt, proforma, clarifying, riskTier, triage, problemList;
  try { mgmt = typeof plan.management_plan === 'string' ? JSON.parse(plan.management_plan) : (plan.management_plan || {}); } catch { mgmt = {}; }
  try { proforma = typeof plan.proforma === 'string' ? JSON.parse(plan.proforma) : plan.proforma; } catch { proforma = null; }
  try { clarifying = typeof plan.clarifying_questions === 'string' ? JSON.parse(plan.clarifying_questions) : plan.clarifying_questions; } catch { clarifying = null; }
  riskTier = mgmt.risk_tier || 'unknown';
  triage = mgmt.triage_output;
  problemList = mgmt.problem_list;
  const triageText = triage ? (triage.one_liner || triage.action || JSON.stringify(triage).slice(0, 120)) : '';
  const riskClass = riskTier === 'HIGH' ? 'risk-high' : riskTier === 'LOW' ? 'risk-low' : 'risk-unknown';
  const dateStr = plan.created_at ? new Date(plan.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';

  return `
    <div class="mgmt-card" data-action="toggle-plan" data-id="${plan.id}">
      <div class="mgmt-header">
        <div>
          <div class="mgmt-patient-name">${esc(plan.patient_name || plan.patient_id || 'Unknown')}</div>
          <div class="mgmt-patient-id">ID: ${esc(plan.patient_id || 'N/A')}</div>
        </div>
        <span class="risk-badge ${riskClass}">${riskTier}</span>
      </div>
      <div class="mgmt-source">
        <ion-icon name="${plan.source === 'live' ? 'pulse' : 'cloud-upload'}"></ion-icon>
        <span class="mgmt-source-text">${plan.source === 'live' ? 'Live Consultation' : 'Audio Upload'}</span>
        <span class="mgmt-date">${dateStr}</span>
      </div>
      ${triageText ? `<div class="mgmt-triage ${isExp ? '' : 'collapsed'}">${esc(triageText)}</div>` : ''}
      ${isExp ? `
      <div class="mgmt-expanded">
        ${proforma ? `<div class="mgmt-sub"><div class="mgmt-sub-title">Proforma</div><div class="mgmt-sub-content">${esc(typeof proforma === 'string' ? proforma : JSON.stringify(proforma, null, 2))}</div></div>` : ''}
        ${clarifying ? `<div class="mgmt-sub"><div class="mgmt-sub-title">Clarifying Questions</div><div class="mgmt-sub-content">${esc(typeof clarifying === 'string' ? clarifying : JSON.stringify(clarifying, null, 2))}</div></div>` : ''}
        ${problemList ? `<div class="mgmt-sub"><div class="mgmt-sub-title">Problem List</div><div class="mgmt-sub-content">${esc(typeof problemList === 'string' ? problemList : JSON.stringify(problemList, null, 2))}</div></div>` : ''}
      </div>` : ''}
      <div class="gemini-hint">${isExp ? 'Tap to collapse' : 'Tap to expand'}</div>
      <button class="clear-btn" data-action="clear-plan" data-id="${plan.id}">Clear</button>
    </div>
  `;
}

function bindEvents(container) {
  container.addEventListener('click', async (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const id = target.dataset.id;

    if (action === 'toggle-suggestion') {
      if (e.target.closest('[data-action="flag"]') || e.target.closest('[data-action="ask-ai"]')) return;
      dashData.expanded[id] = !dashData.expanded[id];
      render(container);
    }

    if (action === 'toggle-plan') {
      if (e.target.closest('[data-action="clear-plan"]')) return;
      dashData.planExpanded[id] = !dashData.planExpanded[id];
      render(container);
    }

    if (action === 'flag') {
      e.stopPropagation();
      showFlagModal(id);
    }

    if (action === 'ask-ai') {
      e.stopPropagation();
      const textarea = container.querySelector(`.ask-ai-input[data-id="${id}"]`);
      const msg = textarea?.value?.trim();
      if (!msg) { showToast('Enter a question', 'error'); return; }
      target.disabled = true; target.textContent = 'Sending...';
      const item = dashData.suggestions.find(s => s.id == id);
      const r = await api.followupGeminiSuggestion(id, msg, item?.patientId);
      if (r.success) {
        if (!item.followups) item.followups = [];
        item.followups.push({ question: msg, answer: r.data?.followupAnswer || r.data?.content || '' });
        render(container);
      } else {
        showToast(r.error || 'Failed', 'error');
        target.disabled = false; target.textContent = 'Send';
      }
    }

    if (action === 'clear-plan') {
      e.stopPropagation();
      const r = await api.clearManagementPlan(id);
      if (r.success) {
        dashData.plans = dashData.plans.filter(p => p.id != id);
        render(container);
      } else {
        showToast(r.error || 'Failed to clear', 'error');
      }
    }
  });
}

function showFlagModal(id) {
  showModal(`
    <div class="modal-title">Flag for review</div>
    <div class="modal-subtitle">Please elaborate the reason for flagging.</div>
    <textarea class="flag-modal-input" id="flag-reason" placeholder="Type your reason here..."></textarea>
    <div class="modal-actions">
      <button class="btn btn-secondary btn-sm" id="flag-cancel">Cancel</button>
      <button class="btn btn-danger btn-sm" id="flag-submit">Submit</button>
    </div>
  `);
  document.getElementById('flag-cancel').onclick = hideModal;
  document.getElementById('flag-submit').onclick = async () => {
    const reason = document.getElementById('flag-reason').value.trim();
    if (!reason) { showToast('Please add a reason', 'error'); return; }
    const r = await api.flagGeminiSuggestion(id, reason);
    if (r.success) {
      const item = dashData.suggestions.find(s => s.id == id);
      if (item) item._flagged = true;
      hideModal();
      showToast('Flagged for review', 'success');
      render(document.getElementById('page-dashboard'));
    } else {
      showToast(r.error || 'Failed to flag', 'error');
    }
  };
}

function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}
