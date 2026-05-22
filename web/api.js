/* NurseAI Web — API Service */
const API_BASE_URL = window.location.origin + '/api';
const AUTH_TOKEN_KEY = '@nurseai_auth_token';
const CACHE_DURATION = 30000;
const cache = new Map();

function getCached(k) { const c = cache.get(k); return c && Date.now() - c.ts < CACHE_DURATION ? c.d : null; }
function setCache(k, d) { cache.set(k, { d, ts: Date.now() }); }

function getAuthToken() { return localStorage.getItem(AUTH_TOKEN_KEY); }

async function apiCall(endpoint, options = {}) {
  try {
    const token = getAuthToken();
    const url = `${API_BASE_URL}${endpoint}`;
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(url, { headers, ...options });
    if (!response.ok) {
      if (response.status === 401) {
        const isAuth = endpoint.includes('/auth/');
        if (!isAuth && token) {
          localStorage.removeItem(AUTH_TOKEN_KEY);
          throw new Error('Session expired. Please login again.');
        }
      }
      const errText = await response.text();
      let errMsg;
      try { errMsg = JSON.parse(errText).error || errText; } catch { errMsg = errText || `API Error: ${response.status}`; }
      throw new Error(errMsg);
    }
    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError'))
      return { success: false, error: 'No internet connection. Please check your connection.' };
    if (error.message === 'Session expired. Please login again.')
      return { success: false, error: error.message };
    return { success: false, error: error.message || 'Something went wrong.' };
  }
}

function unwrap(result) {
  if (!result?.success) return null;
  return result.data?.data !== undefined ? result.data.data : result.data;
}

async function apiFormUpload(url, formData, timeoutMs = 180000) {
  const token = getAuthToken();
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'POST', headers, body: formData, signal: controller.signal });
    clearTimeout(tid);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { success: false, status: response.status, error: data.error || 'Upload failed', data };
    return { success: true, data };
  } catch (error) {
    clearTimeout(tid);
    if (error.name === 'AbortError') return { success: false, error: 'Upload timed out. Please try again.' };
    return { success: false, error: 'Network error during upload.' };
  }
}

const api = {
  login: async (email, password) => {
    const r = await apiCall('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    if (r.success) return { success: true, data: unwrap(r) || r.data };
    return r;
  },
  register: async (name, email, password, phone) => {
    const r = await apiCall('/auth/register', { method: 'POST', body: JSON.stringify({ name, email, password, phone }) });
    if (r.success) return { success: true, data: unwrap(r) || r.data };
    return r;
  },
  verifyOtp: async (email, otp) => {
    const r = await apiCall('/auth/verify-otp', { method: 'POST', body: JSON.stringify({ email, otp }) });
    if (r.success) return { success: true, data: unwrap(r) || r.data };
    return r;
  },
  resendOtp: async (email) => {
    const r = await apiCall('/auth/resend-otp', { method: 'POST', body: JSON.stringify({ email }) });
    return r;
  },
  getDashboardSummary: async () => {
    const c = getCached('summary'); if (c) return { success: true, data: c };
    const r = await apiCall('/dashboard/summary');
    if (r.success) { const d = unwrap(r); setCache('summary', d); return { success: true, data: d }; }
    return r;
  },
  getPatientTasks: async (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    const r = await apiCall(`/dashboard/patient-tasks${qs ? '?' + qs : ''}`);
    if (r.success) return { success: true, data: unwrap(r) };
    return r;
  },
  completePatientTask: async (id) => {
    const r = await apiCall(`/dashboard/patient-tasks/${id}/complete`, { method: 'PATCH' });
    if (r.success) return { success: true, data: unwrap(r) };
    return r;
  },
  getGeminiSuggestions: async () => {
    const c = getCached('gemini'); if (c) return { success: true, data: c };
    const r = await apiCall('/transcripts/gemini-suggestions');
    if (r.success) { const d = unwrap(r); setCache('gemini', d); return { success: true, data: d }; }
    return r;
  },
  getLatestGeminiSuggestion: async (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    const r = await apiCall(`/transcripts/gemini-latest${qs ? '?' + qs : ''}`);
    if (r.success) return { success: true, data: unwrap(r) };
    return r;
  },
  followupGeminiSuggestion: async (id, message, patientId) => {
    const r = await apiCall(`/transcripts/${id}/followup`, { method: 'POST', body: JSON.stringify({ message, patientId }) });
    if (r.success) return { success: true, data: unwrap(r) };
    return r;
  },
  flagGeminiSuggestion: async (id, reason) => {
    const r = await apiCall(`/transcripts/${id}/flag`, { method: 'POST', body: JSON.stringify({ reason }) });
    if (r.success) return { success: true, data: unwrap(r) };
    return r;
  },
  completeGeminiSuggestion: async (id) => {
    const r = await apiCall(`/transcripts/${id}/complete`, { method: 'PATCH' });
    return r;
  },
  reopenGeminiSuggestion: async (id) => {
    const r = await apiCall(`/transcripts/${id}/reopen`, { method: 'PATCH' });
    return r;
  },
  generateProforma: async (symptoms) => {
    const r = await apiCall('/transcripts/proforma', { method: 'POST', body: JSON.stringify({ symptoms }) });
    if (r.success) return { success: true, data: unwrap(r) };
    return r;
  },
  getManagementPlans: async () => {
    const c = getCached('mgmt'); if (c) return { success: true, data: c };
    const r = await apiCall('/dashboard/management-plans');
    if (r.success) { const d = unwrap(r); setCache('mgmt', d); return { success: true, data: d }; }
    return r;
  },
  clearManagementPlan: async (id) => {
    const r = await apiCall(`/dashboard/management-plans/${id}/clear`, { method: 'POST' });
    if (r.success) cache.delete('mgmt');
    return r;
  },
  getManagementPlanHistory: async () => {
    const c = getCached('mgmt-hist'); if (c) return { success: true, data: c };
    const r = await apiCall('/dashboard/management-plans/history');
    if (r.success) { const d = unwrap(r); setCache('mgmt-hist', d); return { success: true, data: d }; }
    return r;
  },
  getGroupedTranscripts: async () => {
    const r = await apiCall('/transcripts/grouped');
    if (r.success) return { success: true, data: unwrap(r) };
    return r;
  },
  checkPatientExists: async (patientId) => {
    const r = await apiCall(`/patient-record/${encodeURIComponent(patientId)}/check`);
    if (r.success) return { success: true, data: unwrap(r) };
    return r;
  },
  getPatientRecord: async (patientId) => {
    const r = await apiCall(`/patient-record/${encodeURIComponent(patientId)}`);
    if (r.success) return { success: true, data: unwrap(r) };
    return r;
  },
  uploadAudio: async (formData) => {
    return apiFormUpload(`${API_BASE_URL}/audio/upload`, formData);
  },
  extractProforma: async (audioBlob, patientId) => {
    const fd = new FormData();
    const ext = audioBlob.type?.includes('mp4') ? '.m4a' : '.webm';
    fd.append('audio', audioBlob, `segment${ext}`);
    if (patientId) fd.append('patientId', patientId);
    return apiFormUpload(`${API_BASE_URL}/audio/extract-proforma`, fd);
  },
  submitClarifyingAnswers: async (audioRecordId, answerBlob) => {
    const fd = new FormData();
    const ext = answerBlob.type?.includes('mp4') ? '.m4a' : '.webm';
    fd.append('answerAudio', answerBlob, `answer${ext}`);
    return apiFormUpload(`${API_BASE_URL}/audio/${audioRecordId}/prescribe`, fd);
  },
  retryGeminiForAudio: async (id) => {
    const r = await apiCall(`/audio/${id}/retry-gemini`, { method: 'POST' });
    if (r.success) return { success: true, data: unwrap(r) };
    return r;
  },
  updateGeminiMissingData: async (id, missingData) => {
    const r = await apiCall(`/transcripts/${id}/missing-data`, { method: 'PATCH', body: JSON.stringify({ missingData }) });
    if (r.success) return { success: true, data: unwrap(r) };
    return r;
  },
  clearCache: () => cache.clear(),
};

export default api;
