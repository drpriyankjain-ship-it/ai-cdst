import pg from 'pg';
const p = new pg.Pool({
  connectionString: 'postgresql://postgres.mitudrxcfjcmpisbkbuf:Postgres123!@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres',
  ssl: { rejectUnauthorized: false }
});
// Simulate the exact query from the dashboard route for user_id=1
const r = await p.query(
  `SELECT cq.session_id, cq.status, cq.risk_tier, s.data->>'nurse_id' as nurse_id
   FROM case_queue cq
   JOIN sessions s ON cq.session_id = s.session_id
   WHERE cq.status = 'active'
     AND (s.data->>'nurse_id' = $1 OR s.data->>'nurse_id' = $2)
   ORDER BY cq.created_at DESC`,
  ['1', 'N-1']
);
console.log('Active cases for N-1:', r.rows.length, 'cases');
r.rows.forEach(row => console.log(`  ${row.session_id} | ${row.risk_tier} | nurse=${row.nurse_id}`));
await p.end();
