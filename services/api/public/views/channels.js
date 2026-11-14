// Tectobox frontend — views/channels.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

async function loadConnectors() {
  // Show a loading state immediately: the page shell (heading + empty
  // "Webhook URLs" card) used to sit blank until all three calls below
  // resolved, which reads as a ~5s hang on a cold first open.
  $('chan-empty').innerHTML = '';
  $('chan-grid').innerHTML = Array.from({ length: 3 }, () =>
    `<div class="chan-card"><div class="sk" style="height:22px; width:48%; margin-bottom:14px;"></div><div class="sk" style="height:12px; width:92%; margin-bottom:8px;"></div><div class="sk" style="height:12px; width:68%;"></div></div>`).join('');
  $('webhook-urls').innerHTML = '<div class="small muted" style="padding:6px 0;">Loading webhook URLs…</div>';
  // The three calls are independent — fire them in parallel instead of
  // awaiting each in turn (sequential ~223ms vs parallel ~103ms over the
  // public path; the real win is the skeleton above, not the ~120ms).
  let urls = {};
  try {
    const [connectors, webchat, fetchedUrls] = await Promise.all([
      api(`/api/clients/${state.clientId}/connectors`),
      api('/api/webchat/config').catch(() => ({})),
      api('/api/webhook-urls').catch(() => ({})),
    ]);
    state.connectors = connectors;
    state.webchat = webchat;
    urls = fetchedUrls;
  } catch (e) {
    $('chan-grid').innerHTML = `<div class="warm-empty"><b>Couldn't load channels</b><p>The connection hiccuped. Your channels are safe — let's try again.</p><button class="btn-primary" id="btn-chan-retry" style="margin-top:6px;">Retry</button></div>`;
    $('webhook-urls').innerHTML = '';
    $('btn-chan-retry').onclick = () => loadConnectors();
    return;
  }
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
    // List only accounts that actually connected. A half-finished or failed
    // connect leaves a row stuck at 'connecting'/'disconnected'/'error' —
    // it must never appear in the list; it only becomes visible once the
    // link really succeeds. The connect modal is the in-progress surface,
    // and the API still returns the row so the modal poll and the restart
    // poller can track it.
    const connectedAccts = (!isMeta && s.accounts) ? s.accounts.filter(a => a.status === 'connected') : [];
    let acctHtml = '';
    if (connectedAccts.length) {
      acctHtml = '<div class="acct-list">' + connectedAccts.map(a => `
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
    // AI surface: hidden entirely without the ai_response feature.
    const commentPanel = (ch === 'messenger' && s.status === 'connected' && hasFeature('ai_response'))
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
    // Card header pill: only connected accounts count — a half-finished
    // connect must never paint the card 'pending' from its dead row.
    const accts = connectedAccts.length ? connectedAccts : null;
    const headStatus = accts ? 'connected' : s.status;
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
