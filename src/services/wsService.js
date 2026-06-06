/**
 * WebSocket Service — Real-time clinical session
 * ================================================
 * Manages the persistent WS connection for live consultations.
 */

const WS_RECONNECT_DELAY = 2000;
const WS_MAX_RECONNECTS = 5;
const WS_KEEPALIVE_INTERVAL = 25000; // 25s — keeps connection alive past nginx idle timeout
const WS_RAPID_CLOSE_THRESHOLD = 3000; // if connection closes within 3s, count as a failed connect

class WSService {
  constructor() {
    this.ws = null;
    this.token = null;
    this.serverUrl = null;
    this.sessionId = null;
    this.reconnectAttempts = 0;
    this.listeners = {};
    this._intentionalClose = false;
    this._keepaliveInterval = null;
    this._connectedAt = null; // track when connection was established
  }

  /**
   * Set the server base URL (called once from config)
   */
  setServerUrl(url) {
    this.serverUrl = url.replace(/^http/, 'ws');
  }

  /**
   * Register event listeners
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

  _startKeepalive() {
    this._stopKeepalive();
    this._keepaliveInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this._send({ type: 'pong', ping_ts: Date.now() });
      }
    }, WS_KEEPALIVE_INTERVAL);
  }

  _stopKeepalive() {
    if (this._keepaliveInterval) {
      clearInterval(this._keepaliveInterval);
      this._keepaliveInterval = null;
    }
  }

  _doConnect() {
    if (this._intentionalClose) return; // don't reconnect if we intentionally closed

    if (this.ws) {
      // CRITICAL: Detach all handlers BEFORE closing, so the old WS's onclose
      // doesn't trigger a phantom reconnect that kills the new connection 2s later
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    const wsUrl = `${this.serverUrl}/session/ws?token=${encodeURIComponent(this.token)}`;
    console.log(`[WS] Connecting to ${this.serverUrl}/session/ws (attempt ${this.reconnectAttempts})`);
    this._emit('connection_state', { state: 'connecting' });

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this._connectedAt = Date.now();
      // NOTE: Do NOT reset reconnectAttempts here.
      // Only reset after a message is successfully received (proves connection is stable).
      this._emit('connection_state', { state: 'connected' });
      this._startKeepalive();

      // If we have an active session, auto-reconnect it on the server side
      if (this.sessionId) {
        console.log(`[WS] Auto-reconnecting session ${this.sessionId}`);
        this.reconnectSession(this.sessionId);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        // Connection is stable — reset reconnect counter
        this.reconnectAttempts = 0;
        this._handleMessage(msg);
      } catch (e) {
        console.error('[WS] Parse error:', e);
      }
    };

    this.ws.onerror = (error) => {
      console.error('[WS] Error:', error.message);
    };

    this.ws.onclose = (event) => {
      const wasConnectedMs = this._connectedAt ? Date.now() - this._connectedAt : 0;
      console.log(`[WS] Closed: code=${event.code} reason=${event.reason} after=${wasConnectedMs}ms`);
      this._emit('connection_state', { state: 'disconnected' });
      this._stopKeepalive();
      this._connectedAt = null;

      if (this._intentionalClose) return; // don't reconnect

      // If connection closed very quickly, it counts as a failed attempt (don't reset counter)
      // If it lasted a while, reset counter since the connection was stable
      if (wasConnectedMs > WS_RAPID_CLOSE_THRESHOLD) {
        this.reconnectAttempts = 0; // was a stable connection, reset for fresh retries
      }

      if (this.reconnectAttempts < WS_MAX_RECONNECTS) {
        this.reconnectAttempts++;
        const delay = WS_RECONNECT_DELAY * Math.min(this.reconnectAttempts, 5);
        console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${WS_MAX_RECONNECTS})`);
        this._emit('connection_state', { state: 'reconnecting', attempt: this.reconnectAttempts });
        setTimeout(() => this._doConnect(), delay);
      } else {
        console.warn(`[WS] Max reconnect attempts (${WS_MAX_RECONNECTS}) reached — giving up`);
        this._emit('connection_state', { state: 'failed' });
        this._emit('error', { code: 'WS_MAX_RECONNECTS', message: 'Could not maintain a stable connection to the server.' });
      }
    };
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'session_ready':
        this.sessionId = msg.session_id;
        this._emit('session_ready', msg);
        break;
      case 'session_reconnected':
        console.log(`[WS] Session reconnected: ${msg.session_id}`);
        this._emit('session_reconnected', msg);
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
        // Auto-reconnect session if server lost state
        if (msg.code === 'SESSION_LOST' && this.sessionId) {
          console.log(`[WS] Server lost session state — reconnecting ${this.sessionId}`);
          this.reconnectSession(this.sessionId);
          return;
        }
        this._emit('error', msg);
        break;
      case 'ping':
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
  initSession(patientId, patientName, gps = {}, local_month = null) {
    return this._send({
      type: 'init',
      patient_id: patientId,
      patient_name: patientName,
      gps,
      local_month,
    });
  }

  reconnectSession(sessionId) {
    return this._send({ type: 'reconnect', session_id: sessionId });
  }

  sendMarker(marker, timestamp) {
    return this._send({ type: 'marker', marker, t: timestamp });
  }

  endSession(durationSeconds) {
    this._send({ type: 'session_end', t: durationSeconds });
  }

  sendTranscriptionTiming(transcriptionMs) {
    return this._send({ type: 'transcription_timing', transcription_ms: transcriptionMs });
  }

  /**
   * Disconnect cleanly — stops all reconnection
   */
  disconnect() {
    this._intentionalClose = true;
    this._stopKeepalive();
    this.reconnectAttempts = 0;
    if (this.ws) {
      try { this.ws.close(1000, 'Client disconnect'); } catch {}
      this.ws = null;
    }
    this.sessionId = null;
    this._connectedAt = null;
    this._emit('connection_state', { state: 'disconnected' });
  }

  get isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}

const wsService = new WSService();
export default wsService;
