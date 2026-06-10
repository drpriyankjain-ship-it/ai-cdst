import 'dotenv/config';
import pg from 'pg';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

// Get session_audio columns
const cols = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'session_audio' ORDER BY ordinal_position`);
console.log('session_audio columns:', cols.rows.map(r => r.column_name));

// Check a completed session's full vault
const res = await c.query(`SELECT session_id, jsonb_object_keys(data) AS key FROM sessions WHERE data->>'management_stage_status' = 'complete' ORDER BY created_at DESC LIMIT 1`);
const sid = res.rows[0]?.session_id;
console.log('\nSession:', sid);

const allKeys = await c.query(`SELECT jsonb_object_keys(data) AS key FROM sessions WHERE session_id = $1`, [sid]);
console.log('All vault keys:', allKeys.rows.map(r => r.key));

// Check session_audio for this session
const audio = await c.query('SELECT * FROM session_audio WHERE session_id = $1', [sid]);
console.log('\nsession_audio rows:', audio.rows.length);
if (audio.rows.length > 0) {
  console.log('Sample columns:', Object.keys(audio.rows[0]));
  audio.rows.forEach(r => console.log('  ', JSON.stringify(r).slice(0, 200)));
}

// Get vault data excerpts
const vault = await c.query('SELECT data FROM sessions WHERE session_id = $1', [sid]);
const d = vault.rows[0]?.data || {};
console.log('\nchief_complaint:', JSON.stringify(d.chief_complaint || {}).slice(0, 200));
console.log('\nquestionnaire keys:', d.questionnaire ? Object.keys(d.questionnaire) : 'N/A');
console.log('\ntriage_output keys:', d.triage_output ? Object.keys(d.triage_output) : 'N/A');
console.log('\nproblem_list keys:', d.problem_list ? Object.keys(d.problem_list) : 'N/A');

await c.end();
