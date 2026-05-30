/**
 * WebSocket Service — Real-time clinical session
 * ================================================
 * Manages the persistent WS connection for live consultations.
 */

const WS_RECONNECT_DELAY = 2000;
const WS_MAX_RECONNECTS = 5;

class WSService {
  constructor() {
    this.ws = null;
    this.token = null;
    this.serverUrl = null;
    this.sessionId = null;
    this.reconnectAttempts = 0;
    this.listeners = {};
    this._intentionalClose = false;
  }

  /**
   * Set the server base URL (called once from config)
   */
  setServerUrl(url) {
    // Convert http(s) to ws(s)
    this.serverUrl = url.replace(/^http/, 'ws');
  }

  /**
   * Register event listeners
   * Events: session_ready, stage_token, stage_complete, error, 
   *         transcript, audio_confirmed, session_closed, connection_state
   */
  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
    return () => {
      this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    };
  }

  _emit(event, data) {
    (this.listeners[event] || []).forEach(cb => {
      try { cb(data); } catch (e) { console.error(`[WS] Listener error on ${event}:`, e); }
    });
  }

  /**
   * Connect to the WebSocket endpoint
   */
  connect(authToken) {
    this.token = authToken;
    this._intentionalClose = false;
    this.reconnectAttempts = 0;
    this._doConnect();
  }

  _doConnect() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    const wsUrl = `${this.serverUrl}/session/ws?token=${encodeURIComponent(this.token)}`;
    console.log(`[WS] Connecting to ${this.serverUrl}/session/ws`);
    this._emit('connection_state', { state: 'connecting' });

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this.reconnectAttempts = 0;
      this._emit('connection_state', { state: 'connected' });
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._handleMessage(msg);
      } catch (e) {
        console.error('[WS] Parse error:', e);
      }
    };

    this.ws.onerror = (error) => {
      console.error('[WS] Error:', error.message);
      this._emit('error', { code: 'WS_ERROR', message: error.message });
    };

    this.ws.onclose = (event) => {
      console.log(`[WS] Closed: code=${event.code} reason=${event.reason}`);
      this._emit('connection_state', { state: 'disconnected' });

      if (!this._intentionalClose && this.reconnectAttempts < WS_MAX_RECONNECTS) {
        this.reconnectAttempts++;
        const delay = WS_RECONNECT_DELAY * this.reconnectAttempts;
        console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        this._emit('connection_state', { state: 'reconnecting', attempt: this.reconnectAttempts });
        setTimeout(() => this._doConnect(), delay);
      }
    };
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'session_ready':
        this.sessionId = msg.session_id;
        this._emit('session_ready', msg);
        break;
      case 'stage_token':
        this._emit('stage_token', { stage: msg.stage, token: msg.token });
        break;
      case 'stage_complete':
        this._emit('stage_complete', { stage: msg.stage, data: msg.data, timing: msg.timing || null });
        break;
      case 'transcript':
        this._emit('transcript', { text: msg.text, is_final: msg.is_final });
        break;
      case 'audio_confirmed':
        this._emit('audio_confirmed', msg);
        break;
      case 'session_closed':
        this._emit('session_closed', msg);
        break;
      case 'error':
        this._emit('error', msg);
        break;
      case 'ping':
        // Auto-respond with pong to measure network RTT
        this._send({ type: 'pong', ping_ts: msg.ping_ts });
        break;
      default:
        console.log('[WS] Unknown message type:', msg.type);
    }
  }

  _send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[WS] Not connected — cannot send');
      return false;
    }
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  /**
   * Initialize a new session
   */
  initSession(patientId, patientName, gps = {}) {
    return this._send({
      type: 'init',
      patient_id: patientId,
      patient_name: patientName,
      gps,
    });
  }

  /**
   * Reconnect to an existing session
   */
  reconnectSession(sessionId) {
    return this._send({
      type: 'reconnect',
      session_id: sessionId,
    });
  }

  /**
   * Send audio data (base64 encoded)
   */
  sendAudio(base64Data, timestamp) {
    return this._send({
      type: 'audio',
      data: base64Data,
      t: timestamp,
    });
  }

  /**
   * Send a phase marker
   * marker: 'history_complete' | 'diagnosis_complete' | 'management_complete'
   */
  sendMarker(marker, timestamp) {
    return this._send({
      type: 'marker',
      marker,
      t: timestamp,
    });
  }

  /**
   * End the session
   */
  endSession(durationSeconds) {
    this._send({
      type: 'session_end',
      t: durationSeconds,
    });
  }

  /**
   * Send transcription timing back to server for latency breakdown
   */
  sendTranscriptionTiming(transcriptionMs) {
    return this._send({
      type: 'transcription_timing',
      transcription_ms: transcriptionMs,
    });
  }

  /**
   * Disconnect cleanly
   */
  disconnect() {
    this._intentionalClose = true;
    if (this.ws) {
      try { this.ws.close(1000, 'Client disconnect'); } catch {}
      this.ws = null;
    }
    this.sessionId = null;
    this._emit('connection_state', { state: 'disconnected' });
  }

  get isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}

// Singleton
const wsService = new WSService();
export default wsService;
