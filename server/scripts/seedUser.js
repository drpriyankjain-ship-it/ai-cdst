import 'dotenv/config';
import pg from 'pg';
import bcryptjs from 'bcryptjs';

async function run() {
  const hash = await bcryptjs.hash('admin2026', 10);
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const res = await client.query(
    `INSERT INTO users (name, email, password_hash, phone, role, verified, consent_given, consent_at)
     VALUES ($1, $2, $3, $4, $5, true, true, NOW())
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id, name, email, role`,
    ['PJ', 'pj@nurseai.in', hash, '+919999999999', 'nurse']
  );

  console.log('✅ User created:', res.rows[0]);
  await client.end();
}

run().catch(e => { console.error(e); process.exit(1); });
