// Tectobox frontend — main.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

// ---------------- init ----------------
document.addEventListener('DOMContentLoaded', () => {
  // Platform-adaptive native UI (install + login follow the device's store language)
  try {
    var _ua = navigator.userAgent || '', _plat = navigator.platform || '', _pf = 'other';
    if (/android/i.test(_ua)) _pf = 'android';
    else if (/iPad|iPhone|iPod/.test(_ua) || (_plat === 'MacIntel' && navigator.maxTouchPoints > 1)) _pf = 'ios';
    else if (/Win/.test(_plat) || /Windows/.test(_ua)) _pf = 'windows';
    else if (/Mac/.test(_plat)) _pf = 'macos';
    document.documentElement.setAttribute('data-platform', _pf);
    var _lv = document.getElementById('login-view');
    if (_lv) _lv.setAttribute('data-platform', _pf);
  } catch (e) {}
  initCmdk();
  initOffline();
  initModals();
  initPwa();
  initBroadcastComposer();
  initLoginBilingual();
  initPasswordToggles();
  initProfileSecurityModal();
  initPaymentsHub();
  // draft persistence
  $('msg-input').addEventListener('input', () => { saveDraft(); autosizeComposer(); updateSendBtn(); });
  // login (supports CAPTCHA after repeated failures + TOTP for admins)
  const refreshLoginCaptcha = async () => {
    try {
      const c = await api('/api/captcha');
      $('login-captcha-img').innerHTML = c.svg || '';
      $('login-captcha-token').value = c.token || '';
      $('login-captcha-answer').value = '';
    } catch {}
  };
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('login-err');
    err.classList.remove('show');
    const username = $('login-username').value.trim();
    const password = $('login-password').value;
    if (!username || !password) { err.textContent = 'Enter your username and password.'; err.classList.add('show'); return; }
    $('login-btn').disabled = true;
    try {
      const body = { username, password };
      const totpEl = $('login-totp'), capWrap = $('login-captcha-wrap');
      if (totpEl && !$('login-totp-wrap').classList.contains('hidden') && totpEl.value.trim()) body.totp = totpEl.value.trim();
      if (capWrap && !capWrap.classList.contains('hidden')) {
        body.captcha_token = $('login-captcha-token').value;
        body.captcha_answer = $('login-captcha-answer').value.trim();
      }
      // NOTE (Phase 5): this fetch intentionally stays raw — it must read the
      // 401 response body (totp_required / captcha_required). api() throws
      // on 401 before the body is read, which would break TOTP/captcha login.
      const res = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.totp_required) {
          $('login-totp-wrap').classList.remove('hidden');
          $('login-totp').focus();
          throw new Error(data.error || 'Enter your two-factor code.');
        }
        if (data.captcha_required) {
          $('login-captcha-wrap').classList.remove('hidden');
          await refreshLoginCaptcha();
          $('login-captcha-answer').focus();
          throw new Error(data.error || 'Please solve the CAPTCHA.');
        }
        if (capWrap && !capWrap.classList.contains('hidden')) await refreshLoginCaptcha();
        let errorMsg = data.message || data.error;
        if (Array.isArray(errorMsg)) errorMsg = errorMsg.join(', ');
        if (!errorMsg || errorMsg === 'Unauthorized' || errorMsg === 'Bad Request' || errorMsg === 'Invalid username or password') {
          errorMsg = 'ইউজারনেম অথবা পাসওয়ার্ড সঠিক নয়। দয়া করে পুনরায় চেক করুন। (Invalid username or password)';
        }
        throw new Error(errorMsg);
      }
      $('login-password').value = '';
      if (totpEl) totpEl.value = '';
      $('login-totp-wrap').classList.add('hidden');
      $('login-captcha-wrap').classList.add('hidden');
      await boot();
    } catch (e2) {
      err.textContent = e2.message;
      err.classList.add('show');
    } finally {
      $('login-btn').disabled = false;
    }
  });
  $('btn-signout').onclick = async () => {
    let ok = false;
    for (let i = 0; i < 2 && !ok; i++) {
      try { await api('/api/auth/logout', { method: 'POST' }); ok = true; }
      catch {}
    }
    if (!ok) { toast('Logout failed — check connection and try again', 'err'); return; }
    showLogin();
  };
  const mSignout = $('btn-mobile-signout');
  if (mSignout) mSignout.onclick = () => $('btn-signout')?.click();
  const admMSignout = $('btn-admin-mobile-signout');
  if (admMSignout) admMSignout.onclick = () => $('btn-signout')?.click();
  $('btn-refresh').onclick = () => { if (state.view === 'admin') loadAdmin(); };
  
  const btnCourierConfig = $('btn-open-courier-config');
  if (btnCourierConfig) btnCourierConfig.onclick = openCourierConfigModal;
  const btnRefOrders = $('btn-refresh-orders');
  if (btnRefOrders) btnRefOrders.onclick = async () => {
    // Visible feedback: disable while loading, then toast the result. The
    // empty-workspace end state looks identical to before the click, so
    // without the toast the button felt dead.
    if (btnRefOrders.disabled) return;
    btnRefOrders.disabled = true;
    try {
      const n = await loadOrdersPage();
      if (n == null) toast('Could not refresh orders — see the list for details.', 'err');
      else if (n === 0) toast('Orders refreshed — no orders yet');
      else toast(`Orders refreshed — ${n} order${n === 1 ? '' : 's'}`);
    } catch (e) { toast('Refresh failed: ' + (e && e.message ? e.message : 'unknown error'), 'err'); }
    finally { btnRefOrders.disabled = false; }
  };
  const ordSearch = $('orders-page-search');
  if (ordSearch) {
    ordSearch.addEventListener('input', e => {
      const q = (e.target.value || '').toLowerCase().trim();
      document.querySelectorAll('#orders-full-list .order-card-item').forEach(card => {
        const match = !q || card.textContent.toLowerCase().includes(q);
        card.style.display = match ? 'flex' : 'none';
      });
    });
  }

  // Theme toggles (navbar + login page)
  const syncThemeIcon = () => {
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    for (const [sun, moon] of [['icon-sun', 'icon-moon'], ['icon-sun-login', 'icon-moon-login'], ['icon-sun-top', 'icon-moon-top']]) {
      const s = $(sun), m = $(moon);
      if (s) s.classList.toggle('hidden', !dark);
      if (m) m.classList.toggle('hidden', dark);
    }
  };
  syncThemeIcon();
  const toggleTheme = () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('tectonic-theme', next); } catch {}
    syncThemeIcon();
    var _sw = $('sw-theme'); if (_sw) _sw.checked = (next === 'dark');
  };
  $('btn-theme').onclick = toggleTheme;
  const btnThemeM = $('btn-theme-mobile');
  if (btnThemeM) btnThemeM.onclick = toggleTheme;
  const btnSignoutM = $('btn-signout-mobile');
  if (btnSignoutM) btnSignoutM.onclick = () => $('btn-signout')?.click();
  const btnSidebarLogout = $('btn-sidebar-logout');
  if (btnSidebarLogout) btnSidebarLogout.onclick = () => $('btn-signout')?.click();
  const loginToggle = $('btn-theme-login');
  if (loginToggle) loginToggle.onclick = toggleTheme;
  // back buttons on sub-views (CSP blocks inline onclick)
  document.querySelectorAll('[data-back]').forEach(b => b.onclick = () => showView(b.dataset.back));
  // inbox
  renderPlatformChips();
  renderQuickReplies();
  let _searchT = null;
  $('conv-search').addEventListener('input', e => {
    clearTimeout(_searchT);
    const v = e.target.value;
    _searchT = setTimeout(() => { state.convQuery = v; loadConversations(true); }, 280);
  });
  // compact toolbar: filter popover
  $('btn-filter').onclick = (e) => { e.stopPropagation(); $('filter-pop').classList.toggle('hidden'); };
  document.addEventListener('click', (e) => {
    var _p = $('filter-pop');
    if (_p && !_p.classList.contains('hidden') && !e.target.closest('.pop-wrap')) closeFilterPop();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeFilterPop(); collapseSearch(); } });
  // expanding search
  const _se = $('search-expand');
  $('btn-search').onclick = (e) => { e.stopPropagation(); _se.classList.add('open'); _se.closest('.inbox-toolbar')?.classList.add('search-open'); $('btn-search-close').classList.remove('hidden'); setTimeout(() => $('conv-search').focus(), 60); };
  window.collapseSearch = () => {
    if (!_se.classList.contains('open')) return;
    _se.classList.remove('open'); _se.closest('.inbox-toolbar')?.classList.remove('search-open'); $('btn-search-close').classList.add('hidden');
    if (!$('conv-search').value) { state.convQuery = ''; renderConvList(); }
  };
  $('btn-search-close').onclick = (e) => { e.stopPropagation(); $('conv-search').value = ''; collapseSearch(); };
  // needs-human as premium icon toggle
  $('btn-human').onclick = () => {
    state.needsHuman = !state.needsHuman;
    $('btn-human').classList.toggle('on', state.needsHuman);
    renderConvList();
  };
  $('btn-send').onclick = sendReply;
  const _mi = $('msg-input');
  _mi.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.shiftKey) {
      // Bulletproof newline: insert manually so it works even when the
      // native Shift+Enter behavior is swallowed (some automation/IMEs).
      const s = _mi.selectionStart || 0, en = _mi.selectionEnd || 0, v = _mi.value;
      _mi.value = v.slice(0, s) + '\n' + v.slice(en);
      _mi.selectionStart = _mi.selectionEnd = s + 1;
      autosizeComposer();
      refreshSendBtn();
    } else {
      sendReply();
    }
  });
  _mi.addEventListener('input', () => { autosizeComposer(); refreshSendBtn(); });
  document.querySelectorAll('.side-tab').forEach(b => b.onclick = () => switchSideTab(b.dataset.tab));
  $('btn-detail-close').onclick = () => toggleMobileDetail(false);
  $('product-search').addEventListener('input', e => { state.productQuery = e.target.value; loadProducts(); });
  $('btn-create-order').onclick = createOrder;

  // leads
  document.querySelectorAll('#lead-segment-filters button').forEach(b => b.onclick = () => {
    state.leadSegment = b.dataset.seg;
    document.querySelectorAll('#lead-segment-filters button').forEach(x => x.classList.toggle('active', x === b));
    renderLeads();
  });
  document.querySelectorAll('#lead-temp-filters button').forEach(b => b.onclick = () => {
    state.leadTemp = b.dataset.lt;
    document.querySelectorAll('#lead-temp-filters button').forEach(x => x.classList.toggle('active', x === b));
    loadLeads();
  });
  $('lead-stage-filter').addEventListener('change', e => { state.leadStage = e.target.value; loadLeads(); });
  $('lead-search').addEventListener('input', e => { state.leadQuery = e.target.value; loadLeads(); });
  $('btn-csv').onclick = exportLeadsCSV;
  $('btn-close-lead').onclick = () => $('lead-modal').classList.add('hidden');
  $('btn-close-shortcuts').onclick = () => $('shortcuts-modal').classList.add('hidden');
  $('shortcuts-modal').addEventListener('click', e => { if (e.target === $('shortcuts-modal')) $('shortcuts-modal').classList.add('hidden'); });
  $('btn-save-lead').onclick = saveLeadModal;
  $('btn-reanalyze-lead').onclick = async () => { await reanalyzeLead(state.editingLeadId); };
  $('btn-advance-lead').onclick = async () => {
    await advanceLead(state.editingLeadId);
    $('lead-modal').classList.add('hidden');
    await loadLeads();
  };

  // products
  $('catalog-search').addEventListener('input', e => { state.productQuery = e.target.value; loadProducts(); });
  $('btn-add-product').onclick = () => openProductModal(null);
  $('btn-close-product').onclick = () => $('product-modal').classList.add('hidden');
  $('btn-save-product').onclick = saveProductModal;

  // settings
  document.querySelectorAll('#settings-tabs button').forEach(b => b.onclick = () => switchSettingsTab(b.dataset.st));
  document.querySelectorAll('#kb-subtabs button').forEach(b => b.onclick = () => switchKbSubTab(b.dataset.kb));
  $('kb-import-btn').onclick = startKbImport;
  $('btn-add-channel').onclick = () => {
    const list = $('chan-pick-list');
    const opts = [
      { ch: 'whatsapp', label: 'WhatsApp', desc: 'Scan QR code — connect in seconds', badge: 'WA', cls: 'p-whatsapp', ok: true },
      { ch: 'telegram', label: 'Telegram', desc: 'Login code — personal or bot account', badge: 'TG', cls: 'p-telegram', ok: true },
      { ch: 'messenger', label: 'Messenger', desc: 'Coming soon — after Meta verification', badge: 'M', cls: 'p-messenger', ok: false },
      { ch: 'instagram', label: 'Instagram', desc: 'Coming soon — after Meta verification', badge: 'IG', cls: 'p-instagram', ok: false },
    ];
    list.innerHTML = opts.map(o => `
      <button class="chan-pick ${o.ok ? '' : 'disabled'}" data-ch="${o.ch}" ${o.ok ? '' : 'disabled'} style="display:flex;align-items:center;gap:12px;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--card);cursor:${o.ok ? 'pointer' : 'not-allowed'};opacity:${o.ok ? '1' : '.55'};text-align:left;">
        <span class="plat-badge ${o.cls}">${o.badge}</span>
        <span><b>${o.label}</b><br><small class="muted">${o.desc}</small></span>
      </button>`).join('');
    list.querySelectorAll('.chan-pick[data-ch]').forEach(b => b.onclick = () => {
      if (b.disabled) return;
      $('chan-pick-modal').classList.add('hidden');
      addAccount(b.dataset.ch);
    });
    $('chan-pick-modal').classList.remove('hidden');
  };
  $('btn-chan-pick-cancel').onclick = () => $('chan-pick-modal').classList.add('hidden');
  $('chan-pick-modal').onclick = (e) => { if (e.target.id === 'chan-pick-modal') e.target.classList.add('hidden'); };
  $('btn-save-kb').onclick = saveKnowledge;
  $('btn-close-qr').onclick = () => { if (state.qrClose) state.qrClose({ abandon: true }); else { state.qrChannel = null; state.qrSlot = null; $('qr-modal').classList.add('hidden'); } };
  // Phone login buttons (static in the connect modal — wired once here).
  $('btn-tg-verify').onclick = async () => {
    const code = $('tg-code').value.replace(/[^0-9]/g, '');
    if (!/^[0-9]{5}$/.test(code)) { $('tg-code-err').textContent = 'Enter the 5-digit code.'; return; }
    const password = !$('tg-pass-row').classList.contains('hidden') ? $('tg-pass').value : '';
    $('tg-code-err').textContent = '';
    $('btn-tg-verify').disabled = true;
    $('qr-status').textContent = 'Verifying…';
    try {
      const res = await api(`/api/clients/${state.clientId}/connectors/telegram/signin`, {
        method: 'POST',
        body: JSON.stringify({ slot: state.qrSlot || 'default', code, password: password || undefined }),
      });
      if (res && res.error) {
        $('tg-code-err').textContent = res.error;
        $('btn-tg-verify').disabled = false;
        $('qr-status').textContent = 'Code sent — enter the 5-digit code from Telegram.';
      }
      // Otherwise the worker answers over SSE: 'connected' closes the
      // modal, 'tg_code_error' shows inline. Re-enable after 15s so a
      // dropped event never leaves a dead button.
      setTimeout(() => { if (!$('qr-modal').classList.contains('hidden')) $('btn-tg-verify').disabled = false; }, 15000);
    } catch (e) {
      $('tg-code-err').textContent = e.message || 'Could not verify — try again.';
      $('btn-tg-verify').disabled = false;
    }
  };
  // Typing the 5th digit submits — standard OTP behaviour.
  $('tg-code').oninput = () => {
    if ($('tg-code').value.replace(/[^0-9]/g, '').length === 5 && !$('btn-tg-verify').disabled) $('btn-tg-verify').click();
  };
  $('btn-pairing-refresh').onclick = async () => {
    if (!state.qrPhone) return;
    $('pairing-wrap').classList.remove('code-ready');
    $('pairing-wrap').classList.remove('pairing-error');
    $('pairing-code').textContent = '';
    $('btn-pairing-refresh').style.display = 'none';
    $('btn-pairing-change-number').style.display = 'none';
    $('qr-status').textContent = 'Requesting a new pairing code…';
    try {
      await api(`/api/clients/${state.clientId}/connectors/whatsapp/connect`, {
        method: 'POST',
        body: JSON.stringify({ slot: state.qrSlot || 'default', method: 'phone', phoneNumber: state.qrPhone }),
      });
    } catch (e) { $('qr-status').textContent = 'Could not request a new code: ' + e.message; }
  };
  // Wrong number? Close this modal, ask for the number again (same channel
  // + slot + label), and start the phone flow with the corrected number.
  $('btn-pairing-change-number').onclick = async () => {
    const ch = state.qrChannel, sl = state.qrSlot || 'default', lb = state.qrLabel || sl;
    if (!ch) return;
    if (state.qrClose) state.qrClose(); else { $('qr-modal').classList.add('hidden'); state.qrChannel = null; state.qrSlot = null; }
    const num = await askPhoneNumber(ch);
    if (!num) return;
    try {
      await api(`/api/clients/${state.clientId}/connectors/${ch}/connect`, {
        method: 'POST',
        body: JSON.stringify({ slot: sl, method: 'phone', phoneNumber: num }),
      });
    } catch (e) { return toast('Could not start: ' + e.message, 'err'); }
    startPhoneConnect(ch, sl, lb, num);
  };
  $('pairing-code').onclick = () => {
    const code = $('pairing-code').textContent.replace(/-/g, '');
    if (!code) return;
    if (navigator.clipboard) navigator.clipboard.writeText(code).catch(() => {});
    toast('Pairing code copied');
  };

  // admin
  document.querySelectorAll('#admin-tabs button').forEach(b => b.onclick = () => switchAdminTab(b.dataset.at));
  $('btn-create-user').onclick = () => {
    $('um-username').value = ''; $('um-password').value = ''; $('um-workspace').value = ''; $('um-type').value = 'physical';
    const errEl = $('um-err'); if (errEl) { errEl.textContent = ''; errEl.classList.remove('show'); }
    document.querySelectorAll('#um-trial-chips .chip').forEach(x => x.classList.toggle('sel', x.dataset.min === '60'));
    const tc = $('um-trial-custom'); if (tc) { tc.value = ''; }
    const tcr = $('um-trial-custom-row'); if (tcr) tcr.classList.add('hidden');
    $('user-modal').classList.remove('hidden');
  };
  // Test-license duration picker (chips + custom minutes).
  document.querySelectorAll('#um-trial-chips .chip').forEach(b => b.onclick = () => {
    document.querySelectorAll('#um-trial-chips .chip').forEach(x => x.classList.toggle('sel', x === b));
    const tcr = $('um-trial-custom-row');
    if (tcr) tcr.classList.toggle('hidden', b.dataset.min !== 'custom');
  });
  $('btn-close-user').onclick = () => $('user-modal').classList.add('hidden');
  $('btn-save-user').onclick = async () => {
    const errEl = $('um-err');
    if (errEl) { errEl.textContent = ''; errEl.classList.remove('show'); }
    const username = $('um-username').value.trim(), password = $('um-password').value, workspaceName = $('um-workspace').value.trim();
    if (!username || !password || !workspaceName) {
      if (errEl) { errEl.textContent = 'Username, password and workspace name are required'; errEl.classList.add('show'); }
      return toast('Username, password and workspace name are required', 'err');
    }
    const saveBtn = $('btn-save-user');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Creating…';
    try {
      const trialMinutes = selectedTrialMinutes();
      const body = { username, password, workspaceName, businessType: $('um-type').value };
      if (trialMinutes) body.trialMinutes = trialMinutes;
      const res = await api('/api/admin/users', { method: 'POST', body: JSON.stringify(body) });
      $('user-modal').classList.add('hidden');
      toast(`Workspace "${res.client_name || workspaceName}" created successfully!`, 'ok');
      await loadAdmin();
    } catch (e) {
      if (errEl) { errEl.textContent = e.message; errEl.classList.add('show'); }
      toast('Could not create: ' + e.message, 'err');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Create workspace';
    }
  };
  $('btn-close-pw').onclick = () => $('pw-modal').classList.add('hidden');
  $('btn-close-assign').onclick = () => $('assign-modal').classList.add('hidden');
  $('btn-save-pw').onclick = async () => {
    const password = $('pw-new').value;
    if (!password || password.length < 12) return toast('Password must be at least 12 characters', 'err');
    try {
      await api(`/api/admin/users/${state.pwUserId}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) });
      $('pw-modal').classList.add('hidden');
      toast('Password reset ✓', 'ok');
    } catch (e) { toast('Failed: ' + e.message, 'err'); }
  };
  $('btn-save-config').onclick = saveAdminConfig;

  // modal backdrop click closes (except QR which cancels the flow explicitly)
  for (const id of ['lead-modal', 'product-modal', 'user-modal', 'pw-modal', 'meta-pick-modal', 'assign-modal', 'courier-modal', 'courier-book-modal', 'thermal-label-modal', 'quickreplies-modal', 'orders-modal']) {
    const el = $(id);
    if (el) el.addEventListener('click', e => { if (e.target.id === id) el.classList.add('hidden'); });
  }

  // wire operational modals
  if ($('btn-close-courier')) $('btn-close-courier').onclick = () => $('courier-modal').classList.add('hidden');
  if ($('btn-save-courier')) $('btn-save-courier').onclick = saveCourierConfig;
  if ($('btn-close-cbook')) $('btn-close-cbook').onclick = () => $('courier-book-modal').classList.add('hidden');
  if ($('btn-confirm-cbook')) $('btn-confirm-cbook').onclick = confirmCourierBooking;
  if ($('btn-close-thermal')) $('btn-close-thermal').onclick = () => $('thermal-label-modal').classList.add('hidden');
  if ($('btn-close-thermal-foot')) $('btn-close-thermal-foot').onclick = () => $('thermal-label-modal').classList.add('hidden');
  if ($('btn-close-quickreplies')) $('btn-close-quickreplies').onclick = () => $('quickreplies-modal').classList.add('hidden');
  if ($('btn-close-orders')) $('btn-close-orders').onclick = () => $('orders-modal').classList.add('hidden');
  if ($('btn-add-qr')) $('btn-add-qr').onclick = () => {
    const shortcut = $('new-qr-shortcut').value.trim();
    const title = $('new-qr-title').value.trim();
    const body = $('new-qr-body').value.trim();
    if (!shortcut || !body) return toast('Shortcut and message body are required', 'err');
    const cmd = shortcut.startsWith('/') ? shortcut : '/' + shortcut;
    const list = getStoredQuickReplies();
    list.push({ cmd, title: title || cmd, body });
    saveStoredQuickReplies(list);
    $('new-qr-shortcut').value = '';
    $('new-qr-title').value = '';
    $('new-qr-body').value = '';
    renderQuickRepliesModal();
    toast('Quick reply shortcut added ✓');
  };

  initSlashCommands();
  initSidebarCollapse();
  initMobileDrawer();
  boot();
});
