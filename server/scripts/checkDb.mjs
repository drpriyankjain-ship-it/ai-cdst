import 'dotenv/config';
import pg from 'pg';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const s = await c.query('SELECT COUNT(*) FROM sessions');
console.log('sessions:', s.rows[0].count);

const cq = await c.query('SELECT COUNT(*) FROM case_queue');
console.log('case_queue:', cq.rows[0].count);

const ar = await c.query('SELECT COUNT(*) FROM audio_records');
console.log('audio_records:', ar.rows[0].count);

const sm = await c.query('SELECT COUNT(*) FROM session_metrics');
console.log('session_metrics:', sm.rows[0].count);

const recent = await c.query("SELECT session_id, created_at, data->>'risk_tier' as tier, data->>'management_stage_status' as mgmt FROM sessions ORDER BY created_at DESC LIMIT 10");
console.log('\nrecent sessions:');
recent.rows.forEach(r => console.log(' ', r.session_id, '|', r.tier, '|', r.mgmt, '|', r.created_at));

await c.end();
