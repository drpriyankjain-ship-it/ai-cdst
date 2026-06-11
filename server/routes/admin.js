/**
 * CDST — Admin Routes
 * ====================
 * Protected admin-only endpoints for managing cases, doctors, and viewing metrics.
 */

import { Router } from 'express';
import { getPool } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';

const router = Router();

// ---- Admin middleware — reject non-admin users ----
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Apply both auth + admin check to all routes
router.use(requireAuth, requireAdmin);

// ============================================================
// Cases — view all cases across all nurses
// ============================================================

// GET /api/admin/cases?q=search_term
router.get('/cases', async (req, res) => {
  try {
    const pool = getPool();
    const search = (req.query.q || '').trim().toLowerCase();

    let query = `
      SELECT
        cq.session_id,
        cq.risk_tier,
        cq.status,
        cq.created_at,
        cq.cleared_at,
        s.data->>'patient_id'                          AS patient_id,
        COALESCE(
          s.data->'demographics'->>'name',
          s.data->'chief_complaint'->>'patient_name'
        )                                              AS patient_name,
        s.data->>'nurse_id'                            AS nurse_id,
        s.data->'triage_output'->'triage'->>'one_liner' AS one_liner,
        s.data->'triage_output'                        AS triage_output,
        s.data->'problem_list'                         AS problem_list,
        s.data->'chief_complaint'                      AS chief_complaint,
        s.data->'questionnaire'                        AS questionnaire,
        s.data->'extracted_concepts'                   AS extracted_concepts,
        s.data->'differential_table'                   AS differential_table,
        s.data->'clarifying_questions'                 AS clarifying_questions,
        s.data->'clarifying_findings'                  AS clarifying_findings,
        s.data->'risk_assessment'                      AS risk_assessment,
        s.data->'followups'                            AS followups
      FROM case_queue cq
      JOIN sessions s ON cq.session_id = s.session_id`;

    const params = [];

    if (search) {
      // Look up nurse user_ids matching the search email
      params.push(`%${search}%`);
      query += `
      WHERE (
        LOWER(s.data->>'patient_id') LIKE $1
        OR LOWER(COALESCE(s.data->'demographics'->>'name', s.data->'chief_complaint'->>'patient_name', '')) LIKE $1
        OR s.data->>'nurse_id' IN (
          SELECT 'N-' || id::text FROM users WHERE LOWER(email) LIKE $1
        )
      )`;
    }

    query += `
      ORDER BY
        CASE cq.risk_tier WHEN 'HIGH' THEN 0 ELSE 1 END,
        cq.created_at DESC
      LIMIT 200`;

    const result = await pool.query(query, params);

    // Enrich with nurse email
    const nurseIds = [...new Set(result.rows.map(r => r.nurse_id).filter(Boolean))];
    let nurseMap = {};
    if (nurseIds.length > 0) {
      const numericIds = nurseIds.map(id => parseInt((id || '').replace('N-', ''), 10)).filter(n => !isNaN(n));
      if (numericIds.length > 0) {
        const nurseRes = await pool.query(
          'SELECT id, name, email FROM users WHERE id = ANY($1)',
          [numericIds]
        );
        for (const row of nurseRes.rows) {
          nurseMap[`N-${row.id}`] = { name: row.name, email: row.email };
        }
      }
    }

    const data = result.rows.map(row => ({
      ...row,
      nurse: nurseMap[row.nurse_id] || { name: 'Unknown', email: 'unknown' },
    }));

    res.json({ success: true, data, total: data.length });
  } catch (err) {
    console.error('[ADMIN] Cases error:', err);
    res.status(500).json({ error: 'Failed to load cases' });
  }
});

// GET /api/admin/cases/:sessionId — full case detail
router.get('/cases/:sessionId', async (req, res) => {
  try {
    const pool = getPool();
    const { sessionId } = req.params;
    const sessRes = await pool.query('SELECT data FROM sessions WHERE session_id = $1', [sessionId]);
    if (!sessRes.rows.length) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true, data: sessRes.rows[0].data });
  } catch (err) {
    console.error('[ADMIN] Case detail error:', err);
    res.status(500).json({ error: 'Failed to load case detail' });
  }
});

// ============================================================
// Doctors — CRUD for doctor roster
// ============================================================

// GET /api/admin/doctors — list all doctors with their assigned nurses
router.get('/doctors', async (req, res) => {
  try {
    const pool = getPool();
    const doctorsRes = await pool.query('SELECT * FROM doctors ORDER BY name');

    // Get all tenant assignments
    const tenantsRes = await pool.query(`
      SELECT dt.doctor_id, dt.user_id, dt.assigned_at, u.name, u.email
      FROM doctor_tenants dt
      JOIN users u ON dt.user_id = u.id
      ORDER BY u.name
    `);

    const tenantMap = {};
    for (const t of tenantsRes.rows) {
      if (!tenantMap[t.doctor_id]) tenantMap[t.doctor_id] = [];
      tenantMap[t.doctor_id].push({
        user_id: t.user_id,
        name: t.name,
        email: t.email,
        assigned_at: t.assigned_at,
      });
    }

    const data = doctorsRes.rows.map(d => ({
      ...d,
      tenants: tenantMap[d.id] || [],
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('[ADMIN] Doctors list error:', err);
    res.status(500).json({ error: 'Failed to load doctors' });
  }
});

// POST /api/admin/doctors — create a new doctor
router.post('/doctors', async (req, res) => {
  try {
    const pool = getPool();
    const { name, email, speciality, phone } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

    const result = await pool.query(
      'INSERT INTO doctors (name, email, speciality, phone) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, email.toLowerCase(), speciality || null, phone || null]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Doctor with this email already exists' });
    console.error('[ADMIN] Create doctor error:', err);
    res.status(500).json({ error: 'Failed to create doctor' });
  }
});

// PUT /api/admin/doctors/:id — edit doctor
router.put('/doctors/:id', async (req, res) => {
  try {
    const pool = getPool();
    const { name, email, speciality, phone } = req.body;
    const result = await pool.query(
      `UPDATE doctors SET
        name = COALESCE($1, name),
        email = COALESCE($2, email),
        speciality = COALESCE($3, speciality),
        phone = COALESCE($4, phone)
       WHERE id = $5 RETURNING *`,
      [name, email?.toLowerCase(), speciality, phone, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Doctor not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[ADMIN] Update doctor error:', err);
    res.status(500).json({ error: 'Failed to update doctor' });
  }
});

// DELETE /api/admin/doctors/:id — delete doctor
router.delete('/doctors/:id', async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query('DELETE FROM doctors WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Doctor not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[ADMIN] Delete doctor error:', err);
    res.status(500).json({ error: 'Failed to delete doctor' });
  }
});

// POST /api/admin/doctors/:id/tenants — assign nurse to doctor
router.post('/doctors/:id/tenants', async (req, res) => {
  try {
    const pool = getPool();
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    await pool.query(
      'INSERT INTO doctor_tenants (doctor_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.params.id, user_id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[ADMIN] Assign tenant error:', err);
    res.status(500).json({ error: 'Failed to assign nurse' });
  }
});

// DELETE /api/admin/doctors/:id/tenants/:userId — remove nurse from doctor
router.delete('/doctors/:id/tenants/:userId', async (req, res) => {
  try {
    const pool = getPool();
    await pool.query(
      'DELETE FROM doctor_tenants WHERE doctor_id = $1 AND user_id = $2',
      [req.params.id, req.params.userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[ADMIN] Remove tenant error:', err);
    res.status(500).json({ error: 'Failed to remove nurse' });
  }
});

// GET /api/admin/nurses — list all nurse users (for tenant assignment dropdown)
router.get('/nurses', async (req, res) => {
  try {
    const pool = getPool();
    const result = await pool.query(
      "SELECT id, name, email, created_at FROM users WHERE role = 'nurse' ORDER BY name"
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[ADMIN] Nurses list error:', err);
    res.status(500).json({ error: 'Failed to load nurses' });
  }
});

// ============================================================
// Metrics — system-wide and per-nurse analytics
// ============================================================

// GET /api/admin/metrics
router.get('/metrics', async (req, res) => {
  try {
    const pool = getPool();

    // System-wide totals
    const totalRes = await pool.query(`
      SELECT
        COUNT(*)::int AS total_sessions,
        COALESCE(SUM(total_cost_usd), 0)::numeric(10,6) AS total_cost_usd,
        COALESCE(AVG(total_cost_usd), 0)::numeric(10,6) AS avg_cost_per_session,
        COALESCE(AVG(total_latency_ms), 0)::int AS avg_latency_ms,
        COALESCE(AVG(e2e_duration_ms), 0)::int AS avg_e2e_duration_ms,
        COALESCE(SUM(e2e_duration_ms), 0)::bigint AS total_usage_ms
      FROM session_metrics
    `);

    // Today's stats
    const todayRes = await pool.query(`
      SELECT
        COUNT(*)::int AS sessions_today,
        COALESCE(SUM(total_cost_usd), 0)::numeric(10,6) AS cost_today_usd
      FROM session_metrics WHERE created_at >= CURRENT_DATE
    `);

    // Total users
    const usersRes = await pool.query("SELECT COUNT(*)::int AS total FROM users WHERE role = 'nurse'");

    // Failure rate
    const failRes = await pool.query('SELECT COUNT(*)::int AS total FROM pipeline_failures');

    // Risk tier distribution
    const riskRes = await pool.query(
      'SELECT risk_tier, COUNT(*)::int AS count FROM session_metrics WHERE risk_tier IS NOT NULL GROUP BY risk_tier'
    );

    // Per-nurse breakdown
    const perNurseRes = await pool.query(`
      SELECT
        sm.user_id,
        u.name AS nurse_name,
        u.email AS nurse_email,
        COUNT(*)::int AS total_sessions,
        COALESCE(SUM(sm.total_cost_usd), 0)::numeric(10,6) AS total_cost_usd,
        COALESCE(AVG(sm.total_latency_ms), 0)::int AS avg_latency_ms,
        COALESCE(AVG(sm.e2e_duration_ms), 0)::int AS avg_e2e_ms,
        COALESCE(SUM(sm.e2e_duration_ms), 0)::bigint AS total_usage_ms
      FROM session_metrics sm
      JOIN users u ON sm.user_id = u.id
      GROUP BY sm.user_id, u.name, u.email
      ORDER BY total_sessions DESC
    `);

    const t = totalRes.rows[0] || {};
    const td = todayRes.rows[0] || {};

    res.json({
      success: true,
      system: {
        total_sessions: t.total_sessions || 0,
        total_users: usersRes.rows[0]?.total || 0,
        total_cost_usd: parseFloat(t.total_cost_usd) || 0,
        avg_cost_per_session: parseFloat(t.avg_cost_per_session) || 0,
        avg_latency_ms: t.avg_latency_ms || 0,
        avg_e2e_duration_ms: t.avg_e2e_duration_ms || 0,
        total_usage_ms: parseInt(t.total_usage_ms) || 0,
        sessions_today: td.sessions_today || 0,
        cost_today_usd: parseFloat(td.cost_today_usd) || 0,
        total_failures: failRes.rows[0]?.total || 0,
        failure_rate_pct: (t.total_sessions || 0) > 0
          ? parseFloat((((failRes.rows[0]?.total || 0) / t.total_sessions) * 100).toFixed(2))
          : 0,
        risk_distribution: Object.fromEntries(riskRes.rows.map(r => [r.risk_tier, r.count])),
      },
      per_nurse: perNurseRes.rows.map(r => ({
        user_id: r.user_id,
        name: r.nurse_name,
        email: r.nurse_email,
        total_sessions: r.total_sessions,
        total_cost_usd: parseFloat(r.total_cost_usd) || 0,
        avg_latency_ms: r.avg_latency_ms,
        avg_e2e_ms: r.avg_e2e_ms,
        total_usage_ms: parseInt(r.total_usage_ms) || 0,
      })),
    });
  } catch (err) {
    console.error('[ADMIN] Metrics error:', err);
    res.status(500).json({ error: 'Failed to load metrics' });
  }
});

export default router;
