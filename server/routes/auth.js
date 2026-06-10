/**
 * CDST — Auth Routes
 * ===================
 * Registration, login, OTP verification, password reset.
 * Designed to match the mobile app's apiService.js endpoints.
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getPool } from '../lib/db.js';
import { signJwt, requireAuth } from '../lib/auth.js';
import { sendOtp } from '../lib/email.js';

const router = Router();

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, phone, phoneNumber, role } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const pool = getPool();
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (exists.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, phone, role, otp_code, otp_expires_at, verified)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '10 minutes', false) RETURNING id`,
      [name, email.toLowerCase(), hash, phone || phoneNumber, role || 'nurse', otp]
    );
    sendOtp(email, otp, 'register').catch(() => {});
    res.status(201).json({ success: true, userId: result.rows[0].id, message: 'OTP sent to your email/phone' });
  } catch (err) {
    console.error('[AUTH] Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    const pool = getPool();
    const result = await pool.query(
      'SELECT id, otp_code, otp_expires_at FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = result.rows[0];
    if (user.otp_code !== otp) return res.status(400).json({ error: 'Invalid OTP' });
    if (new Date(user.otp_expires_at) < new Date()) return res.status(400).json({ error: 'OTP expired' });

    await pool.query('UPDATE users SET verified = true, otp_code = NULL WHERE id = $1', [user.id]);
    const token = signJwt({ user_id: user.id, email: email.toLowerCase(), role: 'nurse', nurse_id: `N-${user.id}` });
    res.json({ success: true, token });
  } catch (err) {
    console.error('[AUTH] OTP verify error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// POST /api/auth/resend-otp
router.post('/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;
    const pool = getPool();
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    await pool.query(
      `UPDATE users SET otp_code = $1, otp_expires_at = NOW() + INTERVAL '10 minutes' WHERE email = $2`,
      [otp, email.toLowerCase()]
    );
    sendOtp(email, otp, 'resend').catch(() => {});
    res.json({ success: true, message: 'OTP resent' });
  } catch (err) { res.status(500).json({ error: 'Failed to resend OTP' }); }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const pool = getPool();
    const result = await pool.query('SELECT id, name, email, password_hash, role, verified FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = result.rows[0];
    if (!user.verified) return res.status(403).json({ error: 'Account not verified. Please verify OTP first.' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signJwt({ user_id: user.id, email: user.email, role: user.role, nurse_id: `N-${user.id}` });
    res.json({ success: true, data: { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } } });
  } catch (err) {
    console.error('[AUTH] Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/request-password-reset
router.post('/request-password-reset', async (req, res) => {
  try {
    const { email } = req.body;
    const pool = getPool();
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    await pool.query(`UPDATE users SET otp_code = $1, otp_expires_at = NOW() + INTERVAL '10 minutes' WHERE email = $2`, [otp, email.toLowerCase()]);
    sendOtp(email, otp, 'reset').catch(() => {});
    res.json({ success: true, message: 'Reset OTP sent' });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    const pool = getPool();
    const result = await pool.query('SELECT id, otp_code, otp_expires_at FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    if (result.rows[0].otp_code !== otp) return res.status(400).json({ error: 'Invalid OTP' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1, otp_code = NULL, verified = true WHERE id = $2', [hash, result.rows[0].id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Reset failed' }); }
});

// POST /api/auth/consent
router.post('/consent', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    await pool.query('UPDATE users SET consent_given = true, consent_at = NOW() WHERE id = $1', [req.user.user_id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Consent update failed' }); }
});

export default router;
