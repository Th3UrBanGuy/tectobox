// Tectobox frontend — lib/telemetry.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

// Tectobox — AI-powered unified inbox frontend (vanilla JS + SSE).
// Global Client-Side Error & Diagnostics Tracker
let _lastBeaconTime = 0;
function reportClientError(errData) {
  const now = Date.now();
  if (now - _lastBeaconTime < 2000) return; // 2s rate limit
  _lastBeaconTime = now;
  try {
    const payload = JSON.stringify({
      message: errData.message || 'Client runtime error',
      stack: errData.stack || '',
      url: window.location.href,
      userAgent: navigator.userAgent,
    });
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon('/api/diagnostics/client-telemetry', blob);
    } else {
      // NOTE (Phase 5): fire-and-forget beacon — intentionally raw. It uses
      // keepalive and must never call api() (a failed beacon must not
      // trigger the 401 -> showLogin() redirect).
      fetch('/api/diagnostics/client-telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    }
  } catch {}
}

window.addEventListener('error', (event) => {
  console.warn('[Tectobox Client Error]', event.message, event.filename, event.lineno);
  reportClientError({
    message: `${event.message} at ${event.filename || 'inline'}:${event.lineno || 0}:${event.colno || 0}`,
    stack: event.error && event.error.stack ? event.error.stack : `${event.filename}:${event.lineno}`,
  });
});
window.addEventListener('unhandledrejection', (event) => {
  console.warn('[Tectobox Unhandled Rejection]', event.reason);
  const reason = event.reason;
  reportClientError({
    message: reason && reason.message ? reason.message : String(reason || 'Unhandled promise rejection'),
    stack: reason && reason.stack ? reason.stack : '',
  });
});

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
