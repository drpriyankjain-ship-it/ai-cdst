# Audit Tables — Schema Completion and Case Queue Redesign

**Status:** Implemented  
**Branch:** main  
**Date:** 2026-06-03  
**Author:** Priyank Jain

---

## Summary

Five tables referenced in production code had no CREATE TABLE definition anywhere —
not in `schema.sql` and not in `setupDb.js`. Every session was silently failing all
audit logging. Additionally, the `patient_log` table (referenced in `orchestrator.js`,
`dashboard.js`, and `audio.js`) duplicated clinical data already stored in the vault.
This change adds the four tables that are genuinely needed, removes the one that is not,
and replaces `patient_log` with a slim `case_queue` table that stores only dashboard
workflow state.

---

## Problem

### Missing table definitions

The following tables were called from live code but never defined:

| Table | Written by | Read by |
|---|---|---|
| `llm_results` | `insertLlmResult` in `db.js` — called after every LLM call | `insertSessionMetrics` aggregation; analytics dashboard |
| `pipeline_failures` | `insertPipelineFailure` in `db.js` — called on any stage exception | Analytics failures dashboard |
| `session_metrics` | `insertSessionMetrics` in `db.js` — called after Marker C | All analytics endpoints |
| `patient_log` | Orchestrator after Marker C; legacy `audio.js` upload route | Management plans dashboard |
| `session_audio` | `upsertSessionAudio` in `db.js` (defined but never called) | Session audio dashboard endpoints |

All five functions were wrapped in `try/catch` that logged errors and continued,
so the pipeline never crashed. However, every session silently lost its entire
operational record — cost, latency, token counts, error history, and dashboard state.

### `patient_log` duplicated vault data

The `patient_log` INSERT in `orchestrator.js` read back from the vault to copy
`questionnaire`, `clarifying_questions`, `problem_list`, `triage_output`, and
`risk_assessment` into a separate table row. All of this data already lives in
the vault (`sessions.data`). The only thing `patient_log` actually needed to
provide that the vault did not was a `status` field (`'active'` | `'cleared'`)
for the nurse's dashboard queue — a workflow state, not a clinical record.

### `session_audio` was dead code

`upsertSessionAudio` was defined in `db.js` with full upsert logic, and two
`GET` endpoints in `dashboard.js` read from it. However, `upsertSessionAudio`
was never called from the orchestrator or any route — nothing wrote to it.
In the current WebSocket architecture, audio metadata (phase URLs, retain_until)
lives in the vault under `data.audio`. The `session_audio` table was a remnant
of an earlier design that was superseded but never removed.

---

## Decisions

### Keep: `llm_results`, `pipeline_failures`, `session_metrics`

These three tables store data that does not exist anywhere else:

- **`llm_results`** — The vault stores clinical outputs (differential, problem list,
  etc.) but not operational metadata: which model was used, how many tokens, how
  long the call took, what it cost. This is the only durable record of per-call
  cost and latency. `session_metrics` aggregates from it; the analytics dashboard
  reads it for per-call breakdowns and model usage trends.

- **`pipeline_failures`** — Console logs are ephemeral. If a stage fails repeatedly
  for a specific district or model, you cannot detect the pattern across sessions
  from logs alone after a server restart. Durable failure rows are required for
  production monitoring.

- **`session_metrics`** — A denormalized per-session aggregate computed from
  `llm_results` once after Marker C. Without it, every analytics query would need
  to aggregate across `llm_results` and join with the vault JSONB. Written once,
  read often.

### Replace `patient_log` → `case_queue`

A slim table with four columns replaces `patient_log`:

```sql
CREATE TABLE case_queue (
    session_id  TEXT PRIMARY KEY REFERENCES sessions(session_id),
    risk_tier   TEXT NOT NULL,                   -- 'LOW' | 'HIGH'
    status      TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'cleared'
    cleared_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT now()
);
```

`risk_tier` is the only field denormalized from the vault — it is needed to sort
HIGH cases to the top of the nurse dashboard without joining the vault on every
page load. All clinical data (patient name, one-liner, problem list, triage output)
is read from `sessions.data` via JOIN when the dashboard queries the table.

The orchestrator INSERT shrinks from a 20-line block (including a vault re-read)
to two lines using data already in scope:

```js
await dbClient.query(
  `INSERT INTO case_queue (session_id, risk_tier) VALUES ($1, $2) ON CONFLICT (session_id) DO NOTHING`,
  [sessionId, riskTier]
);
```

The dashboard clear endpoint URL changes from `/management-plans/:id/clear`
(opaque integer from `patient_log.id`) to `/management-plans/:sessionId/clear`
(the session ID string, e.g. `sess_abc123`). Any frontend screen calling this
endpoint must be updated to pass `session_id` instead of the old integer ID.

### Remove `session_audio`

The table is removed entirely:
- `upsertSessionAudio`, `getSessionAudio`, `getSessionAudioIteration` deleted from `db.js`
- `GET /api/dashboard/session-audio/:sessionId` and `GET /api/dashboard/session-audio/:sessionId/:iteration` deleted from `dashboard.js`

Audio metadata is available from `sessions.data.audio` (phase URLs, retain_until,
archived_at) for any dashboard feature that needs it.

---

## Table Schemas

### `llm_results`

```sql
CREATE TABLE llm_results (
    id            SERIAL PRIMARY KEY,
    session_id    TEXT NOT NULL REFERENCES sessions(session_id),
    call_name     TEXT NOT NULL,        -- 'H1_chief_complaint', 'D2_differential', etc.
    stage         TEXT NOT NULL,        -- 'history' | 'diagnosis' | 'management'
    call_order    INT NOT NULL,         -- 1–9, global order across all stages
    model_used    TEXT,
    input_tokens  INT,
    output_tokens INT,
    latency_ms    INT,
    cost_usd      NUMERIC(10,6),
    result        JSONB NOT NULL DEFAULT '{}',
    error         TEXT,
    created_at    TIMESTAMPTZ DEFAULT now()
);
```

`call_order` follows the pipeline sequence: H1=1, H2=2, D1=3, D2=4, D3=5,
M1=6, M2=7, M3=8, M4=9. M3 and M4 run in parallel but are assigned distinct
call_order values.

### `pipeline_failures`

```sql
CREATE TABLE pipeline_failures (
    id          SERIAL PRIMARY KEY,
    session_id  TEXT REFERENCES sessions(session_id),
    user_id     TEXT,
    stage       TEXT,
    call_name   TEXT,
    error_code  TEXT,   -- 'LLM_503' | 'LLM_429' | 'PARSE_ERROR' | 'ENOENT' | 'UNKNOWN'
    error_msg   TEXT,
    created_at  TIMESTAMPTZ DEFAULT now()
);
```

`error_code` is classified deterministically in `insertPipelineFailure` from the
error message string — not inferred by the LLM. This allows failure queries to
filter by type (e.g. all 503s in the last 24 hours) without parsing free-text.

### `session_metrics`

```sql
CREATE TABLE session_metrics (
    session_id               TEXT PRIMARY KEY REFERENCES sessions(session_id),
    user_id                  TEXT,
    patient_id               TEXT,
    total_llm_calls          INT,
    total_input_tokens       INT,
    total_output_tokens      INT,
    total_cost_usd           NUMERIC(10,6),
    total_latency_ms         INT,
    e2e_duration_ms          INT,
    gps_lat                  NUMERIC(9,6),
    gps_lon                  NUMERIC(9,6),
    district_code            TEXT,
    risk_tier                TEXT,
    pipeline_status          TEXT,
    network_rtt_ms           INT,
    total_transcription_ms   INT,
    total_server_overhead_ms INT,
    phase_timings            JSONB,
    created_at               TIMESTAMPTZ DEFAULT now()
);
```

`phase_timings` is a JSONB array of per-stage timing breakdowns (total, Gemini ms,
server overhead ms, per-call latency). Written once after Marker C via
`insertSessionMetrics`, which aggregates `total_*` fields from `llm_results`
in the same call using a single aggregate query.

### `case_queue`

```sql
CREATE TABLE case_queue (
    session_id  TEXT PRIMARY KEY REFERENCES sessions(session_id),
    risk_tier   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    cleared_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT now()
);
```

---

## Files Changed

### `db/schema.sql`
- Added `llm_results`, `pipeline_failures`, `session_metrics`, `case_queue`
  with full column definitions, constraints, and indexes.

### `server/scripts/setupDb.js`
- Added the same four tables as `CREATE TABLE IF NOT EXISTS` blocks (numbered
  7–10 in the creation sequence).
- Added all corresponding indexes as `CREATE INDEX IF NOT EXISTS`.

### `server/lib/db.js`
- Deleted `upsertSessionAudio`, `getSessionAudio`, `getSessionAudioIteration`
  and the `ITERATION_LABELS` constant. These targeted the `session_audio` table
  which is removed.
- `insertLlmResult`, `insertPipelineFailure`, `insertSessionMetrics` are
  unchanged — they were already correctly written; only the target tables were
  missing.

### `server/orchestrator.js`
- Replaced the `patient_log` INSERT block (20 lines, required a vault re-read)
  with a 3-line `case_queue` INSERT using `sessionId` and `riskTier` already
  in scope. No vault re-read needed.

### `server/routes/dashboard.js`
- Deleted `GET /api/dashboard/session-audio/:sessionId` and
  `GET /api/dashboard/session-audio/:sessionId/:iteration`.
- Rewrote `GET /api/dashboard/management-plans`: queries `case_queue JOIN sessions`,
  sorts HIGH risk first then by time. Returns `session_id`, `risk_tier`, `status`,
  `patient_id`, `patient_name`, `nurse_id`, `one_liner` (from vault JSONB).
- Rewrote `POST /api/dashboard/management-plans/:sessionId/clear`: updates
  `case_queue` by `session_id`, sets `cleared_at`. URL param renamed from `:id`
  (integer) to `:sessionId` (string) — **breaking change for any frontend caller**.
- Rewrote `GET /api/dashboard/management-plans/history`: same shape as active
  list, filters `status = 'cleared'`, orders by `cleared_at DESC`.

### `server/routes/audio.js`
- Removed the `patient_log` INSERT from `POST /api/audio/upload`. The legacy
  file-upload flow has no session_id and does not participate in the case queue.

---

## What does NOT change

- `insertLlmResult`, `insertPipelineFailure`, `insertSessionMetrics` in `db.js`
  — these functions were already correct; they just had nowhere to write to.
- All nine LLM stage functions (H1–M4) — unchanged.
- The vault structure — clinical outputs continue to be written to `sessions.data`.
- The analytics dashboard endpoints (`/analytics/session`, `/analytics/user`,
  `/analytics/overview`, `/analytics/failures`) — these already queried
  `llm_results`, `session_metrics`, and `pipeline_failures` correctly.
- The `audio_records` table and `audio.js` upload route (minus the `patient_log`
  insert) — the legacy upload flow is otherwise unchanged.

---

## Running on an existing database

For a database created with an older version of `setupDb.js`, run the new tables
directly:

```bash
node server/scripts/setupDb.js
```

All table creation statements use `CREATE TABLE IF NOT EXISTS` — safe to re-run
against a database that already has the older tables. The four new tables will be
created; existing tables are untouched.
