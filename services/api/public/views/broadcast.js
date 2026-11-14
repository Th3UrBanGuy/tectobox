// Tectobox frontend — views/broadcast.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

// ---------------- client: Broadcast campaigns ----------------
async function renderBroadcast() {
  if (!hasFeature('broadcast')) {
    showView(firstAvailableView());
    return;
  }
  let list = [];
  try { list = await api('/api/broadcasts'); } catch (e) { $('bcast-list').innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  // A non-array payload used to crash the view with "list.map is not a
  // function" (same class as the 2026-11-13 KB crash) — degrade to empty.
  if (!Array.isArray(list)) list = [];
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
    // Messenger / Instagram are "Coming soon" (META_CONNECTORS_VISIBLE is
    // false) — the options are disabled, but guard anyway in case a stale
    // value is submitted.
    if (channel === 'messenger' || channel === 'instagram') { toast('Messenger and Instagram broadcasts are coming soon — pick WhatsApp, Telegram, or All channels.', 'err'); return; }
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
