import 'dotenv/config';
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
// Get a real URL from a session in case_queue
const r = await c.query(`SELECT sa.file_path FROM session_audio sa JOIN case_queue cq ON sa.session_id = cq.session_id WHERE sa.file_path LIKE 'http%' LIMIT 1`);
const url = r.rows[0]?.file_path;
console.log('Testing URL:', url);
if (url) {
  const res = await fetch(url, { method: 'HEAD' });
  console.log('Status:', res.status);
  console.log('Content-Type:', res.headers.get('content-type'));
  console.log('Content-Length:', res.headers.get('content-length'));
}
await c.end();
