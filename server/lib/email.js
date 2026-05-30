/**
 * CDST — Email Service (Nodemailer + Gmail SMTP)
 * ================================================
 * Sends OTP emails for registration, resend, and password reset.
 * Falls back to console.log if SMTP is not configured.
 *
 * Env vars:
 *   GMAIL_USER        — sender Gmail address (e.g. shauryasharma2002@gmail.com)
 *   GMAIL_APP_PASSWORD — 16-char Google App Password
 */

import nodemailer from 'nodemailer';

const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';

let transporter = null;

if (GMAIL_USER && GMAIL_APP_PASSWORD) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  console.log(`[EMAIL] Gmail SMTP configured — sender: ${GMAIL_USER}`);
} else {
  console.warn('[EMAIL] GMAIL_USER / GMAIL_APP_PASSWORD not set — OTPs will only be logged to console');
}

/**
 * Send an OTP email.
 * @param {string} to — recipient email
 * @param {string} otp — 6-digit OTP code
 * @param {'register'|'resend'|'reset'} type — email type
 */
export async function sendOtp(to, otp, type = 'register') {
  const subjects = {
    register: 'AI-CDST — Verify your account',
    resend: 'AI-CDST — Your verification code',
    reset: 'AI-CDST — Password reset code',
  };

  const headings = {
    register: 'Welcome to AI-CDST!',
    resend: 'Your Verification Code',
    reset: 'Password Reset',
  };

  const messages = {
    register: 'Thank you for registering. Use the code below to verify your account:',
    resend: 'Here is your new verification code:',
    reset: 'You requested a password reset. Use the code below:',
  };

  const html = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #f8fafc; border-radius: 12px;">
      <div style="text-align: center; margin-bottom: 24px;">
        <h1 style="color: #0D9488; margin: 0; font-size: 24px;">🩺 AI-CDST</h1>
      </div>
      <div style="background: #ffffff; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <h2 style="color: #1e293b; margin: 0 0 12px; font-size: 20px;">${headings[type]}</h2>
        <p style="color: #64748b; font-size: 15px; line-height: 1.5; margin: 0 0 20px;">${messages[type]}</p>
        <div style="background: #f1f5f9; border-radius: 8px; padding: 16px; text-align: center; margin-bottom: 20px;">
          <span style="font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #0D9488;">${otp}</span>
        </div>
        <p style="color: #94a3b8; font-size: 13px; margin: 0;">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
      </div>
      <p style="text-align: center; color: #94a3b8; font-size: 12px; margin-top: 16px;">
        © ${new Date().getFullYear()} AI-CDST Clinical Decision Support
      </p>
    </div>
  `;

  if (!transporter) {
    console.log(`[EMAIL] (no SMTP) OTP for ${to}: ${otp} [${type}]`);
    return;
  }

  try {
    await transporter.sendMail({
      from: `"AI-CDST" <${GMAIL_USER}>`,
      to,
      subject: subjects[type] || subjects.register,
      html,
    });
    console.log(`[EMAIL] OTP sent to ${to} [${type}]`);
  } catch (err) {
    console.error(`[EMAIL] Failed to send OTP to ${to}:`, err.message);
    // Fallback — log to console so the OTP isn't lost
    console.log(`[EMAIL] Fallback OTP for ${to}: ${otp} [${type}]`);
  }
}
