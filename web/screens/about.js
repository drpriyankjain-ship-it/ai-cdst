/* NurseAI Web — About Screen */
import { navigate, clearToken } from '../app.js';

export function initAbout(container) {
  container.innerHTML = `
    <div class="about-page">
      <div class="logo-card" style="border:none;padding:0;margin-bottom:20px;">
        <div class="logo-header">
          <div class="logo-icon"><ion-icon name="document-text"></ion-icon></div>
          <div>
            <div class="logo-title">NurseAI</div>
            <div class="logo-subtitle">Clinical Assistant</div>
          </div>
        </div>
      </div>

      <div class="about-section">
        <p style="font-size:14px;color:#475569;line-height:1.6;">
          AI-powered clinical decision support for nurse practitioners in rural West Bengal.
          NurseAI helps nurses conduct structured patient consultations with real-time AI guidance.
        </p>
        <p style="font-size:12px;color:#94A3B8;margin-top:8px;">Version 1.0.0</p>
      </div>

      <div class="about-section">
        <h3>Features</h3>
        <div class="about-feature"><ion-icon name="mic"></ion-icon><span>Audio recording with automatic transcription</span></div>
        <div class="about-feature"><ion-icon name="medkit"></ion-icon><span>AI-powered diagnostic assessment</span></div>
        <div class="about-feature"><ion-icon name="document-text"></ion-icon><span>Smart proforma generation</span></div>
        <div class="about-feature"><ion-icon name="analytics"></ion-icon><span>Management plans with risk assessment</span></div>
        <div class="about-feature"><ion-icon name="shield-checkmark"></ion-icon><span>Verified clinical suggestions</span></div>
      </div>

      <div class="about-section">
        <h3>Legal</h3>
        <div class="about-feature">
          <ion-icon name="lock-closed"></ion-icon>
          <a href="https://nurseai.in/privacy" target="_blank" rel="noopener" style="font-size:14px;">Privacy Policy</a>
        </div>
        <div class="about-feature">
          <ion-icon name="information-circle"></ion-icon>
          <span>Data collected for research purposes only</span>
        </div>
      </div>

      <button class="btn btn-danger btn-block" id="logout-btn" style="margin-top:8px;">
        <ion-icon name="log-out-outline"></ion-icon> Logout
      </button>
    </div>
  `;

  container.querySelector('#logout-btn').addEventListener('click', () => {
    clearToken();
    localStorage.removeItem('@nurseai_current_patient');
    navigate('login');
  });
}
