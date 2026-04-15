"""
CDST Session Orchestrator
=========================
Central WebSocket handler for the full clinical consultation session.

Handles the complete session lifecycle:
  1. Session init — patient lookup, Vault initialisation
  2. Continuous audio → Deepgram STT → rolling transcript accumulation
  3. Marker A → History Stage → questionnaire streamed to nurse
  4. Marker B → Diagnosis Stage → differential streamed to nurse
  5. Marker C → Management Stage → triage output delivered to nurse
  6. Session end → Vault closed, doctor notification triggered

WebSocket protocol
------------------
Client → Server:
  { "type": "init", "patient_id": "P-00123", "nurse_id": "N-001",
    "gps": { "district": "Murshidabad", "district_code": "WB_MSD",
             "lat": 24.18, "lng": 88.27 } }

  { "type": "reconnect", "session_id": "sess_abc123" }

  { "type": "audio", "data": "<base64-encoded opus chunk>", "t": 12.4 }
    — t is session-relative seconds; sent continuously

  { "type": "marker", "marker": "history_complete", "t": 94.3 }
    — valid markers: "history_complete", "diagnosis_complete", "management_complete"

  { "type": "session_end", "t": 742.0 }

  { "type": "audio_uploaded",
    "url": "s3://cdst-media/sessions/sess_abc123/audio.opus",
    "codec": "opus", "duration_seconds": 742, "size_bytes": 1893422 }
    — device calls this after background S3 upload completes

Server → Client:
  { "type": "session_ready", "session_id": "sess_abc123", "is_new_patient": true }
  { "type": "transcript", "text": "...", "is_final": true }
  { "type": "stage_token", "stage": "history|diagnosis", "token": "..." }
  { "type": "stage_complete", "stage": "history|diagnosis|management", "data": {...} }
  { "type": "session_closed", "risk_tier": "low|high" }
  { "type": "audio_confirmed" }
  { "type": "error", "code": "AUTH_FAILED|SESSION_NOT_FOUND|...", "message": "..." }

Authentication
--------------
JWT Bearer token required in the Authorization header at WebSocket upgrade time.
Expected claims: { "nurse_id": "N-001", "role": "nurse", "clinic_id": "C-042" }

Dependencies:
    pip install fastapi uvicorn asyncpg deepgram-sdk PyJWT python-dotenv
"""

import asyncio
import base64
import json
import logging
import os
import uuid
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Optional

import asyncpg
import jwt
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# Stage imports — stage functions are called directly from the orchestrator.
# Each stage handles its own Vault writes; the orchestrator owns the lifecycle.
from history_stage import (
    extract_chief_complaint,
    generate_questionnaire,
    validate_questionnaire,
    extract_patient_record_update,
    stream_questionnaire,
    load_baseline_diseases,
    load_epi_prior,
)
from diagnosis_stage import (
    extract_medical_concepts,
    generate_differential,
    validate_differential,
    stream_differential,
    generate_clarifying_questions,
    run_diagnosis_stage,
)
from management_stage import run_management_stage


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DATABASE_URL      = os.environ.get("DATABASE_URL", "postgresql://localhost/cdst")
JWT_SECRET        = os.environ.get("JWT_SECRET", "change-me-in-production")
JWT_ALGORITHM     = "HS256"
DEEPGRAM_API_KEY  = os.environ.get("DEEPGRAM_API_KEY", "")
DEEPGRAM_LANGUAGE = os.environ.get("DEEPGRAM_LANGUAGE", "hi")  # Bengali: "bn"; Hindi: "hi"
AUDIO_RETAIN_DAYS = 90

log = logging.getLogger("cdst.orchestrator")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)


# ---------------------------------------------------------------------------
# Database connection pool
# ---------------------------------------------------------------------------

_pool: Optional[asyncpg.Pool] = None


async def _init_pool() -> None:
    global _pool
    _pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)
    log.info("Database pool initialised — %s", DATABASE_URL)


async def _close_pool() -> None:
    global _pool
    if _pool:
        await _pool.close()
        log.info("Database pool closed")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await _init_pool()
    yield
    await _close_pool()


async def get_pool() -> asyncpg.Pool:
    if _pool is None:
        await _init_pool()
    return _pool


# ---------------------------------------------------------------------------
# JWT authentication
# ---------------------------------------------------------------------------

def verify_jwt(token: str) -> dict:
    """Decode and verify JWT. Returns claims. Raises HTTPException on failure."""
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail=f"Invalid token: {exc}")


def extract_token(websocket: WebSocket) -> str:
    """Pull Bearer token from WebSocket upgrade headers."""
    auth = websocket.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Authorization: Bearer header")
    return auth[7:]


# ---------------------------------------------------------------------------
# Patient records service
# ---------------------------------------------------------------------------

async def load_patient_record(conn: asyncpg.Connection, patient_id: str) -> dict:
    """
    Load patient summary from patient_records table.
    Returns empty dict for unknown patients — History Stage treats an empty
    record as a new patient and collects a full intake.
    """
    row = await conn.fetchrow(
        "SELECT summary FROM patient_records WHERE patient_id = $1",
        patient_id,
    )
    return json.loads(row["summary"]) if row else {}


# ---------------------------------------------------------------------------
# Vault helpers
# ---------------------------------------------------------------------------

async def vault_init(
    conn: asyncpg.Connection,
    session_id: str,
    patient_id: str,
    nurse_id: str,
    gps: dict,
    patient_record: dict,
) -> None:
    """
    Create the initial Vault document. Called once at session start.
    The patient_record is pre-loaded from patient_records and written here
    so all agents can read it from the Vault without hitting patient_records again.
    """
    demographics = dict(patient_record.get("demographics", {}))
    demographics["patient_id"] = patient_id

    document = {
        "patient_id":         patient_id,
        "nurse_id":           nurse_id,
        "demographics":       demographics,
        "gps":                gps,
        "patient_record":     patient_record,
        "session_started_at": datetime.now(timezone.utc).isoformat(),
        "transcript_full":    "",
        "transcript_segments": {
            "phase_1": "",
            "phase_2": "",
            "phase_3": "",
        },
        "audio": {
            "upload_status": "pending",
            "retain_until":  None,
        },
        "risk_tier":          None,
        "doctor_auth_status": "pending",
    }

    await conn.execute(
        "INSERT INTO sessions (session_id, data) VALUES ($1, $2::jsonb)",
        session_id,
        json.dumps(document),
    )
    log.info(
        "[%s] Vault initialised — patient_id=%s nurse_id=%s",
        session_id, patient_id, nurse_id,
    )


async def vault_read(conn: asyncpg.Connection, session_id: str) -> dict:
    row = await conn.fetchrow(
        "SELECT data FROM sessions WHERE session_id = $1", session_id
    )
    if not row:
        raise ValueError(f"Session {session_id} not found in Vault")
    return json.loads(row["data"])


async def vault_update(conn: asyncpg.Connection, session_id: str, patch: dict) -> None:
    """Shallow-merge patch fields into the Vault JSONB document."""
    await conn.execute(
        """
        UPDATE sessions
        SET data       = data || $2::jsonb,
            updated_at = now()
        WHERE session_id = $1
        """,
        session_id,
        json.dumps(patch),
    )


async def vault_set_nested(
    conn: asyncpg.Connection,
    session_id: str,
    path: list[str],
    value,
) -> None:
    """
    Set a single nested key using jsonb_set.
    path = ["transcript_segments", "phase_2"]
    """
    await conn.execute(
        """
        UPDATE sessions
        SET data       = jsonb_set(data, $2::text[], $3::jsonb, true),
            updated_at = now()
        WHERE session_id = $1
        """,
        session_id,
        path,
        json.dumps(value),
    )


async def vault_append_transcript(
    conn: asyncpg.Connection,
    session_id: str,
    text: str,
) -> None:
    """Append a space-separated transcript chunk to transcript_full."""
    await conn.execute(
        """
        UPDATE sessions
        SET data = jsonb_set(
                data,
                '{transcript_full}',
                to_jsonb(coalesce(data->>'transcript_full', '') || $2),
                true
            ),
            updated_at = now()
        WHERE session_id = $1
        """,
        session_id,
        text + " ",
    )


# ---------------------------------------------------------------------------
# Deepgram STT integration
# ---------------------------------------------------------------------------

class DeepgramConnection:
    """
    Wraps a Deepgram live transcription WebSocket.

    Forwards audio bytes from the mobile client to Deepgram and relays
    transcripts back via the on_transcript callback.

    Falls back to a no-op stub when DEEPGRAM_API_KEY is not set,
    so the orchestrator can be tested without a live Deepgram account.
    """

    def __init__(self, session_id: str, on_transcript):
        self.session_id    = session_id
        self.on_transcript = on_transcript
        self._connection   = None
        self._stub         = not bool(DEEPGRAM_API_KEY)

    async def connect(self) -> None:
        if self._stub:
            log.warning(
                "[%s] DEEPGRAM_API_KEY not set — STT running in stub mode. "
                "Audio will be received but not transcribed.",
                self.session_id,
            )
            return

        from deepgram import DeepgramClient, LiveTranscriptionEvents, LiveOptions

        dg = DeepgramClient(api_key=DEEPGRAM_API_KEY)
        self._connection = dg.listen.asynclive.v("1")

        async def _on_transcript(_self, result, **_kwargs):
            try:
                alt        = result.channel.alternatives[0]
                transcript = alt.transcript
                is_final   = result.is_final
                if transcript:
                    await self.on_transcript(transcript, is_final)
            except Exception as exc:
                log.warning("[%s] Transcript parse error: %s", self.session_id, exc)

        self._connection.on(LiveTranscriptionEvents.Transcript, _on_transcript)

        options = LiveOptions(
            model           = "nova-2",
            language        = DEEPGRAM_LANGUAGE,
            punctuate       = True,
            interim_results = True,
            encoding        = "opus",
            sample_rate     = 16000,
            channels        = 1,
        )
        await self._connection.start(options)
        log.info("[%s] Deepgram connected (language=%s)", self.session_id, DEEPGRAM_LANGUAGE)

    async def send(self, audio_bytes: bytes) -> None:
        if self._connection:
            await self._connection.send(audio_bytes)

    async def close(self) -> None:
        if self._connection:
            try:
                await self._connection.finish()
            except Exception as exc:
                log.warning("[%s] Deepgram close error: %s", self.session_id, exc)
            self._connection = None
            log.info("[%s] Deepgram connection closed", self.session_id)


# ---------------------------------------------------------------------------
# Per-session in-memory state
# ---------------------------------------------------------------------------

class SessionState:
    """
    In-memory state for one active consultation session.

    Transcript accumulation happens here first (fast path) and is
    flushed to the Vault asynchronously. On reconnect, state is
    rebuilt from the Vault if the server restarted.
    """

    def __init__(self, session_id: str, conn: asyncpg.Connection):
        self.session_id    = session_id
        self.conn          = conn

        # Rolling transcript — grows throughout the session
        self.transcript_full: str  = ""

        # Transcript text accumulated up to each marker press
        self.phase_1_end: str = ""   # text at marker A
        self.phase_2_end: str = ""   # text at marker B

        # Session-relative timestamps (seconds) for each marker
        self.marker_a_at: Optional[float] = None
        self.marker_b_at: Optional[float] = None
        self.marker_c_at: Optional[float] = None

        self.dg: Optional[DeepgramConnection] = None

        # Ring buffer: last ~60s of audio chunks for reconnect replay
        # Each element: (session_relative_seconds, audio_bytes)
        self.ring_buffer: deque[tuple[float, bytes]] = deque(maxlen=600)

    async def append_transcript(self, text: str, is_final: bool) -> None:
        """Accumulate final transcript chunks and persist to Vault."""
        if is_final and text.strip():
            self.transcript_full += text + " "
            await vault_append_transcript(self.conn, self.session_id, text)

    @classmethod
    async def from_vault(cls, session_id: str, conn: asyncpg.Connection) -> "SessionState":
        """Rebuild in-memory state from the Vault (used after server restart)."""
        state = cls(session_id, conn)
        ctx   = await vault_read(conn, session_id)
        segs  = ctx.get("transcript_segments", {})

        state.transcript_full = ctx.get("transcript_full", "")
        state.phase_1_end     = segs.get("phase_1", "")
        state.phase_2_end     = state.phase_1_end + segs.get("phase_2", "")
        state.marker_a_at     = ctx.get("marker_a_at")
        state.marker_b_at     = ctx.get("marker_b_at")
        state.marker_c_at     = ctx.get("marker_c_at")
        return state


# ---------------------------------------------------------------------------
# Active session registry
# ---------------------------------------------------------------------------

_active: dict[str, SessionState] = {}


# ---------------------------------------------------------------------------
# Safe WebSocket send helper
# ---------------------------------------------------------------------------

async def ws_send(ws: WebSocket, payload: dict) -> bool:
    """Send JSON to client. Returns False if the connection is closed."""
    try:
        await ws.send_json(payload)
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Marker A — History Stage
# ---------------------------------------------------------------------------

async def handle_marker_a(ws: WebSocket, state: SessionState, t: float) -> None:
    """
    Nurse pressed button after ~30s opening. Patient has stated name, age,
    village, chief complaint, and duration. Nothing else is known.

    Flow:
      1. Snapshot the transcript at this moment as phase_1
      2. Extract chief complaint (Call 1, ~700ms)
      3. Concurrently:
         a. stream_questionnaire → tokens to nurse (human-readable, display only)
         b. generate_questionnaire → structured JSON → Vault
      4. Send stage_complete with structured questionnaire

    Target: first token on screen within 1.5s of button press.
    """
    state.marker_a_at = t
    state.phase_1_end = state.transcript_full

    await vault_update(state.conn, state.session_id, {"marker_a_at": t})
    await vault_set_nested(
        state.conn, state.session_id,
        ["transcript_segments", "phase_1"],
        state.phase_1_end,
    )

    phase_1 = state.phase_1_end
    session_id = state.session_id
    conn = state.conn

    async def run():
        try:
            vault_ctx      = await vault_read(conn, session_id)
            patient_record = vault_ctx.get("patient_record", {})
            gps            = vault_ctx.get("gps", {})
            district_code  = gps.get("district_code", "WB_UNKNOWN")
            month          = datetime.now().month

            baseline = load_baseline_diseases()
            epi      = load_epi_prior(district_code, month)

            # Call 1: extract chief complaint from the ~30s opening
            log.info("[%s] History Call 1: extracting chief complaint", session_id)
            chief = await extract_chief_complaint(phase_1, vault_ctx)
            await vault_update(conn, session_id, {"chief_complaint": chief})

            # Concurrent: stream to nurse + generate structured JSON
            async def do_stream():
                async for token in stream_questionnaire(
                    chief, vault_ctx, baseline, epi, patient_record
                ):
                    await ws_send(ws, {"type": "stage_token", "stage": "history", "token": token})

            async def do_structured():
                q    = await generate_questionnaire(chief, vault_ctx, baseline, epi, patient_record)
                q    = validate_questionnaire(q)
                stub = extract_patient_record_update(q, chief, session_id)
                await vault_update(conn, session_id, {
                    "questionnaire":              q,
                    "patient_record_stub":        stub,
                    "history_stage_status":       "complete",
                    "history_stage_completed_at": datetime.now(timezone.utc).isoformat(),
                })
                return q

            log.info("[%s] History Call 2: streaming questionnaire + structured write", session_id)
            questionnaire, _ = await asyncio.gather(do_structured(), do_stream())

            await ws_send(ws, {
                "type":  "stage_complete",
                "stage": "history",
                "data":  questionnaire,
            })
            log.info("[%s] History stage complete", session_id)

        except Exception as exc:
            log.exception("[%s] History stage error: %s", session_id, exc)
            await ws_send(ws, {"type": "error", "code": "HISTORY_STAGE_ERROR", "message": str(exc)})

    asyncio.create_task(run())


# ---------------------------------------------------------------------------
# Marker B — Diagnosis Stage
# ---------------------------------------------------------------------------

async def handle_marker_b(ws: WebSocket, state: SessionState, t: float) -> None:
    """
    Nurse pressed button after 3-4 minute structured interview.

    Flow:
      1. Snapshot phase 2 transcript (marker A → marker B)
      2. Extract medical concepts (Call 1, ~900ms)
      3. Concurrently:
         a. stream_differential → tokens to nurse (display only)
         b. generate_differential → structured Vault write
      4. Generate clarifying questions (Call 3, ~1.4s)
      5. Send stage_complete with full differential + clarifying questions

    Target: differential starts streaming within 1.5s of button press.
    """
    state.marker_b_at = t
    state.phase_2_end = state.transcript_full

    phase_2    = state.transcript_full[len(state.phase_1_end):]
    session_id = state.session_id
    conn       = state.conn

    await vault_update(conn, session_id, {"marker_b_at": t})
    await vault_set_nested(conn, session_id, ["transcript_segments", "phase_2"], phase_2)

    async def run():
        try:
            vault_ctx     = await vault_read(conn, session_id)
            gps           = vault_ctx.get("gps", {})
            district_code = gps.get("district_code", "WB_UNKNOWN")
            month         = datetime.now().month

            baseline = load_baseline_diseases()
            epi      = load_epi_prior(district_code, month)

            # Call 1: concept extraction
            log.info("[%s] Diagnosis Call 1: extracting medical concepts", session_id)
            concepts = await extract_medical_concepts(phase_2, vault_ctx)
            await vault_update(conn, session_id, {"extracted_concepts": concepts})

            # Concurrent: stream differential to nurse + generate structured DDx
            async def do_stream():
                async for token in stream_differential(concepts, vault_ctx, baseline, epi):
                    await ws_send(ws, {"type": "stage_token", "stage": "diagnosis", "token": token})

            async def do_structured():
                ddx = await generate_differential(concepts, vault_ctx, baseline, epi)
                ddx = validate_differential(ddx)
                await vault_update(conn, session_id, {"differential_table": ddx})
                return ddx

            log.info("[%s] Diagnosis Call 2: streaming differential + structured write", session_id)
            ddx, _ = await asyncio.gather(do_structured(), do_stream())

            # Call 3: clarifying questions (constrained to bedside tools)
            log.info("[%s] Diagnosis Call 3: clarifying questions", session_id)
            clarifying = await generate_clarifying_questions(ddx, concepts, vault_ctx)
            await vault_update(conn, session_id, {
                "clarifying_questions":          clarifying,
                "diagnosis_stage_status":        "complete",
                "diagnosis_stage_completed_at":  datetime.now(timezone.utc).isoformat(),
            })

            await ws_send(ws, {
                "type":  "stage_complete",
                "stage": "diagnosis",
                "data": {
                    "differential":        ddx,
                    "clarifying_questions": clarifying,
                },
            })
            log.info("[%s] Diagnosis stage complete", session_id)

        except Exception as exc:
            log.exception("[%s] Diagnosis stage error: %s", session_id, exc)
            await ws_send(ws, {"type": "error", "code": "DIAGNOSIS_STAGE_ERROR", "message": str(exc)})

    asyncio.create_task(run())


# ---------------------------------------------------------------------------
# Marker C — Management Stage
# ---------------------------------------------------------------------------

async def handle_marker_c(ws: WebSocket, state: SessionState, t: float) -> None:
    """
    Nurse pressed button after 1-2 minute clarifying questions phase.

    The Management Stage runs its four-call pipeline including RAG and the
    deterministic rule engine. Its run function handles all Vault writes
    internally, so we just await it and forward the result.

    Full pipeline: ~7-8s. No token streaming for management — the structured
    triage output is delivered as a single message on completion.
    """
    state.marker_c_at = t

    phase_3    = state.transcript_full[len(state.phase_2_end):]
    session_id = state.session_id
    conn       = state.conn

    await vault_update(conn, session_id, {"marker_c_at": t})
    await vault_set_nested(conn, session_id, ["transcript_segments", "phase_3"], phase_3)

    async def run():
        try:
            log.info("[%s] Management stage: four-call pipeline starting", session_id)
            result    = await run_management_stage(session_id, phase_3, conn)
            triage    = result.get("triage", {})
            risk_tier = result.get("rule_engine", {}).get("final_risk_tier", "high")

            await ws_send(ws, {
                "type":  "stage_complete",
                "stage": "management",
                "data": {
                    "triage_output":        triage,
                    "risk_tier":            risk_tier,
                    "provisional_diagnosis": result.get("provisional_dx", {}),
                    "risk_assessment":      result.get("risk_assessment", {}),
                },
            })

            # HIGH risk: notify doctor immediately
            if risk_tier == "high":
                asyncio.create_task(_notify_doctor(session_id, triage))

            log.info("[%s] Management stage complete — risk_tier=%s", session_id, risk_tier)

        except Exception as exc:
            log.exception("[%s] Management stage error: %s", session_id, exc)
            await ws_send(ws, {"type": "error", "code": "MANAGEMENT_STAGE_ERROR", "message": str(exc)})

    asyncio.create_task(run())


# ---------------------------------------------------------------------------
# Session end
# ---------------------------------------------------------------------------

async def handle_session_end(ws: WebSocket, state: SessionState, t: float) -> None:
    """
    Write final transcript segments and session metadata to Vault.
    Close Deepgram. Audio upload is the device's responsibility —
    the server records the retain_until date when the device confirms upload.
    """
    vault_ctx = await vault_read(state.conn, state.session_id)
    risk_tier = vault_ctx.get("risk_tier", "unknown")

    # Final transcript segment snapshot
    phase_3 = (
        state.transcript_full[len(state.phase_2_end):]
        if state.marker_c_at else ""
    )

    await vault_update(state.conn, state.session_id, {
        "session_ended_at":        datetime.now(timezone.utc).isoformat(),
        "session_duration_seconds": t,
        "transcript_segments": {
            "phase_1": state.phase_1_end,
            "phase_2": state.transcript_full[len(state.phase_1_end):len(state.phase_2_end)],
            "phase_3": phase_3,
        },
    })

    if state.dg:
        await state.dg.close()

    _active.pop(state.session_id, None)

    await ws_send(ws, {"type": "session_closed", "risk_tier": risk_tier})
    log.info(
        "[%s] Session closed — risk_tier=%s duration=%.1fs",
        state.session_id, risk_tier, t,
    )


# ---------------------------------------------------------------------------
# Doctor notification stub
# ---------------------------------------------------------------------------

async def _notify_doctor(session_id: str, triage_output: dict) -> None:
    """
    Push notification to the on-call doctor for HIGH risk cases.
    Replace this stub with FCM / SMS gateway integration.
    """
    one_liner = triage_output.get("triage", {}).get("one_liner", "see session")
    log.warning(
        "[%s] HIGH RISK — doctor notification triggered. one_liner=%s",
        session_id, one_liner,
    )
    # TODO: call FCM / SMS / paging service here


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------

app = FastAPI(title="CDST Session Orchestrator", lifespan=lifespan)


@app.websocket("/session/ws")
async def session_websocket(websocket: WebSocket):
    """
    Main WebSocket endpoint. One connection per consultation.

    The connection stays open from session init until session_end.
    On reconnect after a drop, the client sends { "type": "reconnect" }
    with the existing session_id and then flushes its ring-buffered audio.
    """
    # Authenticate at WebSocket upgrade time
    try:
        token  = extract_token(websocket)
        claims = verify_jwt(token)
    except HTTPException as exc:
        await websocket.close(code=4001, reason=exc.detail)
        return

    await websocket.accept()

    pool  = await get_pool()
    conn  = await pool.acquire()
    state: Optional[SessionState] = None

    try:
        # ── Handshake: first message must be init or reconnect ────────────────
        raw      = await websocket.receive_json()
        msg_type = raw.get("type")

        if msg_type == "init":
            session_id = f"sess_{uuid.uuid4().hex[:16]}"
            patient_id = raw.get("patient_id", "")
            nurse_id   = claims.get("nurse_id", "unknown")
            gps        = raw.get("gps", {})

            patient_record = await load_patient_record(conn, patient_id)
            is_new_patient = not bool(patient_record)

            await vault_init(conn, session_id, patient_id, nurse_id, gps, patient_record)

            state = SessionState(session_id, conn)
            _active[session_id] = state

            await ws_send(websocket, {
                "type":          "session_ready",
                "session_id":    session_id,
                "is_new_patient": is_new_patient,
            })
            log.info("[%s] Session started — patient_id=%s", session_id, patient_id)

        elif msg_type == "reconnect":
            session_id = raw.get("session_id", "")

            try:
                # Try to get in-memory state first (avoids Vault read if server running)
                state = _active.get(session_id)
                if state is None:
                    state = await SessionState.from_vault(session_id, conn)
                    _active[session_id] = state
            except ValueError:
                await ws_send(websocket, {
                    "type":    "error",
                    "code":    "SESSION_NOT_FOUND",
                    "message": f"Session {session_id} not found",
                })
                return

            await ws_send(websocket, {
                "type":       "session_ready",
                "session_id": session_id,
                "reconnected": True,
            })
            log.info("[%s] Client reconnected", session_id)

        else:
            await ws_send(websocket, {
                "type":    "error",
                "code":    "PROTOCOL_ERROR",
                "message": "First message must be 'init' or 'reconnect'",
            })
            return

        # ── Open Deepgram STT connection ──────────────────────────────────────
        async def on_transcript(text: str, is_final: bool) -> None:
            await state.append_transcript(text, is_final)
            await ws_send(websocket, {
                "type":     "transcript",
                "text":     text,
                "is_final": is_final,
            })

        state.dg = DeepgramConnection(state.session_id, on_transcript)
        await state.dg.connect()

        # ── Main receive loop ─────────────────────────────────────────────────
        while True:
            raw      = await websocket.receive_json()
            msg_type = raw.get("type")

            if msg_type == "audio":
                audio_b64   = raw.get("data", "")
                t           = float(raw.get("t", 0.0))
                audio_bytes = base64.b64decode(audio_b64)
                state.ring_buffer.append((t, audio_bytes))
                await state.dg.send(audio_bytes)

            elif msg_type == "marker":
                marker = raw.get("marker", "")
                t      = float(raw.get("t", 0.0))
                log.info("[%s] Marker: %s at t=%.1fs", state.session_id, marker, t)

                if marker == "history_complete":
                    await handle_marker_a(websocket, state, t)
                elif marker == "diagnosis_complete":
                    await handle_marker_b(websocket, state, t)
                elif marker == "management_complete":
                    await handle_marker_c(websocket, state, t)
                else:
                    log.warning("[%s] Unknown marker: %s", state.session_id, marker)

            elif msg_type == "session_end":
                t = float(raw.get("t", 0.0))
                await handle_session_end(websocket, state, t)
                break  # Close the receive loop; WebSocket will close naturally

            elif msg_type == "audio_uploaded":
                # Device reports background S3 upload is complete
                retain_until = (
                    datetime.now(timezone.utc) + timedelta(days=AUDIO_RETAIN_DAYS)
                ).strftime("%Y-%m-%d")
                await vault_set_nested(
                    conn, state.session_id, ["audio"],
                    {
                        "url":              raw.get("url", ""),
                        "codec":            raw.get("codec", "opus"),
                        "duration_seconds": raw.get("duration_seconds"),
                        "size_bytes":       raw.get("size_bytes"),
                        "upload_status":    "complete",
                        "uploaded_at":      datetime.now(timezone.utc).isoformat(),
                        "retain_until":     retain_until,
                        "retention_days":   AUDIO_RETAIN_DAYS,
                    },
                )
                await ws_send(websocket, {"type": "audio_confirmed"})
                log.info(
                    "[%s] Audio upload recorded — retain_until=%s",
                    state.session_id, retain_until,
                )

            else:
                log.warning("[%s] Unknown message type: %s", state.session_id, msg_type)

    except WebSocketDisconnect:
        sid = state.session_id if state else "unknown"
        log.info("[%s] Client disconnected (ring_buffer=%d chunks)",
                 sid, len(state.ring_buffer) if state else 0)
        # Session remains in Vault; client may reconnect with { "type": "reconnect" }

    except Exception as exc:
        sid = state.session_id if state else "unknown"
        log.exception("[%s] Unhandled error: %s", sid, exc)
        await ws_send(websocket, {
            "type":    "error",
            "code":    "INTERNAL_ERROR",
            "message": str(exc),
        })

    finally:
        # Close Deepgram if still open (e.g. after an exception)
        if state and state.dg:
            try:
                await state.dg.close()
            except Exception:
                pass
        await pool.release(conn)


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------

@app.get("/session/{session_id}/status")
async def session_status(session_id: str):
    """
    Return current session state for doctor/admin review.
    Used by the doctor review queue to check stage completion status.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        try:
            ctx = await vault_read(conn, session_id)
        except ValueError:
            raise HTTPException(status_code=404, detail="Session not found")

    return {
        "session_id":               session_id,
        "risk_tier":                ctx.get("risk_tier"),
        "doctor_auth_status":       ctx.get("doctor_auth_status"),
        "history_stage_status":     ctx.get("history_stage_status"),
        "diagnosis_stage_status":   ctx.get("diagnosis_stage_status"),
        "management_stage_status":  ctx.get("management_stage_status"),
        "session_started_at":       ctx.get("session_started_at"),
        "session_ended_at":         ctx.get("session_ended_at"),
    }


class DoctorAuthRequest(BaseModel):
    decision:     str    # "approved" | "modified" | "rejected"
    doctor_id:    str
    notes:        Optional[str] = None
    modified_rx:  Optional[list] = None   # if decision is "modified"


@app.post("/session/{session_id}/doctor-auth")
async def doctor_auth(session_id: str, req: DoctorAuthRequest):
    """
    Doctor approves, modifies, or rejects a management plan.

    For LOW risk cases this is async review (4-hour window).
    For HIGH risk cases the nurse has already escalated — this records
    the outcome for the audit trail.
    """
    valid = {"approved", "modified", "rejected"}
    if req.decision not in valid:
        raise HTTPException(status_code=400, detail=f"decision must be one of {valid}")

    pool = await get_pool()
    async with pool.acquire() as conn:
        try:
            ctx = await vault_read(conn, session_id)
        except ValueError:
            raise HTTPException(status_code=404, detail="Session not found")

        patch: dict = {
            "doctor_auth_status": req.decision,
            "doctor_auth_at":     datetime.now(timezone.utc).isoformat(),
            "doctor_id":          req.doctor_id,
        }
        if req.notes:
            patch["doctor_notes"] = req.notes
        if req.decision == "modified" and req.modified_rx:
            patch["modified_prescription"] = req.modified_rx

        await vault_update(conn, session_id, patch)

    log.info(
        "[%s] Doctor auth recorded — decision=%s doctor=%s",
        session_id, req.decision, req.doctor_id,
    )
    return {"session_id": session_id, "doctor_auth_status": req.decision}


@app.get("/health")
async def health():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("orchestrator:app", host="0.0.0.0", port=8000, reload=False)
