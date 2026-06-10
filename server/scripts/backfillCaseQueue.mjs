import 'dotenv/config';
import pg from 'pg';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

// Backfill case_queue from completed sessions that have a risk_tier
const result = await c.query(`
  INSERT INTO case_queue (session_id, risk_tier, status, created_at)
  SELECT
    session_id,
    COALESCE(data->>'risk_tier', 'LOW') AS risk_tier,
    'active' AS status,
    created_at
  FROM sessions
  WHERE data->>'management_stage_status' = 'complete'
    AND session_id NOT IN (SELECT session_id FROM case_queue)
  ON CONFLICT (session_id) DO NOTHING
`);

console.log(`Backfilled ${result.rowCount} sessions into case_queue`);

// Verify
const cq = await c.query('SELECT COUNT(*) FROM case_queue');
console.log(`case_queue now has ${cq.rows[0].count} rows`);

const sample = await c.query(`
  SELECT cq.session_id, cq.risk_tier, cq.status, s.data->>'patient_id' as pid
  FROM case_queue cq
  JOIN sessions s ON cq.session_id = s.session_id
  ORDER BY cq.created_at DESC LIMIT 5
`);
console.log('\nSample:');
sample.rows.forEach(r => console.log(' ', r.session_id, '|', r.risk_tier, '|', r.status, '| patient:', r.pid));

await c.end();
