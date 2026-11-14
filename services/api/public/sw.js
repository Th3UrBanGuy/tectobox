/* Tectobox service worker — app shell cache + OTA updates + push notifications.
 * Version bump = clients get an "Update available" prompt, never a stale app.
 */
var SW_VERSION = 'tectobox-v6';
var SHELL = [
  '/app',
  '/manifest.webmanifest',
  '/img/tectobox-icon-192.png',
  '/img/tectobox-icon.png',
  '/img/apple-touch-icon.png',
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SW_VERSION).then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
      .catch(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== SW_VERSION; }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Strategy: navigations → network first (always fresh HTML); versioned static
// assets (?v=…) → cache first (immutable); everything else → network, fallback cache.
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(function (r) {
        var copy = r.clone();
        caches.open(SW_VERSION).then(function (c) { c.put(e.request, copy); });
        return r;
      }).catch(function () {
        return caches.match(e.request).then(function (hit) { return hit || caches.match('/app'); });
      })
    );
    return;
  }
  if (/[?&]v=/.test(url.search)) {
    e.respondWith(
      caches.match(e.request).then(function (hit) {
        return hit || fetch(e.request).then(function (r) {
          var copy = r.clone();
          caches.open(SW_VERSION).then(function (c) { c.put(e.request, copy); });
          return r;
        });
      })
    );
  }
});

// ---- Web Push ----
self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  var title = data.title || 'Tectobox';
  var body = data.body || 'You have a new message.';
  var target = data.url || '/app';
  e.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: '/img/tectobox-icon-192.png',
      badge: '/img/tectobox-icon-192.png',
      tag: data.tag || 'tectobox-msg',
      renotify: true,
      data: { url: target },
    })
  );
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (wins) {
      for (var i = 0; i < wins.length; i++) {
        var w = wins[i];
        if (w.url.indexOf(self.location.origin) === 0) { w.focus(); w.navigate(target); return; }
      }
      return self.clients.openWindow(target);
    })
  );
});

// Tell the page when a newer SW is waiting → it shows the update toast.
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
