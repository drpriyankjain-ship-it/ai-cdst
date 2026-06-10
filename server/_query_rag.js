import pg from 'pg';
const pool = new pg.Pool({
  connectionString: 'postgresql://postgres.mitudrxcfjcmpisbkbuf:Postgres123!@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres',
  ssl: { rejectUnauthorized: false }
});
const r = await pool.query('SELECT otp_code, otp_expires_at FROM users WHERE email = $1', ['shaurya@velocityindia.net']);
console.log(r.rows[0]);
await pool.end();
