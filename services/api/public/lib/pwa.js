// Tectobox frontend — lib/pwa.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

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
