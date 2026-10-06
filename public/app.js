// Tectobox — AI-powered unified inbox frontend (vanilla JS + SSE).
// Auth-first: client users are auto-scoped server-side; admin gets the Platform panel.
const PLATFORMS = {
  whatsapp:  { label: 'WhatsApp',  badge: 'WA', cls: 'p-whatsapp',  color: '#25D366' },
  telegram:  { label: 'Telegram',  badge: 'TG', cls: 'p-telegram',  color: '#229ED9' },
  messenger: { label: 'Messenger', badge: 'M',  cls: 'p-messenger', color: '#0099ff' },
  instagram: { label: 'Instagram', badge: 'IG', cls: 'p-instagram', color: '#ee2a7b' },
  webchat:   { label: 'Webchat',   badge: 'WC', cls: 'p-webchat',   color: '#7c5cff' },
};
const LEAD_NEXT = { lead: 'user', user: 'confirmed', confirmed: 'confirmed' };
const LEAD_PILL = { lead: 'amber', user: 'blue', confirmed: 'green' };
// Meta (Messenger + Instagram) Page connect is hidden until the Meta app
// verification is complete. Flip to true to re-enable the connect UI.
const META_CONNECTORS_VISIBLE = false;

const state = {
  me: null,            // {username, role, clientId}
  clientId: null,      // from /api/auth/me (client role)
  view: null,          // client sub-view or 'admin'
  conversations: [],
  messages: [],
  activeId: null,
  platformFilter: 'all',
  convQuery: '',
  needsHuman: false,
  products: [],
  orderLines: {},
  status: {},
  leads: [],
  leadTemp: 'all',
  leadStage: 'all',
  leadSegment: 'all',
  leadQuery: '',
  knowledge: [],
  connectors: {},
  editingLeadId: null,
  editingProductId: null,
  qrChannel: null,
  qrSlot: null,
  adminTab: 'resources',
  settingsTab: 'channels',
  kbSubTab: 'docs',
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Conversation-list preview: never leak raw AI JSON like {"reply":"..."}.
// Parses it defensively and shows just the human-readable reply text.
function previewText(t) {  let s = String(t == null ? '' : t).trim();
  if (!s) return '';
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s);
      if (o && typeof o.reply === 'string' && o.reply.trim()) return o.reply.trim();
    } catch {}
    const m = s.match(/^\{\s*"reply"\s*:\s*"(.*)$/s);
    if (m) {
      let x = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
      const debris = x.search(/",\s*"[A-Za-z_][A-Za-z0-9_]*"\s*:/);
      if (debris > 0) x = x.slice(0, debris);
      x = x.replace(/"\s*\}?\s*$/, '').trim();
      if (x) return x;
    }
  }
  return s;
}

function relTime(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
// Messenger-grade avatar: gradient circle from name hash, initials, platform
// mini-badge, and an online dot when the conversation was active recently.
function avatarHue(name) {
  let h = 0;
  for (const ch of String(name || '?')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
function avatarInitials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function convAvatar(c, size) {
  const m = PLATFORMS[c.platform] || {};
  const nm = c.customer_name || m.label || c.platform;
  const badge = { whatsapp: ['WA', 'p-whatsapp'], telegram: ['TG', 'p-telegram'], webchat: ['WC', 'p-webchat'], messenger: ['M', 'p-messenger'], instagram: ['IG', 'p-instagram'] }[c.platform];
  // Online dot: active within the last 10 minutes.
  let online = false;
  try { online = (Date.now() - new Date(c.last_message_at).getTime()) < 10 * 60 * 1000; } catch {}
  return `<div class="conv-avatar${size === 'lg' ? ' lg' : ''}" style="--av-hue:${avatarHue(nm)}" title="${esc(nm)}">
    <span>${esc(avatarInitials(nm))}</span>
    ${badge ? `<span class="av-badge ${badge[1]}">${badge[0]}</span>` : ''}
    ${online ? '<span class="av-online"></span>' : ''}
  </div>`;
}
function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dhaka' });
}
function fmtDT(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Dhaka', month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
}
function fmtDay(iso) {
  const d = new Date(new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }));
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }));
  const yest = new Date(today); yest.setDate(yest.getDate() - 1);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, today)) return 'Today';
  if (same(d, yest)) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function platBadge(p, size) {
  const m = PLATFORMS[p] || { badge: '?', cls: '' };
  return `<span class="plat-badge ${m.cls}" title="${esc(m.label || p)}" ${size ? `style="width:${size}px;height:${size}px;border-radius:${size / 3}px;font-size:${size / 2.7}px;"` : ''}>${m.badge}</span>`;
}
function platDot(p) {
  const m = PLATFORMS[p] || {};
  return `<span class="plat-dot" style="background:${m.color || '#999'}"></span>`;
}
function statusPill(status) {
  const cls = status === 'connected' ? 'green' : status === 'error' ? 'red' : status === 'pending' ? 'amber' : 'gray';
  return `<span class="pill ${cls}"><span class="dot"></span>${esc(status)}</span>`;
}
function leadPill(status) {
  return `<span class="pill ${LEAD_PILL[status] || 'gray'}">${esc(status)}</span>`;
}

// ---------------- api ----------------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401) { showLogin(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------- auth ----------------
function showLogin() {
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
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  var _bt2 = $('bottom-tabs'); if (_bt2) _bt2.classList.remove('hidden');
  $('user-name').textContent = me.username;
  $('user-avatar').textContent = (me.username || '?')[0].toUpperCase();
  if (me.role === 'admin') {
    var _bs=$('brand-sub'); if(_bs) _bs.textContent='Platform Panel';
    $('btn-refresh').classList.remove('hidden');
    renderNav([
      { id: 'admin', label: 'Platform', icon: 'grid' },
      { id: 'more', label: 'More', icon: 'dots' },
    ]);
    showView('admin');
    loadAdmin();
  } else {
    var _bs2=$('brand-sub'); if(_bs2) _bs2.textContent='Tectobox';
    $('btn-refresh').classList.add('hidden');
    renderNav([
      { id: 'inbox', label: 'Inbox', icon: 'inbox' },
      { id: 'leads', label: 'Leads', icon: 'sheets' },
      { id: 'more', label: 'More', icon: 'dots' },
    ]);
    showView('inbox');
    loadClientAll();
  }
  connectSSE();
  maybeShowMetaPicker();
}
const ICONS = {
  inbox: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.5L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.5A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.5z"/></svg>',
  sheets: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>',
  box: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
  gear: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  grid: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  dots: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  sun: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2 12h2.5M19.5 12H22M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>',
  zap: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>',
  chat: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8.5v.5z"/></svg>',
  book: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  boxsm: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
  card: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20"/></svg>',
  chev: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
};
function renderNav(items) {
  $('nav-links').innerHTML = items.map(i =>
    `<button class="nav-link" data-nav="${i.id}">${ICONS[i.icon] || ''}${esc(i.label)}</button>`).join('');
  document.querySelectorAll('#nav-links .nav-link').forEach(b =>
    b.onclick = () => { showView(b.dataset.nav); if (b.dataset.nav === 'admin') loadAdmin(); });
  // mobile bottom tab bar
  $('bottom-tabs').innerHTML = items.map(i =>
    `<button class="btab" data-nav="${i.id}">${ICONS[i.icon] || ''}<span>${esc(i.label)}</span></button>`).join('');
  document.querySelectorAll('#bottom-tabs .btab').forEach(b =>
    b.onclick = () => { showView(b.dataset.nav); if (b.dataset.nav === 'admin') loadAdmin(); });
}
var VIEW_TITLES = { admin:'Platform Panel', inbox:'Inbox', leads:'Leads', more:'More', products:'Products', settings:'Settings' };
function showView(view) {
  state.view = view;
  var _tt = $('topnav-title'); if (_tt) _tt.textContent = VIEW_TITLES[view] || '';
  // products/settings now live under More — keep the More tab highlighted there
  const navView = (view === 'products' || view === 'settings') ? 'more' : view;
  document.querySelectorAll('#nav-links .nav-link').forEach(b => b.classList.toggle('active', b.dataset.nav === navView));
  document.querySelectorAll('#bottom-tabs .btab').forEach(b => b.classList.toggle('active', b.dataset.nav === navView));
  // reset mobile inbox to list when switching views
  $('inbox-panes').classList.remove('m-chat-open', 'm-detail-open');
  const adminMode = state.me && state.me.role === 'admin';
  const onAdminDash = adminMode && view === 'admin';
  $('view-client').classList.toggle('hidden', onAdminDash);
  $('view-admin').classList.toggle('hidden', !onAdminDash);
  for (const v of ['inbox', 'leads', 'products', 'settings', 'more']) {
    $('cview-' + v).classList.toggle('hidden', view !== v);
  }
  if (view === 'inbox') { loadConversations(); if (!state.activeId) renderChatHeader(null); }
  if (view === 'leads') loadLeads();
  if (view === 'products') loadProducts();
  if (view === 'settings') { switchSettingsTab(state.settingsTab); renderSetupChecklist(); }
  if (view === 'more') renderMore();
}

// ---------------- command palette (Cmd+K) ----------------
const CMDK_ACTIONS = [
  { id:'go-inbox', t:'Go to Inbox', s:'View conversations', ic:'M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z', run:() => showView('inbox') },
  { id:'go-leads', t:'Go to Leads', s:'Lead intelligence', ic:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', run:() => showView('leads') },
  { id:'go-more', t:'Go to More', s:'Workspace hub', ic:'M12 5v14M5 12h14', run:() => showView('more') },
  { id:'go-products', t:'Products', s:'Manage catalog', ic:'M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2', run:() => showView('products') },
  { id:'go-settings', t:'Settings', s:'Channels, widget, preferences', ic:'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z', run:() => showView('settings') },
  { id:'add-product', t:'Add product', s:'New catalog item', ic:'M12 5v14M5 12h14', run:() => { showView('products'); setTimeout(() => openProductModal(null), 150); } },
  { id:'theme', t:'Toggle theme', s:'Light / dark mode', ic:'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z', run:() => $('btn-theme')?.click() },
  { id:'shortcuts', t:'Keyboard shortcuts', s:'View all shortcuts', ic:'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9', run:() => $('shortcuts-modal').classList.remove('hidden') },
  { id:'logout', t:'Log out', s:'End session', ic:'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9', run:() => $('btn-signout')?.click() },
];
let cmdkSel = 0, cmdkItems = [];
function openCmdk() {
  $('cmdk-bg').classList.remove('hidden');
  $('cmdk-input').value = '';
  renderCmdk('');
  setTimeout(() => $('cmdk-input').focus(), 30);
}
function closeCmdk() { $('cmdk-bg').classList.add('hidden'); }
function renderCmdk(q) {
  const ql = q.toLowerCase();
  cmdkItems = CMDK_ACTIONS.filter(a =>
    !ql || a.t.toLowerCase().includes(ql) || a.s.toLowerCase().includes(ql));
  // admin action only for admins
  if (state.me && state.me.role === 'admin' && (!ql || 'platform panel'.includes(ql))) {
    cmdkItems.push({ id:'go-admin', t:'Platform Panel', s:'Admin dashboard', ic:'M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z', run:() => showView('admin') });
  }
  cmdkSel = 0;
  $('cmdk-list').innerHTML = cmdkItems.length ? cmdkItems.map((a, i) => `
    <div class="cmdk-item ${i === 0 ? 'sel' : ''}" data-ci="${i}" role="option">
      <span class="ci-ic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${a.ic}"/></svg></span>
      <span class="ci-tx"><b>${esc(a.t)}</b><span>${esc(a.s)}</span></span>
    </div>`).join('')
    : '<div class="cmdk-empty">No matching commands.</div>';
  document.querySelectorAll('.cmdk-item').forEach(el => {
    el.onclick = () => { const a = cmdkItems[+el.dataset.ci]; closeCmdk(); a && a.run(); };
    el.onmousemove = () => { cmdkSel = +el.dataset.ci; paintCmdkSel(); };
  });
}
function paintCmdkSel() {
  document.querySelectorAll('.cmdk-item').forEach((el, i) => el.classList.toggle('sel', i === cmdkSel));
  document.querySelectorAll('.cmdk-item')[cmdkSel]?.scrollIntoView({ block:'nearest' });
}
function initCmdk() {
  $('cmdk-input').addEventListener('input', e => renderCmdk(e.target.value));
  $('cmdk-input').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdkSel = Math.min(cmdkSel + 1, cmdkItems.length - 1); paintCmdkSel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cmdkSel = Math.max(cmdkSel - 1, 0); paintCmdkSel(); }
    else if (e.key === 'Enter') { const a = cmdkItems[cmdkSel]; closeCmdk(); a && a.run(); }
    else if (e.key === 'Escape') closeCmdk();
  });
  $('cmdk-bg').addEventListener('click', e => { if (e.target === $('cmdk-bg')) closeCmdk(); });
  // Unified keyboard handling: Cmd+K, g-sequences, ?, Escape
  let gPending = false, gTimer = null;
  document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    // Cmd/Ctrl+K: command palette
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if ($('app-view').classList.contains('hidden')) return;
      $('cmdk-bg').classList.contains('hidden') ? openCmdk() : closeCmdk();
      return;
    }
    // Escape: close topmost modal (palette handles its own)
    if (e.key === 'Escape') {
      if (!$('cmdk-bg').classList.contains('hidden')) return; // palette input handles it
      const open = [...document.querySelectorAll('.modal-bg')].find(m => !m.classList.contains('hidden') && m.id !== 'cmdk-bg');
      if (open) { open.classList.add('hidden'); e.stopPropagation(); }
      return;
    }
    if (mod || e.altKey) return;
    if (e.target.matches('input, textarea, select')) return;
    if ($('app-view').classList.contains('hidden')) return;
    // ? opens shortcuts help
    if (e.key === '?' && !gPending) { $('shortcuts-modal').classList.remove('hidden'); return; }
    if (gPending) {
      clearTimeout(gTimer); gPending = false;
      const k = e.key.toLowerCase();
      if (k === 'i') showView('inbox');
      else if (k === 'l') showView('leads');
      else if (k === 'm') showView('more');
      else if (k === 'p') showView('products');
      else if (k === 's') showView('settings');
      return;
    }
    if (e.key.toLowerCase() === 'g') {
      gPending = true;
      gTimer = setTimeout(() => gPending = false, 1500);
    }
  });
}

// ---------------- more / settings (native) ----------------
function gotoSettings(tab) { showView('settings'); switchSettingsTab(tab || 'channels'); }
async function renderMore() {
  const me = state.me || {};
  const initial = (me.username || '?')[0].toUpperCase();
  $('more-acct').innerHTML = `
    <div class="avatar" style="width:52px;height:52px;font-size:21px;">${esc(initial)}</div>
    <div style="flex:1;min-width:0;">
      <div style="font-weight:800;color:var(--ink);font-size:16px;">${esc(me.username || '—')}</div>
      <div class="muted small">${esc(me.role === 'admin' ? 'Platform Owner' : 'Client workspace' + (me.clientId ? ' · #' + me.clientId : ''))}</div>
    </div>
    <span class="pill ${me.role === 'admin' ? 'blue' : 'green'}">${esc(me.role || '')}</span>`;
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  let prefs = `
    <label class="mrow">
      <span class="mrow-ic">${ICONS['sun'] || ''}</span>
      <span class="mrow-tx"><b>Dark Mode</b><small>Easier on the eyes at night</small></span>
      <span class="switch"><input type="checkbox" id="sw-theme" ${dark ? 'checked' : ''}><span class="knob"></span></span>
    </label>`;
  if (me.role === 'admin') {
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
  $('sw-theme').onchange = () => { $('btn-theme').click(); };
  const swAr = $('sw-autoreply');
  if (swAr) swAr.onchange = async () => {
    try { await api('/api/admin/config', { method: 'PUT', body: JSON.stringify({ autoReply: swAr.checked }) }); }
    catch { swAr.checked = !swAr.checked; }
  };
  // Workspace section — Products + everything that used to be Settings
  if (me.role !== 'admin') {
    const ws = [
      { icon: 'boxsm', t: 'Products', s: 'Catalog, prices & stock', go: () => showView('products') },
      { icon: 'chat', t: 'Channels', s: 'WhatsApp, Telegram & webchat', go: () => gotoSettings('channels') },
      { icon: 'book', t: 'Knowledge Base', s: 'Teach the AI everything', go: () => gotoSettings('kb') },
      { icon: 'save', t: 'Backup', s: 'Export, restore & Drive sync', go: () => gotoSettings('backup') },
      { icon: 'sun', t: 'Appearance', s: 'Chat widget look & greeting', go: () => gotoSettings('appearance') },
    ];
    $('more-workspace').innerHTML = ws.map((w, i) => `
      <button class="mrow" data-ws="${i}" style="width:100%;cursor:pointer;text-align:left;">
        <span class="mrow-ic">${ICONS[w.icon] || ''}</span>
        <span class="mrow-tx"><b>${esc(w.t)}</b><small>${esc(w.s)}</small></span>
        <span class="muted">${ICONS.chev}</span>
      </button>`).join('');
    document.querySelectorAll('#more-workspace [data-ws]').forEach(b =>
      b.onclick = () => ws[+b.dataset.ws].go());
    $('more-workspace-wrap').classList.remove('hidden');
  } else {
    $('more-workspace-wrap').classList.add('hidden');
  }
  $('more-actions').innerHTML = `
    <button class="mrow danger" id="btn-more-signout" style="width:100%;cursor:pointer;">
      <span class="mrow-tx" style="text-align:center;"><b>Sign Out</b></span>
    </button>`;
  $('btn-more-signout').onclick = () => $('btn-signout').click();
}
const isMobileView = () => window.matchMedia('(max-width: 900px)').matches;
function closeMobileChat() {
  $('inbox-panes').classList.remove('m-chat-open', 'm-detail-open');
  state.activeId = null;
  renderConvList();
  setComposerEnabled(false);
}
function toggleMobileDetail(open) {
  $('inbox-panes').classList.toggle('m-detail-open', open);
}

// ---------------- client: inbox ----------------
async function loadClientAll() {
  await Promise.all([loadStats(), loadConversations(true), loadProducts(true)]);
  renderCustomerTab(null);
  setComposerEnabled(false);
}
async function loadStats() { /* reserved for future stat display */ }

function renderPlatformChips() {
  const hidden = META_CONNECTORS_VISIBLE ? [] : ['messenger', 'instagram'];
  const all = [{ id: 'all', label: 'All' }, ...Object.entries(PLATFORMS)
    .filter(([id]) => !hidden.includes(id)).map(([id, m]) => ({ id, label: m.label }))];
  $('platform-chips').innerHTML = all.map(c => `
    <button class="fchip ${state.platformFilter === c.id ? 'active' : ''}" data-p="${c.id}">
      ${c.id !== 'all' ? platDot(c.id) : ''}${esc(c.label)}
    </button>`).join('');
  document.querySelectorAll('#platform-chips .fchip').forEach(b =>
    b.onclick = () => { state.platformFilter = b.dataset.p; renderPlatformChips(); renderConvList(); loadConversations(true); });
}

// Generation counter: concurrent loads (boot fires two) can't clobber each other,
// and a failed fetch shows a warm retry state instead of a dead skeleton.
let _convGen = 0;
async function loadConversations(quiet) {
  const gen = ++_convGen;
  const q = new URLSearchParams();
  if (state.platformFilter !== 'all') q.set('platform', state.platformFilter);
  if (state.convQuery) q.set('q', state.convQuery);
  if (!quiet) {
    // Skeleton shimmer while fetching — feels instant, never a blank flash.
    $('conv-list').innerHTML = Array.from({ length: 6 }, () =>
      `<div class="conv-skel"><div class="sk-av"></div><div class="sk-lines"><div class="sk-l1"></div><div class="sk-l2"></div></div></div>`).join('');
  }
  try {
    state.conversations = await api('/api/conversations' + (q.toString() ? '?' + q : ''));
  } catch (e) {
    if (gen !== _convGen) return; // superseded by a newer load
    $('conv-list').innerHTML = `<div class="warm-empty">
      <div class="we-ic">📡</div><b>Couldn't load conversations</b>
      <p>The connection hiccuped. Your chats are safe — let's try again.</p>
      <button class="btn-primary" id="btn-conv-retry" style="margin-top:6px;">Retry</button>
    </div>`;
    $('btn-conv-retry').onclick = () => loadConversations();
    return;
  }
  if (gen !== _convGen) return; // a newer load won the race — don't clobber it
  if (!quiet) state._convAnim = true; // play the staggered entrance once
  renderConvList();
  renderInboxEmpty();
}

function renderConvList() {
  let list = state.conversations;
  if (state.needsHuman) list = list.filter(c => (c.unread_count || 0) > 0);
  const box = $('conv-list');
  if (!list.length) {
    box.innerHTML = `<div class="conv-empty">
      <div class="conv-empty-ic">💬</div>
      <div><b>No conversations yet</b></div>
      <div class="muted small">New chats from WhatsApp, Telegram and your website will appear here.</div>
    </div>`;
    return;
  }
  box.innerHTML = list.map((c, i) => {
    const m = PLATFORMS[c.platform] || {};
    const nm = c.customer_name || m.label || c.platform;
    const unread = c.unread_count > 0;
    // Keep the "AI is replying…" warmth across list re-renders.
    const thinking = state._thinking === c.id;
    // Stagger the entrance — first render only, so re-renders don't replay it.
    const anim = state._convAnim ? ` style="animation-delay:${Math.min(i * 35, 500)}ms"` : '';
    return `<div class="conv-item${state.activeId === c.id ? ' active' : ''}${state._convAnim ? ' conv-enter' : ''}" data-id="${c.id}"${anim}>
      ${convAvatar(c)}
      <div class="conv-main">
        <div class="conv-top">
          <span class="conv-name">${esc(nm)}</span>
          <span class="conv-time${unread ? ' unread-t' : ''}">${relTime(c.last_message_at)}</span>
        </div>
        <div class="conv-sub">
          <span class="conv-prev${unread ? ' unread-p' : ''}${thinking ? ' typing' : ''}">${thinking ? 'AI is replying' : esc(previewText(c.last_message) || '')}</span>
          ${unread ? `<span class="unread">${c.unread_count > 99 ? '99+' : c.unread_count}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
  state._convAnim = false;
  box.querySelectorAll('.conv-item').forEach(el => el.onclick = () => selectConversation(Number(el.dataset.id)));
}

async function renderInboxEmpty() {
  const empty = $('inbox-empty'), panes = $('inbox-panes');
  let connected = 0;
  try {
    const conns = await api(`/api/clients/${state.clientId}/connectors`);
    connected = Object.values(conns).filter(s => s.status === 'connected').length;
  } catch {}
  if (!state.conversations.length && connected === 0) {
    panes.classList.add('hidden');
    empty.innerHTML = `<div class="empty-state fade-in">
      <div class="ic"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 19.5h.01"/></svg></div>
      <h3>No channels connected yet</h3>
      <p>Link your first WhatsApp, Telegram or Messenger account<br>to start receiving customer conversations in this unified inbox.</p>
      <button class="btn-primary" id="btn-goto-connect">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        Connect a channel
      </button>
    </div>`;
    $('btn-goto-connect').onclick = () => { showView('settings'); switchSettingsTab('channels'); };
  } else {
    panes.classList.remove('hidden');
    empty.innerHTML = '';
  }
}

async function selectConversation(id) {
  state.activeId = id;
  state.orderLines = {};
  renderConvList();
  try { await api(`/api/conversations/${id}/read`, { method: 'POST' }); } catch {}
  const conv = state.conversations.find(c => c.id === id);
  if (conv) { conv.unread_count = 0; renderConvList(); }
  state.messages = await api(`/api/conversations/${id}/messages`);
  renderChatHeader(conv);
  renderMessages();
  renderCustomerTab(conv);
  renderOrderTab();
  setComposerEnabled(true);
  restoreDraft();
  // Animated entrance: the chat slides in beside the contact.
  const pane = document.querySelector('.chat-pane');
  if (pane) {
    pane.classList.remove('pane-enter');
    void pane.offsetWidth; // restart the animation
    pane.classList.add('pane-enter');
  }
  if (isMobileView()) {
    $('inbox-panes').classList.add('m-chat-open');
    $('inbox-panes').classList.remove('m-detail-open');
  } else {
    $('msg-input').focus();
  }
}

function renderChatHeader(conv) {
  const box = $('chat-header');
  const hb = $('human-banner-slot');
  if (!conv) {
    box.innerHTML = '';
    if (hb) hb.innerHTML = '';
    $('messages').innerHTML = `<div class="warm-empty">
      <div class="we-ic">💌</div><b>Pick a conversation</b>
      <p>Choose someone from the list and you'll be chatting in a second. Every message here is a real person — treat them like a guest.</p>
    </div>`;
    return;
  }
  const m = PLATFORMS[conv.platform] || {};
  const nm = conv.customer_name || m.label || 'Chat';
  const sub = conv.customer_phone ? esc(conv.customer_phone) : esc(m.label || '');
  box.innerHTML = `
    <button class="icon-btn m-back" id="btn-chat-back" aria-label="Back">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
    </button>
    ${convAvatar(conv, 'lg')}
    <div style="flex:1; min-width:0;"><div class="nm">${esc(nm)}</div>
    <div class="sub">${sub}</div></div>
    ${conv.needs_human ? '<span class="pill amber">Needs human</span>' : ''}
    <button class="icon-btn m-info" id="btn-chat-info" aria-label="Details">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/></svg>
    </button>`;
  $('btn-chat-back').onclick = closeMobileChat;
  $('btn-chat-info').onclick = () => toggleMobileDetail(!$('inbox-panes').classList.contains('m-detail-open'));
  // Warm handover banner — a human heart is needed here.
  const hbs = $('human-banner-slot');
  if (hbs) {
    hbs.innerHTML = conv.needs_human
      ? `<div class="human-banner"><span class="dot"></span><span><b>${esc(nm.split(' ')[0])}</b> asked for a human — jump in, they'll feel the difference.</span></div>`
      : '';
  }
}

// Toast — warm in-app notices. Never use alert().
function toast(msg, kind) {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-live', 'polite');
    document.body.appendChild(wrap);
  }
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .3s, transform .3s'; t.style.opacity = '0'; t.style.transform = 'translateY(8px)'; setTimeout(() => t.remove(), 320); }, 2600);
}

function msgBubble(m) {
  return `<div class="bubble ${m.direction === 'out' ? 'bubble-out' : 'bubble-in'}">
    <div class="txt">${richText(m.text)}</div>
    <span class="ts">${fmtTime(m.created_at)}</span>
  </div>`;
}

// Markdown-lite for chat bubbles: escape first (XSS-safe), then format
// **bold**, * bullets, and line breaks. No raw "**" leaks to the customer.
function richText(t) {
  let h = esc(t || '');
  // bold
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  // bullet lines: "* item" or "• item" or "- item" at line start
  h = h.replace(/^(?:\*|•|-)\s+(.+)$/gm, '<span class="md-li">$1</span>');
  // line breaks
  h = h.replace(/\n/g, '<br>');
  return h;
}

function renderMessages() {
  const box = $('messages');
  hideAiThinking();
  if (!state.messages.length) {
    box.innerHTML = `<div class="warm-empty">
      <div class="we-ic">💬</div><b>No messages yet</b>
      <p>Say hello! Your first message will appear here — and the AI will keep the conversation warm when you're away.</p>
    </div>`;
    return;
  }
  let lastDay = '', lastDir = '';
  box.innerHTML = state.messages.map(m => {
    const day = fmtDay(m.created_at);
    const div = day !== lastDay ? `<div class="day-div"><span>${day}</span></div>` : '';
    lastDay = day;
    const grouped = m.direction === lastDir ? ' grouped' : '';
    lastDir = m.direction;
    return `${div}<div class="msg-row ${m.direction === 'out' ? 'out' : ''}${grouped} fade-in" data-mid="${m.id || ''}">${msgBubble(m)}</div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

// Incremental append — no full re-render, no scroll jump, no animation replay.
function appendMessage(m) {
  const box = $('messages');
  if (!box || document.querySelector(`.msg-row[data-mid="${m.id}"]`)) return; // dedupe
  hideAiThinking();
  const empty = box.querySelector('.warm-empty');
  if (empty) { renderMessages(); return; }
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  const rows = box.querySelectorAll('.msg-row');
  const lastRow = rows[rows.length - 1];
  const lastDir = lastRow ? (lastRow.classList.contains('out') ? 'out' : 'in') : '';
  const grouped = lastDir === m.direction ? ' grouped' : '';
  const lastDayDiv = [...box.querySelectorAll('.day-div')].pop();
  const day = fmtDay(m.created_at);
  const needDay = !lastDayDiv || lastDayDiv.textContent.trim() !== day;
  const html = `${needDay ? `<div class="day-div"><span>${day}</span></div>` : ''}<div class="msg-row ${m.direction === 'out' ? 'out' : ''}${grouped}" data-mid="${m.id || ''}">${msgBubble(m)}</div>`;
  box.insertAdjacentHTML('beforeend', html);
  if (nearBottom || m.direction === 'out') box.scrollTop = box.scrollHeight;
}

// AI thinking indicator — the human warmth of "she is typing…"
let _thinkTimer = null;
function showAiThinking(convId) {
  if (convId !== state.activeId) return;
  hideAiThinking();
  const box = $('messages');
  if (!box || box.querySelector('.warm-empty')) return;
  box.insertAdjacentHTML('beforeend', `<div class="typing-row" id="ai-thinking">
    <div class="typing-bubble"><i></i><i></i><i></i></div>
    <span class="typing-label">AI is replying…</span>
  </div>`);
  box.scrollTop = box.scrollHeight;
  // Conv-list preview shows the warmth too.
  state._thinking = convId;
  const row = document.querySelector(`.conv-item[data-id="${convId}"] .conv-prev`);
  if (row) { row.classList.add('typing'); row.textContent = 'AI is replying'; }
  _thinkTimer = setTimeout(hideAiThinking, 90000); // safety
}
function hideAiThinking() {
  clearTimeout(_thinkTimer);
  const t = $('ai-thinking');
  if (t) t.remove();
  if (state._thinking) {
    const row = document.querySelector(`.conv-item[data-id="${state._thinking}"] .conv-prev`);
    if (row) row.classList.remove('typing');
    state._thinking = null;
  }
}

async function sendReply() {
  const input = $('msg-input');
  const text = input.value.trim();
  if (!text || !state.activeId) return;
  input.value = '';
  clearDraft();
  autosizeComposer();
  // Optimistic: the message appears instantly with a "sending" shimmer.
  const pending = { id: 'pending-' + Date.now(), direction: 'out', text, created_at: new Date().toISOString() };
  appendMessage(pending);
  try {
    const res = await api(`/api/conversations/${state.activeId}/reply`, {
      method: 'POST', body: JSON.stringify({ text }),
    });
    // Swap the optimistic row for the real one.
    const prow = document.querySelector(`.msg-row[data-mid="${pending.id}"]`);
    if (prow) prow.remove();
    // The SSE broadcast may have already delivered this message — dedupe.
    if (!state.messages.some(x => x.id === res.message.id)) state.messages.push(res.message);
    appendMessage(res.message);
    input.focus();
  } catch (e) {
    const prow = document.querySelector(`.msg-row[data-mid="${pending.id}"]`);
    if (prow) prow.remove();
    toast('Could not send — please check your connection and try again.', 'err');
  }
}

// Textarea grows with the message, up to 130px.
function autosizeComposer() {
  const input = $('msg-input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 130) + 'px';
}

// Composer drafts persist per conversation (localStorage).
function saveDraft() {
  if (!state.activeId) return;
  try { localStorage.setItem('draft-' + state.activeId, $('msg-input').value); } catch {}
}
function restoreDraft() {
  if (!state.activeId) return;
  try {
    const d = localStorage.getItem('draft-' + state.activeId) || '';
    $('msg-input').value = d;
    autosizeComposer();
    updateSendBtn();
  } catch {}
}
function clearDraft() {
  if (!state.activeId) return;
  try { localStorage.removeItem('draft-' + state.activeId); } catch {}
}

// Global modal behavior: backdrop click closes. (Escape is handled in the
// unified keyboard listener inside initCmdk.)
function initModals() {
  document.querySelectorAll('.modal-bg').forEach(bg => {
    bg.addEventListener('click', e => {
      if (e.target === bg && bg.id !== 'cmdk-bg') bg.classList.add('hidden');
    });
  });
}

// Offline banner.
function initOffline() {
  const banner = document.createElement('div');
  banner.id = 'offline-banner';
  banner.className = 'hidden';
  banner.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12.55a11 11 0 0 1 14.08 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/></svg> You are offline — messages will send when you reconnect.';
  document.body.prepend(banner);
  const upd = () => banner.classList.toggle('hidden', navigator.onLine);
  window.addEventListener('online', upd);
  window.addEventListener('offline', upd);
  upd();
}

// The send button only comes alive when there's something to send.
function refreshSendBtn() {
  const hasText = $('msg-input').value.trim().length > 0;
  $('btn-send').disabled = !state.activeId || !hasText;
}
// Composer is only usable when a conversation is selected — otherwise the
// input, send button and quick replies stay visibly disabled.
function setComposerEnabled(on) {
  $('msg-input').disabled = !on;
  document.querySelectorAll('#quick-replies button').forEach(b => b.disabled = !on);
  document.querySelector('.composer').classList.toggle('composer-idle', !on);
  refreshSendBtn();
}
function renderQuickReplies() {
  const items = ['Share catalog', 'Check stock', 'Delivery info'];
  const idle = !state.activeId;
  $('quick-replies').innerHTML = items.map(q => `<button data-q="${esc(q)}" ${idle ? 'disabled' : ''}>${esc(q)}</button>`).join('');
  document.querySelectorAll('#quick-replies button').forEach(b =>
    b.onclick = async () => { $('msg-input').value = await quickReplyText(b.dataset.q); $('msg-input').focus(); });
}

// Quick replies insert REAL content, not the button label.
async function quickReplyText(which) {
  try {
    if (which === 'Share catalog' || which === 'Check stock') {
      if (!state.products) state.products = await api('/api/products');
      const ps = (state.products || []).slice(0, 12);
      if (!ps.length) return which === 'Share catalog'
        ? 'Our catalog is being updated — please ask about any product!'
        : 'Stock info coming right up — which product are you asking about?';
      if (which === 'Share catalog')
        return '🛍️ Our catalog:\n\n' + ps.map(p => `• ${p.name} — ৳${Number(p.price_bdt).toLocaleString()}`).join('\n');
      return '📦 Stock update:\n\n' + ps.map(p => `• ${p.name} — ${(p.stock || 0) > 0 ? `In stock (${p.stock} pcs)` : 'Out of stock'}`).join('\n');
    }
    if (which === 'Delivery info') {
      if (!state.knowledge) state.knowledge = await api(`/api/clients/${state.clientId}/knowledge`);
      const ship = (state.knowledge || []).find(k => (k.category || '') === 'shipping');
      if (ship && ship.content) return ship.content;
      return 'Delivery charge: ৳60 inside Dhaka (24–48 hours), ৳120 outside Dhaka (3–5 working days). Cash on delivery available all over Bangladesh.';
    }
  } catch { /* fall through to label */ }
  return which + ' ';
}

// ---------------- client: customer / products / order tabs ----------------
function leadForConv(conv) {
  if (!conv) return null;
  return (state.leads || []).find(l => l.platform === conv.platform && String(l.platform_user_id) === String(conv.platform_user_id)) || null;
}
async function renderCustomerTab(conv) {
  const box = $('tab-customer');
  if (!conv) { box.innerHTML = '<div class="tbl-empty">Select a conversation</div>'; return; }
  const m = PLATFORMS[conv.platform] || {};
  let orders = [];
  try { orders = await api(`/api/conversations/${conv.id}/orders`); } catch {}
  const lead = leadForConv(conv);
  const status = lead ? lead.status : 'lead';
  const score = lead && lead.score != null ? Math.round(lead.score) : null;
  const tempColor = lead && lead.temperature === 'hot' ? '#ef4444' : lead && lead.temperature === 'warm' ? '#f59e0b' : '#3b82f6';
  const ring = (() => {
    const r = 26, c = 2 * Math.PI * r;
    const pct = score != null ? score : 0;
    const off = c * (1 - pct / 100);
    return `<div class="score-ring">
      <svg width="64" height="64"><circle cx="32" cy="32" r="${r}" fill="none" stroke="var(--line)" stroke-width="6"/>
      <circle cx="32" cy="32" r="${r}" fill="none" stroke="${tempColor}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg>
      <div class="sc-val">${score != null ? score : '–'}</div></div>
      <div class="sc-lb">${score != null ? 'Lead score' : 'No score yet'}</div>`;
  })();
  box.innerHTML = `
    <div class="cust-hero">
      ${convAvatar(conv, 'lg')}
      <div class="nm">${esc(conv.customer_name || m.label)}</div>
      <div class="sub">${esc(conv.customer_phone || m.label || '')}</div>
      ${ring}
    </div>
    <div class="kv"><span class="k">Phone</span><span class="v">${esc(conv.customer_phone || (lead && lead.phone) || '—')}</span></div>
    <div class="kv"><span class="k">Email</span><span class="v">${esc((lead && lead.email) || '—')}</span></div>
    <div class="kv"><span class="k">Platform ID</span><span class="v" style="font-family:ui-monospace,monospace; font-size:11.5px;">${esc(conv.platform_user_id)}</span></div>
    <div class="kv"><span class="k">Lead status</span><span class="v">${leadPill(status)}</span></div>
    ${status !== 'confirmed' ? `<button class="btn-soft mt8" id="btn-advance-cust" style="width:100%; justify-content:center;">Advance to ${LEAD_NEXT[status]} →</button>` : ''}
    <div style="font-weight:800; color:var(--ink); font-size:13.5px; margin:16px 0 8px;">Order history (${orders.length})</div>
    ${orders.length ? orders.map(o => {
      let items = [];
      try { items = JSON.parse(o.items_json); } catch {}
      const dc = Number(o.delivery_charge_bdt) || 0;
      const advReq = Number(o.advance_required_bdt) || 0;
      const advPaid = Number(o.advance_paid_bdt) || 0;
      const grandTotal = Number(o.total_bdt) + dc;
      const pctPaid = grandTotal > 0 ? Math.round((advPaid / grandTotal) * 100) : 0;
      const payCls = o.payment_status === 'paid' ? 'green' : o.payment_status === 'partial' ? 'amber' : 'gray';
      return `<div class="prod-row" style="flex-direction:column; align-items:stretch; gap:8px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div class="inf"><div class="nm">#${o.id} · ${esc(o.status)}</div>
          <div class="meta">${items.map(i => `${i.qty}x ${esc(i.name)}`).join(', ')}</div>
          <div class="meta">${fmtDT(o.created_at)}</div></div>
          <div style="text-align:right;">
            <div style="font-weight:800; color:var(--ink); font-size:14px;">৳${grandTotal.toLocaleString('en-US')}</div>
            ${dc ? `<div class="meta">incl. ৳${dc} delivery</div>` : ''}
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <span class="pill ${payCls}">${esc(o.payment_status || 'pending')}</span>
          ${o.transaction_id ? `<span class="small muted" style="font-family:ui-monospace,monospace;">TrxID: ${esc(o.transaction_id)}</span>` : ''}
          <span style="margin-left:auto;" class="small muted">৳${advPaid.toLocaleString('en-US')} / ৳${grandTotal.toLocaleString('en-US')} (${pctPaid}%)</span>
        </div>
        <div style="height:6px; background:var(--hover); border-radius:99px; overflow:hidden;">
          <div style="height:100%; width:${pctPaid}%; background:var(--accent-grad); border-radius:99px; transition:width .4s var(--ease);"></div>
        </div>
      </div>`;
    }).join('') : '<div class="small muted">No orders yet</div>'}`;
  const adv = $('btn-advance-cust');
  if (adv && lead) adv.onclick = () => advanceLead(lead.id);
}
async function advanceLead(leadId) {
  const lead = state.leads.find(l => l.id === leadId);
  if (!lead || lead.status === 'confirmed') return;
  await api(`/api/leads/${leadId}`, { method: 'PATCH', body: JSON.stringify({ status: LEAD_NEXT[lead.status] }) });
  await loadLeads(true);
  const conv = state.conversations.find(c => c.id === state.activeId);
  renderCustomerTab(conv || null);
}

async function loadProducts(quiet) {
  state.products = await api('/api/products' + (state.productQuery ? '?q=' + encodeURIComponent(state.productQuery) : ''));
  if (!quiet) { renderProductGrid(); renderProductList(); renderOrderProducts(); }
}
function productMeta(p) {
  return `${esc(p.sku)} · ${Number(p.price_bdt).toLocaleString('en-US')} BDT · stock ${p.stock}`;
}
function renderProductList() {
  // right-pane tab: click inserts a quote line into the reply box
  $('product-list').innerHTML = state.products.map(p => `
    <div class="prod-row" data-quote="${p.id}" style="cursor:pointer;" title="Insert into reply">
      <div class="inf"><div class="nm">${esc(p.name)}</div><div class="meta">${productMeta(p)}</div></div>
    </div>`).join('') || '<div class="small muted">No products found</div>';
  document.querySelectorAll('#product-list [data-quote]').forEach(el => el.onclick = () => {
    const p = state.products.find(x => String(x.id) === el.dataset.quote);
    if (!p) return;
    $('msg-input').value += `• ${p.name} — ${Number(p.price_bdt).toLocaleString('en-US')} BDT\n`;
    $('msg-input').focus();
  });
}
function renderOrderProducts() {
  // order builder product picker
  const box = $('order-products');
  if (!box) return;
  box.innerHTML = state.products.map(p => `
    <div class="prod-row"><div class="inf"><div class="nm">${esc(p.name)}</div><div class="meta">${productMeta(p)}</div></div>
      <button class="mini-btn" data-addline="${p.id}">+ Add</button></div>`).join('')
    || '<div class="small muted">No products</div>';
  box.querySelectorAll('[data-addline]').forEach(b => b.onclick = () => {
    const id = b.dataset.addline;
    state.orderLines[id] = (state.orderLines[id] || 0) + 1;
    renderOrderTab();
  });
}
function renderOrderTab() {
  const box = $('order-lines');
  const ids = Object.keys(state.orderLines);
  box.innerHTML = ids.length ? ids.map(id => {
    const p = state.products.find(x => String(x.id) === String(id));
    if (!p) return '';
    const qty = state.orderLines[id];
    return `<div class="prod-row">
      <div class="inf"><div class="nm">${esc(p.name)}</div><div class="meta">${Number(p.price_bdt).toLocaleString('en-US')} BDT each</div></div>
      <button class="qty-btn" data-dec="${id}">−</button>
      <span style="font-weight:800; width:24px; text-align:center;">${qty}</span>
      <button class="qty-btn" data-inc="${id}">+</button></div>`;
  }).join('') : '<div class="small muted" style="margin-bottom:10px;">No items yet — add from the list below.</div>';
  box.querySelectorAll('[data-inc]').forEach(b => b.onclick = () => { state.orderLines[b.dataset.inc]++; renderOrderTab(); });
  box.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => {
    const id = b.dataset.dec;
    if (--state.orderLines[id] <= 0) delete state.orderLines[id];
    renderOrderTab();
  });
  const total = ids.reduce((s, id) => {
    const p = state.products.find(x => String(x.id) === String(id));
    return s + (p ? Number(p.price_bdt) * state.orderLines[id] : 0);
  }, 0);
  $('order-total').textContent = Number(total).toLocaleString('en-US') + ' BDT';
}
async function createOrder() {
  const ids = Object.keys(state.orderLines);
  if (!ids.length || !state.activeId) { $('order-msg').textContent = 'Pick a conversation and add items first.'; return; }
  const items = ids.map(id => {
    const p = state.products.find(x => String(x.id) === String(id));
    return { sku: p.sku, qty: state.orderLines[id] };
  });
  try {
    const res = await api('/api/orders', { method: 'POST', body: JSON.stringify({ conversation_id: state.activeId, items }) });
    $('order-msg').textContent = `Order #${res.order.id} created — ${Number(res.order.total_bdt).toLocaleString('en-US')} BDT. Summary posted in chat.`;
    state.orderLines = {};
    renderOrderTab();
    state.messages = await api(`/api/conversations/${state.activeId}/messages`);
    renderMessages();
  } catch (e) { $('order-msg').textContent = 'Error: ' + e.message; }
}
function switchSideTab(name) {
  document.querySelectorAll('.side-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $('tab-customer').classList.toggle('hidden', name !== 'customer');
  $('tab-products').classList.toggle('hidden', name !== 'products');
  $('tab-order').classList.toggle('hidden', name !== 'order');
  if (name === 'products') renderProductList();
  if (name === 'order') { renderOrderProducts(); renderOrderTab(); }
}

// ---------------- client: leads (intelligence sheet) ----------------
const STAGE_PILL = { new: 'gray', contacted: 'blue', qualified: 'blue', intent: 'amber', verified: 'green', converted: 'green', lost: 'red', dormant: 'gray' };
const TEMP_PILL = { hot: 'red', warm: 'amber', cold: 'blue' };
function stagePill(s) { return `<span class="pill ${STAGE_PILL[s] || 'gray'}">${esc(s || 'new')}</span>`; }
function tempPill(t) {
  const icon = t === 'hot' ? '🔥 ' : '';
  return `<span class="pill ${TEMP_PILL[t] || 'blue'}">${icon}${esc(t || 'cold')}</span>`;
}
function scoreBar(score) {
  const s = Math.max(0, Math.min(100, Number(score) || 0));
  const cls = s >= 70 ? 'hot' : s >= 40 ? 'warm' : 'cold';
  return `<div class="score-wrap" title="Lead score ${s}/100"><div class="score-bar ${cls}"><i style="width:${s}%"></i></div><span class="score-num">${s}</span></div>`;
}
function affinityNames(l) {
  try {
    const a = JSON.parse(l.product_affinity_json || '[]');
    if (!Array.isArray(a) || !a.length) return '<span class="muted">—</span>';
    return a.slice(0, 2).map(x => `<span class="chip">${esc(x.product || '?')}</span>`).join(' ');
  } catch { return '<span class="muted">—</span>'; }
}
async function loadLeads(quiet) {
  const q = new URLSearchParams();
  if (state.leadTemp !== 'all') q.set('temperature', state.leadTemp);
  if (state.leadStage !== 'all') q.set('stage', state.leadStage);
  if (state.leadQuery) q.set('q', state.leadQuery);
  state.leads = await api('/api/leads' + (q.toString() ? '?' + q : ''));
  // Default sort: score desc — hottest leads on top.
  state.leads.sort((a, b) => (b.score || 0) - (a.score || 0));
  if (!quiet) renderLeads();
  loadIntelSummary();
}
async function loadIntelSummary() {
  try {
    const s = await api('/api/leads/intel-stats');
    const hot = (s.byTemperature && s.byTemperature.hot) || 0;
    const warm = (s.byTemperature && s.byTemperature.warm) || 0;
    $('lead-intel-summary').textContent = `${s.total || 0} leads · 🔥${hot} hot · ${warm} warm`;
  } catch { /* non-fatal */ }
}
// Smart segments: customers (bought), potential (hot/warm or engaged, not yet
// bought), new leads (everyone else). Driven by the AI intel engine's
// stage/temperature — one lead always lands in exactly one segment.
function leadSegmentOf(l) {
  if (l.status === 'confirmed') return 'customers';
  const engaged = ['qualified', 'intent', 'verified'].includes(l.stage);
  if (l.temperature === 'hot' || l.temperature === 'warm' || engaged) return 'potential';
  return 'new';
}
function renderLeads() {
  const segName = { all: 'All', customers: '🛒 Customers', potential: '🎯 Potential', new: '🌱 New leads' };
  document.querySelectorAll('#lead-segment-filters button').forEach(b => {
    const f = b.dataset.seg;
    const n = f === 'all' ? state.leads.length : state.leads.filter(l => leadSegmentOf(l) === f).length;
    b.textContent = segName[f] + (state.leadSegment === 'all' || f === state.leadSegment ? ` (${n})` : '');
  });
  const rows = state.leads.filter(l => state.leadSegment === 'all' || leadSegmentOf(l) === state.leadSegment);
  document.querySelectorAll('#lead-temp-filters button').forEach(b => {
    const f = b.dataset.lt;
    const base = f === 'all' ? 'All temps' : f === 'hot' ? '🔥 Hot' : f[0].toUpperCase() + f.slice(1);
    const n = f === 'all' ? state.leads.length : state.leads.filter(l => (l.temperature || 'cold') === f).length;
    b.textContent = base + (state.leadTemp === 'all' || f === state.leadTemp ? ` (${n})` : '');
  });
  $('leads-body').innerHTML = rows.map(l => {
    const conv = l.conversion_probability != null ? Math.round(l.conversion_probability * 100) + '%' : '—';
    const val = l.predicted_value_bdt ? `৳${Number(l.predicted_value_bdt).toLocaleString('en-US')}` : '—';
    const due = l.followup_due_at ? relTime(l.followup_due_at) : '—';
    return `
    <tr class="rowlink" data-lead="${l.id}">
      <td data-label="Customer"><div style="font-weight:700; color:var(--ink);">${esc(l.name || '—')}</div><div class="small muted" style="font-family:ui-monospace,monospace;">${esc(l.phone || '')}</div></td>
      <td data-label="Stage">${stagePill(l.stage)}<div style="margin-top:4px;">${tempPill(l.temperature)}</div></td>
      <td data-label="Score">${scoreBar(l.score)}</td>
      <td data-label="Wants" class="small" style="max-width:220px;">${esc(l.intent_summary || '—')}</td>
      <td data-label="Likely products">${affinityNames(l)}</td>
      <td data-label="Convert" style="font-weight:700;">${conv}</td>
      <td data-label="Value" class="small">${val}</td>
      <td data-label="Next action" class="small" style="max-width:220px;" title="${esc(l.next_action || '')}">${esc((l.next_action || '—').slice(0, 80))}</td>
      <td data-label="Follow-up" class="small muted">${due}</td>
      <td data-label="Channel"><span style="display:inline-flex; align-items:center; gap:7px;">${platDot(l.platform)}<span class="small">${esc((PLATFORMS[l.platform] || {}).label || l.platform || '—')}</span></span></td>
      <td><button class="btn-icon" data-reanalyze="${l.id}" title="Re-analyze with AI">↻</button></td>
    </tr>`;
  }).join('')
    || '<tr><td colspan="11" class="tbl-empty">No leads yet — they appear here automatically as customers chat.</td></tr>';
  document.querySelectorAll('#leads-body tr[data-lead]').forEach(tr =>
    tr.onclick = (e) => {
      if (e.target.closest('[data-reanalyze]')) return;
      openLeadModal(Number(tr.dataset.lead));
    });
  document.querySelectorAll('#leads-body [data-reanalyze]').forEach(b =>
    b.onclick = async (e) => { e.stopPropagation(); await reanalyzeLead(Number(b.dataset.reanalyze)); });
}
async function reanalyzeLead(id) {
  const btn = document.querySelector(`[data-reanalyze="${id}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const r = await api(`/api/leads/${id}/analyze`, { method: 'POST' });
    if (r.lead) {
      const i = state.leads.findIndex(l => l.id === id);
      if (i >= 0) state.leads[i] = r.lead;
      state.leads.sort((a, b) => (b.score || 0) - (a.score || 0));
      renderLeads();
      if (state.editingLeadId === id) renderLeadIntel(r.lead);
    }
  } catch (err) {
    console.warn('re-analyze failed', err);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻'; }
  }
}
async function renderLeadIntel(l) {
  const box = $('lm-intel');
  if (!box) return;
  let aff = [];
  try { aff = JSON.parse(l.product_affinity_json || '[]'); } catch { aff = []; }
  // Fetch orders for payment tracking
  let orders = [];
  try {
    const conv = state.conversations.find(c => c.platform === l.platform && c.platform_user_id === l.platform_user_id);
    if (conv) orders = await api(`/api/conversations/${conv.id}/orders`);
  } catch {}
  const payHtml = orders.length ? `
    <div style="font-weight:800; color:var(--ink); font-size:13px; margin:16px 0 8px;">Payment tracking (${orders.length} order${orders.length > 1 ? 's' : ''})</div>
    ${orders.map(o => {
      const dc = Number(o.delivery_charge_bdt) || 0;
      const advPaid = Number(o.advance_paid_bdt) || 0;
      const grandTotal = Number(o.total_bdt) + dc;
      const pct = grandTotal > 0 ? Math.round((advPaid / grandTotal) * 100) : 0;
      const cls = o.payment_status === 'paid' ? 'green' : o.payment_status === 'partial' ? 'amber' : 'gray';
      return `<div style="background:var(--hover); border:1px solid var(--line); border-radius:12px; padding:12px 14px; margin-bottom:8px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <b style="font-size:13px;">Order #${o.id}</b>
          <span class="pill ${cls}">${esc(o.payment_status || 'pending')}</span>
        </div>
        <div class="small muted" style="margin-bottom:6px;">Subtotal ৳${Number(o.total_bdt).toLocaleString('en-US')}${dc ? ` + Delivery ৳${dc}` : ''} = <b style="color:var(--ink);">৳${grandTotal.toLocaleString('en-US')}</b></div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <span class="small">Paid: <b>৳${advPaid.toLocaleString('en-US')}</b> (${pct}%)</span>
          ${o.transaction_id ? `<span class="small muted" style="font-family:ui-monospace,monospace;">${esc(o.transaction_id)}</span>` : '<span class="small muted">No TrxID yet</span>'}
        </div>
        <div style="height:6px; background:var(--card); border-radius:99px; overflow:hidden;">
          <div style="height:100%; width:${pct}%; background:var(--accent-grad); border-radius:99px;"></div>
        </div>
      </div>`;
    }).join('')}` : '';
  box.innerHTML = `
    <div class="intel-grid">
      <div><span class="k">Stage</span>${stagePill(l.stage)}</div>
      <div><span class="k">Temperature</span>${tempPill(l.temperature)}</div>
      <div><span class="k">Score</span>${scoreBar(l.score)}</div>
      <div><span class="k">Convert chance</span><b>${l.conversion_probability != null ? Math.round(l.conversion_probability * 100) + '%' : '—'}</b></div>
      <div><span class="k">Predicted value</span><b>${l.predicted_value_bdt ? '৳' + Number(l.predicted_value_bdt).toLocaleString('en-US') : '—'}</b></div>
      <div><span class="k">Verification</span><span class="pill ${(l.verification_state === 'verified') ? 'green' : (l.verification_state === 'partial' ? 'amber' : 'gray')}">${esc(l.verification_state || 'unverified')}</span></div>
    </div>
    <div class="intel-row"><span class="k">Wants</span><span>${esc(l.intent_summary || '—')}</span></div>
    <div class="intel-row"><span class="k">Likely products</span><span>${aff.length ? aff.map(x => `${esc(x.product || '?')} (${Math.round((x.confidence || 0) * 100)}%)`).join(', ') : '—'}</span></div>
    <div class="intel-row"><span class="k">Next action</span><span>${esc(l.next_action || '—')}</span></div>
    <div class="intel-row"><span class="k">Follow-up due</span><span>${l.followup_due_at ? esc(new Date(l.followup_due_at).toLocaleString()) : '—'}</span></div>
    <div class="intel-row"><span class="k">Analyzed</span><span class="muted">${l.intel_updated_at ? relTime(l.intel_updated_at) : 'not yet'}</span></div>
    ${payHtml}`;
}
function scoreRing(score, temp) {
  const r = 26, c = 2 * Math.PI * r;
  const pct = score != null ? Math.round(score) : 0;
  const off = c * (1 - pct / 100);
  const tempColor = temp === 'hot' ? '#ef4444' : temp === 'warm' ? '#f59e0b' : '#3b82f6';
  return `<div class="score-ring">
    <svg width="64" height="64"><circle cx="32" cy="32" r="${r}" fill="none" stroke="var(--line)" stroke-width="6"/>
    <circle cx="32" cy="32" r="${r}" fill="none" stroke="${tempColor}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg>
    <div class="sc-val">${score != null ? Math.round(score) : '–'}</div></div>
    <div class="sc-lb">${score != null ? 'Lead score' : 'No score yet'}</div>`;
}
function openLeadModal(id) {
  const l = state.leads.find(x => x.id === id);
  if (!l) return;
  state.editingLeadId = id;
  // hero
  const nm = l.name || 'Unknown';
  const hue = avatarHue(nm);
  $('lm-hero').innerHTML = `
    <span class="lh-avatar" style="background:linear-gradient(135deg,hsl(${hue},65%,55%),hsl(${(hue + 40) % 360},65%,45%));">${esc(avatarInitials(nm))}</span>
    <div style="min-width:0;">
      <div class="lh-name">${esc(nm)}</div>
      <div class="lh-sub">${esc(l.phone || l.platform || '')}</div>
      <div class="lh-pills">${stagePill(l.stage)}${tempPill(l.temperature)}</div>
    </div>
    <div class="lh-score">${scoreRing(l.score, l.temperature)}</div>`;
  // tabs
  document.querySelectorAll('#lm-tabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.lt === 'intel');
    b.onclick = () => {
      document.querySelectorAll('#lm-tabs button').forEach(x => x.classList.toggle('active', x === b));
      $('lm-tab-intel').classList.toggle('hidden', b.dataset.lt !== 'intel');
      $('lm-tab-details').classList.toggle('hidden', b.dataset.lt !== 'details');
    };
  });
  $('lm-tab-intel').classList.remove('hidden');
  $('lm-tab-details').classList.add('hidden');
  $('lm-name').value = l.name || ''; $('lm-phone').value = l.phone || '';
  $('lm-email').value = l.email || ''; $('lm-wa').value = l.whatsapp_id || '';
  $('lm-loc').value = l.location || ''; $('lm-status').value = l.status || 'lead';
  $('lm-notes').value = l.notes || '';
  const adv = $('btn-advance-lead');
  adv.style.display = l.status === 'confirmed' ? 'none' : '';
  adv.textContent = `Advance to ${LEAD_NEXT[l.status]} →`;
  renderLeadIntel(l);
  $('lead-modal').classList.remove('hidden');
}
async function saveLeadModal() {
  await api(`/api/leads/${state.editingLeadId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: $('lm-name').value.trim() || null, phone: $('lm-phone').value.trim() || null,
      email: $('lm-email').value.trim() || null, whatsapp_id: $('lm-wa').value.trim() || null,
      location: $('lm-loc').value.trim() || null, status: $('lm-status').value,
      notes: $('lm-notes').value.trim() || null,
    }),
  });
  $('lead-modal').classList.add('hidden');
  await loadLeads();
  const conv = state.conversations.find(c => c.id === state.activeId);
  if (conv) renderCustomerTab(conv);
}
function exportLeadsCSV() {
  const rows = [['Name', 'Phone', 'Email', 'Location', 'Platform', 'Status', 'Stage', 'Score', 'Temperature', 'Wants', 'Likely products', 'Convert %', 'Value BDT', 'Next action', 'Follow-up due', 'Verification']];
  for (const l of state.leads) {
    let aff = [];
    try { aff = JSON.parse(l.product_affinity_json || '[]'); } catch { aff = []; }
    rows.push([l.name, l.phone, l.email, l.location, l.platform, l.status, l.stage, l.score, l.temperature,
      l.intent_summary, aff.map(x => (x && x.product) || '').filter(Boolean).join('; '),
      l.conversion_probability != null ? Math.round(l.conversion_probability * 100) : '',
      l.predicted_value_bdt || '', l.next_action, l.followup_due_at || '', l.verification_state]
      .map(v => v == null ? '' : String(v)));
  }
  const csv = rows.map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'leads.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------- client: products ----------------
function renderProductGrid() {
  const box = $('product-grid'), empty = $('products-empty');
  if (!state.products.length) {
    box.innerHTML = '';
    empty.innerHTML = `<div class="empty-state fade-in">
      <div class="ic"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg></div>
      <h3>No products yet</h3>
      <p>Add the products you sell — the AI will quote their real prices,<br>and photos customers send will be matched against them.</p>
    </div>`;
    return;
  }
  empty.innerHTML = '';
  box.innerHTML = state.products.map(p => {
    const stockCls = p.stock === 0 ? 'stock-out' : p.stock < 5 ? 'stock-low' : 'stock-ok';
    const stockTx = p.stock === 0 ? 'Out of stock' : p.stock < 5 ? `Low stock (${p.stock})` : `In stock (${p.stock})`;
    return `
    <div class="prod-card fade-in">
      <div class="nm">${esc(p.name)}</div>
      <div class="sku">${esc(p.sku)}</div>
      ${p.category ? `<span class="pill blue cat">${esc(p.category)}</span>` : ''}
      <div class="price">${Number(p.price_bdt).toLocaleString('en-US')} BDT</div>
      <div class="stock ${stockCls}">● ${stockTx}</div>
      <div class="row">
        <button class="mini-btn" data-pedit="${p.id}">Edit</button>
        <button class="mini-btn danger" data-pdel="${p.id}">Delete</button>
      </div>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-pedit]').forEach(b => b.onclick = () => openProductModal(Number(b.dataset.pedit)));
  box.querySelectorAll('[data-pdel]').forEach(b => b.onclick = async () => {
    if (!await askConfirm('Delete product?', 'This removes the product from your catalog. The AI will stop mentioning it.', 'Delete', true)) return;
    await api('/api/products/' + b.dataset.pdel, { method: 'DELETE' });
    loadProducts();
  });
}
function openProductModal(id) {
  const p = id ? state.products.find(x => x.id === id) : null;
  state.editingProductId = id || null;
  $('pm-title').textContent = id ? 'Edit product' : 'Add product';
  $('pm-sku').value = p ? p.sku : ''; $('pm-name').value = p ? p.name : '';
  $('pm-category').value = p ? (p.category || '') : '';
  $('pm-price').value = p ? p.price_bdt : ''; $('pm-stock').value = p ? p.stock : '';
  $('pm-image').value = p ? (p.image_url || '') : '';
  $('product-modal').classList.remove('hidden');
}
async function saveProductModal() {
  const sku = $('pm-sku').value.trim(), name = $('pm-name').value.trim();
  const price = Number($('pm-price').value);
  if (!sku || !name || !($('pm-price').value.trim()) || isNaN(price)) return toast('SKU, name and price are required', 'err');
  try {
    if (state.editingProductId) {
      await api('/api/products/' + state.editingProductId, {
        method: 'PATCH',
        body: JSON.stringify({
          sku, name, category: $('pm-category').value.trim() || null,
          price_bdt: price, stock: Number($('pm-stock').value) || 0,
          image_url: $('pm-image').value.trim() || null,
        }),
      });
    } else {
      await api('/api/products', {
        method: 'POST',
        body: JSON.stringify({
          sku, name, category: $('pm-category').value.trim() || null,
          price_bdt: price, stock: Number($('pm-stock').value) || 0,
          image_url: $('pm-image').value.trim() || null,
        }),
      });
    }
    $('product-modal').classList.add('hidden');
    loadProducts();
  } catch (e) { toast('Could not save: ' + e.message, 'err'); }
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
  const waLive = (conn.whatsapp && (conn.whatsapp.accounts || []).some(a => a.live)) || false;
  const tgLive = (conn.telegram && (conn.telegram.accounts || []).some(a => a.live)) || false;
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
  if (tab === 'channels') loadConnectors();
  if (tab === 'kb') { switchKbSubTab(state.kbSubTab); loadKnowledge(); }
  if (tab === 'appearance') loadAppearanceTab();
  if (tab === 'backup') loadBackupTab();
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
function wcToast(msg) {
  let t = document.getElementById('wc-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'wc-toast';
    t.style.cssText = 'position:fixed;bottom:26px;left:50%;transform:translateX(-50%);background:#1a1a2e;color:#fff;padding:11px 20px;border-radius:14px;font-size:13.5px;z-index:99999;box-shadow:0 10px 30px rgba(0,0,0,.3);opacity:0;transition:opacity .25s;pointer-events:none;';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.style.opacity = '0'; }, 2600);
}
function webchatCard() {
  const w = state.webchat || {};
  const snippet = `<script src="${location.origin}/widget.js?v=20261002d" data-client="${w.widget_key || ''}"></script>`;
  return `<div class="chan-card fade-in">
    <div class="top"><span class="plat-badge p-webchat">WC</span>
      <span class="nm">Webchat</span>
      <span style="margin-left:auto;">${statusPill('connected')}</span></div>
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
  const snippet = `<script src="${location.origin}/widget.js?v=20261002d" data-client="${w.widget_key || ''}"></script>`;
  const copyBtn = $('wc-copy');
  if (copyBtn) copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(snippet); wcToast('Embed code copied ✓'); }
    catch { wcToast('Copy failed — select the code manually'); }
  };
  const testBtn = $('wc-test');
  if (testBtn) testBtn.onclick = () => {
    if (document.querySelector('script[data-wc-test]')) { wcToast('Test widget already on this page — check the corner'); return; }
    const s = document.createElement('script');
    s.src = `${location.origin}/widget.js?v=20261002d`;
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
            <div class="wc-pv-in" id="wc-pv-greet">Hi there! 👋 How can I help you today?</div>
            <div class="wc-pv-out">Do you have this in blue?</div>
          </div>
          <div class="wc-pv-input"><span>Type your message…</span><i id="wc-pv-send">➤</i></div>
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
        <button class="btn-primary" id="wc-save-appear" style="margin-top:4px;">Save appearance</button>
      </div>
    </div>`;
}
async function loadAppearanceTab() {
  if (!state.webchat || !state.webchat.widget_key) {
    try { state.webchat = await api('/api/webchat/config'); } catch { state.webchat = {}; }
  }
  $('appearance-card').innerHTML = appearanceCard();
  wireAppearance();
}

// ---------------- Backup & Google Drive ----------------
async function loadBackupTab() {
  const card = $('backup-card');
  card.innerHTML = `<div class="card small muted">Loading backup status…</div>`;
  let st = { configured: false, connected: false };
  try { st = await api('/api/backup/drive/status'); } catch {}
  const driveSection = !st.configured ? `
    <div class="card small" style="background:var(--hover); margin-top:14px;">
      <div class="ttl" style="margin-bottom:6px;">⚙️ Google Drive not configured</div>
      <div class="muted small">The workspace owner needs to add Google OAuth credentials
      (<span class="mono">GOOGLE_DRIVE_CLIENT_ID</span> / <span class="mono">GOOGLE_DRIVE_SECRET</span>)
      on the server first. Local download / upload works without it.</div>
    </div>` : st.connected ? `
    <div class="row" style="gap:10px; margin-top:14px; align-items:center;">
      <span class="pill ok">Drive connected${st.email ? ' · ' + esc(st.email) : ''}</span>
      <button class="mini-btn" data-bk-drive-upload>⬆ Back up to Drive</button>
      <button class="mini-btn" data-bk-drive-list>📁 View Drive backups</button>
      <button class="mini-btn danger" data-bk-drive-disconnect>Disconnect</button>
    </div>
    <div id="bk-drive-files" style="margin-top:10px;"></div>` : `
    <div style="margin-top:14px;">
      <a class="btn primary" href="/api/backup/drive/connect?client_id=${state.clientId}" target="_blank" rel="noopener">🔗 Connect Google Drive</a>
      <div class="muted small" style="margin-top:8px;">Backups go to a <b>${esc(st.folder || 'Tectobox Backups')}</b> folder in your Drive.</div>
    </div>`;

  card.innerHTML = `
    <div class="ttl" style="font-size:17px; margin-bottom:4px;">💾 Backup & Restore</div>
    <p class="muted small" style="margin-bottom:14px;">Export everything — products, knowledge, leads, orders, conversations — as a portable backup. Restore it on any device.</p>
    <div class="row" style="gap:10px; flex-wrap:wrap;">
      <button class="btn primary" data-bk-export>⬇ Download backup (.json)</button>
      <button class="mini-btn" data-bk-export-md>📄 Readable summary (.md)</button>
      <label class="mini-btn" style="cursor:pointer;">📤 Restore from file<input type="file" data-bk-import accept=".json,application/json" style="display:none;"></label>
    </div>
    <div id="bk-status" class="muted small" style="margin-top:10px;"></div>
    <hr style="margin:16px 0; border:none; border-top:1px solid var(--line);">
    <div class="ttl" style="margin-bottom:4px;">☁️ Google Drive</div>
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
      say(`✅ Restored: ${r.imported.products} products, ${r.imported.knowledge} knowledge docs, ${r.imported.leads} leads, ${r.imported.orders} orders.`);
    } catch (err) { say('Restore failed: ' + err.message, true); }
    e.target.value = '';
  };
  const du = card.querySelector('[data-bk-drive-upload]');
  if (du) du.onclick = async () => {
    say('Uploading to Drive…');
    try {
      const r = await api(`/api/clients/${state.clientId}/backup/drive/upload`, { method: 'POST' });
      say(`✅ Backed up to Drive → ${r.folder}/ (${r.files.map(f => f.name).join(', ')})`);
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
          say(`✅ Restored from Drive: ${rr.imported.products} products, ${rr.imported.knowledge} docs, ${rr.imported.leads} leads, ${rr.imported.orders} orders.`);
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
    greeting: ap.greeting || 'Hi there! 👋 How can I help you today?',
    subtitle: ap.subtitle || 'Online — replies instantly',
    color: ap.color || '#7c5cff',
    position: ap.position || 'bottom-right',
    avatar: ap.avatar || '',
    require_intro: ap.require_intro === undefined || ap.require_intro === null ? 1 : +ap.require_intro,
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
async function loadConnectors() {
  state.connectors = await api(`/api/clients/${state.clientId}/connectors`);
  try { state.webchat = await api('/api/webchat/config'); } catch { state.webchat = {}; }
  let urls = {};
  try { urls = await api('/api/webhook-urls'); } catch {}
  $('webhook-urls').innerHTML = `
    ${META_CONNECTORS_VISIBLE ? `<div class="code-box"><span class="cl">Meta (Messenger + Instagram)</span>${esc(urls.meta || '—')}</div>` : ''}
    <div class="code-box"><span class="cl">Telegram bot</span>${esc(urls.telegram || '—')}</div>`;
  // Hide Meta connectors until verification is done; show a "coming soon" card instead.
  const cards = Object.entries(state.connectors)
    .filter(([ch]) => META_CONNECTORS_VISIBLE || (ch !== 'messenger' && ch !== 'instagram'));
  const comingSoonCard = META_CONNECTORS_VISIBLE ? '' : `
    <div class="chan-card fade-in" style="opacity:.75;">
      <div class="top"><span class="plat-badge p-messenger">M</span>
        <span class="nm">Messenger + Instagram</span>
        <span style="margin-left:auto;"><span class="pill amber">Coming soon</span></span></div>
      <div class="note">Page connect arrives after our Meta verification completes. WhatsApp and Telegram work right now.</div>
    </div>`;
  const anyConnected = cards.some(([, s]) => s.status === 'connected');
  $('chan-empty').innerHTML = anyConnected ? '' :
    `<div class="card" style="text-align:center; color:var(--muted); padding:34px;">Nothing connected yet — add your first channel to open the sky.</div>`;
  const chanMeta = {
    whatsapp: { badge: 'WA', cls: 'p-whatsapp' },
    telegram: { badge: 'TG', cls: 'p-telegram' },
    messenger: { badge: 'M', cls: 'p-messenger' },
    instagram: { badge: 'IG', cls: 'p-instagram' },
    webchat: { badge: 'WC', cls: 'p-webchat' },
  };
  const help = {
    messenger: 'Click “Connect Facebook Page”, approve via Facebook, and pick your Page. Each workspace connects its OWN Page — messages route automatically by Page ID.',
    instagram: 'If an Instagram business account is linked to the connected Facebook Page, IG DMs connect automatically.',
  };
  $('chan-grid').innerHTML = cards.map(([ch, s]) => {
    if (ch === 'webchat') return webchatCard();
    const m = PLATFORMS[ch] || { label: ch };
    const isMeta = ch === 'messenger' || ch === 'instagram';
    // Multi-account: render account list for whatsapp/telegram.
    let acctHtml = '';
    if (!isMeta && s.accounts && s.accounts.length) {
      acctHtml = '<div class="acct-list">' + s.accounts.map(a => `
        <div class="acct-row">
          <span class="plat-badge ${chanMeta[ch] ? chanMeta[ch].cls : ''}">${chanMeta[ch] ? chanMeta[ch].badge : '?'}</span>
          <div class="inf">
            <div class="nm">${esc(a.label || a.slot)}</div>
            <div class="sub">${esc(a.slot)} · ${esc(a.status)}</div>
          </div>
          ${statusPill(a.status)}${a.aiPaused && a.status === 'connected' ? ' <span class="pill amber">AI paused</span>' : ''}
          <div class="acts">
            ${a.status !== 'connected'
              ? `<button class="icon-btn" data-restart="${ch}:${a.slot}" title="Restart gateway (reconnects automatically)">⟳</button>`
              : (a.aiPaused
                ? `<button class="icon-btn" data-ai-resume="${ch}:${a.slot}" title="Resume AI replies">▶</button>`
                : `<button class="icon-btn" data-ai-pause="${ch}:${a.slot}" title="Pause AI replies">⏸</button>`)
                + `<button class="icon-btn" data-acct-disconnect="${ch}:${a.slot}" title="Disconnect gateway">⏻</button>`}
            <button class="icon-btn danger" data-acct-delete="${ch}:${a.slot}" title="Remove account">✕</button>
          </div>
        </div>`).join('') + '</div>';
    }
    const addBtn = isMeta
      ? (s.status === 'connected'
        ? `<button class="btn-danger-soft" data-disconnect="${ch}">Disconnect</button>`
        : `<button class="btn-primary" data-meta-oauth="1">Connect Facebook Page</button>`)
      : `<button class="add-acct" data-add-acct="${ch}">＋ Add ${esc(m.label)} account</button>`;
    // FB comment automation panel (messenger card, when the Page is connected).
    const commentPanel = (ch === 'messenger' && s.status === 'connected')
      ? `<div class="comment-auto" id="comment-auto">
          <div class="ca-head">💬 Comment automation <span class="ca-sub">comment → AI reply → DM → lead</span></div>
          <div class="ca-toggles">
            <label class="toggle-row">Auto-reply to comments
              <span class="switch" style="margin-left:auto;"><input type="checkbox" id="ca-autoreply"><span class="sl"></span></span></label>
            <label class="toggle-row">DM follow-up to commenter
              <span class="switch" style="margin-left:auto;"><input type="checkbox" id="ca-dm"><span class="sl"></span></span></label>
            <label class="toggle-row">Like comments
              <span class="switch" style="margin-left:auto;"><input type="checkbox" id="ca-like"><span class="sl"></span></span></label>
          </div>
          <div class="ca-rules">
            <div class="ca-label">Keyword rules <span class="ca-hint">(one per line: keywords =&gt; reply)</span></div>
            <textarea id="ca-rules" rows="3" placeholder="দাম, price => দাম জানতে ইনবক্স চেক করুন ✨"></textarea>
            <button class="btn-primary" id="ca-save" style="margin-top:8px;">Save comment settings</button>
          </div>
          <div class="ca-label" style="margin-top:12px;">Recent comment activity</div>
          <div id="ca-activity" class="ca-activity"><div class="ca-empty">No comments yet.</div></div>
        </div>`
      : '';
    // Card header pill: for multi-account channels reflect the accounts, not a
    // possibly-stale channel-level status (avoids "disconnected" header next
    // to a "connected" account row after reconnect).
    const accts = (!isMeta && s.accounts && s.accounts.length) ? s.accounts : null;
    const headStatus = accts
      ? (accts.some(a => a.status === 'connected') ? 'connected'
        : accts.some(a => a.status === 'pending') ? 'pending'
        : accts.some(a => a.status === 'error') ? 'error' : 'disconnected')
      : s.status;
    return `<div class="chan-card fade-in">
      <div class="top"><span class="plat-badge ${chanMeta[ch] ? chanMeta[ch].cls : ''}">${chanMeta[ch] ? chanMeta[ch].badge : '?'}</span>
        <span class="nm">${esc(m.label)}</span>
        <span style="margin-left:auto;">${statusPill(headStatus)}</span></div>
      <div class="method">Method: ${esc(s.method || '—')}</div>
      <div class="note">${esc(s.note || '')}</div>
      ${help[ch] ? `<div class="note" style="background:rgba(255,255,255,.5); border-radius:12px; padding:10px 13px; font-size:12.5px;">${esc(help[ch])}</div>` : ''}
      ${acctHtml}
      ${addBtn}
      ${commentPanel}
    </div>`;
  }).join('') + comingSoonCard;
  // Wire up the comment automation panel (if rendered).
  if ($('comment-auto')) loadCommentConfig();
  if ($('wc-copy')) wireWebchatCard();
  document.querySelectorAll('[data-add-acct]').forEach(b => b.onclick = () => addAccount(b.dataset.addAcct));
  document.querySelectorAll('[data-restart]').forEach(b => b.onclick = () => {
    const [ch, slot] = b.dataset.restart.split(':');
    restartGateway(ch, slot);
  });
  document.querySelectorAll('[data-ai-pause]').forEach(b => b.onclick = async () => {
    const [ch, slot] = b.dataset.aiPause.split(':');
    if (!await askConfirm('Pause AI replies?', `New messages on ${ch} (${slot}) will still arrive in the inbox — a human can reply manually. Nothing is lost. The AI stays off until you resume it.`, 'Pause AI')) return;
    await api(`/api/clients/${state.clientId}/connectors/${ch}/ai-pause`, { method: 'POST', body: JSON.stringify({ slot, paused: true }) });
    loadConnectors();
  });
  document.querySelectorAll('[data-ai-resume]').forEach(b => b.onclick = async () => {
    const [ch, slot] = b.dataset.aiResume.split(':');
    await api(`/api/clients/${state.clientId}/connectors/${ch}/ai-pause`, { method: 'POST', body: JSON.stringify({ slot, paused: false }) });
    loadConnectors();
  });
  document.querySelectorAll('[data-acct-disconnect]').forEach(b => b.onclick = async () => {
    const [ch, slot] = b.dataset.acctDisconnect.split(':');
    if (!await askConfirm('Disconnect gateway?', 'The pairing session is kept — Restart reconnects without a re-scan.', 'Disconnect')) return;
    await api(`/api/clients/${state.clientId}/connectors/${ch}/disconnect`, { method: 'POST', body: JSON.stringify({ slot }) });
    loadConnectors();
  });
  document.querySelectorAll('[data-acct-delete]').forEach(b => b.onclick = async () => {
    const [ch, slot] = b.dataset.acctDelete.split(':');
    if (!await askConfirm('Remove account?', `${ch} (${slot}) will be removed permanently. The session is forgotten — reconnecting will need a fresh QR scan.`, 'Remove', true)) return;
    await api(`/api/clients/${state.clientId}/connectors/${ch}/${encodeURIComponent(slot)}`, { method: 'DELETE' });
    loadConnectors();
  });
  document.querySelectorAll('[data-meta-oauth]').forEach(b => b.onclick = startMetaOAuth);
  document.querySelectorAll('[data-disconnect]').forEach(b => b.onclick = async () => {
    if (!await askConfirm('Disconnect this channel?', '', 'Disconnect')) return;
    await api(`/api/clients/${state.clientId}/connectors/${b.dataset.disconnect}/disconnect`, { method: 'POST' });
    loadConnectors();
  });
  if (state.view === 'settings') renderSetupChecklist();
}

// ---------------- FB comment automation panel ----------------
async function loadCommentConfig() {
  try {
    const cfg = await api(`/api/clients/${state.clientId}/comment-config`);
    $('ca-autoreply').checked = !!cfg.autoReply;
    $('ca-dm').checked = !!cfg.dmFollowup;
    $('ca-like').checked = !!cfg.likeComment;
    $('ca-rules').value = (cfg.rules || []).map(r => `${r.keywords.join(', ')} => ${r.reply}`).join('\n');
  } catch (e) { console.warn('[comment] config load failed:', e.message); }
  $('ca-save').onclick = async () => {
    const rules = $('ca-rules').value.split('\n').map(line => {
      const i = line.indexOf('=>');
      if (i < 0) return null;
      return { keywords: line.slice(0, i).trim(), reply: line.slice(i + 2).trim() };
    }).filter(r => r && r.keywords && r.reply);
    const btn = $('ca-save');
    const old = btn.textContent;
    try {
      await api(`/api/clients/${state.clientId}/comment-config`, {
        method: 'PUT',
        body: JSON.stringify({
          autoReply: $('ca-autoreply').checked,
          dmFollowup: $('ca-dm').checked,
          likeComment: $('ca-like').checked,
          rules,
        }),
      });
      btn.textContent = 'Saved ✅';
    } catch (e) {
      btn.textContent = 'Save failed ❌';
    }
    setTimeout(() => { btn.textContent = old; }, 1800);
  };
  // Toggles save immediately for one-tap control.
  for (const [id, key] of [['ca-autoreply', 'autoReply'], ['ca-dm', 'dmFollowup'], ['ca-like', 'likeComment']]) {
    $(id).onchange = async () => {
      try {
        await api(`/api/clients/${state.clientId}/comment-config`, {
          method: 'PUT', body: JSON.stringify({ [key]: $(id).checked }),
        });
      } catch { $(id).checked = !$(id).checked; }
    };
  }
  loadCommentActivity();
}
async function loadCommentActivity() {
  const box = $('ca-activity');
  if (!box) return;
  try {
    const rows = await api(`/api/clients/${state.clientId}/comments`);
    box.innerHTML = rows.map(c => `
      <div class="ca-item">
        <div class="ca-c"><b>${esc(c.commenter_name || 'Someone')}</b>: ${esc((c.comment_text || '').slice(0, 120))}</div>
        ${c.reply_text ? `<div class="ca-r">↳ ${esc(c.reply_text.slice(0, 140))}${c.dm_sent ? ' <span class="ca-dm">+DM ✉</span>' : ''}</div>` : '<div class="ca-r ca-skip">↳ skipped</div>'}
      </div>`).join('') || '<div class="ca-empty">No comments yet.</div>';
  } catch { box.innerHTML = '<div class="ca-empty">Could not load activity.</div>'; }
}

// ---------------- knowledge base / business context ----------------
const KB_CATS = {
  policy: 'Return / Policy', shipping: 'Shipping', product: 'Product info',
  faq: 'FAQ', marketing: 'Marketing', general: 'General',
};
const kbCatLabel = c => KB_CATS[c] || 'General';
const kbCatOptions = sel => Object.entries(KB_CATS).map(([v, l]) =>
  `<option value="${v}"${v === sel ? ' selected' : ''}>${l}</option>`).join('');

async function loadKnowledge() {
  state.knowledge = await api(`/api/clients/${state.clientId}/knowledge`);
  const n = state.knowledge.length;
  $('kb-count').textContent = n ? `· ${n} document${n > 1 ? 's' : ''} live` : '';
  $('kb-list').innerHTML = state.knowledge.map(k => `
    <div class="doc-card fade-in" data-kbcard="${k.id}">
      <div class="row" style="justify-content:space-between; align-items:center;">
        <div class="ttl">${esc(k.title)}</div>
        <span class="pill">${esc(kbCatLabel(k.category))}</span>
      </div>
      <div class="cnt">${esc(k.content)}</div>
      <div class="row">
        <button class="mini-btn" data-kbedit="${k.id}">Edit</button>
        <button class="mini-btn danger" data-kbdel="${k.id}">Delete</button>
      </div>
    </div>`).join('') || '<div class="card small muted">No documents yet — add your return policy, shipping rules, product info and FAQs above. The AI uses them in every reply.</div>';
  document.querySelectorAll('[data-kbdel]').forEach(b => b.onclick = async () => {
    if (!await askConfirm('Delete document?', 'The AI will no longer use this document in its replies.', 'Delete', true)) return;
    await api('/api/knowledge/' + b.dataset.kbdel, { method: 'DELETE' });
    loadKnowledge();
  });
  document.querySelectorAll('[data-kbedit]').forEach(b => b.onclick = () => kbStartEdit(+b.dataset.kbedit));
}
function kbStartEdit(id) {
  const k = state.knowledge.find(x => x.id === id);
  if (!k) return;
  const card = document.querySelector(`[data-kbcard="${id}"]`);
  card.innerHTML = `
    <div class="frow" style="margin-bottom:10px; display:flex; gap:10px;">
      <input class="input no-icon" data-kbe-title type="text" value="${esc(k.title)}" style="flex:2;">
      <select class="input no-icon" data-kbe-cat style="flex:1;">${kbCatOptions(k.category || 'general')}</select>
    </div>
    <div class="frow" style="margin-bottom:10px;"><textarea class="input no-icon" data-kbe-content rows="4">${esc(k.content)}</textarea></div>
    <div class="row">
      <button class="mini-btn primary" data-kbesave="${id}">Save</button>
      <button class="mini-btn" data-kbecancel="${id}">Cancel</button>
    </div>`;
  card.querySelector('[data-kbesave]').onclick = async () => {
    const title = card.querySelector('[data-kbe-title]').value.trim();
    const content = card.querySelector('[data-kbe-content]').value.trim();
    const category = card.querySelector('[data-kbe-cat]').value;
    if (!title || !content) return toast('Title and content are required', 'err');
    await api('/api/knowledge/' + id, { method: 'PATCH', body: JSON.stringify({ title, content, category }) });
    loadKnowledge();
  };
  card.querySelector('[data-kbecancel]').onclick = loadKnowledge;
}
// ---------------- KB presets (one-click starter documents) ----------------
const KB_PRESETS = [
  { title: 'Return & refund policy', category: 'policy',
    blurb: '7-day returns, refund via bKash/Nagad — edit the details to match your rules.',
    content: 'We accept returns within 7 days of delivery if the product is unused and the packaging is intact. To request a return, message us with your order ID and a photo of the product. Refunds are sent via bKash/Nagad within 48 hours of receiving the returned product.' },
  { title: 'Delivery information', category: 'shipping',
    blurb: 'Delivery charges and timelines for Dhaka vs outside Dhaka.',
    content: 'Delivery charge: ৳60 inside Dhaka (delivery in 24–48 hours), ৳120 outside Dhaka (3–5 working days). Cash on delivery is available all over Bangladesh. You will get a tracking update on WhatsApp once your parcel is handed to the courier.' },
  { title: 'Payment methods', category: 'general',
    blurb: 'bKash, Nagad, Rocket and cash on delivery.',
    content: 'We accept bKash, Nagad, Rocket and Cash on Delivery (COD). For advance payment, send money to the merchant number we share in chat and send us the transaction ID (TrxID) so we can confirm your order quickly.' },
  { title: 'Common questions', category: 'faq',
    blurb: 'Starter FAQ — add your own questions and answers.',
    content: 'Q: Are your products original?\nA: Yes — 100% authentic, sourced directly.\n\nQ: How do I place an order?\nA: Message us the product name and your address, or order from the website.\n\nQ: Can I change or cancel my order?\nA: Yes, within 12 hours of ordering — just message us your order ID.' },
  { title: 'About our shop', category: 'general',
    blurb: 'Who you are — the AI introduces your shop with this.',
    content: 'We are [your shop name], based in [city]. We sell [your products] with a focus on quality and honest pricing. Message us anytime — we reply fast, 7 days a week.' },
  { title: 'Opening hours', category: 'general',
    blurb: 'When you reply and process orders.',
    content: 'We reply from 9 AM to 11 PM, 7 days a week. Orders placed after 8 PM are processed the next morning.' },
];
function renderKbPresets() {
  const el = $('kb-presets'); if (!el) return;
  el.innerHTML = KB_PRESETS.map((pr, i) => `
    <div class="kb-preset fade-in">
      <div class="row" style="justify-content:space-between; align-items:center; gap:8px;">
        <div class="ttl">${esc(pr.title)}</div>
        <span class="pill">${esc(kbCatLabel(pr.category))}</span>
      </div>
      <div class="cnt muted small">${esc(pr.blurb)}</div>
      <button class="mini-btn primary" data-preset="${i}">Use this preset</button>
    </div>`).join('');
  el.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => useKbPreset(+b.dataset.preset));
}
function useKbPreset(i) {
  const pr = KB_PRESETS[i]; if (!pr) return;
  switchKbSubTab('docs');
  $('kb-title').value = pr.title;
  $('kb-category').value = pr.category;
  $('kb-content').value = pr.content;
  setTimeout(() => $('kb-title').scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
  wcToast('Preset loaded — edit it, then Save document');
}

// ---------------- KB: website import (jobs + per-page detail) ----------------
function kbPagePill(s) {
  if (s === 'imported') return '<span class="pill green">Saved</span>';
  if (s === 'skipped_thin') return '<span class="pill amber">Skipped — thin</span>';
  if (s === 'skipped_duplicate') return '<span class="pill amber">Skipped — duplicate</span>';
  return '<span class="pill red">Skipped — failed</span>';
}
function kbImportJobHtml(j) {
  const when = String(j.started_at || '').slice(0, 16).replace('T', ' ');
  const pill = j.status === 'done' ? '<span class="pill green">Done</span>'
    : j.status === 'running' ? '<span class="pill blue">Running</span>'
    : '<span class="pill red">Failed</span>';
  return `<div class="kb-job fade-in">
    <div class="row" style="justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
      <div style="min-width:0;"><b style="word-break:break-all;">${esc(j.website_url)}</b>
        <div class="muted small">${esc(when)}</div></div>
      <div style="display:flex; gap:8px; align-items:center;">${pill}
        <button class="mini-btn" data-jobpages="${j.id}">Pages</button></div>
    </div>
    <div class="muted small">${j.discovered || 0} found · ${j.imported || 0} saved · ${j.skipped || 0} skipped${j.error ? ' · ' + esc(j.error) : ''}</div>
    <div class="kb-job-pages" id="kb-jobpages-${j.id}"></div>
  </div>`;
}
function renderKbImportProgress(st) {
  const el = $('kb-import-progress'); if (!el) return;
  const pr = st.progress || { processed: 0, imported: 0, skipped: 0 };
  const total = Math.max(st.discovered || 0, pr.processed, 1);
  const pct = Math.min(100, Math.round(pr.processed / total * 100));
  el.innerHTML = `<div class="kb-prog"><div class="kb-prog-bar" style="width:${pct}%"></div></div>
    <div class="note" style="margin-top:6px;">Importing <b>${esc(st.website_url || '')}</b> — ${pr.processed} of ${st.discovered || '…'} pages checked (${pr.imported} saved, ${pr.skipped} skipped)…</div>`;
}
async function loadKbImports() {
  const histEl = $('kb-import-history'); if (!histEl) return;
  let status = { status: 'idle' }, history = [];
  try { status = await api('/api/kb/import-status'); } catch {}
  try { history = await api('/api/kb/imports'); } catch {}
  const urlInput = $('kb-site-url');
  if (urlInput && !urlInput.value) {
    if (status.website_url) urlInput.value = status.website_url;
    else if (state.webchat && state.webchat.website_url) urlInput.value = state.webchat.website_url;
  }
  const progEl = $('kb-import-progress');
  if (status.status === 'running') { renderKbImportProgress(status); pollKbImport(); }
  else if (progEl) progEl.innerHTML = '';
  histEl.innerHTML = history.length
    ? history.map(kbImportJobHtml).join('')
    : '<div class="card small muted">No website imports yet — enter your site above and press Import.</div>';
  histEl.querySelectorAll('[data-jobpages]').forEach(b => b.onclick = () => toggleImportPages(+b.dataset.jobpages, b));
}
async function toggleImportPages(importId, btn) {
  const box = $('kb-jobpages-' + importId); if (!box) return;
  if (box.dataset.loaded) { box.style.display = box.style.display === 'none' ? '' : 'none'; return; }
  box.innerHTML = '<div class="note">Loading pages…</div>'; box.style.display = '';
  try {
    const pages = await api('/api/kb/imports/' + importId + '/pages');
    box.dataset.loaded = '1';
    box.innerHTML = pages.length ? `<div class="kb-pages">` + pages.map(pg => `
      <div class="kb-page">
        <div class="kb-page-top">${kbPagePill(pg.status)}<b>${esc(pg.page_title || pg.page_url)}</b></div>
        <div class="kb-page-url muted small">${esc(pg.page_url)}</div>
        <div class="muted small">${esc(kbCatLabel(pg.category))} · ${(pg.chars || 0).toLocaleString()} characters${pg.note ? ' · ' + esc(pg.note) : ''}</div>
      </div>`).join('') + `</div>` : '<div class="note">No page details recorded.</div>';
  } catch (e) { box.innerHTML = '<div class="note">Could not load pages.</div>'; }
  if (btn) btn.textContent = 'Hide';
}
let _kbPollH = null;
async function pollKbImport() {
  clearTimeout(_kbPollH);
  for (let i = 0; i < 120; i++) {
    await new Promise(r => _kbPollH = setTimeout(r, 3000));
    if (!$('kb-import-progress')) return;
    let st; try { st = await api('/api/kb/import-status'); } catch { continue; }
    if (st.status === 'running') { renderKbImportProgress(st); continue; }
    $('kb-import-progress').innerHTML = '';
    const btn = $('kb-import-btn'); if (btn) btn.disabled = false;
    loadKbImports(); loadKnowledge();
    wcToast(st.status === 'done' ? `Import done — ${st.imported || 0} page(s) saved to the Knowledge Base` : 'Import finished');
    return;
  }
}
async function startKbImport() {
  const url = ($('kb-site-url').value || '').trim();
  if (!url) return toast('Enter your website URL first', 'err');
  const btn = $('kb-import-btn'); btn.disabled = true;
  renderKbImportProgress({ website_url: url, discovered: 0, progress: { processed: 0, imported: 0, skipped: 0 } });
  try {
    const r = await api('/api/kb/import-website', { method: 'POST', body: JSON.stringify({ url }) });
    if (r && r.status === 'running') { loadKbImports(); pollKbImport(); }
    else { $('kb-import-progress').innerHTML = ''; btn.disabled = false; }
  } catch (e) {
    $('kb-import-progress').innerHTML = '<div class="note">Error: ' + esc(e.message || 'failed') + '</div>';
    btn.disabled = false;
  }
}
async function saveKnowledge() {
  const title = $('kb-title').value.trim(), content = $('kb-content').value.trim();
  const category = $('kb-category').value;
  if (!title || !content) return toast('Title and content are required', 'err');
  try {
    await api(`/api/clients/${state.clientId}/knowledge`, { method: 'POST', body: JSON.stringify({ title, content, category }) });
    $('kb-title').value = ''; $('kb-content').value = '';
    loadKnowledge();
  } catch (e) { toast('Could not save: ' + e.message, 'err'); }
}

// Restart a gateway account WITHOUT forcing a QR scan. The backend reuses the
// saved pairing session, so a healthy account reconnects silently; the QR modal
// only opens if the backend actually emits a QR (pairing genuinely needed,
// e.g. logged out on the phone).
async function restartGateway(channel, slot = 'default') {
  let res;
  try {
    res = await api(`/api/clients/${state.clientId}/connectors/${channel}/connect`, {
      method: 'POST', body: JSON.stringify({ slot }),
    });
  } catch (e) { return toast('Could not restart: ' + e.message, 'err'); }
  if (res && res.error) return toast('Could not restart: ' + res.error, 'err');
  toast('Reconnecting gateway…');
  loadConnectors();
  const t0 = Date.now();
  const timer = setInterval(async () => {
    let s;
    try { s = await api(`/api/clients/${state.clientId}/connectors`); } catch { return; }
    const accts = (((channel === 'whatsapp' ? s.whatsapp : s.telegram) || {}).accounts) || [];
    const acct = accts.find(a => (a.slot || 'default') === slot);
    if (!acct) { clearInterval(timer); loadConnectors(); return; }
    if (acct.status === 'connected') {
      clearInterval(timer);
      toast('Gateway reconnected ✓');
      loadConnectors();
    } else if (acct.qr) {
      // Session is gone — a fresh scan is genuinely needed.
      clearInterval(timer);
      startQrConnect(channel, slot);
    } else if (Date.now() - t0 > 90000) {
      clearInterval(timer);
      toast('Gateway is still not connected after 90s — check the account and try again.', 'err');
      loadConnectors();
    }
  }, 2500);
}

// ---------------- QR connect ----------------
// Custom slot-name dialog (Aurora-styled) — replaces the native browser prompt().
function askSlotLabel(channel) {
  return new Promise((resolve) => {
    const modal = $('slot-modal'), input = $('slot-label');
    $('slot-title').textContent = `Name this ${channel} account`;
    input.value = '';
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 50);
    const done = (val) => {
      modal.classList.add('hidden');
      $('btn-slot-ok').onclick = $('btn-slot-cancel').onclick = input.onkeydown = null;
      resolve(val);
    };
    $('btn-slot-ok').onclick = () => done(input.value.trim() || null);
    $('btn-slot-cancel').onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') done(input.value.trim() || null);
      else if (e.key === 'Escape') done(null);
    };
    modal.onclick = (e) => { if (e.target === modal) done(null); };
  });
}
// Promise-based confirm dialog (Aurora-styled) — replaces the native
// confirm(), which is blocking, visually off-brand, and invisible to
// automation/testing layers (every confirm()-gated button looked "dead"
// in automated QA because the native dialog never surfaced).
function askConfirm(title, body, okLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    const modal = $('confirm-modal');
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body || '';
    $('confirm-body').style.display = body ? '' : 'none';
    const okBtn = $('btn-confirm-ok');
    okBtn.textContent = okLabel;
    okBtn.classList.toggle('btn-danger-soft', danger);
    okBtn.classList.toggle('btn-primary', !danger);
    modal.classList.remove('hidden');
    const done = (val) => {
      modal.classList.add('hidden');
      okBtn.onclick = $('btn-confirm-cancel').onclick = modal.onclick = null;
      resolve(val);
    };
    okBtn.onclick = () => done(true);
    $('btn-confirm-cancel').onclick = () => done(false);
    modal.onclick = (e) => { if (e.target === modal) done(false); };
  });
}
async function addAccount(channel) {
  const label = await askSlotLabel(channel);
  if (label === null) return; // cancelled
  const slot = (label.trim() || 'account').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'account';
  try {
    await api(`/api/clients/${state.clientId}/connectors/${channel}/connect`, {
      method: 'POST',
      body: JSON.stringify({ slot, label: label.trim() || slot }),
    });
  } catch (e) { return toast('Could not start: ' + e.message, 'err'); }
  startQrConnect(channel, slot, label.trim() || slot);
}
async function startQrConnect(channel, slot = 'default', label = null) {
  if (slot === 'default' && !label) {
    try {
      await api(`/api/clients/${state.clientId}/connectors/${channel}/connect`, { method: 'POST' });
    } catch (e) { return toast('Could not start: ' + e.message, 'err'); }
  }
  state.qrChannel = channel;
  state.qrSlot = slot;
  $('qr-title').textContent = (channel === 'whatsapp' ? 'Scan with WhatsApp' : 'Scan with Telegram') + (label ? ` — ${label}` : '');
  $('qr-sub').textContent = channel === 'whatsapp'
    ? 'WhatsApp → ⋮ menu → Linked devices → Link a device'
    : 'Telegram → Settings → Devices → Link Desktop Device';
  $('qr-img').removeAttribute('src');
  $('qr-modal').classList.remove('hidden');
  // Poll the connector status while the modal is open. SSE 'channel_status'
  // can be missed (reboot / dropped EventSource / modal opened late) which
  // used to leave the modal stuck on "verifying" forever even though the
  // phone paired fine. Polling is the source of truth.
  if (state.qrPoll) { clearInterval(state.qrPoll); clearTimeout(state.qrPollKill); state.qrPoll = null; }
  const pollSlot = slot, pollChannel = channel;
  const closeQrModal = () => {
    if (state.qrPoll) { clearInterval(state.qrPoll); clearTimeout(state.qrPollKill); state.qrPoll = null; }
    $('qr-modal').classList.add('hidden');
    state.qrChannel = null;
    state.qrSlot = null;
    if (state.view === 'settings') loadConnectors();
  };
  state.qrClose = closeQrModal;
  state.qrPoll = setInterval(async () => {
    try {
      const s = await api(`/api/clients/${state.clientId}/connectors`);
      const accounts = (pollChannel === 'whatsapp' ? (s.whatsapp && s.whatsapp.accounts) : (s.telegram && s.telegram.accounts)) || [];
      const acct = accounts.find(a => (a.slot || 'default') === (pollSlot || 'default'));
      if (acct && acct.status === 'connected') closeQrModal();
      // SSE fallback: the status response carries the latest QR, so even if
      // the 'qr' event was dropped the modal still shows the code.
      else if (acct && acct.qr && !$('qr-img').getAttribute('src')) $('qr-img').src = acct.qr;
    } catch {}
  }, 3000);
  state.qrPollKill = setTimeout(() => {
    if (state.qrPoll) { clearInterval(state.qrPoll); state.qrPoll = null; }
  }, 180000);
}

// ---------------- Meta OAuth ----------------
async function startMetaOAuth() {
  let res;
  try {
    res = await api(`/api/clients/${state.clientId}/connectors/messenger/oauth/start`);
  } catch (e) { return toast('Could not start: ' + e.message, 'err'); }
  if (!res.url) return toast('Could not start: no URL returned', 'err');
  window.open(res.url, '_blank', 'width=640,height=720');
  const t = setInterval(async () => {
    try {
      const s = await api(`/api/clients/${state.clientId}/connectors`);
      if (s.messenger && s.messenger.status === 'connected') {
        clearInterval(t); clearTimeout(kill);
        if (state.view === 'settings') loadConnectors();
      }
    } catch {}
  }, 3000);
  const kill = setTimeout(() => clearInterval(t), 180000);
}
async function maybeShowMetaPicker() {
  if (!location.hash.startsWith('#meta-pick')) return;
  const pid = new URLSearchParams(location.hash.split('?')[1] || '').get('pid');
  history.replaceState(null, '', location.pathname);
  if (!pid) return;
  let res;
  try { res = await fetch(`/api/meta/oauth/pending/${pid}`).then(r => r.json()); }
  catch { return toast('Could not load pages — please try again.', 'err'); }
  if (res.error || !res.pages || !res.pages.length) {
    toast(res.error || 'Connection session expired — please try again.', 'err');
    return;
  }
  $('meta-pick-list').innerHTML = res.pages.map(p =>
    `<button class="pick-btn" data-pick-page="${esc(p.id)}">
      <div class="pn">${esc(p.name)}</div><div class="pi">Page ID ${esc(p.id)}</div>
    </button>`).join('');
  $('meta-pick-modal').classList.remove('hidden');
  document.querySelectorAll('[data-pick-page]').forEach(b => b.onclick = async () => {
    try {
      const r = await api('/api/meta/oauth/pick', {
        method: 'POST', body: JSON.stringify({ pid, pageId: b.dataset.pickPage }),
      });
      $('meta-pick-modal').classList.add('hidden');
      toast(`Connected: ${r.page}` + (r.instagram ? ` + Instagram @${r.instagram}` : ''), 'ok');
      if (state.view === 'settings') loadConnectors();
    } catch (e) { toast('Could not connect: ' + e.message, 'err'); }
  });
}

// ---------------- admin ----------------
async function loadAdmin() {
  const [ov, users, resources] = await Promise.all([
    api('/api/admin/overview'), api('/api/admin/users'), api('/api/admin/resources'),
  ]);
  const stats = [
    ['Workspaces', ov.workspaces, '', 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z'],
    ['Active users', ov.activeUsers, '', 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75'],
    ['Channels', ov.channels, '', 'M13 2L3 14h7l-1 8 10-12h-7l1-8z'],
    ['Connected', ov.connected, 'green', 'M22 11.1V12a10 10 0 1 1-5.93-9.14M22 4L12 14l-3-3'],
    ['Errored', ov.errored, 'red', 'M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z'],
  ];
  $('admin-stats').innerHTML = stats.map(([l, v, cls, path]) => `
    <div class="stat-card"><div class="stat-ic">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>
    </div><div><div class="lbl">${l}</div><div class="num ${cls}">${v}</div></div></div>`).join('');
  renderAdminUsers(users, resources);
  renderAdminResources(resources);
  switchAdminTab(state.adminTab);
}
function renderAdminResources(resources) {
  $('resources-body').innerHTML = resources.map(r => {
    const m = PLATFORMS[r.channel] || {};
    return `<tr>
      <td data-label="Channel"><span style="display:inline-flex; align-items:center; gap:10px;">${platBadge(r.channel, 34)}<b style="color:var(--ink);">${esc(m.label || r.channel)}</b></span></td>
      <td data-label="Account" class="muted">${esc(r.account || '—')}</td>
      <td data-label="Workspace" class="muted">@${esc(r.workspace || '—')}</td>
      <td data-label="Status">${statusPill(r.status)}</td>
      <td data-label="Last seen" class="small muted">${fmtDT(r.lastSeen)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="tbl-empty">No channel resources yet.</td></tr>';
}
function renderAdminUsers(users, resources) {
  $('users-grid').innerHTML = users.map(u => {
    const chans = resources.filter(r => r.workspace === u.client_name).length;
    const isAdmin = u.role === 'admin';
    const nm = u.client_name || u.username;
    const hue = avatarHue(nm);
    return `<div class="user-card fade-in">
      <div class="top">
        <span class="admin-avatar" style="background:linear-gradient(135deg,hsl(${hue},65%,55%),hsl(${(hue + 40) % 360},65%,45%));">${esc(avatarInitials(nm))}</span>
        <div style="min-width:0;">
          <div class="nm">${esc(nm)}
            ${isAdmin ? '<span class="pill blue">SUPER ADMIN</span>' : ''}
          </div>
          <div class="sub" style="margin:3px 0 0;">@${esc(u.username)} · ${chans} channel(s)</div>
        </div>
        <span style="margin-left:auto; color:var(--green); flex-shrink:0;">${u.active ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5.5"/></svg>' : ''}</span>
      </div>
      <div class="row" style="margin-top:14px;">
        ${isAdmin ? '' : `<label class="switch" title="Active"><input type="checkbox" data-utoggle="${u.id}" ${u.active ? 'checked' : ''}><span class="sl"></span></label>
        <span class="small muted">${u.active ? 'Active' : 'Disabled'}</span>`}
        <div style="flex:1;"></div>
        ${isAdmin ? '' : `<button class="btn-soft" data-pwreset="${u.id}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L21 2m-4 2l3 3"/></svg>
          Reset password</button>`}
      </div>
    </div>`;
  }).join('');
  document.querySelectorAll('[data-utoggle]').forEach(t => t.onchange = async () => {
    try { await api(`/api/admin/users/${t.dataset.utoggle}/toggle`, { method: 'POST' }); loadAdmin(); }
    catch (e) { toast('Failed: ' + e.message, 'err'); loadAdmin(); }
  });
  document.querySelectorAll('[data-pwreset]').forEach(b => b.onclick = () => {
    const u = users.find(x => String(x.id) === b.dataset.pwreset);
    state.pwUserId = u.id;
    $('pw-sub').textContent = `Set a new password for @${u.username}.`;
    $('pw-new').value = '';
    $('pw-modal').classList.remove('hidden');
  });
}
function switchAdminTab(tab) {
  state.adminTab = tab;
  document.querySelectorAll('#admin-tabs button').forEach(b => b.classList.toggle('active', b.dataset.at === tab));
  $('atab-resources').classList.toggle('hidden', tab !== 'resources');
  $('atab-users').classList.toggle('hidden', tab !== 'users');
  $('atab-config').classList.toggle('hidden', tab !== 'config');
  $('atab-audit').classList.toggle('hidden', tab !== 'audit');
  if (tab === 'config') loadAdminConfig();
  if (tab === 'audit') loadAdminAudit();
}
async function loadAdminConfig() {
  const c = await api('/api/admin/config');
  $('cfg-autoreply').checked = !!c.autoReply;
  $('cfg-model').value = c.aiModel || '';
  $('cfg-modelpool').value = c.aiModelPool || '';
  $('cfg-baseurl').value = c.aiBaseUrl || '';
  $('cfg-msg').textContent = '';
  let urls = {};
  try { urls = await api('/api/webhook-urls'); } catch {}
  $('admin-webhook-urls').innerHTML = `
    <div class="code-box"><span class="cl">Meta (Messenger + Instagram)</span>${esc(urls.meta || '—')}</div>
    <div class="code-box"><span class="cl">Telegram bot</span>${esc(urls.telegram || '—')}</div>`;
}
async function saveAdminConfig() {
  try {
    await api('/api/admin/config', {
      method: 'PUT',
      body: JSON.stringify({
        autoReply: $('cfg-autoreply').checked,
        aiModel: $('cfg-model').value.trim(),
        aiModelPool: $('cfg-modelpool').value.trim(),
        aiBaseUrl: $('cfg-baseurl').value.trim(),
      }),
    });
    $('cfg-msg').textContent = 'Saved ✓';
  } catch (e) { $('cfg-msg').textContent = 'Save failed: ' + e.message; }
}
async function loadAdminAudit() {
  const rows = await api('/api/admin/audit');
  $('audit-list').innerHTML = rows.map(a => `
    <div class="audit-row">
      <span class="ev">${esc(a.event)}</span>
      <span class="muted small">${esc(a.actor || '')}${a.target ? ' → ' + esc(a.target) : ''}</span>
      <span class="right"><span>${esc(a.ip || '')}</span><span>${fmtDT(a.created_at)}</span></span>
    </div>`).join('') || '<div class="tbl-empty">No audit events yet.</div>';
}

// ---------------- live updates ----------------
function connectSSE() {
  if (window._es) { try { window._es.close(); } catch {} }
  const es = new EventSource('/api/events');
  window._es = es;
  es.onmessage = async (e) => {
    try {
      const evt = JSON.parse(e.data);
      if (evt.type === 'message') {
        // Preserve the list's scroll position across the refresh.
        const cl = $('conv-list');
        const slTop = cl ? cl.scrollTop : 0;
        await loadConversations(true);
        if (cl) cl.scrollTop = slTop;
        if (evt.conversation && evt.conversation.id === state.activeId) {
          if (evt.outbound) {
            // AI/operator reply landed → append it, warmth indicator goes away.
            const m = evt.outbound;
            if (!state.messages.some(x => x.id === m.id)) state.messages.push(m);
            appendMessage(m);
          } else {
            // Customer wrote → pull the new inbound(s), show "AI is replying…".
            try {
              const fresh = await api(`/api/conversations/${state.activeId}/messages`);
              const seen = new Set(state.messages.map(x => x.id));
              for (const m of fresh) {
                if (!seen.has(m.id)) { state.messages.push(m); appendMessage(m); }
              }
            } catch {}
            showAiThinking(state.activeId);
          }
          const conv = state.conversations.find(c => c.id === state.activeId);
          if (conv) { conv.unread_count = 0; renderConvList(); }
        }
      } else if (evt.type === 'qr') {
        if (String(evt.clientId) === String(state.clientId) && evt.channel === state.qrChannel
          && (evt.slot || 'default') === (state.qrSlot || 'default')) {
          $('qr-img').src = evt.dataUrl;
        }
      } else if (evt.type === 'channel_status' || evt.type === 'connectors') {
        const cid = evt.clientId != null ? String(evt.clientId) : null;
        if (!cid || cid === String(state.clientId)) {
          if ((evt.status === 'connected' || evt.type === 'connectors') && evt.channel === state.qrChannel
            && (evt.slot || 'default') === (state.qrSlot || 'default')) {
            if (state.qrClose) state.qrClose(); else { $('qr-modal').classList.add('hidden'); state.qrChannel = null; state.qrSlot = null; }
          }
          if (state.view === 'settings') loadConnectors();
          if (state.view === 'inbox') renderInboxEmpty();
        }
        if (state.view === 'admin') loadAdmin();
      } else if (evt.type === 'lead') {
        if (String(evt.clientId) === String(state.clientId)) {
          if (state.view === 'leads') loadLeads();
          await loadLeads(true);
          const conv = state.conversations.find(c => c.id === state.activeId);
          if (conv) renderCustomerTab(conv);
        }
      } else if (evt.type === 'comment') {
        if (String(evt.clientId) === String(state.clientId) && $('ca-activity')) {
          loadCommentActivity();
        }
      }
    } catch { /* ignore malformed */ }
  };
  es.onerror = () => { es.close(); window._es = null; setTimeout(connectSSE, 5000); };
}

// ---------------- init ----------------
document.addEventListener('DOMContentLoaded', () => {
  initCmdk();
  initOffline();
  initModals();
  // draft persistence
  $('msg-input').addEventListener('input', () => { saveDraft(); autosizeComposer(); updateSendBtn(); });
  // login
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('login-err');
    err.classList.remove('show');
    const username = $('login-username').value.trim();
    const password = $('login-password').value;
    if (!username || !password) { err.textContent = 'Enter your username and password.'; err.classList.add('show'); return; }
    $('login-btn').disabled = true;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Login failed');
      $('login-password').value = '';
      await boot();
    } catch (e2) {
      err.textContent = e2.message;
      err.classList.add('show');
    } finally {
      $('login-btn').disabled = false;
    }
  });
  $('btn-signout').onclick = async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
    showLogin();
  };
  $('btn-refresh').onclick = () => { if (state.view === 'admin') loadAdmin(); };
  // Theme toggles (navbar + login page)
  const syncThemeIcon = () => {
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    for (const [sun, moon] of [['icon-sun', 'icon-moon'], ['icon-sun-login', 'icon-moon-login']]) {
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
  };
  $('btn-theme').onclick = toggleTheme;
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
  $('needs-human').addEventListener('change', e => { state.needsHuman = e.target.checked; renderConvList(); });
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
      { ch: 'whatsapp', label: 'WhatsApp', desc: 'QR scan — drives real WhatsApp Web', badge: 'WA', cls: 'p-whatsapp', ok: true },
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
  $('btn-close-qr').onclick = () => { if (state.qrClose) state.qrClose(); else { state.qrChannel = null; state.qrSlot = null; $('qr-modal').classList.add('hidden'); } };

  // admin
  document.querySelectorAll('#admin-tabs button').forEach(b => b.onclick = () => switchAdminTab(b.dataset.at));
  $('btn-create-user').onclick = () => {
    $('um-username').value = ''; $('um-password').value = ''; $('um-workspace').value = ''; $('um-type').value = 'physical';
    $('user-modal').classList.remove('hidden');
  };
  $('btn-close-user').onclick = () => $('user-modal').classList.add('hidden');
  $('btn-save-user').onclick = async () => {
    const username = $('um-username').value.trim(), password = $('um-password').value, workspaceName = $('um-workspace').value.trim();
    if (!username || !password || !workspaceName) return toast('Username, password and workspace name are required', 'err');
    try {
      await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ username, password, workspaceName, businessType: $('um-type').value }) });
      $('user-modal').classList.add('hidden');
      loadAdmin();
    } catch (e) { toast('Could not create: ' + e.message, 'err'); }
  };
  $('btn-close-pw').onclick = () => $('pw-modal').classList.add('hidden');
  $('btn-save-pw').onclick = async () => {
    const password = $('pw-new').value;
    if (!password || password.length < 4) return toast('Password must be at least 4 characters', 'err');
    try {
      await api(`/api/admin/users/${state.pwUserId}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) });
      $('pw-modal').classList.add('hidden');
      toast('Password reset ✓', 'ok');
    } catch (e) { toast('Failed: ' + e.message, 'err'); }
  };
  $('btn-save-config').onclick = saveAdminConfig;

  // modal backdrop click closes (except QR which cancels the flow explicitly)
  for (const id of ['lead-modal', 'product-modal', 'user-modal', 'pw-modal', 'meta-pick-modal']) {
    $(id).addEventListener('click', e => { if (e.target.id === id) $(id).classList.add('hidden'); });
  }

  boot();
});
