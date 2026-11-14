// Tectobox frontend — views/kb.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

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
  // A non-array payload (backend hiccup) used to crash the whole KB view
  // with "state.knowledge.map is not a function" (2026-11-13 click audit).
  if (!Array.isArray(state.knowledge)) state.knowledge = [];
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
