// API Service for backend calls
// Optimized with caching and error handling
import AsyncStorage from '@react-native-async-storage/async-storage';

// Default to local backend in dev; allow override via EXPO_PUBLIC_API_URL.
const DEV_API_URL =
  process.env.EXPO_PUBLIC_API_URL ||
  'http://172.20.10.2:3000/api';

const PROD_API_URL =
  process.env.EXPO_PUBLIC_API_URL ||
  'https://v2.nurseai.in/api';
const API_BASE_URL = __DEV__
  ? DEV_API_URL
  : PROD_API_URL; // Production URL

const AUTH_TOKEN_KEY = '@nurseai_auth_token';

// Mock Mode Configuration
const MOCK_MODE = false; // Backend is now connected

// Cache configuration
const CACHE_DURATION = 30000; // 30 seconds
const cache = new Map();

// Mock Data for testing without backend
const MOCK_DASHBOARD_SUMMARY = {
  pending: 5,
  done: 12,
};

const MOCK_PATIENT_TASKS = [
  {
    id: '1',
    patientName: 'John Doe',
    taskDescription: 'Administer medication - Morning dose',
    scheduledTime: '09:00 AM',
    emergencyLevel: 'High',
    status: 'Pending',
  },
  {
    id: '2',
    patientName: 'Jane Smith',
    taskDescription: 'Vital signs check',
    scheduledTime: '10:30 AM',
    emergencyLevel: 'Medium',
    status: 'Pending',
  },
  {
    id: '3',
    patientName: 'Robert Johnson',
    taskDescription: 'Wound dressing change',
    scheduledTime: '11:00 AM',
    emergencyLevel: 'High',
    status: 'Pending',
  },
  {
    id: '4',
    patientName: 'Mary Williams',
    taskDescription: 'Physical therapy session',
    scheduledTime: '02:00 PM',
    emergencyLevel: 'Low',
    status: 'Pending',
  },
  {
    id: '5',
    patientName: 'David Brown',
    taskDescription: 'Blood test results review',
    scheduledTime: '03:30 PM',
    emergencyLevel: 'Medium',
    status: 'Done',
  },
];

const MOCK_TRANSCRIPTS = [
  {
    id: '1',
    title: 'Patient Consultation - Morning',
    content: 'Patient presented with mild fever and headache. Vital signs stable. Prescribed rest and hydration.',
    patient_name: 'John Doe',
    created_at: new Date(Date.now() - 86400000).toISOString(), // Yesterday
  },
  {
    id: '2',
    title: 'Follow-up Visit',
    content: 'Patient recovering well. No complications observed. Continue current medication regimen.',
    patient_name: 'Jane Smith',
    created_at: new Date(Date.now() - 172800000).toISOString(), // 2 days ago
  },
  {
    id: '3',
    title: 'Emergency Assessment',
    content: 'Patient admitted with chest pain. ECG performed. Results normal. Monitoring continued.',
    patient_name: 'Robert Johnson',
    created_at: new Date(Date.now() - 259200000).toISOString(), // 3 days ago
  },
];

// Helper function to check if we should use mock mode
const shouldUseMockMode = (result) => {
  // Only use mock mode if explicitly enabled
  // No fallback to mock mode on errors - let errors propagate
  return MOCK_MODE;
};

// Helper function to get cached data
const getCachedData = (key) => {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data;
  }
  return null;
};

// Helper function to set cache
const setCachedData = (key, data) => {
  cache.set(key, { data, timestamp: Date.now() });
};

// Get auth token
const getAuthToken = async () => {
  try {
    return await AsyncStorage.getItem(AUTH_TOKEN_KEY);
  } catch (error) {
    return null;
  }
};

// Generic API call function with error handling and auth token
export const apiCall = async (endpoint, options = {}) => {
  try {
    const token = await getAuthToken();
    const url = `${API_BASE_URL}${endpoint}`;
    
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    // Add auth token if available
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      console.log(`🔑 Using auth token: ${token.substring(0, 20)}...`);
    } else {
      console.log(`⚠️ No auth token found for endpoint: ${endpoint}`);
    }

    console.log(`🌐 Making API call to: ${url}`);

    const response = await fetch(url, {
      headers,
      ...options,
    });

    if (!response.ok) {
      // Handle 401 Unauthorized - but only for authenticated endpoints
      // Don't treat login/register 401 as session expired (those are valid auth failures)
      if (response.status === 401) {
        const isAuthEndpoint =
          endpoint.includes('/auth/login') ||
          endpoint.includes('/auth/register') ||
          endpoint.includes('/auth/verify-otp') ||
          endpoint.includes('/auth/resend-otp') ||
          endpoint.includes('/auth/request-password-reset') ||
          endpoint.includes('/auth/reset-password');
        
        if (!isAuthEndpoint && token) {
          // This is an authenticated endpoint that returned 401 - token expired
        await AsyncStorage.removeItem(AUTH_TOKEN_KEY);
        throw new Error('Session expired. Please login again.');
      }
        // For auth endpoints, 401 is a valid response (wrong credentials, etc.)
        // Just return the error message from the backend
      }
      
      const errorText = await response.text();
      let errorMessage;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error || errorText;
      } catch {
        errorMessage = errorText || `API Error: ${response.status}`;
      }
      
      console.error(`❌ API Error ${response.status}:`, errorMessage);
      throw new Error(errorMessage);
    }

    const data = await response.json();
    console.log(`✅ API Success for ${endpoint}`);
    return { success: true, data };
  } catch (error) {
    console.error(`❌ API Error for ${endpoint}:`, error.message);
    // Provide user-friendly error messages
    if (error.message.includes('Network request failed') || error.message.includes('Failed to fetch')) {
      return { 
        success: false, 
        error: 'No internet connection. Please check your Wi-Fi or mobile data and try again.' 
      };
    }
    if (error.message === 'Session expired. Please login again.') {
      return { success: false, error: error.message };
    }
    // Pass through the actual server error message instead of hiding it
    return { success: false, error: error.message || 'Something went wrong. Please try again in a moment.' };
  }
};

// API Methods
const unwrapApiData = (result) => {
  if (!result || !result.success) return null;
  // apiCall returns { success: true, data: <backend_response> }
  // backend_response is typically { success: true, data: <payload> }
  return result.data && result.data.data !== undefined ? result.data.data : result.data;
};

export const apiService = {
  getBaseUrl: () => API_BASE_URL,
  getConsentStatus: async () => {
    const result = await apiCall('/auth/consent');
    if (result.success) {
      const payload = unwrapApiData(result);
      return {success: true, data: payload};
    }
    return result;
  },

  acceptConsent: async () => {
    const result = await apiCall('/auth/consent', {
      method: 'POST',
      body: JSON.stringify({accepted: true}),
    });
    if (result.success) {
      const payload = unwrapApiData(result);
      return {success: true, data: payload};
    }
    return result;
  },

  // Get dashboard summary (pending and done counts)
  getDashboardSummary: async () => {
    const cacheKey = 'dashboard-summary';
    const cached = getCachedData(cacheKey);
    if (cached) return { success: true, data: cached };

    const result = await apiCall('/dashboard/summary');
    
    // If backend is not available, use mock mode
    if (shouldUseMockMode(result)) {
      console.log('🔧 Mock Mode: Dashboard summary');
      setCachedData(cacheKey, MOCK_DASHBOARD_SUMMARY);
      return { success: true, data: MOCK_DASHBOARD_SUMMARY };
    }
    
    if (result.success) {
      const payload = unwrapApiData(result);
      setCachedData(cacheKey, payload);
      return { success: true, data: payload };
    }
    return result;
  },

  // Get patient tasks
  getPatientTasks: async (params = {}) => {
    const cacheKey = `patient-tasks-${JSON.stringify(params)}`;
    const cached = getCachedData(cacheKey);
    if (cached) return { success: true, data: cached };

    const queryString = new URLSearchParams(params).toString();
    const endpoint = `/dashboard/patient-tasks${queryString ? `?${queryString}` : ''}`;
    const result = await apiCall(endpoint);
    
    // If backend is not available, use mock mode
    if (shouldUseMockMode(result)) {
      console.log('🔧 Mock Mode: Patient tasks');
      let mockTasks = [...MOCK_PATIENT_TASKS];
      
      // Filter by status if provided
      if (params.status) {
        mockTasks = mockTasks.filter(task => task.status === params.status);
      }
      
      // Filter by patient name if provided
      if (params.patientName) {
        mockTasks = mockTasks.filter(
          task => task.patientName?.toLowerCase() === params.patientName.toLowerCase()
        );
      }
      
      // Filter by patient ID if provided
      if (params.patientId) {
        mockTasks = mockTasks.filter(task => task.patientId === params.patientId);
      }
      
      setCachedData(cacheKey, mockTasks);
      return { success: true, data: mockTasks };
    }
    
    if (result.success) {
      const payload = unwrapApiData(result);
      setCachedData(cacheKey, payload);
      return { success: true, data: payload };
    }
    return result;
  },

  completePatientTask: async (id) => {
    const result = await apiCall(`/dashboard/patient-tasks/${id}/complete`, {
      method: 'PATCH',
    });
    if (result.success) {
      const payload = unwrapApiData(result);
      return {success: true, data: payload};
    }
    return result;
  },

  getLatestGeminiSuggestion: async (params = {}) => {
    const queryString = new URLSearchParams(params).toString();
    const endpoint = `/transcripts/gemini-latest${queryString ? `?${queryString}` : ''}`;
    const result = await apiCall(endpoint);
    if (result.success) {
      const payload = unwrapApiData(result);
      return {success: true, data: payload};
    }
    return result;
  },

  updateGeminiMissingData: async (id, missingData) => {
    const result = await apiCall(`/transcripts/${id}/missing-data`, {
      method: 'PATCH',
      body: JSON.stringify({missingData}),
    });
    if (result.success) {
      const payload = unwrapApiData(result);
      return {success: true, data: payload};
    }
    return result;
  },

  followupGeminiSuggestion: async (id, message, patientId = null) => {
    const result = await apiCall(`/transcripts/${id}/followup`, {
      method: 'POST',
      body: JSON.stringify({message, patientId}),
    });
    if (result.success) {
      const payload = unwrapApiData(result);
      return {success: true, data: payload};
    }
    return result;
  },

  generateProforma: async (symptoms) => {
    const result = await apiCall('/transcripts/proforma', {
      method: 'POST',
      body: JSON.stringify({symptoms}),
    });
    if (result.success) {
      const payload = unwrapApiData(result);
      return {success: true, data: payload};
    }
    return result;
  },

  flagGeminiSuggestion: async (id, reason = '') => {
    const result = await apiCall(`/transcripts/${id}/flag`, {
      method: 'POST',
      body: JSON.stringify({reason}),
    });
    if (result.success) {
      const payload = unwrapApiData(result);
      return {success: true, data: payload};
    }
    return result;
  },

  // Get transcript by ID
  getTranscript: async (id) => {
    const result = await apiCall(`/transcripts/${id}`);
    
    // If backend is not available, use mock mode
    if (shouldUseMockMode(result)) {
      console.log('🔧 Mock Mode: Get transcript');
      const mockTranscript = MOCK_TRANSCRIPTS.find(t => t.id === id) || MOCK_TRANSCRIPTS[0];
      return { success: true, data: mockTranscript };
    }
    
    return result;
  },

  // Save transcript
  saveTranscript: async (transcriptData) => {
    const result = await apiCall('/transcripts', {
      method: 'POST',
      body: JSON.stringify(transcriptData),
    });
    
    // If backend is not available, use mock mode
    if (shouldUseMockMode(result)) {
      console.log('🔧 Mock Mode: Save transcript');
      const newTranscript = {
        id: Date.now().toString(),
        ...transcriptData,
        created_at: new Date().toISOString(),
      };
      MOCK_TRANSCRIPTS.unshift(newTranscript);
      cache.clear();
      return { success: true, data: newTranscript };
    }
    
    // Clear cache after saving
    cache.clear();
    return result;
  },

  // Upload a 12-second m4a segment to the server's in-memory session buffer.
  // Used by the session-based WebSocket flow. Returns { ok, buffered_segments }.
  uploadAudioSegment: async (sessionId, phase, segmentIndex, uri, photoUris = []) => {
    try {
      const token = await getAuthToken();
      const url = `${API_BASE_URL.replace('/api', '')}/api/session/${sessionId}/audio-segment`;

      const filename = uri.split('/').pop() || `seg${segmentIndex}.m4a`;
      const normalizedUri = uri.startsWith('file://') || uri.startsWith('content://') ? uri : `file://${uri}`;

      const formData = new FormData();
      formData.append('audio', { uri: normalizedUri, name: filename, type: 'audio/mp4' });
      formData.append('phase', String(phase));
      formData.append('segment_index', String(segmentIndex));

      for (const photoUri of photoUris) {
        const photoName = photoUri.split('/').pop() || 'photo.jpg';
        const ext = photoName.split('.').pop()?.toLowerCase() || 'jpg';
        const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' };
        formData.append('photos', { uri: photoUri, name: photoName, type: mimeMap[ext] || 'image/jpeg' });
      }

      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s per segment
      const response = await fetch(url, { method: 'POST', headers, body: formData, signal: controller.signal });
      clearTimeout(timeoutId);

      const data = await response.json().catch(() => ({}));
      if (!response.ok) return { success: false, error: data.error || `Segment upload failed: ${response.status}` };
      return { success: true, data };
    } catch (error) {
      if (error.name === 'AbortError') return { success: false, error: 'Segment upload timed out' };
      if (error.message?.includes('Network request failed')) return { success: false, error: 'No internet connection' };
      return { success: false, error: error.message };
    }
  },

  // Upload audio recording (supports optional second audio segment)
  uploadAudio: async ({uri, photoUri, patientName, patientId, secondAudioUri}) => {
    try {
      const token = await getAuthToken();
      const url = `${API_BASE_URL}/audio/upload`;

      const formData = new FormData();

      const resolveAudioFile = (audioUri, fieldName) => {
        const fn = audioUri.split('/').pop() || 'recording.m4a';
        const ext = fn.split('.').pop()?.toLowerCase() || 'm4a';
        const typeMap = {
          m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
          caf: 'audio/x-caf', aac: 'audio/aac', '3gp': 'audio/3gpp', '3gpp': 'audio/3gpp',
        };
        const ft = typeMap[ext] || 'audio/mp4';
        const normalized = audioUri.startsWith('file://') || audioUri.startsWith('content://')
          ? audioUri : `file://${audioUri}`;
        return {uri: normalized, name: fn, type: ft};
      };

      const mainAudio = resolveAudioFile(uri, 'audio');
      console.log(`Audio upload: uri=${mainAudio.uri}, name=${mainAudio.name}, type=${mainAudio.type}`);
      formData.append('audio', mainAudio);

      if (secondAudioUri) {
        const secondAudio = resolveAudioFile(secondAudioUri, 'audio2');
        console.log(`Audio2 upload: uri=${secondAudio.uri}, name=${secondAudio.name}, type=${secondAudio.type}`);
        formData.append('audio2', secondAudio);
      }

      if (photoUri) {
        const photoName = photoUri.split('/').pop() || 'photo.jpg';
        let photoType = 'image/jpeg';
        if (photoName.endsWith('.png')) {
          photoType = 'image/png';
        } else if (photoName.endsWith('.webp')) {
          photoType = 'image/webp';
        } else if (photoName.endsWith('.heic')) {
          photoType = 'image/heic';
        }

        formData.append('photo', {
          uri: photoUri,
          name: photoName,
          type: photoType,
        });
      }

      if (patientName) formData.append('patientName', patientName);
      if (patientId) formData.append('patientId', patientId);

      const headers = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 180000); // 3 min timeout for Gemini processing

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        return {success: false, status: response.status, error: data.error || 'Upload failed', data};
      }

      return {success: true, data};
    } catch (error) {
      console.error('Audio upload error:', error);
      if (error.name === 'AbortError') {
        return {success: false, error: 'Upload timed out. The AI is processing — please check your history in a moment.'};
      }
      if (error.message?.includes('Network request failed') || error.message?.includes('Failed to fetch')) {
        return {success: false, error: 'No internet connection. Please check your Wi-Fi or mobile data and try again.'};
      }
      return {success: false, error: 'Something went wrong. Please try again in a moment.'};
    }
  },

  extractProforma: async (audioUri, patientId) => {
    try {
      const token = await getAuthToken();
      const url = `${API_BASE_URL}/audio/extract-proforma`;

      const filename = audioUri.split('/').pop() || 'segment.m4a';
      const extension = filename.split('.').pop()?.toLowerCase() || 'm4a';
      const audioTypeMap = {
        m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
        caf: 'audio/x-caf', aac: 'audio/aac', '3gp': 'audio/3gpp', '3gpp': 'audio/3gpp',
      };
      const fileType = audioTypeMap[extension] || 'audio/mp4';

      const normalizedUri = audioUri.startsWith('file://') || audioUri.startsWith('content://')
        ? audioUri : `file://${audioUri}`;

      const formData = new FormData();
      formData.append('audio', {uri: normalizedUri, name: filename, type: fileType});
      if (patientId) formData.append('patientId', patientId);

      const headers = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 180000); // 3 min timeout for dual Gemini calls

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        return {success: false, status: response.status, error: data.error || 'Extract proforma failed', data};
      }

      return {success: true, data};
    } catch (error) {
      console.error('Extract proforma error:', error);
      if (error.name === 'AbortError') {
        return {success: false, error: 'Proforma extraction timed out. The AI is taking longer than usual — please try again.'};
      }
      if (error.message?.includes('Network request failed') || error.message?.includes('Failed to fetch')) {
        return {success: false, error: 'No internet connection. Please check your Wi-Fi or mobile data and try again.'};
      }
      return {success: false, error: 'Something went wrong. Please try again in a moment.'};
    }
  },

  submitClarifyingAnswers: async (audioRecordId, answerAudioUri) => {
    try {
      const token = await AsyncStorage.getItem(AUTH_TOKEN_KEY);
      const url = `${API_BASE_URL}/audio/${audioRecordId}/prescribe`;

      const filename = answerAudioUri.split('/').pop() || 'answer.m4a';
      const extension = filename.split('.').pop()?.toLowerCase() || 'm4a';
      const audioTypeMap = {
        m4a: 'audio/mp4',
        mp4: 'audio/mp4',
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        caf: 'audio/x-caf',
        aac: 'audio/aac',
        '3gp': 'audio/3gpp',
        '3gpp': 'audio/3gpp',
      };
      const fileType = audioTypeMap[extension] || 'audio/mp4';

      const normalizedUri =
        answerAudioUri.startsWith('file://') || answerAudioUri.startsWith('content://')
          ? answerAudioUri
          : `file://${answerAudioUri}`;

      const formData = new FormData();
      formData.append('answerAudio', {
        uri: normalizedUri,
        name: filename,
        type: fileType,
      });

      const headers = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 180000); // 3 min timeout for prescription generation

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        return {success: false, status: response.status, error: data.error || 'Prescription failed', data};
      }

      return {success: true, data};
    } catch (error) {
      console.error('Submit clarifying answers error:', error);
      if (error.name === 'AbortError') {
        return {success: false, error: 'Prescription generation timed out. Please try again.'};
      }
      if (error.message?.includes('Network request failed') || error.message?.includes('Failed to fetch')) {
        return {success: false, error: 'No internet connection. Please check your Wi-Fi or mobile data and try again.'};
      }
      return {success: false, error: 'Something went wrong. Please try again in a moment.'};
    }
  },

  retryGeminiForAudio: async (audioRecordId) => {
    const result = await apiCall(`/audio/${audioRecordId}/retry-gemini`, {
      method: 'POST',
    });
    if (result.success) {
      const payload = unwrapApiData(result);
      return {success: true, data: payload};
    }
    return result;
  },

  getGroupedTranscripts: async () => {
    const result = await apiCall('/transcripts/grouped');
    if (result.success) {
      const payload = unwrapApiData(result);
      return {success: true, data: payload};
    }
    return result;
  },

  // Get comprehensive patient record (all visits, reasoning, follow-ups)
  getPatientRecord: async (patientId) => {
    const result = await apiCall(`/patient-record/${encodeURIComponent(patientId)}`);
    if (result.success) {
      const payload = unwrapApiData(result);
      return {success: true, data: payload};
    }
    return result;
  },

  // Check if a patient ID already exists
  checkPatientExists: async (patientId) => {
    const result = await apiCall(`/patient-record/${encodeURIComponent(patientId)}/check`);
    if (result.success) {
      const payload = unwrapApiData(result);
      return {success: true, data: payload};
    }
    return result;
  },

  // Get all transcripts (history)
  getTranscripts: async (params = {}) => {
    const cacheKey = `transcripts-${JSON.stringify(params)}`;
    const cached = getCachedData(cacheKey);
    if (cached) return { success: true, data: cached };

    const queryString = new URLSearchParams(params).toString();
    const endpoint = `/transcripts${queryString ? `?${queryString}` : ''}`;
    const result = await apiCall(endpoint);
    
    // If backend is not available, use mock mode
    if (shouldUseMockMode(result)) {
      console.log('🔧 Mock Mode: Get transcripts');
      let mockTranscripts = [...MOCK_TRANSCRIPTS];
      
      // Filter by patient name if provided
      if (params.patientName) {
        mockTranscripts = mockTranscripts.filter(
          t => t.patientName?.toLowerCase() === params.patientName.toLowerCase()
        );
      }
      
      // Filter by patient ID if provided
      if (params.patientId) {
        mockTranscripts = mockTranscripts.filter(
          t => t.patientId === params.patientId
        );
      }
      
      setCachedData(cacheKey, mockTranscripts);
      return { success: true, data: mockTranscripts };
    }
    
    if (result.success) {
      const payload = unwrapApiData(result);
      setCachedData(cacheKey, payload);
      return { success: true, data: payload };
    }
    return result;
  },

  // Get latest Gemini suggestion for a patient
  getLatestGeminiSuggestion: async (params = {}) => {
    const cacheKey = `gemini-latest-${JSON.stringify(params)}`;
    const cached = getCachedData(cacheKey);
    if (cached) return {success: true, data: cached};

    const queryString = new URLSearchParams(params).toString();
    const endpoint = `/transcripts/gemini-latest${queryString ? `?${queryString}` : ''}`;
    const result = await apiCall(endpoint);

    if (result.success) {
      const payload = unwrapApiData(result);
      setCachedData(cacheKey, payload);
      return {success: true, data: payload};
    }
    return result;
  },

  // Get all Gemini suggestions for dashboard
  getGeminiSuggestions: async (params = {}) => {
    const cacheKey = `gemini-suggestions-${JSON.stringify(params)}`;
    const cached = getCachedData(cacheKey);
    if (cached) return {success: true, data: cached};

    const queryString = new URLSearchParams(params).toString();
    const endpoint = `/transcripts/gemini-suggestions${queryString ? `?${queryString}` : ''}`;
    const result = await apiCall(endpoint);

    if (result.success) {
      const payload = unwrapApiData(result);
      setCachedData(cacheKey, payload);
      return {success: true, data: payload};
    }
    return result;
  },

  // Mark Gemini suggestion completed
  completeGeminiSuggestion: async (id) => {
    const result = await apiCall(`/transcripts/${id}/complete`, {
      method: 'PATCH',
    });
    return result;
  },

  // Reopen a completed Gemini suggestion
  reopenGeminiSuggestion: async (id) => {
    const result = await apiCall(`/transcripts/${id}/reopen`, {
      method: 'PATCH',
    });
    return result;
  },

  // ============================================================
  // Management Plans — patient_log
  // ============================================================

  // Get active management plans for dashboard
  getManagementPlans: async () => {
    const cacheKey = 'management-plans';
    const cached = getCachedData(cacheKey);
    if (cached) return {success: true, data: cached};

    const result = await apiCall('/dashboard/management-plans');
    if (result.success) {
      const payload = unwrapApiData(result);
      setCachedData(cacheKey, payload);
      return {success: true, data: payload};
    }
    return result;
  },

  // Clear a management plan from dashboard (moves to history)
  clearManagementPlan: async (id) => {
    const result = await apiCall(`/dashboard/management-plans/${id}/clear`, {
      method: 'POST',
    });
    if (result.success) {
      cache.delete('management-plans');
    }
    return result;
  },

  // Get cleared management plans for history page
  getManagementPlanHistory: async () => {
    const cacheKey = 'management-plan-history';
    const cached = getCachedData(cacheKey);
    if (cached) return {success: true, data: cached};

    const result = await apiCall('/dashboard/management-plans/history');
    if (result.success) {
      const payload = unwrapApiData(result);
      setCachedData(cacheKey, payload);
      return {success: true, data: payload};
    }
    return result;
  },

  // Clear cache
  clearCache: () => {
    cache.clear();
  },
};

export default apiService;

