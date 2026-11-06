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

function isAdmin(role) {
  const r = role || (state.me && state.me.role);
  return r === 'admin' || r === 'superadmin';
}

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
  access: null,          // workspace license + feature grants from /api/client/access
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
function timeAgo(date) {
  if (!date) return '';
  const d = new Date(date);
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
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

// ---------------- workspace license gating (client side) ----------------
function hasFeature(k) {
  if (!state.me || isAdmin(state.me.role)) return true;
  const a = state.access;
  if (!a) return true; // not loaded yet — never hide before we know
  const feats = a.features || [];
  // Normalize synonyms
  if ((k === 'combined_inbox' || k === 'inbox') && (feats.includes('combined_inbox') || feats.includes('inbox'))) return true;
  return feats.includes(k);
}

function isInboxLocked() {
  if (!state.me || isAdmin(state.me.role)) return false;
  if (!state.access) return false;
  return state.access.mode === 'none' || (state.access.mode === 'licensed' && !hasFeature('combined_inbox'));
}

function applyAccessGating() {
  const a = state.access;
  if (!a || !state.me || isAdmin(state.me.role)) return;
  const stApp = document.querySelector('#settings-tabs [data-st="appearance"]');
  if (stApp) stApp.style.display = hasFeature('webchat') ? '' : 'none';
  const stKb = document.querySelector('#settings-tabs [data-st="kb"]');
  if (stKb) stKb.style.display = hasFeature('knowledge') ? '' : 'none';
  const stKeys = document.querySelector('#settings-tabs [data-st="apikeys"]');
  if (stKeys) stKeys.style.display = hasFeature('api_access') ? '' : 'none';
  if (state.settingsTab === 'appearance' && !hasFeature('webchat')) state.settingsTab = 'channels';
  if (state.settingsTab === 'kb' && !hasFeature('knowledge')) state.settingsTab = 'channels';
  if (state.settingsTab === 'apikeys' && !hasFeature('api_access')) state.settingsTab = 'channels';

  // Sidebar isolated links gating based on active license features
  const navKb = document.querySelector('#nav-links [data-nav="kb"]');
  if (navKb) navKb.style.display = hasFeature('knowledge') ? '' : 'none';
  const navWebchat = document.querySelector('#nav-links [data-nav="webchat"]');
  if (navWebchat) navWebchat.style.display = hasFeature('webchat') ? '' : 'none';
  const navBroadcast = document.querySelector('#nav-links [data-nav="broadcast"]');
  if (navBroadcast) navBroadcast.style.display = hasFeature('broadcast') ? '' : 'none';
  const navApiKeys = document.querySelector('#nav-links [data-nav="apikeys"]');
  if (navApiKeys) navApiKeys.style.display = hasFeature('api_access') ? '' : 'none';

  const ltIntel = document.querySelector('#lm-tabs [data-lt="intel"]');
  if (ltIntel) {
    const show = hasFeature('lead_intel');
    ltIntel.style.display = show ? '' : 'none';
    if (!show) {
      document.querySelectorAll('#lm-tabs button').forEach(x => x.classList.toggle('active', x.dataset.lt === 'details'));
      $('lm-tab-intel').classList.add('hidden');
      $('lm-tab-details').classList.remove('hidden');
    }
  }
  renderLicenseBanner();
  updateInboxLock();
}

function renderLicenseBanner() {
  let el = $('license-banner');
  const a = state.access;
  const admin = !state.me || isAdmin(state.me.role);
  if (!a || admin || isInboxLocked()) { if (el) el.remove(); return; }
  const msgs = [];
  if (a.license && a.license.status === 'expired') msgs.push(['warn', 'Your license has expired — AI and licensed features are paused until renewal.']);
  if (a.aiPaused) msgs.push(['warn', 'AI replies are paused by the platform admin. Your inbox keeps working — every message still arrives here.']);
  else if (a.aiReason === 'credits_exhausted') msgs.push(['warn', `AI credits exhausted (${a.license.credits_used}/${a.license.credits_total} used). The inbox keeps working — ask the admin for a top-up to resume AI replies.`]);
  else if (a.aiReason === 'feature_not_in_plan' || a.aiReason === 'ai_not_granted') msgs.push(['', 'AI auto-replies are not included in your current plan — reply manually from the inbox.']);
  if (!msgs.length) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'license-banner'; $('cview-inbox').prepend(el); }
  el.innerHTML = msgs.map(([cls, t]) =>
    `<div class="notice ${cls}" style="margin-bottom:10px;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg><span>${esc(t)}</span></div>`).join('');
}

function updateInboxLock() {
  const locked = isInboxLocked();
  const panes = $('inbox-panes');
  const empty = $('inbox-empty');
  let note = $('inbox-locked');
  const licBanner = $('license-banner');

  if (locked) {
    if (licBanner) licBanner.remove();
    if (empty) empty.innerHTML = '';
    if (panes) {
      panes.classList.add('hidden');
      panes.style.setProperty('display', 'none', 'important');
    }
    if (!note) {
      note = document.createElement('div');
      note.id = 'inbox-locked';
      $('cview-inbox').prepend(note);
    }
    const noLic = !state.access || state.access.mode === 'none';
    note.innerHTML = `
      <div class="locked-container-card" style="max-width:560px; margin:60px auto; text-align:center; padding:44px 32px; background:var(--card); border:1px solid var(--line); border-radius:20px; box-shadow:var(--shadow-md);">
        <div style="width:64px; height:64px; margin:0 auto 18px; border-radius:18px; background:var(--card2); border:1px solid var(--line); display:flex; align-items:center; justify-content:center; color:var(--ink);">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="3" ry="3"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            <circle cx="12" cy="16" r="1.5"/>
          </svg>
        </div>
        <h2 style="font-size:20px; font-weight:700; color:var(--ink); margin:0 0 8px; letter-spacing:-0.02em;">
          ${noLic ? 'No Active License' : 'Combined Inbox Locked'}
        </h2>
        <p class="muted small" style="margin:0 0 24px; line-height:1.6; max-width:440px; margin-left:auto; margin-right:auto;">
          ${noLic
            ? 'This workspace has no active subscription or license assigned. Customer conversations and inbox features remain locked until an active plan is issued by the platform owner.'
            : 'The Combined Inbox feature is not included in your workspace active plan. Upgrade your plan or contact the platform owner to unlock omnichannel customer chat.'}
        </p>
        <div style="display:flex; gap:10px; justify-content:center;">
          <button class="btn-primary" id="btn-recheck-lic" style="min-width:140px;">
            <span>Recheck License</span>
          </button>
        </div>
      </div>`;
    const rBtn = $('btn-recheck-lic');
    if (rBtn) {
      rBtn.onclick = async () => {
        rBtn.disabled = true;
        rBtn.textContent = 'Checking…';
        try {
          state.access = await api('/api/client/access');
          applyAccessGating();
          if (!isInboxLocked()) {
            loadClientAll();
          }
        } catch {
          location.reload();
        } finally {
          rBtn.disabled = false;
          rBtn.textContent = 'Recheck License';
        }
      };
    }
  } else {
    if (panes) {
      panes.style.removeProperty('display');
      panes.classList.remove('hidden');
    }
    if (note) note.remove();
  }
}
const ICONS = {
  inbox: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
  leads: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>',
  cart: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1.3"/><circle cx="20" cy="21" r="1.3"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>',
  grid: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="2.5"/><rect x="14" y="3" width="7" height="7" rx="2.5"/><rect x="3" y="14" width="7" height="7" rx="2.5"/><rect x="14" y="14" width="7" height="7" rx="2.5"/></svg>',
  box: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  channels: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><circle cx="8.5" cy="10" r="1.3" fill="currentColor"/><circle cx="12" cy="10" r="1.3" fill="currentColor"/><circle cx="15.5" cy="10" r="1.3" fill="currentColor"/></svg>',
  brain: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/><circle cx="12" cy="12" r="3.5"/></svg>',
  palette: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".7" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".7" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".7" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".7" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.7-.8 1.7-1.7 0-.4-.2-.8-.5-1.1-.3-.3-.4-.7-.4-1.2 0-.9.8-1.7 1.7-1.7h2c3.9 0 7-3.1 7-7 0-5-4.5-9.3-11.5-9.3z"/></svg>',
  cloud: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 11a4 4 0 0 0-4-4h-.5a6 6 0 0 0-11 2 4 4 0 0 0 0 8h15a3 3 0 0 0 .5-6z"/><polyline points="10 14 12 12 14 14"/><line x1="12" y1="12" x2="12" y2="18"/></svg>',
  crown: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 2 18 2 22 8 12 22 2 8 6 2"/><line x1="2" y1="8" x2="22" y2="8"/><line x1="12" y1="2" x2="8" y2="8"/><line x1="12" y1="2" x2="16" y2="8"/></svg>',
  key: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L20 3m-3 3l2.5 2.5M16 7l2 2"/></svg>',
  broadcast: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/></svg>',
  compass: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>',
  sheets: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>',
  gear: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  send: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/></svg>',
  dots: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>',
  sun: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2 12h2.5M19.5 12H22M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>',
  zap: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>',
  chat: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8.5v.5z"/></svg>',
  book: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  boxsm: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
  chart: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15l4-6 4 3 5-8"/></svg>',
  help: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>',
  down: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
  card: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20"/></svg>',
  key_solid: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="15" r="4.5"/><path d="M11.2 11.8L20 3m-3 3l2.5 2.5M16 7l2 2"/></svg>',
  shield: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  chev: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
};

function renderNav() {
  const isAdminUser = state.me && isAdmin(state.me.role);

  const mainItems = [
    { id: 'inbox', label: 'Inbox', icon: 'inbox' },
    { id: 'leads', label: 'Leads', icon: 'leads' },
    { id: 'orders', label: 'Orders', icon: 'cart' },
  ];
  if (isAdminUser) {
    mainItems.push({ id: 'admin', label: 'Platform Panel', icon: 'grid' });
  }

  const workspaceItems = [
    { id: 'payments', label: 'Payments Hub', icon: 'card' },
    { id: 'products', label: 'My Products', icon: 'box' },
    { id: 'channels', label: 'Connect Channels', icon: 'channels' },
    { id: 'kb', label: 'Teach the AI', icon: 'brain', req: 'knowledge' },
    { id: 'webchat', label: 'Chat Widget Style', icon: 'palette', req: 'webchat' },
    { id: 'backup', label: 'Backup My Data', icon: 'cloud' },
    { id: 'plan', label: 'My Plan', icon: 'crown' },
    { id: 'apikeys', label: 'API Keys', icon: 'key', req: 'api_access' },
    { id: 'broadcast', label: 'Broadcast', icon: 'broadcast', req: 'broadcast' },
    { id: 'guide', label: 'Help & Guides', icon: 'compass' },
  ];

  const buildGroup = (headerTitle, items) => `
    <div class="sidebar-group">
      <div class="sidebar-group-header">
        <span class="cat-dot"></span>
        <span>${headerTitle}</span>
      </div>
      ${items.map(i => {
        const isHidden = (i.req && !hasFeature(i.req));
        const badge = (i.id === 'payments' && state.pendingPaymentsCount > 0)
          ? `<span class="badge-pending-count" style="margin-left:auto;position:static;display:inline-flex;">${state.pendingPaymentsCount}</span>`
          : '';
        return `
        <button class="nav-link" data-nav="${i.id}" title="${esc(i.label)}" style="${isHidden ? 'display:none;' : ''}">
          <span class="nav-active-bar"></span>
          <span class="nav-icon-badge">
            ${ICONS[i.icon] || ''}
          </span>
          <span class="nav-text">${esc(i.label)}</span>
          ${badge}
        </button>
      `;
      }).join('')}
    </div>
  `;

  // Hidden compatibility button for tests / scripts expecting data-nav="more"
  const legacyMore = '<button class="nav-link hidden-more-btn" data-nav="more" style="display:none;"></button>';

  $('nav-links').innerHTML = buildGroup('MAIN', mainItems) + buildGroup('WORKSPACE', workspaceItems) + legacyMore;

  document.querySelectorAll('#nav-links .nav-link').forEach(b => {
    b.onclick = () => {
      showView(b.dataset.nav);
      if (b.dataset.nav === 'admin') loadAdmin();
    };
  });

  // Mobile bottom tab bar
  const mobileItems = [
    { id: 'inbox', label: 'Inbox', icon: 'inbox' },
    { id: 'leads', label: 'Leads', icon: 'sheets' },
    { id: 'orders', label: 'Orders', icon: 'cart' },
    { id: 'products', label: 'Products', icon: 'box' },
  ];
  if (isAdminUser) mobileItems.unshift({ id: 'admin', label: 'Admin', icon: 'grid' });
  const bt = $('bottom-tabs');
  if (bt) {
    bt.innerHTML = mobileItems.map(i =>
      `<button class="btab" data-nav="${i.id}">${ICONS[i.icon] || ''}<span>${esc(i.label)}</span></button>`).join('');
    document.querySelectorAll('#bottom-tabs .btab').forEach(b =>
      b.onclick = () => { showView(b.dataset.nav); if (b.dataset.nav === 'admin') loadAdmin(); });
  }
}

var VIEW_TITLES = {
  admin: 'Platform Panel',
  inbox: 'Inbox',
  leads: 'Leads',
  orders: 'Orders & Logistics',
  products: 'My Products',
  channels: 'Connect Channels',
  kb: 'Teach the AI',
  webchat: 'Chat Widget Style',
  backup: 'Backup My Data',
  plan: 'My Plan',
  apikeys: 'API Keys',
  broadcast: 'Broadcast',
  guide: 'Help & Guides',
  more: 'More',
  settings: 'Settings'
};

const ALL_VIEWS = [
  'inbox', 'leads', 'orders', 'products', 'channels', 'kb',
  'webchat', 'backup', 'plan', 'apikeys', 'broadcast', 'guide', 'more', 'settings'
];

function showView(view) {
  state.view = view;
  var _tt = $('topnav-title'); if (_tt) _tt.textContent = VIEW_TITLES[view] || '';

  // Active state on sidebar and bottom tabs
  document.querySelectorAll('#nav-links .nav-link').forEach(b => b.classList.toggle('active', b.dataset.nav === view));
  document.querySelectorAll('#bottom-tabs .btab').forEach(b => b.classList.toggle('active', b.dataset.nav === view));

  $('inbox-panes').classList.remove('m-chat-open', 'm-detail-open');
  const adminMode = state.me && isAdmin(state.me.role);
  const onAdminDash = adminMode && view === 'admin';
  $('view-client').classList.toggle('hidden', onAdminDash);
  $('view-admin').classList.toggle('hidden', !onAdminDash);

  for (const v of ALL_VIEWS) {
    var _cv = $('cview-' + v);
    if (_cv) {
      const isTarget = (view === v);
      _cv.classList.toggle('hidden', !isTarget);
      if (isTarget) {
        _cv.classList.remove('view-enter'); void _cv.offsetWidth; _cv.classList.add('view-enter');
      }
    }
  }

  if (view === 'payments') { openPaymentsModal(); return; }
  if (view === 'inbox') {
    updateInboxLock();
    if (!isInboxLocked()) {
      loadConversations();
      if (!state.activeId) renderChatHeader(null);
    }
  }
  if (view === 'leads') loadLeads();
  if (view === 'orders') loadOrdersPage();
  if (view === 'products') loadProducts();
  if (view === 'channels') { $('stab-channels')?.classList.remove('hidden'); loadConnectors(); }
  if (view === 'kb') { $('stab-kb')?.classList.remove('hidden'); switchKbSubTab(state.kbSubTab); loadKnowledge(); }
  if (view === 'webchat') { $('stab-appearance')?.classList.remove('hidden'); loadAppearanceTab(); }
  if (view === 'backup') { $('stab-backup')?.classList.remove('hidden'); loadBackupTab(); }
  if (view === 'plan') { $('stab-plan')?.classList.remove('hidden'); renderPlanTab(); }
  if (view === 'apikeys') { $('stab-apikeys')?.classList.remove('hidden'); renderApiKeysTab(); }
  if (view === 'broadcast') renderBroadcast();
  if (view === 'guide') renderGuide();
  if (view === 'more') renderMore();
  if (view === 'settings') { switchSettingsTab(state.settingsTab); renderSetupChecklist(); }
  if (view === 'admin') loadAdmin();
}

async function loadOrdersPage() {
  const box = $('orders-full-list');
  if (!box) return;
  box.innerHTML = '<div class="small muted" style="padding:24px; text-align:center;">Loading orders & logistics...</div>';
  try {
    const res = await api('/api/orders');
    const orders = res.orders || res || [];
    const statsEl = $('orders-stats-summary');
    if (statsEl) {
      const bookedCount = orders.filter(o => o.courier_status === 'booked').length;
      statsEl.textContent = `${orders.length} orders total · ${bookedCount} booked to courier`;
    }
    if (!orders.length) {
      box.innerHTML = '<div class="warm-empty" style="padding:40px; text-align:center;"><div class="we-ic" style="margin-bottom:8px;"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg></div><b>No orders placed yet</b><p class="muted small" style="margin-top:4px;">Orders created by AI or operators in chat will appear here automatically.</p></div>';
      return;
    }
    box.innerHTML = orders.map(o => {
      let items = [];
      try { items = typeof o.items_json === 'string' ? JSON.parse(o.items_json) : (o.items_json || []); } catch {}
      const dc = Number(o.delivery_charge_bdt) || 0;
      const grandTotal = Number(o.total_bdt) || (Number(o.subtotal_bdt || 0) + dc);
      const isBooked = o.courier_status === 'booked';
      return `
        <div class="card order-card-item" style="padding:16px 20px; display:flex; justify-content:space-between; align-items:center; gap:16px;" data-oid="${o.id}">
          <div style="flex:1; min-width:0;">
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
              <b style="font-size:16px; color:var(--ink);">Order #${o.id}</b>
              <span class="pill ${isBooked ? 'green' : 'amber'}">${isBooked ? 'Booked (Steadfast)' : 'Unbooked'}</span>
              ${o.courier_consignment_id ? `<span class="small muted">Tracking: <b>${esc(o.courier_consignment_id)}</b></span>` : ''}
              <span class="small muted" style="margin-left:auto;">${fmtDT(o.created_at)}</span>
            </div>
            <div style="font-size:14px; color:var(--body); margin-bottom:4px;">
              <b>${esc(o.customer_name || 'Customer')}</b> · <span class="muted">${esc(o.customer_phone || '—')}</span>
            </div>
            <div class="small muted" style="margin-bottom:6px;">
              ${items.length ? items.map(i => `${esc(i.name || i.sku)} × ${i.quantity || 1}`).join(', ') : 'Items'}
            </div>
            <div style="font-weight:700; color:var(--ink); font-size:14px;">Total COD: ${grandTotal} BDT</div>
          </div>
          <div style="display:flex; flex-direction:column; gap:8px; align-items:flex-end;">
            ${!isBooked ? `<button class="btn-primary" data-book-order="${o.id}" style="font-size:13px; padding:7px 14px;">Dispatch parcel</button>` : ''}
            <button class="btn-soft" data-thermal-order="${o.id}" style="font-size:13px; padding:6px 12px;">Thermal slip</button>
          </div>
        </div>
      `;
    }).join('');

    box.querySelectorAll('[data-book-order]').forEach(b => {
      b.onclick = () => {
        const o = orders.find(x => String(x.id) === b.dataset.bookOrder);
        if (o) openCourierBookModal(o);
      };
    });
    box.querySelectorAll('[data-thermal-order]').forEach(b => {
      b.onclick = () => {
        printThermalShippingLabel(b.dataset.thermalOrder);
      };
    });
  } catch (e) {
    box.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`;
  }
}

// ---------------- command palette (Cmd+K) ----------------
const CMDK_ACTIONS = [
  { id:'go-inbox', t:'Go to Inbox', s:'View conversations', ic:'M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z', run:() => showView('inbox') },
  { id:'go-leads', t:'Go to Leads', s:'Lead intelligence', ic:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', run:() => showView('leads') },
  { id:'go-more', t:'Go to More', s:'Workspace hub', ic:'M12 5v14M5 12h14', run:() => showView('more') },
  { id:'go-broadcast', t:'Broadcast', s:'Campaign messages', ic:'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z', run:() => showView('broadcast'), req:'broadcast' },
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
    (!a.req || hasFeature(a.req)) &&
    (!ql || a.t.toLowerCase().includes(ql) || a.s.toLowerCase().includes(ql)));
  // admin action only for admins
  if (state.me && isAdmin(state.me.role) && (!ql || 'platform panel'.includes(ql))) {
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
    if (mod && (e.key?.toLowerCase() === 'k' || e.code === 'KeyK')) {
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
// ---------------- client: Broadcast campaigns ----------------
async function renderBroadcast() {
  if (!hasFeature('broadcast')) {
    $('bcast-list').innerHTML = `<div class="card"><p class="muted">Broadcast is not included in your plan.</p></div>`;
    return;
  }
  let list = [];
  try { list = await api('/api/broadcasts'); } catch (e) { $('bcast-list').innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  const pill = (s) => `<span class="pill ${s === 'sending' ? 'blue' : s === 'done' ? 'green' : s === 'cancelled' ? 'red' : ''}">${esc(s)}</span>`;
  $('bcast-list').innerHTML = list.map(b => {
    const pct = b.total ? Math.round(((b.sent + b.failed) / b.total) * 100) : 0;
    return `<div class="card mb16" data-bcast="${b.id}">
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <div style="flex:1; min-width:180px;">
          <div style="font-weight:800; color:var(--ink);">${esc(b.name)}</div>
          <div class="muted small">${esc(b.channel === 'all' ? 'All channels' : b.channel)} · ${b.total} recipient${b.total === 1 ? '' : 's'}</div>
        </div>
        ${pill(b.status)}
      </div>
      <div class="meter" style="margin:10px 0 6px;"><div class="meter-fill" style="width:${pct}%;"></div></div>
      <div class="muted small" style="margin-bottom:10px;">${b.sent} sent · ${b.failed} failed · ${pct}%</div>
      <div class="muted small" style="margin-bottom:10px; white-space:pre-wrap;">${esc((b.text || '').slice(0, 220))}${(b.text || '').length > 220 ? '…' : ''}</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        ${b.status === 'draft' ? `<button class="btn-soft" data-bc-aud="${b.id}">Build audience</button>
          ${b.total > 0 ? `<button class="btn-primary" data-bc-send="${b.id}">Send to ${b.total}</button>` : ''}
          <button class="btn-soft danger" data-bc-del="${b.id}">Delete</button>` : ''}
        ${b.status === 'sending' ? `<button class="btn-soft danger" data-bc-cancel="${b.id}">Cancel</button>` : ''}
        ${(b.status === 'done' || b.status === 'cancelled') ? `<button class="btn-soft danger" data-bc-del="${b.id}">Delete</button>` : ''}
      </div>
    </div>`;
  }).join('') || `<div class="card"><p class="muted">No campaigns yet. Create one to message your customers in bulk.</p></div>`;

  $('bcast-list').querySelectorAll('[data-bc-aud]').forEach(x => x.onclick = async () => {
    try { const b = await api(`/api/broadcasts/${x.dataset.bcAud}/audience`, { method: 'POST' }); toast(`Audience ready: ${b.stats.total} recipients`); renderBroadcast(); }
    catch (e) { toast('Failed: ' + e.message, 'err'); }
  });
  $('bcast-list').querySelectorAll('[data-bc-send]').forEach(x => x.onclick = async () => {
    if (!confirm('Start sending this campaign?')) return;
    try { await api(`/api/broadcasts/${x.dataset.bcSend}/send`, { method: 'POST' }); toast('Campaign sending…'); renderBroadcast(); }
    catch (e) { toast('Failed: ' + e.message, 'err'); }
  });
  $('bcast-list').querySelectorAll('[data-bc-cancel]').forEach(x => x.onclick = async () => {
    if (!confirm('Cancel this campaign? Remaining recipients will not be messaged.')) return;
    try { await api(`/api/broadcasts/${x.dataset.bcCancel}/cancel`, { method: 'POST' }); renderBroadcast(); }
    catch (e) { toast('Failed: ' + e.message, 'err'); }
  });
  $('bcast-list').querySelectorAll('[data-bc-del]').forEach(x => x.onclick = async () => {
    if (!confirm('Delete this campaign?')) return;
    try { await api(`/api/broadcasts/${x.dataset.bcDel}`, { method: 'DELETE' }); renderBroadcast(); }
    catch (e) { toast('Failed: ' + e.message, 'err'); }
  });
}
function initBroadcastComposer() {
  $('btn-bcast-new').onclick = () => { $('bcast-composer').classList.remove('hidden'); };
  $('bcast-cancel-compose').onclick = () => { $('bcast-composer').classList.add('hidden'); };
  $('bcast-create').onclick = async () => {
    const name = $('bcast-name').value.trim() || 'Campaign';
    const channel = $('bcast-channel').value;
    const text = $('bcast-text').value.trim();
    if (!text) { toast('Write the message first.', 'err'); return; }
    try {
      const b = await api('/api/broadcasts', { method: 'POST', body: JSON.stringify({ name, channel, text }) });
      const full = await api(`/api/broadcasts/${b.id}/audience`, { method: 'POST' });
      $('bcast-name').value = ''; $('bcast-text').value = '';
      $('bcast-composer').classList.add('hidden');
      toast(`Draft created — audience: ${full.stats.total} recipients`);
      renderBroadcast();
    } catch (e) { toast('Failed: ' + e.message, 'err'); }
  };
}

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

// ---------------- Inbound Web Audio Chime ----------------
function playInboundChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now); // D5
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880.00, now + 0.09); // A5

    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.09);
    osc2.start(now + 0.09);
    osc2.stop(now + 0.35);
  } catch {}
}

// ---------------- Payment Web Audio Cash Chime ----------------
function playPaymentChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const osc3 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(523.25, now); // C5
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(659.25, now + 0.09); // E5
    osc3.type = 'triangle';
    osc3.frequency.setValueAtTime(1046.50, now + 0.18); // C6

    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);

    osc1.connect(gain);
    osc2.connect(gain);
    osc3.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.09);
    osc2.start(now + 0.09);
    osc2.stop(now + 0.18);
    osc3.start(now + 0.18);
    osc3.stop(now + 0.55);
  } catch {}
}

// ---------------- Courier & Logistics ----------------
async function openCourierConfigModal() {
  const m = $('courier-modal');
  if (!m) return;
  m.classList.remove('hidden');
  try {
    const cfg = await api('/api/courier/config');
    $('courier-provider').value = cfg.provider || 'steadfast';
    $('sf-api-key').value = cfg.steadfast_api_key || '';
    $('sf-secret-key').value = cfg.steadfast_secret_key || '';
    $('sf-charge-inside').value = cfg.default_delivery_charge_inside ?? 60;
    $('sf-charge-outside').value = cfg.default_delivery_charge_outside ?? 120;
    $('sf-auto-sms').checked = cfg.auto_send_tracking_sms !== false;
  } catch (e) {
    toast('Courier config error: ' + e.message, 'err');
  }
}

async function saveCourierConfig() {
  const payload = {
    provider: $('courier-provider').value,
    steadfast_api_key: $('sf-api-key').value.trim(),
    steadfast_secret_key: $('sf-secret-key').value.trim(),
    default_delivery_charge_inside: Number($('sf-charge-inside').value) || 60,
    default_delivery_charge_outside: Number($('sf-charge-outside').value) || 120,
    auto_send_tracking_sms: $('sf-auto-sms').checked,
  };
  try {
    await api('/api/courier/config', { method: 'POST', body: JSON.stringify(payload) });
    toast('Courier configuration saved successfully ✓');
    $('courier-modal').classList.add('hidden');
  } catch (e) {
    toast('Save failed: ' + e.message, 'err');
  }
}

function openCourierBookModal(order) {
  const m = $('courier-book-modal');
  if (!m) return;
  $('cb-order-id').value = order.id;
  $('cb-sub').textContent = `Booking Order #${order.id} for dispatch via Steadfast Courier`;
  $('cb-name').value = order.customer_name || '';
  $('cb-phone').value = order.customer_phone || '';
  $('cb-address').value = order.customer_address || '';
  const dc = Number(order.delivery_charge_bdt) || 0;
  const tot = Number(order.total_bdt) || (Number(order.subtotal_bdt || 0) + dc);
  const advPaid = Number(order.advance_paid_bdt) || 0;
  const codDue = Math.max(0, tot - advPaid);
  $('cb-cod').value = codDue;
  $('cb-note').value = `Order #${order.id}`;
  m.classList.remove('hidden');
}

async function confirmCourierBooking() {
  const orderId = Number($('cb-order-id').value);
  const btn = $('btn-confirm-cbook');
  btn.disabled = true;
  btn.textContent = 'Booking with Steadfast...';
  try {
    const res = await api('/api/courier/steadfast/book', {
      method: 'POST',
      body: JSON.stringify({
        order_id: orderId,
        recipient_name: $('cb-name').value.trim(),
        recipient_phone: $('cb-phone').value.trim(),
        recipient_address: $('cb-address').value.trim(),
        cod_amount: Number($('cb-cod').value) || 0,
        note: $('cb-note').value.trim(),
      })
    });
    toast(`Booked with Steadfast. Tracking: ${res.tracking_code}`);
    $('courier-book-modal').classList.add('hidden');
    const conv = state.conversations.find(c => c.id === state.activeId);
    if (conv) renderCustomerTab(conv);
    if ($('orders-modal') && !$('orders-modal').classList.contains('hidden')) openOrdersModal();
  } catch (e) {
    toast('Booking failed: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirm & dispatch';
  }
}

// ---------------- 4x6" Thermal Shipping Slip ----------------
async function printThermalShippingLabel(orderId) {
  let orderData;
  try {
    orderData = await api(`/api/orders/${orderId}/invoice`);
  } catch (e) {
    toast('Failed to load invoice: ' + e.message, 'err');
    return;
  }
  const o = orderData.order;
  const clientName = orderData.clientName || 'TECTOBOX STORE';
  let items = orderData.items || [];
  const dc = Number(o.delivery_charge_bdt) || 0;
  const total = Number(o.total_bdt) || (Number(o.subtotal_bdt || 0) + dc);
  const advPaid = Number(o.advance_paid_bdt) || 0;
  const codDue = Math.max(0, total - advPaid);
  const trackingCode = o.courier_tracking_code || `STEAD-${o.id}-${Date.now().toString().slice(-4)}`;

  const labelHtml = `
    <div class="thermal-sheet">
      <div class="ts-head">
        <div>
          <div class="ts-store">${esc(clientName)}</div>
          <div style="font-size:11px; color:#555;">Order ID: #${o.id} · ${fmtDT(o.created_at)}</div>
        </div>
        <div class="ts-courier">
          <div class="ts-cname">STEADFAST COURIER</div>
          <div style="font-size:10px; color:#555;">Standard COD Delivery</div>
        </div>
      </div>

      <div class="ts-barcode">
        <div class="ts-code">${esc(trackingCode)}</div>
        <div style="font-size:10px; letter-spacing:1px; margin-top:2px;">|||||| |||||||||| |||||| |||||||| ||||||</div>
      </div>

      <div class="ts-recipient">
        <div class="ts-lbl">Recipient Delivery Details</div>
        <div class="ts-name">${esc(o.customer_name || 'Valued Customer')}</div>
        <div class="ts-phone">Phone: ${esc(o.customer_phone || '—')}</div>
        <div class="ts-addr">Address: ${esc(o.customer_address || 'Dhaka, Bangladesh')}</div>
      </div>

      <div class="ts-cod-box">
        <div class="ts-cod-title">Cash to Collect (COD)</div>
        <div class="ts-cod-amt">৳${codDue.toLocaleString('en-US')}</div>
      </div>

      <div class="ts-items">
        <div style="font-weight:700; margin-bottom:4px;">Item Details:</div>
        ${items.map(i => `<div>• ${i.qty || 1}x ${esc(i.name || i.sku || 'Item')} — ৳${Number(i.price_bdt || 0).toLocaleString('en-US')}</div>`).join('')}
        ${dc ? `<div style="color:#555;">• Delivery Fee: ৳${dc}</div>` : ''}
      </div>

      <div class="ts-foot">
        <div>Generated by Tectobox</div>
        <div>Please handle with care</div>
      </div>
    </div>
  `;

  $('thermal-preview-container').innerHTML = labelHtml;
  $('thermal-print-area').innerHTML = labelHtml;
  $('thermal-label-modal').classList.remove('hidden');

  $('btn-print-thermal').onclick = () => {
    window.print();
  };
}

// ---------------- Orders & Shipping Slips Modal ----------------
async function openOrdersModal() {
  const m = $('orders-modal');
  if (!m) return;
  m.classList.remove('hidden');
  const box = $('orders-modal-list');
  box.innerHTML = '<div class="small muted" style="padding:20px; text-align:center;">Loading orders...</div>';
  try {
    const res = await api('/api/orders');
    const orders = res.orders || res || [];
    if (!orders.length) {
      box.innerHTML = '<div class="warm-empty" style="padding:30px;"><div class="we-ic"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg></div><b>No orders yet</b><p>Orders created from inbox chats will appear here.</p></div>';
      return;
    }
    box.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:10px;">
        ${orders.map(o => {
          let items = [];
          try { items = typeof o.items_json === 'string' ? JSON.parse(o.items_json) : (o.items_json || []); } catch {}
          const dc = Number(o.delivery_charge_bdt) || 0;
          const grandTotal = Number(o.total_bdt) || (Number(o.subtotal_bdt || 0) + dc);
          const isBooked = o.courier_status === 'booked';
          return `
            <div class="card" style="display:flex; justify-content:space-between; align-items:center; gap:14px; padding:14px 18px;">
              <div style="flex:1; min-width:0;">
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                  <b style="font-size:15px; color:var(--ink);">Order #${o.id}</b>
                  <span class="pill ${isBooked ? 'green' : 'amber'}">${isBooked ? 'Booked' : 'Unbooked'}</span>
                  <span class="small muted">${fmtDT(o.created_at)}</span>
                </div>
                <div style="font-size:13px; color:var(--body);"><b>${esc(o.customer_name || 'Customer')}</b> (${esc(o.customer_phone || '—')})</div>
                <div class="muted small" style="margin-top:2px;">${items.map(i => `${i.qty}x ${esc(i.name || i.sku)}`).join(', ')}</div>
                ${o.courier_tracking_code ? `<div style="font-size:12px; font-weight:700; color:var(--accent); margin-top:4px;">Tracking: ${esc(o.courier_tracking_code)}</div>` : ''}
              </div>
              <div style="text-align:right; flex-shrink:0;">
                <div style="font-weight:700; font-size:16px; color:var(--ink);">৳${grandTotal.toLocaleString('en-US')}</div>
                <div style="display:flex; gap:6px; margin-top:8px;">
                  ${!isBooked ? `<button class="btn-primary" style="padding:6px 12px; font-size:12px;" data-book-order="${o.id}">Book courier</button>` : ''}
                  <button class="btn-soft" style="padding:6px 12px; font-size:12px;" data-print-order="${o.id}">Print label</button>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    box.querySelectorAll('[data-book-order]').forEach(btn => {
      btn.onclick = () => {
        const o = orders.find(x => String(x.id) === btn.dataset.bookOrder);
        if (o) openCourierBookModal(o);
      };
    });
    box.querySelectorAll('[data-print-order]').forEach(btn => {
      btn.onclick = () => printThermalShippingLabel(btn.dataset.printOrder);
    });
  } catch (e) {
    box.innerHTML = `<div class="card err" style="padding:20px;">Failed to load orders: ${esc(e.message)}</div>`;
  }
}

// ---------------- Canned Quick Replies & / Slash Commands ----------------
const DEFAULT_QUICK_REPLIES = [
  {
    cmd: '/bkash',
    title: 'bKash Merchant Payment',
    body: 'আমাদের বিকাশ মার্চেন্ট নম্বর: 017XXXXXXXX (Payment অপশন সিলেক্ট করবেন)। পেমেন্ট করে TrxID বা লাস্ট ৪ ডিজিট এখানে জানাবেন।'
  },
  {
    cmd: '/nagad',
    title: 'Nagad Merchant Payment',
    body: 'আমাদের নগদ মার্চেন্ট নম্বর: 018XXXXXXXX (Make Payment অপশন সিলেক্ট করবেন)। পেমেন্ট করে TrxID টি এখানে জানাবেন।'
  },
  {
    cmd: '/delivery',
    title: 'Delivery charges & time',
    body: 'আমাদের ডেলিভারি চার্জ: ঢাকা সিটির ভিতরে ৬০ টাকা, ঢাকা সিটির বাইরে ১২০ টাকা। ২-৩ কার্যদিবসের মধ্যে ডেলিভারি পাবেন ইনশাআল্লাহ।'
  },
  {
    cmd: '/policy',
    title: 'Checking & return policy',
    body: 'পণ্য রিসিভ করার সময় ডেলিভারি ম্যানের সামনে চেক করে নিবেন। কোন সমস্যা থাকলে সাথে সাথে রিটার্ন করতে পারবেন।'
  },
  {
    cmd: '/size',
    title: 'Standard Apparel Size Chart',
    body: 'আমাদের সাইজ চার্ট:\\nM: Chest 38, Length 27\\nL: Chest 40, Length 28\\nXL: Chest 42, Length 29\\nXXL: Chest 44, Length 30'
  },
  {
    cmd: '/confirm',
    title: 'Order confirmation message',
    body: 'ধন্যবাদ! আপনার অর্ডারটি কনফার্ম করা হয়েছে। আমরা দ্রুততম সময়ে পার্সেলটি কুরিয়ারে বুক করে ট্র্যাকিং আইডি জানিয়ে দিচ্ছি।'
  }
];

function getStoredQuickReplies() {
  try {
    const raw = localStorage.getItem('tectobox_quick_replies');
    if (raw) return JSON.parse(raw);
  } catch {}
  return DEFAULT_QUICK_REPLIES;
}

function saveStoredQuickReplies(list) {
  try {
    localStorage.setItem('tectobox_quick_replies', JSON.stringify(list));
  } catch {}
}

function openQuickRepliesModal() {
  const m = $('quickreplies-modal');
  if (!m) return;
  m.classList.remove('hidden');
  renderQuickRepliesModal();
}

function renderQuickRepliesModal() {
  const list = getStoredQuickReplies();
  const box = $('qr-templates-list');
  if (!box) return;
  box.innerHTML = list.map((item, idx) => `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; padding:10px 12px; border-bottom:1px solid var(--line);">
      <div style="flex:1; min-width:0;">
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="slash-cmd">${esc(item.cmd)}</span>
          <b style="font-size:13px; color:var(--ink);">${esc(item.title)}</b>
        </div>
        <div class="muted small" style="margin-top:4px; line-height:1.4;">${esc(item.body)}</div>
      </div>
      <button class="btn-ghost" data-del-qr="${idx}" style="color:var(--red); font-size:14px; padding:4px 8px;">✕</button>
    </div>
  `).join('');

  box.querySelectorAll('[data-del-qr]').forEach(btn => {
    btn.onclick = () => {
      const idx = +btn.dataset.delQr;
      list.splice(idx, 1);
      saveStoredQuickReplies(list);
      renderQuickRepliesModal();
    };
  });
}

function initSlashCommands() {
  const mi = $('msg-input');
  const pop = $('slash-popup');
  if (!mi || !pop) return;

  function updateSlashPopup() {
    const val = mi.value;
    const slashIdx = val.lastIndexOf('/');
    if (slashIdx === -1 || (slashIdx > 0 && val[slashIdx - 1] !== ' ' && val[slashIdx - 1] !== '\n')) {
      pop.classList.add('hidden');
      return;
    }
    const query = val.slice(slashIdx + 1).toLowerCase();
    const list = getStoredQuickReplies();
    const matches = list.filter(item => item.cmd.toLowerCase().includes('/' + query) || item.title.toLowerCase().includes(query));
    if (!matches.length) {
      pop.classList.add('hidden');
      return;
    }
    pop.innerHTML = matches.map((m, i) => `
      <button class="slash-item" data-slash-idx="${i}">
        <span class="slash-cmd">${esc(m.cmd)}</span>
        <span class="slash-desc"><b>${esc(m.title)}</b> — <span class="slash-snippet">${esc(m.body.slice(0, 50))}…</span></span>
      </button>
    `).join('');

    pop.querySelectorAll('[data-slash-idx]').forEach(btn => {
      btn.onclick = () => {
        const item = matches[+btn.dataset.slashIdx];
        const before = val.slice(0, slashIdx);
        mi.value = before + item.body + ' ';
        pop.classList.add('hidden');
        mi.focus();
        autosizeComposer();
        refreshSendBtn();
      };
    });
    pop.classList.remove('hidden');
  }

  mi.addEventListener('input', updateSlashPopup);
  mi.addEventListener('keydown', e => {
    if (e.key === 'Escape') pop.classList.add('hidden');
  });
  document.addEventListener('click', e => {
    if (!pop.contains(e.target) && e.target !== mi) pop.classList.add('hidden');
  });
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
  if (isInboxLocked()) {
    updateInboxLock();
    await Promise.all([loadStats(), loadProducts(true)]);
    return;
  }
  await Promise.all([loadStats(), loadConversations(true), loadProducts(true)]);
  renderCustomerTab(null);
  setComposerEnabled(false);
}
async function loadStats() { /* reserved for future stat display */ }

function renderPlatformChips() {
  const hidden = META_CONNECTORS_VISIBLE ? [] : ['messenger', 'instagram'];
  const all = [{ id: 'all', label: 'All' }, ...Object.entries(PLATFORMS)
    .filter(([id]) => !hidden.includes(id)).map(([id, m]) => ({ id, label: m.label }))];
  const pop = $('filter-pop');
  if (pop) {
    pop.innerHTML = all.map(c => `
      <button class="pop-item ${state.platformFilter === c.id ? 'active' : ''}" data-p="${c.id}" role="menuitem">
        ${c.id !== 'all' ? platDot(c.id) : '<span class="plat-dot" style="background:var(--accent)"></span>'}${esc(c.label)}
        <span class="tick">✓</span>
      </button>`).join('');
    pop.querySelectorAll('.pop-item').forEach(b =>
      b.onclick = (e) => { e.stopPropagation(); state.platformFilter = b.dataset.p; renderPlatformChips(); renderConvList(); loadConversations(true); closeFilterPop(); });
  }
  const dot = $('filter-dot');
  if (dot) dot.classList.toggle('hidden', state.platformFilter === 'all');
  const fb = $('btn-filter');
  if (fb) fb.classList.toggle('on', state.platformFilter !== 'all');
}
function closeFilterPop() { var _p = $('filter-pop'); if (_p) _p.classList.add('hidden'); }

// Generation counter: concurrent loads (boot fires two) can't clobber each other,
// and a failed fetch shows a warm retry state instead of a dead skeleton.
let _convGen = 0;
async function loadConversations(quiet) {
  if (isInboxLocked()) {
    updateInboxLock();
    return;
  }
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
      <div class="we-ic"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/></svg></div><b>Couldn't load conversations</b>
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
      <div class="conv-empty-ic"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
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
  if (isInboxLocked()) {
    updateInboxLock();
    return;
  }
  const empty = $('inbox-empty'), panes = $('inbox-panes');
  let connected = 0;
  try {
    const conns = await api(`/api/clients/${state.clientId}/connectors`);
    connected = Object.values(conns).filter(s => s.status === 'connected').length;
  } catch {}
  if (isInboxLocked()) {
    updateInboxLock();
    return;
  }
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
      <div class="we-ic"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div><b>Pick a conversation</b>
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
    ${conv.needs_human ? '<span class="pill amber" id="badge-needs-human">Needs human</span>' : ''}
    <button class="icon-btn" id="btn-toggle-human" title="${conv.needs_human ? 'Resolve human handover (resume AI)' : 'Flag for human attention (pause AI)'}" style="color:${conv.needs_human ? '#f59e0b' : 'var(--muted)'};">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.9-2.3l-3.4-3.85a2 2 0 0 1 3-2.65L7 15"/></svg>
    </button>
    <button class="icon-btn m-info" id="btn-chat-info" aria-label="Details">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/></svg>
    </button>`;
  $('btn-chat-back').onclick = closeMobileChat;
  $('btn-chat-info').onclick = () => toggleMobileDetail(!$('inbox-panes').classList.contains('m-detail-open'));
  const btnToggleHuman = $('btn-toggle-human');
  if (btnToggleHuman) {
    btnToggleHuman.onclick = async () => {
      const nextState = !conv.needs_human;
      try {
        await api(`/api/conversations/${conv.id}/flag`, {
          method: 'POST',
          body: JSON.stringify({ needs_human: nextState })
        });
        conv.needs_human = nextState;
        renderChatHeader(conv);
        renderConvList();
        toast(nextState ? 'Flagged for human assistance ✓' : 'Human handover resolved — AI resumed ✓');
      } catch (e) {
        toast('Failed to update flag: ' + e.message, 'err');
      }
    };
  }
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
      <div class="we-ic"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div><b>No messages yet</b>
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
        return 'Our catalog:\n\n' + ps.map(p => `• ${p.name} — ৳${Number(p.price_bdt).toLocaleString()}`).join('\n');
      return 'Stock update:\n\n' + ps.map(p => `• ${p.name} — ${(p.stock || 0) > 0 ? `In stock (${p.stock} pcs)` : 'Out of stock'}`).join('\n');
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
    <div id="cust-fraud-box" style="margin:10px 0;"></div>
    ${status !== 'confirmed' ? `<button class="btn-soft mt8" id="btn-advance-cust" style="width:100%; justify-content:center;">Advance to ${LEAD_NEXT[status]} →</button>` : ''}
    <div style="font-weight:800; color:var(--ink); font-size:13.5px; margin:16px 0 8px;">Order history (${orders.length})</div>
    ${orders.length ? orders.map(o => {
      let items = [];
      try { items = typeof o.items_json === 'string' ? JSON.parse(o.items_json) : (o.items_json || []); } catch {}
      const dc = Number(o.delivery_charge_bdt) || 0;
      const advReq = Number(o.advance_required_bdt) || 0;
      const advPaid = Number(o.advance_paid_bdt) || 0;
      const grandTotal = Number(o.total_bdt) + dc;
      const pctPaid = grandTotal > 0 ? Math.round((advPaid / grandTotal) * 100) : 0;
      const payCls = o.payment_status === 'paid' ? 'green' : o.payment_status === 'partial' ? 'amber' : 'gray';
      const isBooked = o.courier_status === 'booked';
      return `<div class="prod-row" style="flex-direction:column; align-items:stretch; gap:8px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div class="inf"><div class="nm">#${o.id} · ${esc(o.status)}</div>
          <div class="meta">${items.map(i => `${i.qty}x ${esc(i.name || i.sku)}`).join(', ')}</div>
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
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px; padding-top:6px; border-top:1px dashed var(--line);">
          <span class="pill ${isBooked ? 'green' : 'amber'}">${isBooked ? esc(o.courier_tracking_code || 'Booked') : 'Unbooked'}</span>
          <div style="display:flex; gap:6px;">
            ${!isBooked ? `<button class="mini-btn" data-cust-book="${o.id}">Book courier</button>` : ''}
            <button class="mini-btn" data-cust-print="${o.id}">Label</button>
          </div>
        </div>
      </div>`;
    }).join('') : '<div class="small muted">No orders yet</div>'}`;

  // Check fraud / return risk asynchronously
  const ph = conv.customer_phone || (lead && lead.phone);
  if (ph) {
    api('/api/courier/fraud-check?phone=' + encodeURIComponent(ph))
      .then(f => {
        const fb = $('cust-fraud-box');
        if (!fb) return;
        const pCls = f.risk_level === 'high' ? 'red' : f.risk_level === 'medium' ? 'amber' : 'green';
        const icSvg = f.risk_level === 'high'
          ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
          : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
        fb.innerHTML = `
          <div style="padding:10px 12px; border-radius:12px; background:var(--active); border:1px solid var(--line); font-size:12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <span style="font-weight:700; color:var(--ink); display:flex; align-items:center; gap:6px;">
                <span>${icSvg}</span> Courier Reliability
              </span>
              <span class="pill ${pCls}">${f.success_rate}% Success</span>
            </div>
            <div class="muted small">${esc(f.risk_label)}</div>
          </div>
        `;
      }).catch(() => {});
  }

  box.querySelectorAll('[data-cust-book]').forEach(btn => {
    btn.onclick = () => {
      const o = orders.find(x => String(x.id) === btn.dataset.custBook);
      if (o) openCourierBookModal(o);
    };
  });
  box.querySelectorAll('[data-cust-print]').forEach(btn => {
    btn.onclick = () => printThermalShippingLabel(btn.dataset.custPrint);
  });

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
  if (state.creatingOrder) return;
  const ids = Object.keys(state.orderLines || {});
  if (!ids.length || !state.activeId) { $('order-msg').textContent = 'Pick a conversation and add items first.'; return; }
  const btn = $('btn-create-order');
  if (btn) btn.disabled = true;
  state.creatingOrder = true;
  const items = ids.map(id => {
    const p = (state.products || []).find(x => String(x.id) === String(id));
    return {
      sku: p ? p.sku : `ITEM-${id}`,
      name: p ? p.name : 'Product Item',
      price_bdt: p ? Number(p.price_bdt || 0) : 0,
      qty: state.orderLines[id] || 1,
    };
  });
  try {
    const res = await api('/api/orders', { method: 'POST', body: JSON.stringify({ conversation_id: state.activeId, items }) });
    $('order-msg').textContent = `Order #${res.order.id} created — ${Number(res.order.total_bdt).toLocaleString('en-US')} BDT. Summary posted in chat.`;
    state.orderLines = {};
    renderOrderTab();
    state.messages = await api(`/api/conversations/${state.activeId}/messages`);
    renderMessages();
  } catch (e) { $('order-msg').textContent = 'Error: ' + e.message; }
  finally {
    state.creatingOrder = false;
    if (btn) btn.disabled = false;
  }
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
  return `<span class="pill ${TEMP_PILL[t] || 'blue'}">${esc(t || 'cold')}</span>`;
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
    $('lead-intel-summary').textContent = `${s.total || 0} leads · ${hot} hot · ${warm} warm`;
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
  const segName = { all: 'All', customers: 'Customers', potential: 'Potential', new: 'New leads' };
  document.querySelectorAll('#lead-segment-filters button').forEach(b => {
    const f = b.dataset.seg;
    const n = f === 'all' ? state.leads.length : state.leads.filter(l => leadSegmentOf(l) === f).length;
    b.textContent = segName[f] + (state.leadSegment === 'all' || f === state.leadSegment ? ` (${n})` : '');
  });
  const rows = state.leads.filter(l => state.leadSegment === 'all' || leadSegmentOf(l) === state.leadSegment);
  document.querySelectorAll('#lead-temp-filters button').forEach(b => {
    const f = b.dataset.lt;
    const base = f === 'all' ? 'All temps' : f[0].toUpperCase() + f.slice(1);
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
  const sanitizedPrice = Math.max(0, price);
  const sanitizedStock = Math.max(0, Number($('pm-stock').value) || 0);
  try {
    if (state.editingProductId) {
      await api('/api/products/' + state.editingProductId, {
        method: 'PATCH',
        body: JSON.stringify({
          sku, name, category: $('pm-category').value.trim() || null,
          price_bdt: sanitizedPrice, stock: sanitizedStock,
          image_url: $('pm-image').value.trim() || null,
        }),
      });
    } else {
      await api('/api/products', {
        method: 'POST',
        body: JSON.stringify({
          sku, name, category: $('pm-category').value.trim() || null,
          price_bdt: sanitizedPrice, stock: sanitizedStock,
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
  const snippet = `<script src="${location.origin}/widget.js?v=20261006w" data-client="${w.widget_key || ''}"></script>`;
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

// ---------------- PWA: install, updates, push ----------------
let _deferredInstall = null;
function initPwa() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _deferredInstall = e;
    document.querySelectorAll('.pwa-install-btn').forEach(b => b.classList.remove('hidden'));
  });
  window.addEventListener('appinstalled', () => {
    _deferredInstall = null;
    document.querySelectorAll('.pwa-install-btn').forEach(b => b.classList.add('hidden'));
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // update check on visibility return — new features reach the app fast
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
    }).catch(() => {});
    // a new SW took over → tell the user the app just updated
    let _refreshed = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (_refreshed) return; _refreshed = true;
      toast('App updated to the latest version ✓');
    });
  }
}
function promptInstall() {
  location.href = '/install';
}
// Web Push subscription (per login) — powers admin + new-message notifications.
async function vapidKey() {
  const r = await api('/api/push/vapid-key').catch(() => ({}));
  return r && r.key;
}
function b64ToU8(b64) {
  const p = '='.repeat((4 - b64.length % 4) % 4);
  const bin = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function ensurePushSubscribed() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (Notification.permission === 'denied') return;
    if (Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch {}
    }
    if (Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const key = await vapidKey();
      if (!key) return;
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(key) });
    }
    const j = sub.toJSON();
    await api('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }),
    });
  } catch {}
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
  const featRows = CLIENT_FEATURES.map(f => {
    const on = (a.features || []).includes(f.key);
    return `<div class="mrow" style="cursor:default;">
      <span class="mrow-ic" style="color:${on ? 'var(--ok)' : 'var(--muted)'};">${on ? '✓' : '○'}</span>
      <span class="mrow-tx"><b>${esc(f.label)}</b><small>${esc(f.desc)}</small></span>
      <span class="pill ${on ? 'green' : ''}">${on ? 'Included' : 'Not included'}</span>
    </div>`;
  }).join('');
  const creditLine = lic && lic.kind === 'credit'
    ? `<div class="kv"><span>AI credits</span><b>${lic.credits_used} / ${lic.credits_total} used</b></div>
       <div class="meter" style="margin:6px 0 12px;"><div class="meter-fill" style="width:${Math.min(100, Math.round(lic.credits_used / Math.max(1, lic.credits_total) * 100))}%;"></div></div>` : '';
  const featCreditLine = lic && lic.kind === 'feature' && lic.feature_grants
    ? lic.feature_grants.map(g => `<div class="kv"><span>${esc((CLIENT_FEATURES.find(f => f.key === g.feature) || {}).label || g.feature)}</span><b>${g.mode === 'unlimited' ? 'Unlimited' : g.credits_used + ' / ' + g.credits_total + ' used'}</b></div>`).join('') : '';
  card.innerHTML = `
    <div class="ttl" style="font-size:17px; margin-bottom:4px;">My Plan</div>
    <p class="muted small" style="margin-bottom:14px;">What your workspace is licensed for — synced live with the platform.</p>
    <div class="kv"><span>Status</span><b>${esc(modeLabel)}</b></div>
    ${lic ? `<div class="kv"><span>Plan</span><b>${esc(lic.plan_name || lic.kind)}</b></div>
    <div class="kv"><span>License code</span><code>${esc(lic.code)}</code></div>
    ${lic.kind === 'time' && lic.ends_at ? `<div class="kv"><span>Renews / expires</span><b>${esc(fmtDate(lic.ends_at))}</b></div>` : ''}` : ''}
    ${a.aiPaused ? `<div class="notice warn" style="margin:10px 0;">AI replies are paused by the platform admin. Your inbox keeps working.</div>` : ''}
    ${creditLine}${featCreditLine}
    <hr style="margin:16px 0; border:none; border-top:1px solid var(--line);">
    <div class="ttl" style="margin-bottom:8px;">Features</div>
    ${featRows}
    <p class="muted small" style="margin-top:12px;">Need more? Contact the platform admin to upgrade your license.</p>`;
}
// ---------------- client: API keys ----------------
async function renderApiKeysTab() {
  const card = $('apikeys-card');
  if (!hasFeature('api_access')) {
    card.innerHTML = `<div class="card small muted">API access is not included in your plan.</div>`;
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
          <div class="ca-head">Comment automation <span class="ca-sub">comment → AI reply → DM → lead</span></div>
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
            <textarea id="ca-rules" rows="3" placeholder="দাম, price => দাম জানতে ইনবক্স চেক করুন"></textarea>
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
      btn.textContent = 'Saved ✓';
    } catch (e) {
      btn.textContent = 'Save failed';
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
        ${c.reply_text ? `<div class="ca-r">↳ ${esc(c.reply_text.slice(0, 140))}${c.dm_sent ? ' <span class="ca-dm">+DM sent</span>' : ''}</div>` : '<div class="ca-r ca-skip">↳ skipped</div>'}
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
  const [ov, workspaces, resources] = await Promise.all([
    api('/api/admin/overview'), api('/api/admin/workspaces'), api('/api/admin/resources'),
  ]);
  const stats = [
    ['Workspaces', ov.workspaces, ''],
    ['Channels', ov.channels, ''],
    ['Connected', ov.connected, 'green'],
    ['Errored', ov.errored, 'red'],
  ];
  $('admin-stats').innerHTML = stats.map(([l, v, cls]) =>
    `<div class="hstat"><div class="lbl">${l}</div><div class="num ${cls}">${v}</div></div>`).join('');
  renderWorkspaces(workspaces);
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
function renderWorkspaces(workspaces) {
  // Unified workspace cards: license + AI pause + suspend + login toggle,
  // everything about one workspace in one place.
  const grid = $('users-grid');
  grid.innerHTML = workspaces.map(w => {
    const nm = w.client_name || w.username;
    const hue = avatarHue(nm);
    const lic = w.license;
    const licPill = !lic ? '<span class="pill">No license</span>'
      : `<span class="pill ${lic.status === 'active' ? 'green' : lic.status === 'paused' ? 'amber' : 'red'}">${esc(lic.code)}</span>`;
    const aiPill = w.suspended ? '<span class="pill red">Suspended</span>'
      : w.ai_paused ? '<span class="pill amber">AI paused</span>'
      : w.ai_allowed ? '<span class="pill green">AI on</span>' : '<span class="pill amber">AI off</span>';
    const licLine = !lic ? '<span class="muted">Legacy — full access, no license issued</span>'
      : `<code>${esc(lic.code)}</code><span class="muted">${esc(lic.plan_name || KIND_LABEL[lic.kind] || lic.kind)}${lic.kind === 'time' && lic.ends_at ? ' · until ' + esc(fmtDate(lic.ends_at)) : ''}${lic.kind === 'credit' ? ' · ' + lic.credits_used + '/' + lic.credits_total + ' credits' : ''}</span>`;
    const delAt = w.delete_scheduled_at ? new Date(w.delete_scheduled_at) : null;
    const delDays = delAt ? Math.max(0, Math.ceil((delAt - Date.now()) / 86400000)) : 0;
    const delBanner = delAt ? `<div class="ws-del-banner">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
      <span><b>Permanent deletion in ${delDays} day${delDays === 1 ? '' : 's'}</b><small>Workspace is off. All data will be wiped.</small></span>
      <button class="btn-soft" data-wsundel="${w.client_id}">Cancel deletion</button>
    </div>` : '';
    const budget = w.ai_budget;
    const budgetText = budget ? `${budget.used}/${budget.cap} AI replies today` : '—';
    const budgetCtl = budget ? `<div class="ws-ctl">
          <div><b>AI budget</b><small>${esc(budgetText)} — caps daily AI spend</small></div>
          <div class="spacer"></div>
          <button class="btn-soft" data-wsbudget="${w.client_id}" data-cap="${budget.cap}">Edit</button>
        </div>` : '';
    return `<div class="ws-card fade-in ${w.suspended ? 'suspended' : ''}">
      ${delBanner}
      <div class="ws-top">
        <span class="ws-avatar" style="background:linear-gradient(135deg,hsl(${hue},65%,55%),hsl(${(hue + 40) % 360},65%,45%));">${esc(avatarInitials(nm))}</span>
        <div style="min-width:0;flex:1;">
          <div class="ws-name">${esc(nm)}</div>
          <div class="ws-sub">@${esc(w.username)} · workspace #${w.client_id || '—'}</div>
        </div>
      </div>
      <div class="ws-pills">${licPill}${aiPill}${w.active ? '' : '<span class="pill red">LOGIN OFF</span>'}</div>
      <div class="ws-lic">${licLine}</div>
      <div class="ws-controls">
        <div class="ws-ctl">
          <div><b>AI replies</b><small>${w.ai_paused ? 'Paused — inbox still works' : 'AI answers customers'}</small></div>
          <div class="spacer"></div>
          <label class="switch" title="Pause AI for this workspace"><input type="checkbox" data-wsai="${w.client_id}" ${w.ai_paused ? 'checked' : ''} ${w.suspended ? 'disabled' : ''}><span class="sl"></span></label>
        </div>
        ${budgetCtl}
        <div class="ws-ctl">
          <div><b>Workspace</b><small>${w.suspended ? 'Switched OFF — logins blocked' : 'Running normally'}</small></div>
          <div class="spacer"></div>
          <label class="switch" title="Switch workspace off/on"><input type="checkbox" data-wssus="${w.client_id}" ${w.suspended ? '' : 'checked'}><span class="sl"></span></label>
        </div>
        <div class="ws-ctl">
          <div><b>User login</b><small>${w.active ? 'Can sign in' : 'Sign-in disabled'}</small></div>
          <div class="spacer"></div>
          <label class="switch" title="Enable/disable login"><input type="checkbox" data-wsuser="${w.id}" ${w.active ? 'checked' : ''}><span class="sl"></span></label>
        </div>
      </div>
      <div class="ws-actions">
        <button class="btn-soft" data-wsassign="${w.client_id}">Assign license</button>
        <button class="btn-soft" data-wspw="${w.id}">Reset password</button>
        ${delAt ? '' : `<button class="btn-soft danger" data-wsdel="${w.client_id}">Delete</button>`}
      </div>
    </div>`;
  }).join('') || '<div class="card"><p class="muted">No workspaces yet.</p></div>';
  document.querySelectorAll('[data-wsai]').forEach(t => t.onchange = async () => {
    try {
      await api(`/api/admin/clients/${t.dataset.wsai}/ai-pause`, { method: 'POST', body: JSON.stringify({ paused: t.checked }) });
      toast(t.checked ? 'AI paused — inbox keeps working' : 'AI resumed');
      loadAdmin();
    } catch (e) { toast('Failed: ' + e.message, 'err'); loadAdmin(); }
  });
  document.querySelectorAll('[data-wssus]').forEach(t => t.onchange = async () => {
    const turnOff = !t.checked;
    if (turnOff && !confirm('Switch this workspace OFF? Its users will be signed out immediately and the widget, API and AI stop working. Data is kept.')) { t.checked = true; return; }
    try {
      await api(`/api/admin/clients/${t.dataset.wssus}/suspend`, { method: 'POST', body: JSON.stringify({ suspended: turnOff }) });
      toast(turnOff ? 'Workspace switched OFF' : 'Workspace switched ON');
      loadAdmin();
    } catch (e) { toast('Failed: ' + e.message, 'err'); loadAdmin(); }
  });
  document.querySelectorAll('[data-wsuser]').forEach(t => t.onchange = async () => {
    try { await api(`/api/admin/users/${t.dataset.wsuser}/toggle`, { method: 'POST' }); loadAdmin(); }
    catch (e) { toast('Failed: ' + e.message, 'err'); loadAdmin(); }
  });
  document.querySelectorAll('[data-wsbudget]').forEach(b => b.onclick = async () => {
    const cur = b.dataset.cap;
    const v = prompt(`Daily AI reply budget for this workspace (used to cap AI spend):`, cur);
    if (v === null) return;
    const cap = Math.floor(Number(v));
    if (!Number.isFinite(cap) || cap < 0 || cap > 100000) { toast('Enter a number 0–100000', 'err'); return; }
    try {
      await api(`/api/admin/clients/${b.dataset.wsbudget}/ai-budget`, { method: 'PUT', body: JSON.stringify({ cap }) });
      toast(`AI budget set to ${cap}/day`);
      loadAdmin();
    } catch (e) { toast('Failed: ' + e.message, 'err'); }
  });
  document.querySelectorAll('[data-wsassign]').forEach(b => b.onclick = () => openAssignModal(Number(b.dataset.wsassign), workspaces));
  document.querySelectorAll('[data-wspw]').forEach(b => b.onclick = () => {
    state.pwUserId = Number(b.dataset.wspw);
    const w = workspaces.find(x => x.id === state.pwUserId);
    $('pw-sub').textContent = `Set a new password for @${w ? w.username : ''}.`;
    $('pw-new').value = '';
    $('pw-modal').classList.remove('hidden');
  });
  document.querySelectorAll('[data-wsdel]').forEach(b => b.onclick = async () => {
    const w = workspaces.find(x => x.client_id === Number(b.dataset.wsdel));
    const name = w ? (w.client_name || w.username) : ('#' + b.dataset.wsdel);
    if (!confirm(`Delete workspace "${name}"?\n\nIt switches OFF immediately and is permanently wiped after 15 days. You can cancel anytime during the wait.`)) return;
    if (!confirm(`Last check — really queue "${name}" for deletion?`)) return;
    try {
      await api(`/api/admin/clients/${b.dataset.wsdel}/delete-schedule`, { method: 'POST' });
      toast('Deletion scheduled — 15 day grace period');
      loadAdmin();
    } catch (e) { toast('Failed: ' + e.message, 'err'); }
  });
  document.querySelectorAll('[data-wsundel]').forEach(b => b.onclick = async () => {
    if (!confirm('Cancel the scheduled deletion? The workspace will be switched back ON.')) return;
    try {
      await api(`/api/admin/clients/${b.dataset.wsundel}/delete-cancel`, { method: 'POST' });
      toast('Deletion cancelled — workspace restored');
      loadAdmin();
    } catch (e) { toast('Failed: ' + e.message, 'err'); }
  });
}
function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return iso; }
}

function switchAdminTab(tab) {
  state.adminTab = tab;
  document.querySelectorAll('#admin-tabs button').forEach(b => b.classList.toggle('active', b.dataset.at === tab));
  $('atab-resources').classList.toggle('hidden', tab !== 'resources');
  $('atab-users').classList.toggle('hidden', tab !== 'users');
  $('atab-licensing').classList.toggle('hidden', tab !== 'licensing');
  $('atab-config').classList.toggle('hidden', tab !== 'config');
  $('atab-notify').classList.toggle('hidden', tab !== 'notify');
  $('atab-audit').classList.toggle('hidden', tab !== 'audit');
  if (tab === 'config') loadAdminConfig();
  if (tab === 'notify') loadNotifyTab();
  if (tab === 'audit') loadAdminAudit();
  if (tab === 'licensing') loadAdminLicensing();
}

// ---------------- admin: plans & licenses (simple) ----------------
let _licFeatures = null;
async function licFeatureList() {
  if (!_licFeatures) _licFeatures = await api('/api/admin/features');
  return _licFeatures;
}
const KIND_LABEL = { time: 'Package', credit: 'Credit System', feature: 'Feature Based' };
const PERIOD_LABEL = { monthly: 'Monthly', quarterly: '3-Monthly', yearly: 'Yearly' };
let _createMode = 'package';   // 'package' | 'credit'
let _createPeriod = 'monthly';

async function loadAdminLicensing() {
  const [features, plans, licenses, workspaces] = await Promise.all([
    licFeatureList(), api('/api/admin/plans'), api('/api/admin/licenses'), api('/api/admin/workspaces').catch(() => []),
  ]);
  const wsSel = $('crt-workspace');
  if (wsSel) {
    const curVal = wsSel.value;
    wsSel.innerHTML = '<option value="">Save as plan template only</option>' +
      (workspaces || []).map(w => `<option value="${w.client_id || w.id}">Issue to: ${esc(w.client_name || w.username || ('#' + (w.client_id || w.id)))}</option>`).join('');
    if (curVal) wsSel.value = curVal;
  }
  renderCreateSection(features);
  renderPlanCards(plans);
  renderLicensesTable(licenses);
}
function featureCheckGrid(elId, features, checked) {
  $(elId).innerHTML = (features || []).map(f => {
    const k = f.key || f.id || '';
    const l = f.label || f.name || k;
    const d = f.desc || f.description || '';
    return `<label class="check"><input type="checkbox" value="${esc(k)}" ${checked ? 'checked' : ''}>
      <span><b>${esc(l)}</b><small>${esc(d)}</small></span></label>`;
  }).join('');
}
function checkedFeatures(elId) {
  return [...document.querySelectorAll(`#${elId} input:checked`)].map(i => i.value);
}
function planKindMeta(p) {
  if (p.kind === 'time') return PERIOD_LABEL[p.billing_period] || 'Monthly';
  if (p.kind === 'credit') return `${p.credits_included} credits`;
  return 'Per-feature';
}
// --- single Create: Package | Credit System toggle, form adapts ---
function renderCreateSection(features) {
  featureCheckGrid('crt-features', features, true);
  document.querySelectorAll('#crt-mode .mode-opt').forEach(b => b.onclick = () => {
    _createMode = b.dataset.mode;
    document.querySelectorAll('#crt-mode .mode-opt').forEach(x => x.classList.toggle('sel', x === b));
    $('crt-period-row').classList.toggle('hidden', _createMode !== 'package');
    $('crt-credits-row').classList.toggle('hidden', _createMode !== 'credit');
  });
  document.querySelectorAll('#crt-period-chips .chip').forEach(b => b.onclick = () => {
    _createPeriod = b.dataset.p;
    document.querySelectorAll('#crt-period-chips .chip').forEach(x => x.classList.toggle('sel', x === b));
  });
  $('crt-msg').textContent = '';
  $('btn-create').onclick = async () => {
    const name = $('crt-name').value.trim();
    if (!name) { $('crt-msg').textContent = 'Give it a name first.'; return; }
    const targetWs = $('crt-workspace') ? $('crt-workspace').value : '';
    const body = _createMode === 'package'
      ? { name, kind: 'time', billing_period: _createPeriod, features: checkedFeatures('crt-features'), price_bdt: Number($('crt-price').value) || 0 }
      : { name, kind: 'credit', credits_included: Math.max(1, Number($('crt-credits').value) || 0), features: checkedFeatures('crt-features'), price_bdt: Number($('crt-price').value) || 0 };
    if (_createMode === 'credit' && !(Number($('crt-credits').value) > 0)) { $('crt-msg').textContent = 'Enter how many credits.'; return; }
    $('crt-msg').textContent = 'Creating…';
    try {
      const plan = await api('/api/admin/plans', { method: 'POST', body: JSON.stringify(body) });
      if (targetWs) {
        const lic = await api(`/api/admin/clients/${targetWs}/assign-license`, { method: 'POST', body: JSON.stringify({ planId: plan.id }) });
        toast(`License issued: ${lic.code} to workspace!`, 'ok');
      } else {
        toast(`Plan "${plan.name}" created!`, 'ok');
      }
      $('crt-name').value = ''; $('crt-credits').value = ''; $('crt-price').value = '';
      $('crt-msg').textContent = '';
      await loadAdminLicensing();
      loadAdmin();
    } catch (e) { $('crt-msg').textContent = 'Failed: ' + e.message; }
  };
}
// --- existing plans ---
function renderPlanCards(plans) {
  $('plans-grid').innerHTML = plans.map(p => `
    <div class="plan-card">
      <div class="pn">${esc(p.name)}</div>
      <div class="prow"><span class="pill blue">${esc(KIND_LABEL[p.kind] || p.kind)}</span>
        <span class="pill">${esc(planKindMeta(p))}</span>${p.active ? '' : '<span class="pill red">OFF</span>'}</div>
      <div class="pmeta">${(p.features || []).length} features${p.price_bdt ? ' · ৳' + esc(String(p.price_bdt)) : ''}</div>
      <button class="btn-soft danger pdel" data-plandel="${p.id}">Delete plan</button>
    </div>`).join('') || '<div class="card"><p class="muted">No plans yet — create one above.</p></div>';
  document.querySelectorAll('[data-plandel]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this plan? Issued licenses keep working.')) return;
    try { await api(`/api/admin/plans/${b.dataset.plandel}`, { method: 'DELETE' }); loadAdminLicensing(); }
    catch (e) { toast('Failed: ' + e.message, 'err'); }
  });
}
// --- assign license from a workspace card ---
async function openAssignModal(clientId, workspaces) {
  const w = workspaces.find(x => x.client_id === clientId);
  const nm = w ? (w.client_name || w.username) : ('#' + clientId);
  $('assign-sub').textContent = `Pick a plan for "${nm}". It becomes the workspace's license right away.`;
  const cur = w && w.license
    ? `<div class="ws-lic"><code>${esc(w.license.code)}</code><span class="muted">${esc(w.license.plan_name || '')} · ${esc(w.license.status)}</span></div>`
    : '<div class="ws-lic"><span class="muted">No license yet</span></div>';
  $('assign-current').innerHTML = cur;
  let plans = [];
  try { plans = (await api('/api/admin/plans')).filter(p => p.active); }
  catch (e) { toast('Failed to load plans: ' + e.message, 'err'); return; }
  $('assign-plans').innerHTML = plans.map(p => `
    <div class="plan-card" style="margin-bottom:10px;">
      <div class="pn">${esc(p.name)}</div>
      <div class="prow"><span class="pill blue">${esc(KIND_LABEL[p.kind] || p.kind)}</span>
        <span class="pill">${esc(planKindMeta(p))}</span></div>
      <div class="pmeta">${(p.features || []).length} features${p.price_bdt ? ' · ৳' + esc(String(p.price_bdt)) : ''}</div>
      <button class="btn-primary btn-soft-assign" data-assign="${p.id}" style="width:100%;">Assign this plan</button>
    </div>`).join('') || '<p class="muted">No plans yet — create one in Plans & licenses.</p>';
  document.querySelectorAll('[data-assign]').forEach(b => b.onclick = async () => {
    const p = plans.find(x => x.id === Number(b.dataset.assign));
    if (!confirm(`Assign "${p ? p.name : ''}" to "${nm}"?` + (w && w.license ? '\nThe current license will be retired.' : ''))) return;
    try {
      const lic = await api(`/api/admin/clients/${clientId}/assign-license`, { method: 'POST', body: JSON.stringify({ planId: b.dataset.assign }) });
      $('assign-modal').classList.add('hidden');
      toast('Assigned: ' + lic.code);
      loadAdmin();
    } catch (e) { toast('Failed: ' + e.message, 'err'); }
  });
  $('assign-modal').classList.remove('hidden');
}
// --- licenses table ---
function licenseValidity(l) {
  if (l.kind === 'time') {
    if (!l.ends_at) return '—';
    const left = Math.max(0, Math.ceil((new Date(l.ends_at) - Date.now()) / 86400000));
    return `until ${fmtDate(l.ends_at)} · ${left}d left`;
  }
  if (l.kind === 'credit') return `${l.credits_used}/${l.credits_total} used`;
  return (l.feature_grants || []).map(g =>
    `${esc(g.feature)}: ${g.mode === 'unlimited' ? '∞' : g.credits_used + '/' + g.credits_total}`).join('<br>') || '—';
}
function renderLicensesTable(licenses) {
  const pill = (s) => `<span class="pill ${s === 'active' ? 'green' : s === 'paused' ? 'amber' : 'red'}">${esc(s.toUpperCase())}</span>`;
  $('licenses-body').innerHTML = licenses.map(l => `
    <tr>
      <td data-label="Code"><b style="color:var(--ink); font-family:monospace;">${esc(l.code)}</b></td>
      <td data-label="Workspace" class="muted">#${l.client_id} · ${esc(l.client_name || '—')}</td>
      <td data-label="Plan" class="muted">${esc(l.plan_name || 'Custom')} <span class="pill blue" style="font-size:10px;">${esc(KIND_LABEL[l.kind] || l.kind)}</span></td>
      <td data-label="Validity / Credits" class="small muted">${licenseValidity(l)}</td>
      <td data-label="Status">${pill(l.status)}</td>
      <td data-label=""><div style="display:flex; gap:6px; flex-wrap:wrap;">
        ${l.status === 'active' ? `<button class="btn-soft" data-licpause="${l.id}">Pause</button>` : ''}
        ${l.status === 'paused' ? `<button class="btn-soft" data-licresume="${l.id}">Resume</button>` : ''}
        ${l.kind !== 'time' ? `<button class="btn-soft" data-lictopup="${l.id}">+ Credits</button>` : ''}
        ${['active', 'paused'].includes(l.status) ? `<button class="btn-soft danger" data-liccancel="${l.id}">Cancel</button>` : ''}
      </div></td>
    </tr>`).join('') || '<tr><td colspan="6" class="tbl-empty">No licenses issued yet.</td></tr>';
  document.querySelectorAll('[data-licpause]').forEach(b => b.onclick = () => licAction(b.dataset.licpause, 'pause'));
  document.querySelectorAll('[data-licresume]').forEach(b => b.onclick = () => licAction(b.dataset.licresume, 'resume'));
  document.querySelectorAll('[data-liccancel]').forEach(b => b.onclick = async () => {
    if (!confirm('Cancel this license? The workspace loses its licensed features.')) return;
    licAction(b.dataset.liccancel, 'cancel');
  });
  document.querySelectorAll('[data-lictopup]').forEach(b => b.onclick = async () => {
    const n = prompt('Add how many credits?');
    if (!n || !(Number(n) > 0)) return;
    try { await api(`/api/admin/licenses/${b.dataset.lictopup}/topup`, { method: 'POST', body: JSON.stringify({ credits: Number(n) }) }); loadAdminLicensing(); }
    catch (e) { toast('Failed: ' + e.message, 'err'); }
  });
}
async function licAction(id, action) {
  try { await api(`/api/admin/licenses/${id}/${action}`, { method: 'POST' }); loadAdminLicensing(); }
  catch (e) { toast('Failed: ' + e.message, 'err'); }
}
async function loadNotifyTab() {
  const sel = $('nt-target');
  sel.innerHTML = '<option value="all">All workspaces</option>';
  try {
    const users = await api('/api/admin/users');
    const seen = {};
    (users.users || users || []).forEach(u => {
      const cid = u.client_id || u.clientId;
      if (isAdmin(u.role) || !cid || seen[cid]) return;
      seen[cid] = 1;
      const o = document.createElement('option');
      o.value = cid; o.textContent = 'Workspace #' + cid + ' (' + (u.username || '') + ')';
      sel.appendChild(o);
    });
  } catch {}
  $('btn-send-notif').onclick = async () => {
    const body = $('nt-body').value.trim();
    if (!body) { $('nt-status').textContent = 'Write a message first.'; return; }
    $('btn-send-notif').disabled = true;
    try {
      const target = $('nt-target').value;
      const r = await api('/api/admin/notify', { method: 'POST',
        body: JSON.stringify({ target: target === 'all' ? 'all' : undefined,
          client_id: target === 'all' ? undefined : +target,
          title: $('nt-title').value.trim() || 'Tectobox', body }) });
      $('nt-status').textContent = r && r.ok ? `Sent to ${r.sent} device(s).` : 'Send failed.';
      if (r && r.ok) $('nt-body').value = '';
    } catch (e) { $('nt-status').textContent = 'Send failed: ' + (e.message || ''); }
    $('btn-send-notif').disabled = false;
  };
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
  loadTotpBox();
}
// ---- admin two-factor (TOTP) ----
async function loadTotpBox() {
  const box = $('totp-box');
  if (!box) return;
  let st = {};
  try { st = await api('/api/admin/totp/status'); } catch { box.innerHTML = '<div class="muted small">Could not load 2FA status.</div>'; return; }
  if (st.enabled) {
    box.innerHTML = `
      <div class="kv"><span class="k"><b style="color:var(--ink);">Two-factor is ON</b><br><span class="small">Login requires your authenticator code.</span></span>
      <span class="pill pill-on">Enabled</span></div>
      <div class="frow mt16"><label>Current password <span class="muted small">(to disable 2FA)</span></label>
      <input id="totp-disable-pw" class="input no-icon" type="password" autocomplete="current-password"></div>
      <button class="btn-ghost" id="btn-totp-disable">Disable two-factor</button>
      <div id="totp-msg" class="small muted mt8"></div>`;
    $('btn-totp-disable').onclick = async () => {
      const pw = $('totp-disable-pw').value;
      if (!pw) { $('totp-msg').textContent = 'Enter your password first.'; return; }
      try {
        await api('/api/admin/totp/disable', { method: 'POST', body: JSON.stringify({ password: pw }) });
        toast('Two-factor disabled', 'ok'); loadTotpBox();
      } catch (e) { $('totp-msg').textContent = 'Failed: ' + e.message; }
    };
    return;
  }
  box.innerHTML = `
    <div class="kv"><span class="k"><b style="color:var(--ink);">Two-factor is OFF</b><br><span class="small">Add an extra login step for this admin account.</span></span>
    <span class="pill">Disabled</span></div>
    <div class="frow mt16"><label>Current password <span class="muted small">(to start setup)</span></label>
    <input id="totp-setup-pw" class="input no-icon" type="password" autocomplete="current-password"></div>
    <button class="btn-primary mt16" id="btn-totp-setup">Set up two-factor</button>
    <div id="totp-setup-area" class="mt16"></div>
    <div id="totp-msg" class="small muted mt8"></div>`;
  $('btn-totp-setup').onclick = async () => {
    const pw = $('totp-setup-pw').value;
    if (!pw) { $('totp-msg').textContent = 'Enter your password first.'; return; }
    try {
      const s = await api('/api/admin/totp/setup', { method: 'POST', body: JSON.stringify({ password: pw }) });
      $('totp-setup-area').innerHTML = `
        <p class="small mb16">Add this key to your authenticator app (Google Authenticator, 1Password, …), then enter the 6-digit code to confirm.</p>
        <div class="code-box mb16"><span class="cl">Manual key</span>${esc(s.secret)}</div>
        <div class="frow"><label>6-digit code</label><input id="totp-confirm-code" class="input no-icon" inputmode="numeric" maxlength="6" placeholder="123456"></div>
        <button class="btn-primary" id="btn-totp-enable">Verify & enable</button>`;
      $('btn-totp-enable').onclick = async () => {
        const token = $('totp-confirm-code').value.trim();
        if (!/^\d{6}$/.test(token)) { $('totp-msg').textContent = 'Enter the 6-digit code.'; return; }
        try {
          await api('/api/admin/totp/enable', { method: 'POST', body: JSON.stringify({ token }) });
          toast('Two-factor enabled', 'ok'); loadTotpBox();
        } catch (e) { $('totp-msg').textContent = 'Failed: ' + e.message; }
      };
    } catch (e) { $('totp-msg').textContent = 'Setup failed: ' + e.message; }
  };
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
        if (!evt.outbound) {
          playInboundChime();
        }
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
      } else if (evt.type === 'payment:received') {
        playPaymentChime();
        updatePaymentBadge((state.pendingPaymentsCount || 0) + 1);
        const p = evt.payment || {};
        toast(`New payment claim: ${(p.method || 'bKash').toUpperCase()} ৳${p.amount || 0} (TrxID: ${p.transaction_id || ''})`, 'ok');
        if (state.paymentsModalOpen) {
          loadPayments();
          loadPaymentStats();
        }
      } else if (evt.type === 'payment:updated') {
        loadPaymentStats();
        if (state.paymentsModalOpen) {
          loadPayments();
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
      } else if (evt.type === 'access_changed') {
        // License/access sync: the admin just changed what a workspace may
        // do (license assigned/paused/cancelled, AI paused, suspended…).
        // Only the affected workspace's own client acts on it — the admin
        // panel has its own refresh and must never self-logout from this.
        const isAdm = !state.me || isAdmin(state.me.role);
        const notOurs = evt.clientId != null && String(evt.clientId) !== String(state.clientId);
        if (!isAdm && !notOurs) {
          try {
            if (evt.access) state.access = evt.access;
            else state.access = await api('/api/client/access');
          } catch { try { state.access = await api('/api/client/access'); } catch {} }
          if (state.access && state.access.suspended) {
            // Workspace switched off: the session is dead server-side too.
            toast('This workspace has been suspended by the platform admin.', 'err');
            try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
            location.href = '/app';
            return;
          }
          applyAccessGating();
          toast('Your plan was updated — features refreshed.', '');
        }
      } else if (evt.type === 'broadcast_progress') {
        if (state.view === 'broadcast') renderBroadcast();
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
      const r = await fetch('/api/captcha');
      const c = await r.json();
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
        throw new Error(data.error || 'Login failed');
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
      try { const r = await fetch('/api/auth/logout', { method: 'POST' }); ok = r.ok; }
      catch {}
    }
    if (!ok) { toast('Logout failed — check connection and try again', 'err'); return; }
    showLogin();
  };
  $('btn-refresh').onclick = () => { if (state.view === 'admin') loadAdmin(); };
  
  const btnCourierConfig = $('btn-open-courier-config');
  if (btnCourierConfig) btnCourierConfig.onclick = openCourierConfigModal;
  const btnRefOrders = $('btn-refresh-orders');
  if (btnRefOrders) btnRefOrders.onclick = loadOrdersPage;
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
    var _sw = $('sw-theme'); if (_sw) _sw.checked = (next === 'dark');
  };
  $('btn-theme').onclick = toggleTheme;
  const btnThemeM = $('btn-theme-mobile');
  if (btnThemeM) btnThemeM.onclick = toggleTheme;
  const btnSignoutM = $('btn-signout-mobile');
  if (btnSignoutM) btnSignoutM.onclick = () => $('btn-signout')?.click();
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
  $('btn-search').onclick = (e) => { e.stopPropagation(); _se.classList.add('open'); $('btn-search-close').classList.remove('hidden'); setTimeout(() => $('conv-search').focus(), 60); };
  window.collapseSearch = () => {
    if (!_se.classList.contains('open')) return;
    _se.classList.remove('open'); $('btn-search-close').classList.add('hidden');
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
  $('btn-close-qr').onclick = () => { if (state.qrClose) state.qrClose(); else { state.qrChannel = null; state.qrSlot = null; $('qr-modal').classList.add('hidden'); } };

  // admin
  document.querySelectorAll('#admin-tabs button').forEach(b => b.onclick = () => switchAdminTab(b.dataset.at));
  $('btn-create-user').onclick = () => {
    $('um-username').value = ''; $('um-password').value = ''; $('um-workspace').value = ''; $('um-type').value = 'physical';
    const errEl = $('um-err'); if (errEl) { errEl.textContent = ''; errEl.classList.remove('show'); }
    $('user-modal').classList.remove('hidden');
  };
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
      const res = await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ username, password, workspaceName, businessType: $('um-type').value }) });
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
    if (!password || password.length < 4) return toast('Password must be at least 4 characters', 'err');
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
  boot();
});

function initSidebarCollapse() {
  const sidebar = $('app-sidebar');
  const toggleBtn = $('btn-sidebar-collapse');
  const resizer = $('sidebar-resizer');
  if (!sidebar) return;

  function setCollapsed(collapsed) {
    sidebar.classList.toggle('collapsed', collapsed);
    if (toggleBtn) {
      toggleBtn.title = collapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)';
      const arrow = toggleBtn.querySelector('.sidebar-toggle-arrow');
      if (arrow) arrow.setAttribute('d', collapsed ? 'M10 9l3 3-3 3' : 'M14 9l-3 3 3 3');
    }
    try {
      localStorage.setItem('tectobox_sidebar_collapsed', collapsed ? '1' : '0');
    } catch (e) {}
  }

  // Restore saved state
  try {
    const isSavedCollapsed = localStorage.getItem('tectobox_sidebar_collapsed') === '1';
    if (isSavedCollapsed) {
      setCollapsed(true);
    }
  } catch (e) {}

  if (toggleBtn) {
    toggleBtn.onclick = (e) => {
      e.stopPropagation();
      setCollapsed(!sidebar.classList.contains('collapsed'));
    };
  }

  // Clicking brand in collapsed mode expands it
  const brand = $('sidebar-brand-click');
  if (brand) {
    brand.onclick = () => {
      if (sidebar.classList.contains('collapsed')) {
        setCollapsed(false);
      }
    };
  }

  // Keyboard shortcut Ctrl+B / Cmd+B
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      if (activeTag !== 'INPUT' && activeTag !== 'TEXTAREA') {
        e.preventDefault();
        setCollapsed(!sidebar.classList.contains('collapsed'));
      }
    }
  });

  // Resizer dragging logic for "ছোট করা যাবে, বড় করা যাবে"
  if (resizer) {
    let isDragging = false;
    let startX = 0;
    let startWidth = 250;

    resizer.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startWidth = sidebar.getBoundingClientRect().width;
      sidebar.classList.add('is-resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const delta = e.clientX - startX;
      let newWidth = startWidth + delta;
      if (newWidth < 120) {
        setCollapsed(true);
      } else {
        if (sidebar.classList.contains('collapsed')) {
          setCollapsed(false);
        }
        if (newWidth > 420) newWidth = 420;
        if (newWidth < 180) newWidth = 180;
        sidebar.style.setProperty('--sidebar-width', `${newWidth}px`);
      }
    });

    window.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      sidebar.classList.remove('is-resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (!sidebar.classList.contains('collapsed')) {
        try {
          const curW = sidebar.getBoundingClientRect().width;
          localStorage.setItem('tectobox_sidebar_width', `${Math.round(curW)}px`);
        } catch (e) {}
      }
    });

    // Double-click resizer to toggle collapse
    resizer.addEventListener('dblclick', () => {
      setCollapsed(!sidebar.classList.contains('collapsed'));
    });
  }

  // Restore saved width if not collapsed
  try {
    const savedWidth = localStorage.getItem('tectobox_sidebar_width');
    const isSavedCollapsed = localStorage.getItem('tectobox_sidebar_collapsed') === '1';
    if (savedWidth && !isSavedCollapsed) {
      sidebar.style.setProperty('--sidebar-width', savedWidth);
    }
  } catch (e) {}
}

// ---------------- guide / documentation ----------------
const GUIDES = [
  {
    id: 'start', icon: 'zap', title: 'Your first 5 minutes',
    sub: 'Do these 3 things and Tectobox starts working for you',
    steps: [
      { t: 'Connect WhatsApp', d: 'Go to Connect Channels → WhatsApp → Add account, then scan the QR code with your business phone. New chats will appear in your Inbox automatically.', img: '/img/guide-connect.png?v=20261006c', go: ['Connect WhatsApp', () => gotoSettings('channels')] },
      { t: 'Add your products', d: 'Go to My Products → Add product. Enter the name, price and a short description. The AI uses this to answer "how much?" questions.', img: '/img/guide-products.png?v=20261006c', go: ['Add a product', () => showView('products')] },
      { t: 'Teach the AI', d: 'Go to Teach the AI → add your delivery rules, payment methods and common answers. Anything you write here, the AI will know.', img: '/img/guide-teach.png?v=20261006c', go: ['Teach the AI', () => gotoSettings('kb')] },
    ]
  },
  {
    id: 'inbox', icon: 'inbox', title: 'Replying to chats',
    sub: 'Every customer message lands here',
    steps: [
      { t: 'Open the Inbox tab', d: 'Newest conversations are on top. The colored dot shows the channel — green WhatsApp, blue Telegram, purple website chat.', img: '/img/guide-inbox.png?v=20261006c' },
      { t: 'Tap a conversation', d: 'You see the full chat history plus the customer\'s profile on the side. Type in the box at the bottom and press send — just like any chat app.' },
      { t: 'Use the funnel to filter', d: 'Tap the funnel icon at the top to show only WhatsApp, only Telegram, or only website chats. Tap the magnifier to search any conversation.' },
      { t: 'Hand icon = needs you', d: 'When a chat needs a human, tap the hand icon at the top. The AI will stay quiet on those chats until you turn it off.' },
    ]
  },
  {
    id: 'leads', icon: 'chart', title: 'Understanding Leads',
    sub: 'Who is ready to buy?',
    steps: [
      { t: 'Open the Leads tab', d: 'Tectobox watches every chat and lists people who showed buying interest — with a score from 0 to 100.', img: '/img/guide-leads.png?v=20261006c' },
      { t: 'Read the score', d: 'Above 70 = Hot (reply now). 40–70 = Warm (follow up soon). Below 40 = Cold (let the AI nurture them).' },
      { t: 'Tap a lead', d: 'See what they want, the suggested next action, and one-tap buttons to message or call them.' },
    ]
  },
  {
    id: 'widget', icon: 'sun', title: 'Chat on your website',
    sub: 'Let visitors talk to your AI',
    steps: [
      { t: 'Open Chat Widget Style', d: 'Go to More → Chat Widget Style. Pick colors and write your greeting message.', img: '/img/guide-widget.png?v=20261006c', go: ['Open widget style', () => gotoSettings('appearance')] },
      { t: 'Copy the code', d: 'Go to Connect Channels → Webchat → Copy embed code. Paste it on your website before </body>. Done — visitors can now chat with your AI.' },
    ]
  },
];
function renderGuide() {
  $('guide-list').innerHTML = GUIDES.map(g => `
    <div class="card guide-card fade-in">
      <div class="guide-head">
        <span class="guide-ic">${ICONS[g.icon] || ''}</span>
        <div><div class="guide-title">${esc(g.title)}</div><div class="muted small">${esc(g.sub)}</div></div>
      </div>
      <div class="guide-steps">
        ${g.steps.map((s, i) => `
          <div class="guide-step">
            <span class="guide-num">${i + 1}</span>
            <div class="guide-body">
              <div class="guide-step-t">${esc(s.t)}</div>
              <div class="guide-step-d">${esc(s.d)}</div>
              ${s.img ? `<span class="guide-img-wrap"><img class="guide-img" src="${s.img}" alt="${esc(s.t)}" loading="lazy"><span class="guide-img-num">${i + 1}</span></span>` : ''}
              ${s.go ? `<button class="btn-soft guide-go" data-g="${g.id}" data-s="${i}">${esc(s.go[0])} →</button>` : ''}
            </div>
          </div>`).join('')}
      </div>
    </div>`).join('');
  document.querySelectorAll('.guide-go').forEach(b =>
    b.onclick = () => {
      const g = GUIDES.find(x => x.id === b.dataset.g);
      const fn = g && g.steps[+b.dataset.s].go && g.steps[+b.dataset.s].go[1];
      if (fn) fn();
    });
}

// ---------------- get started checklist (first-time users) ----------------
function dismissOnboarding() {
  try { localStorage.setItem('tectonic-onboard-hide', '1'); } catch {}
  $('gs-overlay').classList.add('hidden');
}
async function renderGetStarted() {
  const el = $('get-started');
  const ov = $('gs-overlay');
  // ?onboard=1 forces the popup (for testing / demo) — bypasses dismissal + completion.
  let force = false;
  try { force = new URLSearchParams(location.search).get('onboard') === '1'; } catch {}
  try { if (!force && localStorage.getItem('tectonic-onboard-hide') === '1') { ov.classList.add('hidden'); return; } } catch {}
  if (!el || (state.me && isAdmin(state.me.role))) { if (ov) ov.classList.add('hidden'); return; }
  let channels = 0, products = 0, docs = 0;
  try {
    const [st, pr, kb] = await Promise.all([
      api('/api/status').catch(() => ({})),
      api('/api/products').catch(() => []),
      api(`/api/clients/${state.clientId}/knowledge`).catch(() => []),
    ]);
    const plats = (st && st.platforms) || {};
    channels = Object.values(plats).filter(p => p && (p.status === 'connected' || (p.accounts || []).some(a => a.status === 'connected'))).length;
    products = Array.isArray(pr) ? pr.length : (pr.products || []).length;
    docs = Array.isArray(kb) ? kb.length : 0;
  } catch {}
  const steps = [
    { done: channels > 0, t: 'Connect a channel', s: channels > 0 ? 'Connected ✓' : 'Link WhatsApp or Telegram', go: () => gotoSettings('channels') },
    { done: products > 0, t: 'Add your products', s: products > 0 ? products + ' added ✓' : 'What do you sell?', go: () => showView('products') },
    { done: docs > 0, t: 'Teach the AI', s: docs > 0 ? docs + ' taught ✓' : 'Prices, policies, FAQs', go: () => gotoSettings('kb') },
  ];
  const doneCount = steps.filter(x => x.done).length;
  if (doneCount === 3 && !force) { ov.classList.add('hidden'); return; }
  ov.classList.remove('hidden');
  el.innerHTML = `
    <button class="gs-close" id="gs-close" aria-label="Close">×</button>
    <div class="gs-head">
      <div><div class="gs-title">Get started</div><div class="muted small">${doneCount} of 3 done — finish setup and you're live</div></div>
      <div class="gs-bar"><span style="width:${doneCount / 3 * 100}%"></span></div>
    </div>
    ${steps.map((x, i) => `
      <button class="gs-step ${x.done ? 'done' : ''}" data-gs="${i}">
        <span class="gs-check">${x.done ? '✓' : (i + 1)}</span>
        <span class="gs-tx"><b>${esc(x.t)}</b><small>${esc(x.s)}</small></span>
        ${x.done ? '' : '<span class="muted">→</span>'}
      </button>`).join('')}`;
  el.querySelectorAll('[data-gs]').forEach(b =>
    b.onclick = () => { const st = steps[+b.dataset.gs]; if (!st.done) { dismissOnboarding(); st.go(); } });
  $('gs-close').onclick = dismissOnboarding;
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
    const prof = await api('/api/auth/profile');
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

// ---------------- Live Payments Hub & Real-time Verification ----------------
let currentPaymentsTab = 'pending';

function updatePaymentBadge(count) {
  state.pendingPaymentsCount = Math.max(0, count);
  document.querySelectorAll('.badge-pending-count').forEach(badge => {
    if (state.pendingPaymentsCount > 0) {
      badge.textContent = state.pendingPaymentsCount > 99 ? '99+' : state.pendingPaymentsCount;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  });
}

async function loadPaymentStats() {
  try {
    const res = await api('/api/payments/stats');
    if (!res) return;
    updatePaymentBadge(res.pending || 0);
    const pEl = $('pay-stat-pending'); if (pEl) pEl.textContent = res.pending;
    const vEl = $('pay-stat-verified'); if (vEl) vEl.textContent = res.verified;
    const volEl = $('pay-stat-volume'); if (volEl) volEl.textContent = '৳' + Number(res.verified_volume_today || 0).toLocaleString();
    const dEl = $('pay-stat-duplicates'); if (dEl) dEl.textContent = res.duplicates;
    const tabCnt = $('tab-cnt-pending'); if (tabCnt) tabCnt.textContent = res.pending;
  } catch {}
}

async function loadPayments(tab = currentPaymentsTab) {
  currentPaymentsTab = tab;
  const listEl = $('payments-list');
  if (!listEl) return;
  listEl.innerHTML = '<div style="text-align:center;padding:24px;" class="muted small">Loading payments…</div>';

  try {
    const res = await api(`/api/payments?status=${tab}`);
    const payments = res.payments || [];

    if (!payments.length) {
      const emptyLabels = {
        pending: 'No pending payments waiting for verification',
        verified: 'No verified payments recorded yet.',
        rejected: 'No rejected payments.',
        all: 'No payment records found.'
      };
      listEl.innerHTML = `
        <div class="empty-state-box" style="text-align:center;padding:40px 16px;background:var(--card);border-radius:14px;border:1px dashed var(--line);">
          <div style="margin-bottom:8px;"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20"/><circle cx="7" cy="15" r="1"/></svg></div>
          <div style="font-weight:700;color:var(--ink);font-size:15px;">${emptyLabels[tab] || 'No payments'}</div>
          <p class="muted small" style="margin:4px 0 0;">Customer payments from WhatsApp, Webchat and other channels will appear here in real-time.</p>
        </div>`;
      return;
    }

    listEl.innerHTML = payments.map(p => {
      const isDup = !!p.duplicate_flag;
      const method = (p.method || 'bkash').toLowerCase();
      const timeStr = timeAgo(new Date(p.created_at).getTime());
      const custName = p.customer_name || 'Customer';
      const custPhone = p.customer_phone || '';
      const orderTotal = p.order_total ? ` · Order #ORD-${p.order_id || p.id} (৳${p.order_total})` : '';

      let actionsHtml = '';
      if (p.status === 'pending') {
        actionsHtml = `
          <button class="btn-primary btn-sm btn-verify-pay" data-pay-id="${p.id}" style="background:#10b981;box-shadow:none;">
            Verify &amp; Confirm
          </button>
          <button class="btn-danger-soft btn-sm btn-reject-pay" data-pay-id="${p.id}">
            Reject
          </button>`;
      } else if (p.status === 'verified') {
        actionsHtml = `
          <span class="pill green" style="font-size:12px;">Verified by ${esc(p.verified_by || 'Admin')}</span>`;
      } else if (p.status === 'rejected') {
        actionsHtml = `
          <span class="pill" style="color:#ef4444;background:rgba(239,68,68,0.12);font-size:12px;">
            Rejected${p.rejection_reason ? ': ' + esc(p.rejection_reason) : ''}
          </span>`;
      }

      if (p.conversation_id) {
        actionsHtml += `
          <button class="btn-ghost btn-sm btn-jump-chat" data-conv-id="${p.conversation_id}" style="font-size:12px;">
            View chat
          </button>`;
      }

      return `
        <div class="payment-card-item ${isDup ? 'duplicate-border' : ''}" data-item-id="${p.id}">
          <div class="payment-card-top">
            <div class="payment-cust-info">
              <span class="method-badge ${esc(method)}">${esc(method.toUpperCase())}</span>
              <div>
                <div style="font-weight:700;font-size:14.5px;color:var(--ink);">
                  ${esc(custName)} ${custPhone ? `<span class="muted small">(${esc(custPhone)})</span>` : ''}
                </div>
                <div class="muted small">
                  Via ${esc(p.channel || 'webchat')} · ${timeStr}${orderTotal}
                </div>
              </div>
            </div>
            <div class="payment-amount-box">
              <div class="payment-amount-val">৳${esc(Number(p.amount || 0).toLocaleString())}</div>
              <span class="pill ${p.status === 'verified' ? 'green' : (p.status === 'pending' ? 'blue' : '')}">${esc(p.status.toUpperCase())}</span>
            </div>
          </div>

          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <div class="trx-code-badge">
              <span>TrxID:</span>
              <span style="user-select:all;">${esc(p.transaction_id)}</span>
              <button type="button" class="btn-ghost btn-sm btn-copy-trx" data-trx="${esc(p.transaction_id)}" title="Copy TrxID" style="padding:1px 5px;font-size:11px;">Copy</button>
            </div>
            ${isDup ? `<div class="duplicate-warning-badge">Duplicate TrxID — Already used in another order</div>` : ''}
          </div>

          ${p.evidence_text ? `<div class="small muted" style="background:var(--hover);padding:6px 10px;border-radius:8px;font-style:italic;">"${esc(p.evidence_text.slice(0, 150))}"</div>` : ''}

          <div class="payment-card-bottom">
            <div class="muted small">Record ID: #${p.id}</div>
            <div class="payment-actions">
              ${actionsHtml}
            </div>
          </div>
        </div>`;
    }).join('');

    // Bind action handlers
    listEl.querySelectorAll('.btn-verify-pay').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-pay-id');
        btn.disabled = true;
        btn.textContent = 'Verifying…';
        try {
          const r = await api(`/api/payments/${id}/verify`, { method: 'POST', body: JSON.stringify({ verified_by: state.me?.username || 'Owner' }) });
          toast(r.message || 'Payment verified!', 'ok');
          loadPayments();
          loadPaymentStats();
        } catch (err) {
          toast('Verification failed: ' + err.message, 'err');
          btn.disabled = false;
          btn.textContent = 'Verify & Confirm';
        }
      };
    });

    listEl.querySelectorAll('.btn-reject-pay').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-pay-id');
        const reason = prompt('Reason for rejection (sent to customer chat):', 'TrxID স্টেটমেন্টে পাওয়া যায়নি / টাকা ক্রেডিট হয়নি');
        if (reason === null) return;
        btn.disabled = true;
        btn.textContent = 'Rejecting…';
        try {
          const r = await api(`/api/payments/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
          toast(r.message || 'Payment rejected', 'err');
          loadPayments();
          loadPaymentStats();
        } catch (err) {
          toast('Failed to reject: ' + err.message, 'err');
          btn.disabled = false;
        }
      };
    });

    listEl.querySelectorAll('.btn-copy-trx').forEach(btn => {
      btn.onclick = () => {
        const trx = btn.getAttribute('data-trx');
        navigator.clipboard.writeText(trx).then(() => toast('TrxID copied to clipboard!', 'ok'));
      };
    });

    listEl.querySelectorAll('.btn-jump-chat').forEach(btn => {
      btn.onclick = () => {
        const convId = Number(btn.getAttribute('data-conv-id'));
        closePaymentsModal();
        showView('inbox');
        selectConversation(convId);
      };
    });

  } catch (err) {
    listEl.innerHTML = `<div class="login-err show" style="margin:16px;">Failed to load payments: ${esc(err.message)}</div>`;
  }
}

function openPaymentsModal() {
  const modal = $('payments-modal');
  if (!modal) return;
  state.paymentsModalOpen = true;
  modal.classList.remove('hidden');
  loadPaymentStats();
  loadPayments(currentPaymentsTab);
}

function closePaymentsModal() {
  const modal = $('payments-modal');
  if (modal) modal.classList.add('hidden');
  state.paymentsModalOpen = false;
}

function initPaymentsHub() {
  document.querySelectorAll('.btn-payments-trigger').forEach(b => {
    b.onclick = openPaymentsModal;
  });
  const btnClose = $('btn-close-payments');
  if (btnClose) btnClose.onclick = closePaymentsModal;
  const btnCloseFoot = $('btn-close-payments-foot');
  if (btnCloseFoot) btnCloseFoot.onclick = closePaymentsModal;

  // Tabs
  const tabsWrap = $('payments-tabs');
  if (tabsWrap) {
    tabsWrap.querySelectorAll('button[data-ptab]').forEach(b => {
      b.onclick = () => {
        tabsWrap.querySelectorAll('button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        loadPayments(b.getAttribute('data-ptab'));
      };
    });
  }

  // Manual record toggle
  const btnToggleMan = $('btn-toggle-manual-pay');
  const boxMan = $('manual-pay-box');
  if (btnToggleMan && boxMan) {
    btnToggleMan.onclick = () => boxMan.classList.toggle('hidden');
  }

  // Submit manual payment
  const btnSubMan = $('btn-submit-manual-pay');
  if (btnSubMan) {
    btnSubMan.onclick = async () => {
      const phone = $('man-pay-phone').value.trim();
      const name = $('man-pay-name').value.trim();
      const method = $('man-pay-method').value;
      const amount = Number($('man-pay-amount').value) || 0;
      const trx = $('man-pay-trx').value.trim();

      if (!trx) {
        toast('Please enter a Transaction ID (TrxID)', 'err');
        return;
      }
      if (amount <= 0) {
        toast('Please enter a valid amount (৳)', 'err');
        return;
      }

      btnSubMan.disabled = true;
      try {
        const res = await api('/api/payments/claim', {
          method: 'POST',
          body: JSON.stringify({
            client_id: state.clientId || 1,
            customer_name: name || 'Direct Customer',
            customer_phone: phone,
            method,
            amount,
            transaction_id: trx,
            channel: 'manual_entry'
          })
        });

        toast(res.duplicate_warning ? 'Payment claimed (Duplicate TrxID warning)' : 'Payment recorded successfully', 'ok');
        $('man-pay-trx').value = '';
        $('man-pay-amount').value = '';
        boxMan.classList.add('hidden');
        loadPayments();
        loadPaymentStats();
      } catch (err) {
        toast('Failed to record payment: ' + err.message, 'err');
      } finally {
        btnSubMan.disabled = false;
      }
    };
  }
}


