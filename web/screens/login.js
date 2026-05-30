/* AI-CDST Web — Login & Register Screens */
import api from '../api.js';
import { navigate, showToast, saveToken, showModal, hideModal } from '../app.js';

export function initLogin(container) {
  container.innerHTML = `
    <div class="auth-page">
      <div class="auth-logo">
        <div class="auth-logo-icon"><ion-icon name="document-text"></ion-icon></div>
        <div class="auth-logo-text">AI-CDST</div>
      </div>
      <div class="auth-card">
        <div class="input-group">
          <label class="input-label">Email</label>
          <div class="input-wrapper">
            <ion-icon name="mail-outline"></ion-icon>
            <input type="email" id="login-email" placeholder="Enter your email" autocomplete="email">
          </div>
        </div>
        <div class="input-group">
          <label class="input-label">Password</label>
          <div class="input-wrapper">
            <ion-icon name="lock-closed-outline"></ion-icon>
            <input type="password" id="login-password" placeholder="Enter your password" autocomplete="current-password">
          </div>
        </div>
        <button class="btn btn-primary btn-block" id="login-btn">
          <ion-icon name="log-in-outline"></ion-icon> Sign In
        </button>
        <div class="auth-link">
          Don't have an account? <button id="goto-register">Create Account</button>
        </div>
      </div>
    </div>
  `;

  container.querySelector('#login-btn').addEventListener('click', handleLogin);
  container.querySelector('#login-password').addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });
  container.querySelector('#goto-register').addEventListener('click', () => navigate('register'));
}

async function handleLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) { showToast('Please enter email and password', 'error'); return; }

  const btn = document.getElementById('login-btn');
  btn.disabled = true; btn.innerHTML = '<div class="spinner spinner-sm"></div> Signing in...';

  const result = await api.login(email, password);
  if (result.success && result.data?.token) {
    saveToken(result.data.token);
    showToast('Login successful', 'success');
    navigate('dashboard');
  } else {
    showToast(result.error || 'Login failed', 'error');
  }
  btn.disabled = false; btn.innerHTML = '<ion-icon name="log-in-outline"></ion-icon> Sign In';
}

export function initRegister(container) {
  container.innerHTML = `
    <div class="auth-page">
      <div class="auth-logo">
        <div class="auth-logo-icon"><ion-icon name="document-text"></ion-icon></div>
        <div class="auth-logo-text">AI-CDST</div>
      </div>
      <div class="auth-card">
        <div class="input-group">
          <label class="input-label">Full Name</label>
          <div class="input-wrapper">
            <ion-icon name="person-outline"></ion-icon>
            <input type="text" id="reg-name" placeholder="Enter your full name" autocomplete="name">
          </div>
        </div>
        <div class="input-group">
          <label class="input-label">Email</label>
          <div class="input-wrapper">
            <ion-icon name="mail-outline"></ion-icon>
            <input type="email" id="reg-email" placeholder="Enter your email" autocomplete="email">
          </div>
        </div>
        <div class="input-group">
          <label class="input-label">Phone</label>
          <div class="input-wrapper">
            <ion-icon name="call-outline"></ion-icon>
            <input type="tel" id="reg-phone" placeholder="Enter phone number" autocomplete="tel">
          </div>
        </div>
        <div class="input-group">
          <label class="input-label">Password</label>
          <div class="input-wrapper">
            <ion-icon name="lock-closed-outline"></ion-icon>
            <input type="password" id="reg-password" placeholder="Create a password" autocomplete="new-password">
          </div>
        </div>
        <button class="btn btn-primary btn-block" id="register-btn">
          <ion-icon name="person-add-outline"></ion-icon> Create Account
        </button>
        <div class="auth-link">
          Already have an account? <button id="goto-login">Sign In</button>
        </div>
      </div>
    </div>
  `;

  container.querySelector('#register-btn').addEventListener('click', handleRegister);
  container.querySelector('#goto-login').addEventListener('click', () => navigate('login'));
}

let pendingEmail = '';

async function handleRegister() {
  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const phone = document.getElementById('reg-phone').value.trim();
  const password = document.getElementById('reg-password').value;
  if (!name || !email || !password) { showToast('Please fill all required fields', 'error'); return; }

  const btn = document.getElementById('register-btn');
  btn.disabled = true; btn.innerHTML = '<div class="spinner spinner-sm"></div> Creating...';

  const result = await api.register(name, email, password, phone);
  if (result.success) {
    pendingEmail = email;
    showOtpModal(email);
  } else {
    showToast(result.error || 'Registration failed', 'error');
  }
  btn.disabled = false; btn.innerHTML = '<ion-icon name="person-add-outline"></ion-icon> Create Account';
}

function showOtpModal(email) {
  showModal(`
    <div class="modal-title">Verify Email</div>
    <div class="modal-subtitle">Enter the OTP sent to ${email}</div>
    <input class="otp-input" id="otp-input" type="text" maxlength="6" inputmode="numeric" placeholder="------" autocomplete="one-time-code">
    <div style="margin-top:16px;">
      <button class="btn btn-primary btn-block" id="verify-otp-btn">Verify</button>
    </div>
    <div class="auth-link" style="margin-top:12px;">
      <button id="resend-otp-btn">Resend OTP</button>
    </div>
  `);

  document.getElementById('verify-otp-btn').addEventListener('click', async () => {
    const otp = document.getElementById('otp-input').value.trim();
    if (!otp || otp.length < 4) { showToast('Enter a valid OTP', 'error'); return; }
    const btn = document.getElementById('verify-otp-btn');
    btn.disabled = true; btn.textContent = 'Verifying...';
    const r = await api.verifyOtp(pendingEmail, otp);
    if (r.success && r.data?.token) {
      saveToken(r.data.token);
      hideModal();
      showToast('Account verified!', 'success');
      navigate('dashboard');
    } else {
      showToast(r.error || 'Invalid OTP', 'error');
      btn.disabled = false; btn.textContent = 'Verify';
    }
  });

  document.getElementById('resend-otp-btn').addEventListener('click', async () => {
    const r = await api.resendOtp(pendingEmail);
    showToast(r.success ? 'OTP resent' : (r.error || 'Failed to resend'), r.success ? 'success' : 'error');
  });
}
