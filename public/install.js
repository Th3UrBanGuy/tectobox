/* Tectobox install page — platform-adaptive store experience.
   Detects Android / iOS / Windows / macOS and renders the matching
   native store UI (Play Store / App Store / Microsoft Store). */
(function () {
  'use strict';

  function detectPlatform() {
    var ua = navigator.userAgent || '';
    var plat = navigator.platform || '';
    if (/android/i.test(ua)) return 'android';
    if (/iPad|iPhone|iPod/.test(ua) || (plat === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
    if (/Win/.test(plat) || /Windows/.test(ua)) return 'windows';
    if (/Mac/.test(plat)) return 'macos';
    return 'other';
  }

  var platform = detectPlatform();
  document.documentElement.setAttribute('data-platform', platform);
  document.body.setAttribute('data-platform', platform);

  var SUFFIX = { android: '', ios: '-ios', windows: '-win', macos: '-mac', other: '-other' };
  var sfx = SUFFIX[platform] || '-other';

  function $(id) { return document.getElementById(id); }

  var btn = $('btn-install' + sfx) || $('btn-install');
  var note = $('install-note' + sfx) || $('install-note');
  var steps = $('manual-steps' + sfx) || $('manual-steps');
  var stepsList = $('steps-list' + sfx) || $('steps-list');

  // "other" fallback section is hidden by default; reveal it when needed.
  if (platform === 'other') {
    var fb = $('fallback-other');
    if (fb) fb.style.display = 'block';
  }

  var titles = { android: 'Google Play', ios: 'App Store', windows: 'Microsoft Store', macos: 'Install', other: 'App info' };
  var titleEl = $('store-title');
  if (titleEl && titles[platform]) titleEl.textContent = titles[platform];

  var isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                     window.matchMedia('(display-mode: fullscreen)').matches ||
                     navigator.standalone === true;

  var deferredPrompt = null;

  var MANUAL = {
    android: [
      'Tap the browser menu <b>⋮</b> (top-right in Chrome)',
      'Tap <b>"Install app"</b> or <b>"Add to Home screen"</b>',
      'Open <b>Tectobox</b> from your home screen and sign in'
    ],
    ios: [
      'Open this page in <b>Safari</b>',
      'Tap the <b>Share</b> button (square with arrow at the bottom)',
      'Scroll down and tap <b>"Add to Home Screen"</b>',
      'Tap <b>Add</b> — open <b>Tectobox</b> from your Home Screen'
    ],
    windows: [
      'Open this page in <b>Microsoft Edge</b> or <b>Chrome</b>',
      'Click the <b>install icon</b> in the address bar, or menu → <b>Apps → Install Tectobox</b>',
      'Click <b>Install</b> — Tectobox opens in its own window'
    ],
    macos: [
      'Open this page in <b>Chrome</b> or <b>Edge</b>',
      'Click the <b>install icon</b> in the address bar',
      'Click <b>Install</b> — Tectobox opens as its own app'
    ],
    other: [
      'Open this page in <b>Chrome</b> or <b>Edge</b>',
      'Use the browser menu → <b>Install</b> / <b>"Add to Home screen"</b>',
      'Open <b>Tectobox</b> and sign in — done'
    ]
  };

  function showManual() {
    var items = MANUAL[platform] || MANUAL.other;
    if (stepsList) {
      stepsList.innerHTML = items.map(function (t, i) {
        return '<li><span class="step-n">' + (i + 1) + '</span><span>' + t + '</span></li>';
      }).join('');
    }
    if (steps) {
      steps.classList.add('show');
      steps.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function setInstalled() {
    if (!btn) return;
    btn.textContent = btn.getAttribute('data-open-label') || 'Open app';
    btn.classList.add('is-open');
    btn.onclick = function () { location.href = '/app'; };
    if (note) note.textContent = 'Already installed on this device';
    if (steps) steps.classList.remove('show');
  }

  if (btn) {
    if (isStandalone) {
      setInstalled();
    } else {
      window.addEventListener('beforeinstallprompt', function (e) {
        e.preventDefault();
        deferredPrompt = e;
        if (note) note.textContent = 'Free · One-tap install · Updates automatically';
      });
      btn.addEventListener('click', function () {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          try {
            deferredPrompt.userChoice.then(function () { deferredPrompt = null; })
              .catch(function () {});
          } catch (e) {}
          return;
        }
        showManual();
      });
      window.addEventListener('appinstalled', function () { setInstalled(); });
    }
  }

  var back = $('btn-back');
  if (back) back.addEventListener('click', function () { history.back(); });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }
})();
