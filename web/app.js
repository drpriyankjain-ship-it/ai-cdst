/* AI-CDST Web — Main Router & State */
import { initLogin, initRegister } from './screens/login.js';
import { initDashboard, refreshDashboard } from './screens/dashboard.js';
import { initRecord, onRecordPageShow } from './screens/record.js';
import { initHistory, refreshHistory } from './screens/history.js';
import { initAbout } from './screens/about.js';

const AUTH_TOKEN_KEY = '@nurseai_auth_token';
const PATIENT_KEY = '@nurseai_current_patient';

export const state = { user: null, token: null, currentPage: null };

// Token management
export function getToken() { return localStorage.getItem(AUTH_TOKEN_KEY); }
export function saveToken(t) { localStorage.setItem(AUTH_TOKEN_KEY, t); state.token = t; }
export function clearToken() { localStorage.removeItem(AUTH_TOKEN_KEY); state.token = null; }
export function getCurrentPatient() { try { return JSON.parse(localStorage.getItem(PATIENT_KEY)); } catch { return null; } }
export function setCurrentPatient(p) { localStorage.setItem(PATIENT_KEY, JSON.stringify(p)); }

// Toast
export function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// Modal
export function showModal(html) {
  const overlay = document.getElementById('modal-overlay');
  overlay.innerHTML = `<div class="modal-card">${html}</div>`;
  overlay.hidden = false;
}
export function hideModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay.hidden = true;
  overlay.innerHTML = '';
}
export function confirmDialog(title, message, confirmText = 'OK', cancelText = 'Cancel') {
  return new Promise(resolve => {
    showModal(`
      <div class="consent-title">${title}</div>
      <div class="consent-body">${message}</div>
      <div class="consent-actions">
        <button class="consent-cancel" id="modal-cancel">${cancelText}</button>
        <button class="consent-agree" id="modal-confirm">${confirmText}</button>
      </div>
    `);
    document.getElementById('modal-cancel').onclick = () => { hideModal(); resolve(false); };
    document.getElementById('modal-confirm').onclick = () => { hideModal(); resolve(true); };
  });
}

// Navigation
const pageInitMap = {};
let initialized = {};

export function navigate(page) {
  if (page !== 'login' && page !== 'register' && !getToken()) {
    page = 'login';
  }

  // Hide all pages
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

  const section = document.getElementById(`page-${page}`);
  if (!section) { console.error('Unknown page:', page); return; }
  section.classList.add('active');

  // Tab bar visibility
  const tabBar = document.getElementById('tab-bar');
  const authPages = ['login', 'register'];
  tabBar.hidden = authPages.includes(page);

  // Update active tab
  document.querySelectorAll('.tab-item').forEach(t => {
    t.classList.toggle('active', t.dataset.page === page);
  });

  // Init page if not already
  if (!initialized[page] && pageInitMap[page]) {
    pageInitMap[page](section);
    initialized[page] = true;
  }

  // Fire page-show callbacks
  if (page === 'dashboard' && initialized.dashboard) refreshDashboard();
  if (page === 'record' && initialized.record) onRecordPageShow();
  if (page === 'history' && initialized.history) refreshHistory();

  state.currentPage = page;
  window.location.hash = page;
}

// Register page init functions
pageInitMap.login = initLogin;
pageInitMap.register = initRegister;
pageInitMap.dashboard = initDashboard;
pageInitMap.record = initRecord;
pageInitMap.history = initHistory;
pageInitMap.about = initAbout;

// Boot
document.addEventListener('DOMContentLoaded', () => {
  // Tab bar clicks
  document.querySelectorAll('.tab-item').forEach(tab => {
    tab.addEventListener('click', () => navigate(tab.dataset.page));
  });

  // Close modal on overlay click
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) hideModal();
  });

  // Route from hash
  state.token = getToken();
  const hash = window.location.hash.replace('#', '') || '';
  const validPages = ['login', 'register', 'dashboard', 'record', 'history', 'about'];
  const target = validPages.includes(hash) ? hash : (state.token ? 'dashboard' : 'login');
  navigate(target);
});

window.addEventListener('hashchange', () => {
  const page = window.location.hash.replace('#', '');
  if (page && page !== state.currentPage) navigate(page);
});
