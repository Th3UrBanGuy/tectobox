/* Tectobox Webchat — one-line embed.
 * <script src="https://ss.kalandar.me/widget.js?v=20261001i" data-client="WIDGET_KEY"></script>
 * Appearance (title, greeting, color, avatar, position…) is configured in the
 * dashboard and fetched automatically — data-* attributes override it:
 *   data-color, data-title, data-greeting, data-subtitle, data-avatar,
 *   data-position="bottom-right|bottom-left", data-api="https://…"
 * Self-contained, Shadow-DOM isolated, no dependencies.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script) return;
  var KEY = script.getAttribute('data-client') || '';
  if (!KEY) { console.warn('[tectonic-chat] missing data-client key'); return; }
  var API = script.getAttribute('data-api') || new URL(script.src).origin;
  var DS = function (name) { return script.getAttribute('data-' + name); };

  var DEFAULTS = {
    title: 'Chat with us',
    greeting: 'Hi there! 👋 How can I help you today?',
    subtitle: 'Online — replies instantly',
    color: '#7c5cff',
    position: 'bottom-right',
    avatar: ''
  };

  function loadServerConfig() {
    // Dashboard-saved appearance. Never blocks the widget for long.
    return new Promise(function (resolve) {
      var done = false;
      function fin(cfg) { if (!done) { done = true; resolve(cfg || {}); } }
      setTimeout(function () { fin({}); }, 2500);
      try {
        fetch(API + '/api/widget/' + encodeURIComponent(KEY) + '/config')
          .then(function (r) { return r.ok ? r.json() : {}; })
          .then(fin, function () { fin({}); });
      } catch (e) { fin({}); }
    });
  }

  function boot(serverCfg) {
    var COLOR = DS('color') || serverCfg.color || DEFAULTS.color;
    var TITLE = DS('title') || serverCfg.title || DEFAULTS.title;
    var GREETING = DS('greeting') || serverCfg.greeting || DEFAULTS.greeting;
    var SUBTITLE = DS('subtitle') || serverCfg.subtitle || DEFAULTS.subtitle;
    var AVATAR = DS('avatar') || serverCfg.avatar || DEFAULTS.avatar;
    var POS = (DS('position') || serverCfg.position || DEFAULTS.position) === 'bottom-left' ? 'left' : 'right';

    var LS_ID = 'tectonic_wc_vid', LS_NAME = 'tectonic_wc_name', LS_CONTACT = 'tectonic_wc_contact';
    // Pre-chat identification: the shop owner sees WHO is talking. Dashboard
    // toggle (Appearance → "Ask for name & contact"); data-require-intro="0"
    // disables it per-embed. Defaults ON.
    var REQUIRE_INTRO = true;
    try {
      var ri = DS('require-intro');
      if (ri !== null && ri !== undefined && ri !== '') REQUIRE_INTRO = !(ri === '0' || ri === 'false' || ri === 'no');
      else if (serverCfg.require_intro !== undefined && serverCfg.require_intro !== null) REQUIRE_INTRO = !!+serverCfg.require_intro;
    } catch (e) {}
    function uuid() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }
    var visitorId = null;
    try {
      visitorId = localStorage.getItem(LS_ID);
      if (!visitorId) { visitorId = uuid(); localStorage.setItem(LS_ID, visitorId); }
    } catch (e) { visitorId = uuid(); }
    var visitorName = '';
    try { visitorName = localStorage.getItem(LS_NAME) || ''; } catch (e) {}
    var visitorContact = '';
    try { visitorContact = localStorage.getItem(LS_CONTACT) || ''; } catch (e) {}
    var identified = !!(visitorName && visitorContact);

    var root = document.createElement('div');
    root.id = 'tectonic-chat-root';
    // Bulletproof top layer: the host itself is fixed + max z-index with
    // pointer-events:none, so no host-page element can ever cover the widget
    // (or swallow its clicks). Bubble/panel re-enable pointer events.
    root.setAttribute('style', 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;');
    document.body.appendChild(root);
    var shadow = root.attachShadow({ mode: 'open' });

    // Soft tints derived from the brand color (color-mix with white fallback).
    var tint = function (pct) { return 'color-mix(in srgb, ' + COLOR + ' ' + pct + '%, #ffffff)'; };

    var css = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
    .tc-bubble {
      position: fixed; ${POS}: 24px; bottom: 24px; z-index: 2147483000;
      pointer-events: auto;
      width: 58px; height: 58px; border-radius: 50%; cursor: pointer;
      background: #ffffff; border: 1px solid rgba(20,20,50,.06);
      box-shadow: 0 12px 32px rgba(25,25,60,.14), 0 2px 6px rgba(25,25,60,.08);
      display: flex; align-items: center; justify-content: center;
      transition: transform .2s ease, box-shadow .2s ease;
    }
    .tc-bubble:hover { transform: translateY(-2px); box-shadow: 0 16px 38px rgba(25,25,60,.18), 0 2px 6px rgba(25,25,60,.08); }
    .tc-bubble:active { transform: scale(.96); }
    .tc-bubble svg { width: 26px; height: 26px; fill: ${COLOR}; }
    .tc-bubble .tc-ic-close { display: none; width: 22px; height: 22px; }
    .tc-bubble.tc-openbtn .tc-ic-chat { display: none; }
    .tc-bubble.tc-openbtn .tc-ic-close { display: block; }
    .tc-badge {
      position: absolute; top: -4px; ${POS === 'right' ? 'right' : 'left'}: -4px;
      min-width: 22px; height: 22px; border-radius: 11px; padding: 0 6px;
      background: #ff4d5e; color: #fff; font-size: 12px; font-weight: 700;
      display: none; align-items: center; justify-content: center;
      border: 2px solid #fff;
    }
    .tc-panel {
      position: fixed; ${POS}: 24px; bottom: 96px; z-index: 2147483000;
      width: 380px; max-width: calc(100vw - 24px); height: 560px; max-height: calc(100vh - 132px);
      background: rgba(255,255,255,.82);
      -webkit-backdrop-filter: blur(24px) saturate(1.5); backdrop-filter: blur(24px) saturate(1.5);
      border: 1px solid rgba(255,255,255,.65); border-radius: 26px; overflow: hidden;
      display: flex; flex-direction: column;
      box-shadow: 0 30px 80px rgba(25,25,60,.16), 0 4px 18px rgba(25,25,60,.07);
      opacity: 0; transform: translateY(16px) scale(.98); pointer-events: none;
      transition: opacity .25s ease, transform .25s ease;
    }
    .tc-panel.tc-open { opacity: 1; transform: none; pointer-events: auto; }
    .tc-header {
      padding: 16px 14px 14px 16px; display: flex; align-items: center; gap: 12px;
      border-bottom: 1px solid rgba(20,20,50,.06);
      background: linear-gradient(180deg, ${tint(10)}, rgba(255,255,255,0));
    }
    .tc-avatar {
      width: 46px; height: 46px; border-radius: 50%; flex-shrink: 0;
      background: ${tint(14)}; color: ${COLOR};
      display: flex; align-items: center; justify-content: center;
      font-size: 22px; font-weight: 700; overflow: hidden;
    }
    .tc-avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
    .tc-htext { flex: 1; min-width: 0; }
    .tc-htext b { display: block; font-size: 15.5px; color: #17171f; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tc-status { font-size: 12px; color: #8b8b98; display: flex; align-items: center; gap: 6px; margin-top: 2px; }
    .tc-dot { width: 7px; height: 7px; border-radius: 50%; background: #34c77b; }
    .tc-close { background: none; border: none; color: #a2a2b0; font-size: 20px; cursor: pointer; padding: 6px 10px; border-radius: 10px; line-height: 1; }
    .tc-close:hover { background: rgba(20,20,50,.06); color: #55555f; }
    .tc-msgs { flex: 1; overflow-y: auto; padding: 16px 14px; display: flex; flex-direction: column; gap: 8px; background: rgba(246,247,250,.5); }
    .tc-row { display: flex; }
    .tc-row.in { justify-content: flex-start; }
    .tc-row.out { justify-content: flex-end; }
    .tc-msg {
      max-width: 78%; padding: 10px 14px; border-radius: 18px; font-size: 14px; line-height: 1.5;
      word-wrap: break-word; white-space: pre-wrap;
      animation: tc-in .22s ease;
    }
    @keyframes tc-in { from { opacity: 0; transform: translateY(5px); } }
    .tc-row.in .tc-msg { background: #ffffff; color: #23232e; border: 1px solid rgba(20,20,50,.05); border-bottom-left-radius: 6px; box-shadow: 0 1px 3px rgba(25,25,60,.06); }
    .tc-row.out .tc-msg { background: ${COLOR}; color: #fff; border-bottom-right-radius: 6px; }
    .tc-msg .tc-li { display: block; padding-left: 14px; position: relative; margin: 2px 0; }
    .tc-msg .tc-li::before { content: "•"; position: absolute; left: 3px; opacity: .7; }
    .tc-typing { display: inline-flex; gap: 5px; padding: 13px 16px; background: #fff; border: 1px solid rgba(20,20,50,.05); border-radius: 18px; border-bottom-left-radius: 6px; }
    .tc-typing span { width: 6px; height: 6px; border-radius: 50%; background: #c2c2cf; animation: tc-b 1.2s infinite; }
    .tc-typing span:nth-child(2) { animation-delay: .15s; } .tc-typing span:nth-child(3) { animation-delay: .3s; }
    @keyframes tc-b { 0%,60%,100% { transform: none; opacity: .45; } 30% { transform: translateY(-4px); opacity: 1; } }
    .tc-err { align-self: center; font-size: 12px; color: #b04a3a; background: rgba(255,240,238,.9); padding: 6px 12px; border-radius: 10px; }
    .tc-inputbar { display: flex; gap: 8px; padding: 12px; border-top: 1px solid rgba(20,20,50,.06); background: rgba(255,255,255,.6); }
    .tc-inputbar input {
      flex: 1; border: none; border-radius: 22px; padding: 11px 16px;
      font-size: 14px; outline: none; min-width: 0; color: #23232e;
      background: rgba(20,20,50,.055); transition: background .2s, box-shadow .2s;
    }
    .tc-inputbar input:focus { background: #fff; box-shadow: 0 0 0 2px ${tint(35)}; }
    .tc-inputbar input::placeholder { color: #a2a2b0; }
    .tc-send {
      width: 44px; height: 44px; border-radius: 50%; border: none; cursor: pointer; flex-shrink: 0;
      background: ${COLOR}; color: #fff;
      display: flex; align-items: center; justify-content: center;
      transition: transform .15s, opacity .15s;
      box-shadow: 0 4px 12px ${tint(55)};
    }
    .tc-send:hover { transform: scale(1.05); }
    .tc-send:disabled { opacity: .45; cursor: default; transform: none; }
    .tc-send svg { width: 18px; height: 18px; fill: #fff; }
    .tc-intro { padding: 26px 24px; display: none; flex-direction: column; gap: 10px; overflow-y: auto; flex: 1; }
    .tc-panel.tc-need-intro .tc-intro { display: flex; }
    .tc-panel.tc-need-intro .tc-msgs, .tc-panel.tc-need-intro .tc-inputbar { display: none; }
    .tc-intro h4 { margin: 2px 0 0; font-size: 17px; color: #191932; }
    .tc-intro p { margin: 0 0 6px; font-size: 13px; color: #6b6b85; line-height: 1.55; }
    .tc-intro label { font-size: 12px; font-weight: 600; color: #3a3a55; margin-top: 2px; }
    .tc-intro input { border: 1.5px solid rgba(20,20,50,.12); border-radius: 12px; padding: 11px 13px; font-size: 14px; outline: none; width: 100%; color: #191932; background: #fff; }
    .tc-intro input:focus { border-color: ${COLOR}; box-shadow: 0 0 0 3px ${tint(85)}; }
    .tc-ierr { color: #d33; font-size: 12px; min-height: 16px; margin: 0; }
    .tc-start { margin-top: 4px; border: none; border-radius: 12px; padding: 13px; font-size: 15px; font-weight: 700; color: #fff; background: ${COLOR}; cursor: pointer; }
    .tc-start:active { transform: scale(.98); }
    .tc-ident { display: none; align-items: center; gap: 6px; padding: 7px 14px; font-size: 11.5px; color: #6b6b85; border-bottom: 1px solid rgba(20,20,50,.06); background: rgba(255,255,255,.5); }
    .tc-ident b { color: #3a3a55; }
    .tc-ident button { margin-left: auto; border: none; background: none; color: ${COLOR}; font-size: 11.5px; font-weight: 600; cursor: pointer; padding: 2px 4px; }
    @media (max-width: 420px) {
      .tc-panel { ${POS}: 12px; left: 12px; width: auto; bottom: 88px; }
      .tc-bubble { ${POS}: 16px; bottom: 16px; }
    }`;

    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function avatarInner() {
      var av = String(AVATAR || '').trim();
      if (/^https?:\/\//i.test(av)) return '<img src="' + esc(av) + '" alt="">';
      if (av) return esc(av);
      return esc(TITLE.charAt(0).toUpperCase());
    }

    shadow.innerHTML = `
    <style>${css}</style>
    <button class="tc-bubble" aria-label="Open chat">
      <svg class="tc-ic-chat" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.14 2 11.25c0 2.92 1.56 5.55 4.03 7.35-.1.72-.58 2.6-1.83 3.9 0 0 2.35.13 4.42-1.6.86.23 1.77.35 2.71.35h.67c5.52 0 10-4.14 10-9.25S17.52 2 12 2zm-4.5 9.5a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm4.5 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm4.5 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z"/></svg>
      <svg class="tc-ic-close" viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      <span class="tc-badge">0</span>
    </button>
    <div class="tc-panel" role="dialog" aria-label="Chat">
      <div class="tc-header">
        <div class="tc-avatar">${avatarInner()}</div>
        <div class="tc-htext"><b>${esc(TITLE)}</b><span class="tc-status"><span class="tc-dot"></span>${esc(SUBTITLE)}</span></div>
        <button class="tc-close" aria-label="Close chat">×</button>
      </div>
      <div class="tc-ident"><span>Chatting as <b class="tc-ident-name"></b></span><button class="tc-ident-edit" type="button">Change</button></div>
      <div class="tc-intro">
        <h4>Before we start…</h4>
        <p>Tell us who you are so we know who's talking. We'll only use this to reply to you.</p>
        <label>Your name</label>
        <input class="tc-in-name" type="text" placeholder="e.g. Rahim Uddin" maxlength="80" autocomplete="name" />
        <label>Phone or email</label>
        <input class="tc-in-contact" type="text" placeholder="01XXXXXXXXX or you@email.com" maxlength="120" autocomplete="tel" />
        <p class="tc-ierr"></p>
        <button class="tc-start" type="button">Start chat</button>
      </div>
      <div class="tc-msgs"></div>
      <div class="tc-inputbar">
        <input type="text" placeholder="Type your message…" maxlength="2000" autocomplete="off" />
        <button class="tc-send" aria-label="Send"><svg viewBox="0 0 24 24"><path d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>
      </div>
    </div>`;

    var bubble = shadow.querySelector('.tc-bubble');
    var badge = shadow.querySelector('.tc-badge');
    var panel = shadow.querySelector('.tc-panel');
    var msgsEl = shadow.querySelector('.tc-msgs');
    var input = shadow.querySelector('.tc-inputbar input');
    var sendBtn = shadow.querySelector('.tc-send');
    var closeBtn = shadow.querySelector('.tc-close');
    var introName = shadow.querySelector('.tc-in-name');
    var introContact = shadow.querySelector('.tc-in-contact');
    var introErr = shadow.querySelector('.tc-ierr');
    var introStart = shadow.querySelector('.tc-start');
    var identBar = shadow.querySelector('.tc-ident');
    var identName = shadow.querySelector('.tc-ident-name');
    var identEdit = shadow.querySelector('.tc-ident-edit');

    function validContact(v) {
      var s = String(v).trim();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return true; // email
      var digits = s.replace(/\D/g, '');
      return digits.length >= 7 && digits.length <= 15; // phone
    }
    function renderIdentity() {
      var need = REQUIRE_INTRO && !identified;
      panel.classList.toggle('tc-need-intro', need);
      if (!need && identified) {
        identBar.style.display = 'flex';
        identName.textContent = visitorName;
      } else {
        identBar.style.display = 'none';
      }
    }
    function submitIntro() {
      var name = introName.value.trim();
      var contact = introContact.value.trim();
      if (name.length < 2) { introErr.textContent = 'Please enter your name.'; introName.focus(); return; }
      if (!validContact(contact)) { introErr.textContent = 'Enter a valid phone number or email.'; introContact.focus(); return; }
      introErr.textContent = '';
      visitorName = name.slice(0, 80);
      visitorContact = contact.slice(0, 120);
      identified = true;
      try {
        localStorage.setItem(LS_NAME, visitorName);
        localStorage.setItem(LS_CONTACT, visitorContact);
      } catch (e) {}
      // Tell the server about the (possibly changed) identity so the AI
      // addresses the visitor by the current name, not a stale one.
      try {
        fetch(API + '/api/widget/' + encodeURIComponent(KEY) + '/identify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ visitor_id: visitorId, name: visitorName, contact: visitorContact }),
        }).catch(function () {});
      } catch (e) {}
      renderIdentity();
      if (!greeted) { greeted = true; addMsg('in', 'Thanks ' + visitorName.split(' ')[0] + '! ' + GREETING); }
      setTimeout(function () { input.focus(); }, 250);
    }
    introStart.addEventListener('click', submitIntro);
    introContact.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitIntro(); });
    introName.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); introContact.focus(); } });
    identEdit.addEventListener('click', function () {
      identified = false;
      introName.value = visitorName; introContact.value = visitorContact;
      renderIdentity();
      setTimeout(function () { introName.focus(); }, 100);
    });
    renderIdentity();

    var open = false, greeted = false, sending = false, lastSeenId = 0, unread = 0;
    var seenIds = {};

    function richText(t) {
      var h = esc(t || '');
      h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
      h = h.replace(/^(?:\*|•|-)\s+(.+)$/gm, '<span class="tc-li">$1</span>');
      h = h.replace(/\n/g, '<br>');
      return h;
    }
    function addMsg(direction, text, id) {
      if (id && seenIds[id]) return;
      if (id) seenIds[id] = 1;
      if (direction === 'out') everSent = true;
      var row = document.createElement('div');
      row.className = 'tc-row ' + (direction === 'out' ? 'out' : 'in');
      var m = document.createElement('div');
      m.className = 'tc-msg';
      m.innerHTML = richText(text);
      row.appendChild(m);
      msgsEl.appendChild(row);
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }
    function showTyping() {
      var row = document.createElement('div');
      row.className = 'tc-row in'; row.id = 'tc-typing-row';
      row.innerHTML = '<div class="tc-typing"><span></span><span></span><span></span></div>';
      msgsEl.appendChild(row);
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }
    function hideTyping() {
      var t = shadow.getElementById('tc-typing-row');
      if (t) t.remove();
    }
    function showErr(text) {
      var e = document.createElement('div');
      e.className = 'tc-err'; e.textContent = text;
      msgsEl.appendChild(e);
      msgsEl.scrollTop = msgsEl.scrollHeight;
      setTimeout(function () { e.remove(); }, 4000);
    }
    function bumpBadge() {
      unread += 1;
      badge.textContent = unread > 9 ? '9+' : unread;
      badge.style.display = 'flex';
    }

    var everSent = false;
    function setOpen(v) {
      open = v;
      panel.classList.toggle('tc-open', v);
      bubble.classList.toggle('tc-openbtn', v);
      bubble.setAttribute('aria-label', v ? 'Close chat' : 'Open chat');
      if (v) {
        unread = 0; badge.style.display = 'none';
        var needIntro = REQUIRE_INTRO && !identified;
        if (!greeted && !needIntro) { greeted = true; addMsg('in', GREETING); }
        setTimeout(function () { (needIntro ? introName : input).focus(); }, 250);
      }
    }
    bubble.addEventListener('click', function () { setOpen(!open); });
    closeBtn.addEventListener('click', function () { setOpen(false); });

    async function send() {
      var text = input.value.trim();
      if (!text || sending) return;
      sending = true; sendBtn.disabled = true;
      input.value = '';
      addMsg('out', text);
      showTyping();
      try {
        var res = await fetch(API + '/api/widget/' + encodeURIComponent(KEY) + '/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            visitor_id: visitorId,
            name: visitorName || undefined,
            contact: visitorContact || undefined,
            text: text,
            message_id: uuid(),
            page_url: location.href,
            page_title: document.title,
          }),
        });
        hideTyping();
        if (!res.ok) throw new Error('http ' + res.status);
        var data = await res.json();
        // Dedup: register the reply under its server id BEFORE the poll can
        // re-add it, and advance the poll cursor past it.
        if (data.reply_id) {
          addMsg('in', data.reply, 'srv-' + data.reply_id);
          lastSeenId = Math.max(lastSeenId, data.reply_id);
        } else {
          if (data.reply) addMsg('in', data.reply);
          if (data.message_id) lastSeenId = Math.max(lastSeenId, data.message_id);
        }
      } catch (e) {
        hideTyping();
        showErr('Could not send — please try again.');
      } finally {
        sending = false; sendBtn.disabled = false;
      }
    }
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });

    // Poll for operator (human) replies — 4s while open, 10s while closed.
    async function poll() {
      if (!everSent) return;
      try {
        var res = await fetch(API + '/api/widget/' + encodeURIComponent(KEY) +
          '/messages?visitor_id=' + encodeURIComponent(visitorId) + '&since_id=' + lastSeenId);
        if (!res.ok) return;
        var data = await res.json();
        (data.messages || []).forEach(function (m) {
          lastSeenId = Math.max(lastSeenId, m.id);
          if (m.direction === 'out') {
            addMsg('in', m.text, 'srv-' + m.id);
            if (!open) bumpBadge();
          }
        });
      } catch (e) { /* silent — next poll retries */ }
    }
    setInterval(poll, 4000);
    setInterval(function () { if (!open) poll(); }, 10000);
  }

  loadServerConfig().then(boot);
})();
