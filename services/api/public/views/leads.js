// Tectobox frontend — views/leads.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

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
  // Empty workspace: say so instead of silently "downloading" a headers-only file.
  if (!state.leads.length) { toast('No leads to export yet.'); return; }
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
  try {
    const csv = rows.map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'leads.csv';
    // Must be in the DOM and the blob URL must outlive the click: revoking
    // synchronously after click() aborts the download in some browsers,
    // which made the button look dead.
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Downloaded ${state.leads.length} lead${state.leads.length === 1 ? '' : 's'} as CSV`);
  } catch (e) { toast('CSV export failed: ' + (e && e.message ? e.message : 'unknown error'), 'err'); }
}
