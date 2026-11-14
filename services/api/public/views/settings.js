// Tectobox frontend — views/settings.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

async function renderMore() {
  const me = state.me || {};
  const initial = (me.username || '?')[0].toUpperCase();
  $('more-acct').innerHTML = `
    <div class="avatar" style="width:52px;height:52px;font-size:21px;">${esc(initial)}</div>
    <div style="flex:1;min-width:0;">
      <div style="font-weight:800;color:var(--ink);font-size:16px;display:flex;align-items:center;gap:6px;">
        <span>${esc(me.username || '—')}</span>
        <span class="muted small" style="font-weight:400;font-size:12px;">(Click to edit security)</span>
      </div>
      <div class="muted small">${esc(isAdmin(me.role) ? 'Platform Owner' : 'Client workspace' + (me.clientId ? ' · #' + me.clientId : ''))}</div>
    </div>
    <span class="pill ${isAdmin(me.role) ? 'blue' : 'green'}">${esc(me.role || '')}</span>`;
  $('more-acct').style.cursor = 'pointer';
  $('more-acct').onclick = openProfileModal;
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  let prefs = `
    <label class="mrow">
      <span class="mrow-ic">${ICONS['sun'] || ''}</span>
      <span class="mrow-tx"><b>Dark Mode</b><small>Easier on the eyes at night</small></span>
      <span class="switch"><input type="checkbox" id="sw-theme" ${dark ? 'checked' : ''}><span class="knob"></span></span>
    </label>
    <button class="mrow" id="more-btn-security" style="width:100%;cursor:pointer;text-align:left;background:none;border:none;">
      <span class="mrow-ic">${ICONS['shield'] || ''}</span>
      <span class="mrow-tx"><b>Account &amp; 2FA Security</b><small>Change password, username &amp; manage Authenticator</small></span>
      <span class="muted">${ICONS.chev}</span>
    </button>`;
  if (isAdmin(me.role)) {
    let autoReply = true;
    try { const cfg = await api('/api/admin/config'); autoReply = !!cfg.autoReply; } catch {}
    prefs += `
    <label class="mrow">
      <span class="mrow-ic">${ICONS['zap'] || ''}</span>
      <span class="mrow-tx"><b>AI Auto-Reply</b><small>Let the AI answer new conversations</small></span>
      <span class="switch"><input type="checkbox" id="sw-autoreply" ${autoReply ? 'checked' : ''}><span class="knob"></span></span>
    </label>`;
  }
  $('more-prefs').innerHTML = prefs;
  $('sw-theme').checked = document.documentElement.getAttribute('data-theme') !== 'light';
  $('sw-theme').onchange = () => { $('btn-theme').click(); };
  const btnSec = $('more-btn-security');
  if (btnSec) btnSec.onclick = openProfileModal;
  const swAr = $('sw-autoreply');
  if (swAr) swAr.onchange = async () => {
    try { await api('/api/admin/config', { method: 'PUT', body: JSON.stringify({ autoReply: swAr.checked }) }); }
    catch { swAr.checked = !swAr.checked; }
  };
  // Workspace section — Structured categories
  if (!isAdmin(me.role)) {
    const categories = [
      {
        title: 'Store & Logistics',
        subtitle: 'Products, Orders & Courier Delivery',
        items: [
          { icon: 'card', t: 'Live Payments Hub', s: 'Instant bKash/Nagad verification & fraud alerts', go: () => openPaymentsModal() },
          { icon: 'boxsm', t: 'My Products', s: 'What you sell — prices & stock', go: () => showView('products') },
          { icon: 'box', t: 'Courier Logistics', s: 'Steadfast & Pathao courier setup & auto-booking', go: () => openCourierConfigModal() },
          { icon: 'sheets', t: 'Orders & Shipping Slips', s: 'Customer orders & 4x6" thermal labels', go: () => openOrdersModal() },
        ]
      },
      {
        title: 'Channels & Live Chat',
        subtitle: 'Social messaging & Website chat',
        items: [
          { icon: 'chat', t: 'Connect Channels', s: 'Link WhatsApp, Telegram, Facebook Messenger', go: () => gotoSettings('channels') },
          { icon: 'sun', t: 'Webchat Widget', s: 'Website chat bubble embed & appearance', go: () => gotoSettings('appearance'), req: 'webchat' },
          { icon: 'zap', t: 'Canned Quick Replies', s: 'Saved responses & / shortcuts (/bkash, /delivery)', go: () => openQuickRepliesModal() },
        ]
      },
      {
        title: 'AI & Intelligence',
        subtitle: 'Knowledge base & customer scoring',
        items: [
          { icon: 'book', t: 'Teach the AI', s: 'Your prices, policies, answers & website crawler', go: () => gotoSettings('kb'), req: 'knowledge' },
          { icon: 'chart', t: 'Lead Intelligence', s: 'Hot/Warm/Cold lead scoring & buyer intent', go: () => showView('leads'), req: 'lead_intel' },
        ]
      },
      {
        title: 'Marketing & Growth',
        subtitle: 'Promotions & announcements',
        items: [
          { icon: 'chat', t: 'Broadcast Campaigns', s: 'Send bulk campaign messages to customers', go: () => showView('broadcast'), req: 'broadcast' },
        ]
      },
      {
        title: 'Settings & System',
        subtitle: 'Plan, backup, developer API & guides',
        items: [
          { icon: 'shield', t: 'Password & Security (2FA)', s: 'Change password & manage Two-Factor Authentication', go: () => openProfileModal() },
          { icon: 'card', t: 'My Plan', s: 'License, features & usage', go: () => gotoSettings('plan') },
          { icon: 'save', t: 'Backup My Data', s: 'Save a copy or restore', go: () => gotoSettings('backup') },
          { icon: 'key', t: 'API Keys', s: 'Integrate your own systems', go: () => gotoSettings('apikeys'), req: 'api_access' },
          { icon: 'help', t: 'Help & Guides', s: 'Step-by-step with pictures', go: () => showView('guide') },
          { icon: 'down', t: 'Install App', s: 'Add Tectobox to your home screen', go: () => promptInstall(), cls: 'pwa-install-btn hidden' },
        ]
      }
    ];

    let catHtml = '';
    let flatItems = [];
    categories.forEach(cat => {
      const activeItems = cat.items.filter(w => !w.req || hasFeature(w.req));
      if (!activeItems.length) return;
      catHtml += `<div class="more-group-title" style="display:flex; justify-content:space-between; align-items:center;">
        <span>${esc(cat.title)}</span>
        <span class="muted small" style="text-transform:none; font-weight:400; font-size:11px;">${esc(cat.subtitle)}</span>
      </div>
      <div class="more-group card" style="margin-bottom:14px;">
        ${activeItems.map(w => {
          const idx = flatItems.length;
          flatItems.push(w);
          return `<button class="mrow ${w.cls || ''}" data-ws="${idx}" style="width:100%;cursor:pointer;text-align:left;">
            <span class="mrow-ic">${ICONS[w.icon] || ''}</span>
            <span class="mrow-tx"><b>${esc(w.t)}</b><small>${esc(w.s)}</small></span>
            <span class="muted">${ICONS.chev}</span>
          </button>`;
        }).join('')}
      </div>`;
    });

    $('more-workspace-wrap').innerHTML = catHtml;
    document.querySelectorAll('#more-workspace-wrap [data-ws]').forEach(b => {
      b.onclick = () => flatItems[+b.dataset.ws].go();
    });
    $('more-workspace-wrap').classList.remove('hidden');
  } else {
    $('more-workspace-wrap').classList.add('hidden');
  }
  renderGetStarted();
  $('more-actions').innerHTML = `
    <button class="mrow danger" id="btn-more-signout" style="width:100%;cursor:pointer;">
      <span class="mrow-tx" style="text-align:center;"><b>Sign Out</b></span>
    </button>`;
  $('btn-more-signout').onclick = () => $('btn-signout').click();
}

// ---------------- setup checklist (make the product feel simple) ----------------
// A 4-step getting-started guide at the top of Settings with live checkmarks.
// Hides itself once everything is done, or when the user dismisses it.
async function renderSetupChecklist() {
  const box = $('setup-checklist');
  if (!box) return;
  try { if (localStorage.getItem('tectonic_setup_hide') === '1') { box.innerHTML = ''; return; } } catch {}
  let conn = state.connectors, products = state.products, kb = state.knowledge, convs = state.conversations;
  try {
    const [c, p, k, cv] = await Promise.all([
      conn ? conn : api(`/api/clients/${state.clientId}/connectors`),
      (products && products.length) ? products : api('/api/products'),
      (kb && kb.length) ? kb : api(`/api/clients/${state.clientId}/knowledge`),
      (convs && convs.length) ? convs : api('/api/conversations'),
    ]);
    conn = c; products = p; kb = k; convs = cv;
  } catch { box.innerHTML = ''; return; }
  const waLive = (conn.whatsapp && ((conn.whatsapp.accounts || []).some(a => a.status === 'connected') || conn.whatsapp.status === 'connected')) || false;
  const tgLive = (conn.telegram && ((conn.telegram.accounts || []).some(a => a.status === 'connected') || conn.telegram.status === 'connected')) || false;
  const webchatUsed = (convs || []).some(c => c.platform === 'webchat');
  const steps = [
    { done: waLive || tgLive, t: 'Connect WhatsApp or Telegram', d: 'Scan one QR code — customer messages land here.', tab: 'channels', btn: 'Connect' },
    { done: (products || []).length > 0, t: 'Add your products', d: 'The AI can only sell what it knows.', view: 'products', btn: 'Add products' },
    { done: (kb || []).length > 0, t: 'Teach the AI', d: 'Add a preset answer or import your website.', tab: 'kb', btn: 'Add knowledge' },
    { done: webchatUsed, t: 'Put chat on your website', d: 'Paste one line of code — chats appear in your inbox.', tab: 'channels', btn: 'Get embed code' },
  ];
  const doneCount = steps.filter(s => s.done).length;
  if (doneCount === steps.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="card fade-in" style="margin-bottom:16px; border:1.5px solid var(--brand-soft);">
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:4px;">
      <div style="font-weight:800; color:var(--ink); font-size:15px;">Get set up in 4 steps</div>
      <span class="pill ${doneCount ? 'blue' : ''}">${doneCount} of 4 done</span>
      <button class="btn-ghost" id="setup-hide" style="margin-left:auto; padding:4px 10px; font-size:12px;">Hide</button>
    </div>
    <div class="setup-steps">
      ${steps.map((s, i) => `
        <div class="setup-step ${s.done ? 'done' : ''}">
          <div class="setup-check">${s.done ? '✓' : (i + 1)}</div>
          <div style="flex:1;"><b>${esc(s.t)}</b><div class="muted small">${esc(s.d)}</div></div>
          ${s.done ? '' : `<button class="btn-primary btn-sm" data-setup-go="${i}">${esc(s.btn)}</button>`}
        </div>`).join('')}
    </div>
  </div>`;
  $('setup-hide').onclick = () => { try { localStorage.setItem('tectonic_setup_hide', '1'); } catch {} box.innerHTML = ''; };
  box.querySelectorAll('[data-setup-go]').forEach(b => b.onclick = () => {
    const s = steps[+b.dataset.setupGo];
    if (s.view) showView(s.view);
    else if (s.tab) switchSettingsTab(s.tab);
  });
}
// ---------------- client: settings ----------------
function switchSettingsTab(tab) {
  state.settingsTab = tab;
  document.querySelectorAll('#settings-tabs button').forEach(b => b.classList.toggle('active', b.dataset.st === tab));
  $('stab-channels').classList.toggle('hidden', tab !== 'channels');
  $('stab-kb').classList.toggle('hidden', tab !== 'kb');
  $('stab-appearance').classList.toggle('hidden', tab !== 'appearance');
  $('stab-backup').classList.toggle('hidden', tab !== 'backup');
  $('stab-plan').classList.toggle('hidden', tab !== 'plan');
  $('stab-apikeys').classList.toggle('hidden', tab !== 'apikeys');
  if (tab === 'channels') loadConnectors();
  if (tab === 'kb') { switchKbSubTab(state.kbSubTab); loadKnowledge(); }
  if (tab === 'appearance') loadAppearanceTab();
  if (tab === 'backup') loadBackupTab();
  if (tab === 'plan') renderPlanTab();
  if (tab === 'apikeys') renderApiKeysTab();
}
function switchKbSubTab(sub) {
  state.kbSubTab = sub;
  document.querySelectorAll('#kb-subtabs button').forEach(b => b.classList.toggle('active', b.dataset.kb === sub));
  $('kbtab-docs').classList.toggle('hidden', sub !== 'docs');
  $('kbtab-presets').classList.toggle('hidden', sub !== 'presets');
  $('kbtab-website').classList.toggle('hidden', sub !== 'website');
  if (sub === 'presets') renderKbPresets();
  if (sub === 'website') loadKbImports();
}
// ---------------- webchat widget card (embed snippet + website importer) ----------------
// Phase 5: toast systems unified — wcToast is now an alias for toast()
// (single implementation in views/inbox.js). Kept as a named function so
// existing callers need no change.
function wcToast(msg) { toast(msg); }
function webchatCard() {
  const w = state.webchat || {};
  // Honest status: the embed is "ready" once a real widget key exists —
  // never a hardcoded "connected" (2026-11-12: no demo data in prod).
  const wcStatus = (state.connectors && state.connectors.webchat && state.connectors.webchat.status) || 'disconnected';
  const snippet = `<script src="${location.origin}/widget.js?v=20261006w" data-client="${w.widget_key || ''}"></script>`;
  return `<div class="chan-card fade-in">
    <div class="top"><span class="plat-badge p-webchat">WC</span>
      <span class="nm">Webchat</span>
      <span style="margin-left:auto;">${statusPill(wcStatus)}</span></div>
    <div class="note">Paste the snippet on any website — visitor chats land in this inbox and the AI answers from your products + website content. Style the bubble under <b>Settings → Appearance</b>.</div>
    <div class="ca-label" style="margin-top:14px;">Put it on your website</div>
    <div class="code-box" style="word-break:break-all; font-size:12px;">${esc(snippet)}</div>
    <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
      <button class="btn-primary" id="wc-copy">Copy embed code</button>
      <button class="add-acct" id="wc-test">Try it on this page</button>
    </div>
  </div>`;
}
function wireWebchatCard() {
  const w = state.webchat || {};
  const snippet = `<script src="${location.origin}/widget.js?v=20261006w" data-client="${w.widget_key || ''}"></script>`;
  const copyBtn = $('wc-copy');
  if (copyBtn) copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(snippet); wcToast('Embed code copied ✓'); }
    catch { wcToast('Copy failed — select the code manually'); }
  };
  const testBtn = $('wc-test');
  if (testBtn) testBtn.onclick = () => {
    if (document.querySelector('script[data-wc-test]')) { wcToast('Test widget already on this page — check the corner'); return; }
    const s = document.createElement('script');
    s.src = `${location.origin}/widget.js?v=20261006w`;
    s.setAttribute('data-client', w.widget_key || '');
    s.setAttribute('data-wc-test', '1');
    document.body.appendChild(s);
    wcToast('Test widget loaded — it uses your saved appearance');
  };
}

// ---------------- settings: appearance (chat widget) ----------------
function appearanceCard() {
  const w = state.webchat || {};
  const ap = w.appearance || {};
  const EMOJIS = ['', '😊', '🏪', '🛍️', '💬', '🤖', '⭐', '❤️'];
  const COLORS = ['#7c5cff', '#2563eb', '#0ea5a4', '#16a34a', '#f59e0b', '#ef4444', '#ec4899', '#111827'];
  return `
    <div style="font-weight:800; color:var(--ink); font-size:16px; margin-bottom:4px;">Chat widget appearance</div>
    <p class="muted small" style="margin-bottom:14px;">How the chat bubble looks on your website — the preview updates live as you edit. Press <b>Save appearance</b> to publish it.</p>
    <div class="wc-appear">
      <div class="wc-previewwrap">
        <div class="wc-pv" id="wc-pv">
          <div class="wc-pv-head">
            <div class="wc-pv-avatar" id="wc-pv-avatar">C</div>
            <div class="wc-pv-ht"><b id="wc-pv-title">Chat with us</b><span id="wc-pv-sub">Online — replies instantly</span></div>
          </div>
          <div class="wc-pv-msgs">
            <div class="wc-pv-in" id="wc-pv-greet">Hi there! How can I help you today?</div>
            <div class="wc-pv-out">Do you have this in blue?</div>
          </div>
          <div class="wc-pv-input"><span>Type your message…</span><i id="wc-pv-send"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg></i></div>
        </div>
        <div class="wc-pv-bubwrap"><div class="wc-pv-bubble" id="wc-pv-bubble">
          <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.14 2 11.25c0 2.92 1.56 5.55 4.03 7.35-.1.72-.58 2.6-1.83 3.9 0 0 2.35.13 4.42-1.6.86.23 1.77.35 2.71.35h.67c5.52 0 10-4.14 10-9.25S17.52 2 12 2z"/></svg>
        </div></div>
      </div>
      <div class="wc-controls">
        <label class="wc-lab">Chat name<input id="wc-title" class="wc-in" maxlength="60" value="${esc(ap.title || 'Chat with us')}" placeholder="e.g. Riya Fashion"></label>
        <label class="wc-lab">Welcome message<input id="wc-greeting" class="wc-in" maxlength="300" value="${esc(ap.greeting || '')}" placeholder="Hi there! How can I help?"></label>
        <label class="wc-lab">Status text<input id="wc-subtitle" class="wc-in" maxlength="80" value="${esc(ap.subtitle || '')}" placeholder="Online — replies instantly"></label>
        <div class="wc-lab">Profile icon
          <div class="wc-pick" id="wc-emojis">${EMOJIS.map(e => `<button class="wc-opt" data-v="${e}">${e || '<b>A</b>'}</button>`).join('')}</div>
          <input id="wc-avatar-url" class="wc-in" style="margin-top:6px;" placeholder="…or paste your logo image link (optional)" value="${/^https?:/i.test(ap.avatar || '') ? esc(ap.avatar) : ''}">
        </div>
        <div class="wc-lab">Color
          <div class="wc-pick" id="wc-swatches">${COLORS.map(c => `<button class="wc-swatch" data-v="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}</div>
          <div class="wc-colorrow"><input type="color" id="wc-color" value="${esc(ap.color || '#7c5cff')}"><span id="wc-colorhex" class="note">${esc(ap.color || '#7c5cff')}</span></div>
        </div>
        <div class="wc-lab">Corner
          <div class="wc-pick" id="wc-pos">
            <button class="wc-opt wc-wide" data-v="bottom-right">Bottom right</button>
            <button class="wc-opt wc-wide" data-v="bottom-left">Bottom left</button>
          </div>
        </div>
        <div class="wc-lab">Before chat starts
          <div class="wc-pick" id="wc-intro">
            <button class="wc-opt wc-wide" data-v="1">Ask name & phone/email</button>
            <button class="wc-opt wc-wide" data-v="0">Start instantly</button>
          </div>
          <div class="note" style="margin-top:4px;">Visitors introduce themselves first — you always know who's talking.</div>
        </div>
        <div class="wc-lab">Human check
          <div class="wc-pick" id="wc-captcha">
            <button class="wc-opt wc-wide" data-v="1">Simple math question</button>
            <button class="wc-opt wc-wide" data-v="0">No check</button>
          </div>
          <div class="note" style="margin-top:4px;">Visitors solve 7 + 5 = ? before chatting — stops spam bots.</div>
        </div>
        <button class="btn-primary" id="wc-save-appear" style="margin-top:4px;">Save appearance</button>
      </div>
    </div>`;
}
async function loadAppearanceTab() {
  if (!state.webchat || !state.webchat.widget_key) {
    try { state.webchat = await api('/api/webchat/config'); } catch { state.webchat = {}; }
  }
  const w = state.webchat || {};
  const snippet = `<script src="${location.origin}/widget.js?v=20261006w" data-client="${w.widget_key || ''}"></script>`;

  $('appearance-card').innerHTML = `
    <div style="background:var(--active); border:1px solid var(--line); border-radius:14px; padding:18px; margin-bottom:20px;">
      <div style="font-weight:700; font-size:16px; color:var(--ink); margin-bottom:4px; display:flex; align-items:center; gap:8px;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> Webchat Website Integration
      </div>
      <p class="muted small" style="margin-bottom:12px;">Paste this script snippet on your website before the <b>&lt;/body&gt;</b> tag. Visitor chats land directly into your Tectobox unified inbox and the AI answers automatically from your products &amp; FAQs.</p>
      <div class="code-box" style="word-break:break-all; font-size:12px; margin-bottom:12px; font-family:ui-monospace,monospace; background:var(--card); padding:12px; border-radius:8px; border:1px solid var(--line);">${esc(snippet)}</div>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn-primary" id="wc-tab-copy">Copy embed code</button>
        <button class="btn-soft" id="wc-tab-test">Try live on this page</button>
      </div>
    </div>
    ${appearanceCard()}
  `;

  const copyBtn = $('wc-tab-copy');
  if (copyBtn) copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      toast('Webchat embed code copied to clipboard ✓');
    } catch {
      toast('Copy failed — please select code manually', 'err');
    }
  };
  const testBtn = $('wc-tab-test');
  if (testBtn) testBtn.onclick = () => {
    if (document.querySelector('script[data-wc-test]')) {
      toast('Test widget already loaded — see bottom corner');
      return;
    }
    const s = document.createElement('script');
    s.src = `${location.origin}/widget.js?v=20261006w`;
    s.setAttribute('data-client', w.widget_key || '');
    s.setAttribute('data-wc-test', '1');
    document.body.appendChild(s);
    toast('Test widget loaded — test chatting in bottom corner!');
  };

  wireAppearance();
}

// ---------------- Backup & Google Drive ----------------
// ---------------- client: My Plan (license sync view) ----------------
const CLIENT_FEATURES = [
  { key: 'combined_inbox', label: 'Combined inbox', desc: 'All platforms in one unified inbox' },
  { key: 'ai_response', label: 'AI auto-replies', desc: 'AI answers customers on every channel' },
  { key: 'webchat', label: 'Webchat widget', desc: 'Chat bubble for your website' },
  { key: 'broadcast', label: 'Broadcast', desc: 'Bulk campaign messaging' },
  { key: 'lead_intel', label: 'Lead intelligence', desc: 'AI lead scoring (Hot/Warm/Cold)' },
  { key: 'knowledge', label: 'Knowledge base', desc: 'Teach the AI from docs + website' },
  { key: 'api_access', label: 'API keys & webhooks', desc: 'Public API v1 + outbound webhooks' },
];
async function renderPlanTab() {
  const card = $('plan-card');
  card.innerHTML = `<div class="card small muted">Loading plan…</div>`;
  let a = state.access;
  try { a = await api('/api/client/access'); state.access = a; } catch {}
  if (!a) { card.innerHTML = `<div class="card small err">Could not load plan details.</div>`; return; }
  const lic = a.license;
  const modeLabel = { licensed: 'Licensed plan', legacy: 'Legacy — full access', none: 'No active license', suspended: 'Suspended' }[a.mode] || a.mode;
  // Only included features are ever listed — unlicensed features are not shown.
  const featRows = CLIENT_FEATURES.filter(f => (a.features || []).includes(f.key)).map(f => {
    return `<div class="mrow" style="cursor:default;">
      <span class="mrow-ic" style="color:var(--ok);">✓</span>
      <span class="mrow-tx"><b>${esc(f.label)}</b><small>${esc(f.desc)}</small></span>
      <span class="pill green">Included</span>
    </div>`;
  }).join('');
  const creditLine = lic && lic.kind === 'credit'
    ? `<div class="kv"><span>AI credits</span><b>${lic.credits_used} / ${lic.credits_total} used</b></div>
       <div class="meter" style="margin:6px 0 12px;"><div class="meter-fill" style="width:${Math.min(100, Math.round(lic.credits_used / Math.max(1, lic.credits_total) * 100))}%;"></div></div>` : '';
  const featCreditLine = lic && lic.kind === 'feature' && lic.feature_grants
    ? lic.feature_grants.map(g => `<div class="kv"><span>${esc((CLIENT_FEATURES.find(f => f.key === g.feature) || {}).label || g.feature)}</span><b>${g.mode === 'unlimited' ? 'Unlimited' : g.credits_used + ' / ' + g.credits_total + ' used'}</b></div>`).join('') : '';
  // The backend may signal an issued-but-unactivated key for this workspace.
  const pending = (a.pendingLicense || a.pending_license || (lic && lic.status === 'pending_activation' ? lic : null));
  card.innerHTML = `
    <div class="ttl" style="font-size:17px; margin-bottom:4px;">My Plan</div>
    <p class="muted small" style="margin-bottom:14px;">What your workspace is licensed for — synced live with the platform.</p>
    <div class="kv"><span>Status</span><b>${esc(modeLabel)}</b></div>
    ${lic ? `<div class="kv"><span>Plan</span><b>${esc(lic.plan_name || 'Licensed plan')}</b></div>
    <div class="kv"><span>License code</span><code>${esc(lic.code)}</code></div>
    ${lic.kind === 'time' && lic.ends_at ? `<div class="kv"><span>Renews / expires</span><b>${esc(fmtDate(lic.ends_at))}</b></div>` : ''}` : ''}
    ${a.mode === 'none' ? `<p class="muted small" style="margin:10px 0 0;">No active license on this workspace.</p>` : ''}
    ${a.aiPaused ? `<div class="notice warn" style="margin:10px 0;">AI replies are paused by the platform admin. Your inbox keeps working.</div>` : ''}
    ${creditLine}${featCreditLine}
    <hr style="margin:16px 0; border:none; border-top:1px solid var(--line);">
    <div class="ttl" style="margin-bottom:8px;">Features</div>
    ${featRows || '<p class="muted small">No licensed features on this workspace.</p>'}
    <hr style="margin:16px 0; border:none; border-top:1px solid var(--line);">
    <div class="ttl" style="margin-bottom:8px;">Activate license key</div>
    ${pending ? `<p class="muted small" style="margin-bottom:10px;">A license key was issued for this workspace — enter it below to activate.</p>` : ''}
    <div style="display:flex; gap:8px; margin-bottom:8px;">
      <input id="lic-activate-code" class="input no-icon mono" placeholder="LIC-XXXXXXXXXXXX" style="flex:1; min-width:0; text-transform:uppercase;" autocomplete="off">
      <button class="btn-primary" id="lic-activate-btn">Activate</button>
    </div>
    <div id="lic-activate-msg" class="small" style="min-height:18px;"></div>`;
  const actBtn = $('lic-activate-btn');
  if (actBtn) actBtn.onclick = async () => {
    const codeEl = $('lic-activate-code');
    const msgEl = $('lic-activate-msg');
    const code = (codeEl.value || '').trim();
    if (!code) { msgEl.textContent = 'Enter a license key first.'; msgEl.style.color = 'var(--err, #ef4444)'; return; }
    actBtn.disabled = true;
    actBtn.textContent = 'Activating…';
    msgEl.textContent = '';
    try {
      const res = await api('/api/client/licenses/activate', { method: 'POST', body: JSON.stringify({ code }) });
      // The server returns fresh access — re-gate the whole UI without a reload.
      try { state.access = await api('/api/client/access'); } catch { state.access = res.access || res; }
      applyAccessGating();
      renderNav();
      markActiveNav();
      await renderPlanTab();
      toast('License activated.', 'ok');
    } catch (e) {
      msgEl.textContent = e.message || 'Activation failed.';
      msgEl.style.color = 'var(--err, #ef4444)';
      actBtn.disabled = false;
      actBtn.textContent = 'Activate';
    }
  };
}
// ---------------- client: API keys ----------------
async function renderApiKeysTab() {
  const card = $('apikeys-card');
  if (!hasFeature('api_access')) {
    showView(firstAvailableView());
    return;
  }
  card.innerHTML = `<div class="card small muted">Loading API keys…</div>`;
  let keys = [];
  try { keys = (await api(`/api/clients/${state.clientId}/api-keys`)).filter(k => !k.revoked); } catch {}
  card.innerHTML = `
    <div class="ttl" style="font-size:17px; margin-bottom:4px;">API Keys</div>
    <p class="muted small" style="margin-bottom:14px;">Use these keys with the <a href="/api-docs.html" target="_blank" rel="noopener">public API v1</a> (<span class="mono">Authorization: Bearer &lt;key&gt;</span>). The full key is shown once — store it safely.</p>
    <div style="display:flex; gap:8px; margin-bottom:14px;">
      <input id="ak-name" class="input no-icon" placeholder="Key name (e.g. website)" style="flex:1; min-width:0;">
      <button class="btn-primary" id="ak-create">Create key</button>
    </div>
    <div id="ak-new"></div>
    <div id="ak-list">${keys.map(k => `
      <div class="mrow" style="cursor:default;">
        <span class="mrow-ic">${ICONS.key || ''}</span>
        <span class="mrow-tx"><b>${esc(k.name || 'key')}</b><small class="mono">${esc(k.prefix || '')}… · last used ${k.last_used_at ? esc(fmtDT(k.last_used_at)) : 'never'}</small></span>
        <button class="mini-btn danger" data-ak-del="${k.id}">Revoke</button>
      </div>`).join('') || '<p class="muted small">No API keys yet.</p>'}</div>`;
  card.querySelector('#ak-create').onclick = async () => {
    const name = card.querySelector('#ak-name').value.trim() || 'integration';
    try {
      const r = await api(`/api/clients/${state.clientId}/api-keys`, { method: 'POST', body: JSON.stringify({ name }) });
      // Re-render the list WITHOUT wiping the one-time key display.
      const onceHtml = `<div class="notice warn" style="margin-bottom:10px;"><span>New key (copy now — shown once):<br><code style="user-select:all;">${esc(r.api_key)}</code></span></div>`;
      await renderApiKeysTab();
      const slot = $('ak-new');
      if (slot) slot.innerHTML = onceHtml;
    } catch (e) { toast('Failed: ' + e.message, 'err'); }
  };
  card.querySelectorAll('[data-ak-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Revoke this API key?')) return;
    try { await api(`/api/clients/${state.clientId}/api-keys/${b.dataset.akDel}`, { method: 'DELETE' }); renderApiKeysTab(); }
    catch (e) { toast('Failed: ' + e.message, 'err'); }
  });
}
async function loadBackupTab() {
  const card = $('backup-card');
  card.innerHTML = `<div class="card small muted">Loading backup status…</div>`;
  let st = { configured: false, connected: false };
  try { st = await api('/api/backup/drive/status'); } catch {}
  const driveSection = !st.configured ? `
    <div class="card small" style="background:var(--hover); margin-top:14px;">
      <div class="ttl" style="margin-bottom:6px;">Google Drive not configured</div>
      <div class="muted small">The workspace owner needs to add Google OAuth credentials
      (<span class="mono">GOOGLE_DRIVE_CLIENT_ID</span> / <span class="mono">GOOGLE_DRIVE_SECRET</span>)
      on the server first. Local download / upload works without it.</div>
    </div>` : st.connected ? `
    <div class="row" style="gap:10px; margin-top:14px; align-items:center;">
      <span class="pill ok">Drive connected${st.email ? ' · ' + esc(st.email) : ''}</span>
      <button class="mini-btn" data-bk-drive-upload>Back up to Drive</button>
      <button class="mini-btn" data-bk-drive-list>View Drive backups</button>
      <button class="mini-btn danger" data-bk-drive-disconnect>Disconnect</button>
    </div>
    <div id="bk-drive-files" style="margin-top:10px;"></div>` : `
    <div style="margin-top:14px;">
      <a class="btn primary" href="/api/backup/drive/connect?client_id=${state.clientId}" target="_blank" rel="noopener">Connect Google Drive</a>
      <div class="muted small" style="margin-top:8px;">Backups go to a <b>${esc(st.folder || 'Tectobox Backups')}</b> folder in your Drive.</div>
    </div>`;

  card.innerHTML = `
    <div class="ttl" style="font-size:17px; margin-bottom:4px;">Backup & Restore</div>
    <p class="muted small" style="margin-bottom:14px;">Export everything — products, knowledge, leads, orders, conversations — as a portable backup. Restore it on any device.</p>
    <div class="row" style="gap:10px; flex-wrap:wrap;">
      <button class="btn primary" data-bk-export>Download backup (.json)</button>
      <button class="mini-btn" data-bk-export-md>Export summary (.md)</button>
      <label class="mini-btn" style="cursor:pointer;">Restore from file<input type="file" data-bk-import accept=".json,application/json" style="display:none;"></label>
    </div>
    <div id="bk-status" class="muted small" style="margin-top:10px;"></div>
    <hr style="margin:16px 0; border:none; border-top:1px solid var(--line);">
    <div class="ttl" style="margin-bottom:4px;">Google Drive</div>
    ${driveSection}`;

  const say = (t, err) => { $('bk-status').innerHTML = `<span class="${err ? 'err' : 'ok'}">${esc(t)}</span>`; };
  card.querySelector('[data-bk-export]').onclick = () => {
    window.location = `/api/clients/${state.clientId}/backup/export`;
    say('Backup downloading…');
  };
  card.querySelector('[data-bk-export-md]').onclick = () => {
    window.location = `/api/clients/${state.clientId}/backup/export-md`;
  };
  card.querySelector('[data-bk-import]').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const bundle = JSON.parse(await f.text());
      say('Restoring…');
      const r = await api(`/api/clients/${state.clientId}/backup/import`, { method: 'POST', body: JSON.stringify(bundle) });
      say(`Restored: ${r.imported.products} products, ${r.imported.knowledge} knowledge docs, ${r.imported.leads} leads, ${r.imported.orders} orders.`);
    } catch (err) { say('Restore failed: ' + err.message, true); }
    e.target.value = '';
  };
  const du = card.querySelector('[data-bk-drive-upload]');
  if (du) du.onclick = async () => {
    say('Uploading to Drive…');
    try {
      const r = await api(`/api/clients/${state.clientId}/backup/drive/upload`, { method: 'POST' });
      say(`Backed up to Drive → ${r.folder}/ (${r.files.map(f => f.name).join(', ')})`);
      loadBackupTab();
    } catch (e) { say('Drive upload failed: ' + e.message, true); }
  };
  const dl = card.querySelector('[data-bk-drive-list]');
  if (dl) dl.onclick = async () => {
    const el = $('bk-drive-files');
    el.innerHTML = `<div class="muted small">Loading…</div>`;
    try {
      const r = await api(`/api/clients/${state.clientId}/backup/drive/list`);
      el.innerHTML = r.files.length ? r.files.map(f => `
        <div class="row" style="justify-content:space-between; padding:8px 0; border-top:1px solid var(--line);">
          <div><div class="small">${esc(f.name)}</div><div class="muted" style="font-size:11px;">${new Date(f.modifiedTime).toLocaleString()}</div></div>
          ${f.name.endsWith('.json') ? `<button class="mini-btn" data-restore="${f.id}">Restore</button>` : ''}
        </div>`).join('') : `<div class="muted small">No backups in Drive yet.</div>`;
      el.querySelectorAll('[data-restore]').forEach(b => b.onclick = async () => {
        if (!await askConfirm('Restore this backup?', 'Existing data is kept — backup content is merged in.', 'Restore')) return;
        say('Restoring from Drive…');
        try {
          const rr = await api(`/api/clients/${state.clientId}/backup/drive/restore`, { method: 'POST', body: JSON.stringify({ fileId: b.dataset.restore }) });
          say(`Restored from Drive: ${rr.imported.products} products, ${rr.imported.knowledge} docs, ${rr.imported.leads} leads, ${rr.imported.orders} orders.`);
        } catch (e) { say('Restore failed: ' + e.message, true); }
      });
    } catch (e) { el.innerHTML = `<div class="err small">Failed: ${esc(e.message)}</div>`; }
  };
  const dd = card.querySelector('[data-bk-drive-disconnect]');
  if (dd) dd.onclick = async () => {
    if (!await askConfirm('Disconnect Google Drive?', '', 'Disconnect', true)) return;
    await api('/api/backup/drive/disconnect', { method: 'POST' });
    loadBackupTab();
  };
}
function wireAppearance() {
  const w = state.webchat || {};
  const ap = w.appearance || {};
  const st = {
    title: ap.title || 'Chat with us',
    greeting: ap.greeting || 'Hi there! How can I help you today?',
    subtitle: ap.subtitle || 'Online — replies instantly',
    color: ap.color || '#7c5cff',
    position: ap.position || 'bottom-right',
    avatar: ap.avatar || '',
    require_intro: ap.require_intro === undefined || ap.require_intro === null ? 1 : +ap.require_intro,
    captcha: ap.captcha === undefined || ap.captcha === null ? 1 : +ap.captcha,
  };
  const $id = (x) => $(x);
  function tint(hex, pct) {
    const h = String(hex || '#7c5cff').replace('#', '');
    const f = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    const n = parseInt(f, 16) || 0;
    const r = Math.round(((n >> 16) & 255) * pct + 255 * (1 - pct));
    const g = Math.round(((n >> 8) & 255) * pct + 255 * (1 - pct));
    const b = Math.round((n & 255) * pct + 255 * (1 - pct));
    return `rgb(${r},${g},${b})`;
  }
  function avatarHTML() {
    const av = (st.avatar || '').trim();
    if (/^https?:\/\//i.test(av)) return `<img src="${esc(av)}" alt="">`;
    if (av) return esc(av);
    return esc((st.title || 'C').charAt(0).toUpperCase());
  }
  function paint() {
    if ($id('wc-pv-title')) $id('wc-pv-title').textContent = st.title;
    if ($id('wc-pv-sub')) $id('wc-pv-sub').textContent = st.subtitle;
    if ($id('wc-pv-greet')) $id('wc-pv-greet').textContent = st.greeting;
    if ($id('wc-pv-avatar')) { $id('wc-pv-avatar').innerHTML = avatarHTML(); $id('wc-pv-avatar').style.background = tint(st.color, .14); $id('wc-pv-avatar').style.color = st.color; }
    if ($id('wc-pv-send')) $id('wc-pv-send').style.background = st.color;
    if ($id('wc-pv-bubble')) $id('wc-pv-bubble').querySelector('svg').style.fill = st.color;
    document.querySelectorAll('#wc-pv .wc-pv-out').forEach(e => e.style.background = st.color);
    document.querySelectorAll('#wc-emojis .wc-opt').forEach(b => b.classList.toggle('sel', (b.dataset.v || '') === (/^https?:\/\//i.test(st.avatar || '') ? '__url__' : (st.avatar || ''))));
    document.querySelectorAll('#wc-swatches .wc-swatch').forEach(b => b.classList.toggle('sel', b.dataset.v.toLowerCase() === st.color.toLowerCase()));
    document.querySelectorAll('#wc-pos .wc-opt').forEach(b => b.classList.toggle('sel', b.dataset.v === st.position));
    document.querySelectorAll('#wc-intro .wc-opt').forEach(b => b.classList.toggle('sel', +b.dataset.v === +st.require_intro));
    document.querySelectorAll('#wc-captcha .wc-opt').forEach(b => b.classList.toggle('sel', +b.dataset.v === +st.captcha));
    if ($id('wc-colorhex')) $id('wc-colorhex').textContent = st.color;
  }
  ['wc-title', 'wc-greeting', 'wc-subtitle'].forEach(id => {
    const el = $id(id); if (el) el.oninput = () => {
      st[{ 'wc-title': 'title', 'wc-greeting': 'greeting', 'wc-subtitle': 'subtitle' }[id]] = el.value;
      paint();
    };
  });
  const avUrl = $id('wc-avatar-url');
  if (avUrl) avUrl.oninput = () => { st.avatar = avUrl.value.trim(); paint(); };
  document.querySelectorAll('#wc-emojis .wc-opt').forEach(b => b.onclick = () => {
    st.avatar = b.dataset.v || '';
    if (avUrl) avUrl.value = '';
    paint();
  });
  document.querySelectorAll('#wc-swatches .wc-swatch').forEach(b => b.onclick = () => {
    st.color = b.dataset.v;
    const ci = $id('wc-color'); if (ci) ci.value = st.color;
    paint();
  });
  const ci = $id('wc-color');
  if (ci) ci.oninput = () => { st.color = ci.value; paint(); };
  document.querySelectorAll('#wc-pos .wc-opt').forEach(b => b.onclick = () => { st.position = b.dataset.v; paint(); });
  document.querySelectorAll('#wc-intro .wc-opt').forEach(b => b.onclick = () => { st.require_intro = +b.dataset.v; paint(); });
  document.querySelectorAll('#wc-captcha .wc-opt').forEach(b => b.onclick = () => { st.captcha = +b.dataset.v; paint(); });
  const saveBtn = $id('wc-save-appear');
  if (saveBtn) saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      const r = await api('/api/webchat/config', { method: 'POST', body: JSON.stringify(st) });
      if (r && r.ok) { state.webchat.appearance = r.appearance; wcToast('Appearance saved ✓'); }
      else wcToast('Save failed');
    } catch (e) { wcToast('Save failed: ' + (e.message || '')); }
    saveBtn.disabled = false;
  };
  paint();
}
