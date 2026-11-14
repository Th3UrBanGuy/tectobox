// Tectobox frontend — views/auth.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

// ---------------- auth ----------------
function hidePreloader() {
  var _p = $('preloader');
  if (_p) {
    _p.classList.add('done');
    _p.style.display = 'none';
    _p.style.pointerEvents = 'none';
    try { _p.remove(); } catch {}
  }
}
// safety: never trap the user behind the splash
setTimeout(hidePreloader, 10000);
function showLogin() {
  hidePreloader();
  state.me = null;
  $('login-view').classList.remove('hidden');
  $('app-view').classList.add('hidden');
  var _bt = $('bottom-tabs'); if (_bt) _bt.classList.add('hidden');
  if (window._es) { try { window._es.close(); } catch {} window._es = null; }
}
async function boot() {
  let me;
  try {
    me = (await api('/api/auth/me')).user;
  } catch { return; } // showLogin already triggered
  state.me = me;
  state.clientId = me.clientId;
  ensurePushSubscribed();
  hidePreloader();
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  var _bt2 = $('bottom-tabs'); if (_bt2) _bt2.classList.remove('hidden');
  $('user-name').textContent = me.username;
  $('user-avatar').textContent = (me.username || '?')[0].toUpperCase();
  const mUn = $('mobile-user-name');
  if (mUn) mUn.textContent = me.username;
  if (isAdmin(me.role)) {
    var _bs=$('brand-sub'); if(_bs) _bs.textContent='Platform Panel';
    $('btn-refresh').classList.remove('hidden');
    renderNav([
      { id: 'admin', label: 'Platform Panel', icon: 'grid' },
      { id: 'inbox', label: 'Inbox', icon: 'inbox' },
      { id: 'leads', label: 'Leads', icon: 'sheets' },
      { id: 'more', label: 'More', icon: 'dots' },
    ]);
    showView('admin');
    loadAdmin();
  } else {
    var _bs2=$('brand-sub'); if(_bs2) _bs2.textContent='Tectobox';
    $('btn-refresh').classList.add('hidden');
    try { state.access = await api('/api/client/access'); } catch { state.access = null; }
    renderNav();
    applyAccessGating();
    showView('inbox');
    loadClientAll();
  }
  connectSSE();
  loadPaymentStats();
  maybeShowMetaPicker();
  renderGetStarted();
}

// ---------------- Login Bilingual & UI Features ----------------
function initLoginBilingual() {
  const dict = {
    en: {
      tagline: 'AI-Powered Unified Inbox',
      lblUser: 'Username',
      userPlaceholder: 'your-username',
      lblPass: 'Password',
      passPlaceholder: '••••••••',
      lblTotp: 'Two-factor code (2FA)',
      totpPlaceholder: '6-digit code',
      lblCaptcha: 'Security check',
      captchaPlaceholder: 'Type the characters above',
      btnText: 'Sign in',
      linkWelcome: 'New here? See what Tectobox does →'
    },
    bn: {
      tagline: 'AI-চালিত সর্বজনীন কাস্টমার ইনবক্স',
      lblUser: 'ইউজারনেম',
      userPlaceholder: 'আপনার ইউজারনেম',
      lblPass: 'পাসওয়ার্ড',
      passPlaceholder: '••••••••',
      lblTotp: '২-ফ্যাক্টর অথেন্টিকেশন কোড (2FA)',
      totpPlaceholder: '৬ ডিজিটের ওটিপি কোড',
      lblCaptcha: 'নিরাপত্তা যাচাই',
      captchaPlaceholder: 'উপরের অক্ষরগুলো টাইপ করুন',
      btnText: 'লগইন করুন',
      linkWelcome: 'নতুন এসেছেন? টেকটোবক্স কীভাবে কাজ করে দেখুন →'
    }
  };

  let curLang = 'en';
  try {
    const saved = localStorage.getItem('tectobox_login_lang');
    if (saved === 'bn' || saved === 'en') curLang = saved;
  } catch {}

  const applyLang = (lang) => {
    curLang = lang;
    try { localStorage.setItem('tectobox_login_lang', lang); } catch {}
    const t = dict[lang] || dict.en;
    const tagEl = $('login-tagline'); if (tagEl) tagEl.textContent = t.tagline;
    const lu = $('lbl-login-username'); if (lu) lu.textContent = t.lblUser;
    const inpU = $('login-username'); if (inpU) inpU.placeholder = t.userPlaceholder;
    const lp = $('lbl-login-password'); if (lp) lp.textContent = t.lblPass;
    const inpP = $('login-password'); if (inpP) inpP.placeholder = t.passPlaceholder;
    const lt = $('lbl-login-totp'); if (lt) lt.textContent = t.lblTotp;
    const inpT = $('login-totp'); if (inpT) inpT.placeholder = t.totpPlaceholder;
    const lc = $('lbl-login-captcha'); if (lc) lc.textContent = t.lblCaptcha;
    const inpC = $('login-captcha-answer'); if (inpC) inpC.placeholder = t.captchaPlaceholder;
    const txtBtn = $('txt-login-btn'); if (txtBtn) txtBtn.textContent = t.btnText;
    const lnkW = $('link-login-welcome'); if (lnkW) lnkW.textContent = t.linkWelcome;

    const btnEn = $('btn-login-lang-en');
    const btnBn = $('btn-login-lang-bn');
    if (btnEn) btnEn.classList.toggle('active', lang === 'en');
    if (btnBn) btnBn.classList.toggle('active', lang === 'bn');
  };

  const btnEn = $('btn-login-lang-en');
  const btnBn = $('btn-login-lang-bn');
  if (btnEn) btnEn.onclick = () => applyLang('en');
  if (btnBn) btnBn.onclick = () => applyLang('bn');

  applyLang(curLang);
}

// ---------------- Password Visibility Eye Toggles ----------------
function initPasswordToggles() {
  const btnLoginPwd = $('btn-toggle-login-pwd');
  if (btnLoginPwd) {
    btnLoginPwd.onclick = () => {
      const inp = $('login-password');
      if (!inp) return;
      const isPwd = inp.type === 'password';
      inp.type = isPwd ? 'text' : 'password';
      const s = $('eye-show'), h = $('eye-hide');
      if (s) s.classList.toggle('hidden', isPwd);
      if (h) h.classList.toggle('hidden', !isPwd);
    };
  }

  document.querySelectorAll('.btn-toggle-eye').forEach(btn => {
    btn.onclick = () => {
      const tid = btn.getAttribute('data-target');
      const inp = $(tid);
      if (!inp) return;
      inp.type = inp.type === 'password' ? 'text' : 'password';
    };
  });
}

// ---------------- Profile, Credentials & 2FA Management ----------------
let currentProfileData = null;

async function openProfileModal() {
  const modal = $('profile-modal');
  if (!modal) return;

  const errEl = $('prof-cred-err'); if (errEl) { errEl.textContent = ''; errEl.classList.remove('show'); }
  const succEl = $('prof-cred-success'); if (succEl) { succEl.textContent = ''; succEl.classList.add('hidden'); }
  const err2fa = $('prof-2fa-err'); if (err2fa) { err2fa.textContent = ''; err2fa.classList.remove('show'); }
  const succ2fa = $('prof-2fa-success'); if (succ2fa) { succ2fa.textContent = ''; succ2fa.classList.add('hidden'); }

  switchProfileTab('credentials');

  $('prof-curr-password').value = '';
  $('prof-new-password').value = '';
  $('prof-confirm-password').value = '';

  try {
    const rawProf = await api('/api/auth/profile');
    const prof = rawProf.user || rawProf;
    currentProfileData = prof;

    // Header info
    const initial = (prof.username || '?')[0].toUpperCase();
    $('prof-avatar').textContent = initial;
    $('prof-header-name').textContent = prof.username;

    const isAdminUser = prof.role === 'admin';
    const roleBadge = $('prof-role-badge');
    if (roleBadge) {
      roleBadge.textContent = isAdminUser ? 'Platform Admin' : 'Workspace User';
      roleBadge.className = `pill ${isAdminUser ? 'blue' : 'green'}`;
    }

    // Role-based restrictions
    const uInput = $('prof-username');
    const uRuleTag = $('prof-user-rule-tag');
    const uNotice = $('prof-username-notice');

    uInput.value = prof.username;
    if (isAdminUser) {
      uInput.disabled = false;
      uInput.readOnly = false;
      uRuleTag.className = 'field-rule-tag admin';
      uRuleTag.textContent = 'Admin (Editable)';
      uNotice.innerHTML = '<span style="color:var(--muted);font-size:12px;">অ্যাডমিন হিসেবে আপনি নিজের ইউজারনেম পরিবর্তন করতে পারবেন।</span>';
    } else {
      uInput.disabled = true;
      uInput.readOnly = true;
      uRuleTag.className = 'field-rule-tag locked';
      uRuleTag.textContent = 'Locked / সংরক্ষিত';
      uNotice.innerHTML = '<span style="color:var(--muted);font-size:12px;font-weight:500;">ইউজারদের ইউজারনেম পরিবর্তন সুরক্ষিত রাখা হয়েছে — শুধুমাত্র পাসওয়ার্ড পরিবর্তন করা যাবে।</span>';
    }

    // 2FA status
    render2FAStatus(prof.totp_enabled);

    modal.classList.remove('hidden');
  } catch (err) {
    toast('Failed to load profile: ' + (err.message || err), 'err');
  }
}

function closeProfileModal() {
  const modal = $('profile-modal');
  if (modal) modal.classList.add('hidden');
}

function switchProfileTab(tab) {
  const isCred = tab === 'credentials';
  const cTab = $('ptab-credentials');
  const tTab = $('ptab-twofa');
  const btnC = $('ptab-btn-credentials');
  const btnT = $('ptab-btn-twofa');

  if (cTab) cTab.classList.toggle('hidden', !isCred);
  if (tTab) tTab.classList.toggle('hidden', isCred);
  if (btnC) btnC.classList.toggle('active', isCred);
  if (btnT) btnT.classList.toggle('active', !isCred);
}

function render2FAStatus(enabled) {
  const shield = $('prof-2fa-shield');
  const title = $('prof-2fa-status-title');
  const desc = $('prof-2fa-status-desc');
  const badge = $('prof-2fa-badge');
  const actions = $('prof-2fa-actions');
  const setupSec = $('prof-2fa-setup-section');
  const pwdPrompt = $('prof-2fa-pwd-prompt');
  const disableSec = $('prof-2fa-disable-section');

  setupSec.classList.add('hidden');
  pwdPrompt.classList.add('hidden');

  if (enabled) {
    shield.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
    title.textContent = 'Two-Factor Authentication is Active';
    desc.textContent = 'Your account is secured with TOTP. Authentication code is required on login.';
    badge.textContent = 'Active';
    badge.className = 'pill green';

    actions.classList.add('hidden');
    disableSec.classList.remove('hidden');
    $('prof-2fa-disable-pwd').value = '';
  } else {
    shield.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
    title.textContent = 'Two-Factor Authentication is Disabled';
    desc.textContent = 'Add an extra layer of protection using Google Authenticator, 1Password, or Microsoft Authenticator.';
    badge.textContent = 'Disabled';
    badge.className = 'pill';

    actions.classList.remove('hidden');
    disableSec.classList.add('hidden');
  }
}

function initProfileSecurityModal() {
  const btnClose = $('btn-close-profile');
  if (btnClose) btnClose.onclick = closeProfileModal;
  const btnCancel = $('btn-cancel-profile');
  if (btnCancel) btnCancel.onclick = closeProfileModal;

  const tabsWrap = $('profile-tabs');
  if (tabsWrap) {
    tabsWrap.querySelectorAll('button[data-pt]').forEach(btn => {
      btn.onclick = () => switchProfileTab(btn.getAttribute('data-pt'));
    });
  }

  // Save Credentials Form
  const formCred = $('form-profile-credentials');
  if (formCred) {
    formCred.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = $('prof-cred-err');
      const succEl = $('prof-cred-success');
      errEl.classList.remove('show');
      succEl.classList.add('hidden');

      const currPass = $('prof-curr-password').value;
      const newPass = $('prof-new-password').value;
      const confPass = $('prof-confirm-password').value;
      const newUsername = $('prof-username').value.trim();

      if (!currPass) {
        errEl.textContent = 'Please enter your current password to confirm changes.';
        errEl.classList.add('show');
        return;
      }

      if (newPass) {
        if (newPass.length < 6) {
          errEl.textContent = 'New password must be at least 6 characters long.';
          errEl.classList.add('show');
          return;
        }
        if (newPass !== confPass) {
          errEl.textContent = 'New password and confirmation do not match.';
          errEl.classList.add('show');
          return;
        }
      }

      const payload = { current_password: currPass };
      if (newPass) payload.new_password = newPass;

      // Only pass new_username if admin
      if (currentProfileData && currentProfileData.role === 'admin' && newUsername && newUsername !== currentProfileData.username) {
        payload.new_username = newUsername;
      }

      const btnSave = $('btn-save-credentials');
      btnSave.disabled = true;

      try {
        const res = await api('/api/auth/profile/credentials', {
          method: 'POST',
          body: JSON.stringify(payload)
        });

        succEl.textContent = res.message || 'Credentials updated successfully!';
        succEl.classList.remove('hidden');

        $('prof-curr-password').value = '';
        $('prof-new-password').value = '';
        $('prof-confirm-password').value = '';

        if (res.user) {
          currentProfileData.username = res.user.username;
          $('user-name').textContent = res.user.username;
          $('user-avatar').textContent = res.user.username[0].toUpperCase();
          $('prof-header-name').textContent = res.user.username;
          $('prof-avatar').textContent = res.user.username[0].toUpperCase();
          if (state.me) state.me.username = res.user.username;
        }
        toast('Security credentials updated!', 'ok');
      } catch (err) {
        errEl.textContent = err.message || 'Failed to update credentials';
        errEl.classList.add('show');
      } finally {
        btnSave.disabled = false;
      }
    });
  }

  // 2FA Setup Flow
  const btnStartSetup = $('btn-start-2fa-setup');
  if (btnStartSetup) {
    btnStartSetup.onclick = () => {
      $('prof-2fa-pwd-prompt').classList.remove('hidden');
      $('prof-2fa-setup-pwd').focus();
    };
  }

  const btnProceedSetup = $('btn-proceed-2fa-setup');
  if (btnProceedSetup) {
    btnProceedSetup.onclick = async () => {
      const pwd = $('prof-2fa-setup-pwd').value;
      const errEl = $('prof-2fa-err');
      errEl.classList.remove('show');
      if (!pwd) {
        errEl.textContent = 'Enter your current password to begin 2FA setup.';
        errEl.classList.add('show');
        return;
      }

      try {
        const res = await api('/api/auth/profile/2fa/setup', {
          method: 'POST',
          body: JSON.stringify({ current_password: pwd })
        });

        $('prof-2fa-secret').textContent = res.secret;
        const qrEl = $('prof-2fa-qr');
        if (qrEl) {
          qrEl.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(res.otpauth_url)}" alt="TOTP QR Code">`;
        }
        $('prof-2fa-pwd-prompt').classList.add('hidden');
        $('prof-2fa-setup-section').classList.remove('hidden');
        $('prof-2fa-verify-code').focus();
      } catch (err) {
        errEl.textContent = err.message || 'Failed to start 2FA setup';
        errEl.classList.add('show');
      }
    };
  }

  const btnCopySecret = $('btn-copy-2fa-secret');
  if (btnCopySecret) {
    btnCopySecret.onclick = () => {
      const secret = $('prof-2fa-secret').textContent;
      navigator.clipboard.writeText(secret).then(() => {
        toast('Secret key copied to clipboard!', 'ok');
      }).catch(() => {});
    };
  }

  const btnConfirmEnable = $('btn-confirm-enable-2fa');
  if (btnConfirmEnable) {
    btnConfirmEnable.onclick = async () => {
      const code = $('prof-2fa-verify-code').value.trim();
      const errEl = $('prof-2fa-err');
      const succEl = $('prof-2fa-success');
      errEl.classList.remove('show');
      succEl.classList.add('hidden');

      if (!code || code.length !== 6) {
        errEl.textContent = 'Please enter a valid 6-digit verification code.';
        errEl.classList.add('show');
        return;
      }

      try {
        const res = await api('/api/auth/profile/2fa/verify-enable', {
          method: 'POST',
          body: JSON.stringify({ code })
        });
        succEl.textContent = res.message || 'Two-Factor Authentication is now enabled!';
        succEl.classList.remove('hidden');
        render2FAStatus(true);
        toast('Two-Factor Authentication enabled!', 'ok');
      } catch (err) {
        errEl.textContent = err.message || 'Verification failed. Try again.';
        errEl.classList.add('show');
      }
    };
  }

  // 2FA Disable Flow
  const btnConfirmDisable = $('btn-confirm-disable-2fa');
  if (btnConfirmDisable) {
    btnConfirmDisable.onclick = async () => {
      const pwd = $('prof-2fa-disable-pwd').value;
      const errEl = $('prof-2fa-err');
      const succEl = $('prof-2fa-success');
      errEl.classList.remove('show');
      succEl.classList.add('hidden');

      if (!pwd) {
        errEl.textContent = 'Enter your current password to disable 2FA.';
        errEl.classList.add('show');
        return;
      }

      try {
        const res = await api('/api/auth/profile/2fa/disable', {
          method: 'POST',
          body: JSON.stringify({ current_password: pwd })
        });
        succEl.textContent = res.message || 'Two-Factor Authentication disabled.';
        succEl.classList.remove('hidden');
        render2FAStatus(false);
        toast('Two-Factor Authentication disabled', 'ok');
      } catch (err) {
        errEl.textContent = err.message || 'Failed to disable 2FA';
        errEl.classList.add('show');
      }
    };
  }

  // Bind sidebar and user card clicks
  const sidebarUserCard = $('sidebar-user-card');
  if (sidebarUserCard) {
    sidebarUserCard.onclick = (e) => {
      if (e.target.closest('#btn-theme') || e.target.closest('#btn-signout')) return;
      openProfileModal();
    };
  }
}
