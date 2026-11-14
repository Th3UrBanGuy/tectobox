// Tectobox frontend — lib/dom.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

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
