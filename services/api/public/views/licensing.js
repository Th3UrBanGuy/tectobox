// Tectobox frontend — views/licensing.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

// ---------------- admin: plans & licenses (simple) ----------------
let _licFeatures = null;
async function licFeatureList() {
  if (!_licFeatures) _licFeatures = await api('/api/admin/features');
  return _licFeatures;
}
const KIND_LABEL = { time: 'Package', credit: 'Credit System', feature: 'Feature Based' };
const PERIOD_LABEL = { monthly: 'Monthly', quarterly: '3-Monthly', yearly: 'Yearly' };
let _createMode = 'package';   // 'package' | 'credit'
let _createPeriod = 'monthly';

async function loadAdminLicensing() {
  const [features, plans, licenses, workspaces] = await Promise.all([
    licFeatureList(), api('/api/admin/plans'), api('/api/admin/licenses'), api('/api/admin/workspaces').catch(() => []),
  ]);
  const wsSel = $('crt-workspace');
  if (wsSel) {
    const curVal = wsSel.value;
    wsSel.innerHTML = '<option value="">Save as plan template only</option>' +
      (workspaces || []).map(w => `<option value="${w.client_id || w.id}">Issue to: ${esc(w.client_name || w.username || ('#' + (w.client_id || w.id)))}</option>`).join('');
    if (curVal) wsSel.value = curVal;
  }
  renderCreateSection(features);
  renderPlanCards(plans);
  renderLicensesTable(licenses);
  wireGenKeyForm(plans, workspaces);
}
// --- generate a license key (key-only: the client activates it themselves) ---
function wireGenKeyForm(plans, workspaces) {
  const wsSel = $('genkey-ws'), planSel = $('genkey-plan');
  if (!wsSel || !planSel) return;
  const curWs = wsSel.value, curPlan = planSel.value;
  wsSel.innerHTML = '<option value="">Pick a workspace…</option>' +
    (workspaces || []).map(w => `<option value="${w.client_id || w.id}">${esc(w.client_name || w.username || ('#' + (w.client_id || w.id)))}</option>`).join('');
  planSel.innerHTML = '<option value="">Pick a package…</option>' +
    (plans || []).filter(p => p.active).map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  if (curWs) wsSel.value = curWs;
  if (curPlan) planSel.value = curPlan;
  const daysSel = $('genkey-days'), customRow = $('genkey-custom-row');
  if (daysSel) daysSel.onchange = () => { if (customRow) customRow.classList.toggle('hidden', daysSel.value !== 'custom'); };
  const btn = $('btn-genkey');
  if (!btn) return;
  btn.onclick = async () => {
    const msgEl = $('genkey-msg'), resEl = $('genkey-result');
    const clientId = Number(wsSel.value), planId = Number(planSel.value);
    let days = Number(daysSel.value);
    if (daysSel.value === 'custom') days = Number($('genkey-custom-days').value);
    if (!clientId || !planId || !(days > 0)) { msgEl.textContent = 'Pick a workspace, a package and a validity.'; return; }
    btn.disabled = true;
    btn.textContent = 'Generating…';
    msgEl.textContent = '';
    resEl.innerHTML = '';
    try {
      const res = await api('/api/admin/licenses', { method: 'POST', body: JSON.stringify({ client_id: clientId, plan_id: planId, days, deliver: 'key-only' }) });
      const code = res.code || (res.license && res.license.code) || '';
      resEl.innerHTML = `<div class="notice" style="margin-top:10px;"><span>License key — hand it to the client after payment:<br><code id="genkey-code" style="user-select:all;">${esc(code)}</code></span></div>
        <button class="btn-soft" id="genkey-copy" style="margin-top:8px;">Copy key</button>`;
      $('genkey-copy').onclick = async () => {
        try { await navigator.clipboard.writeText(code); toast('Key copied.', 'ok'); }
        catch {
          const el = $('genkey-code');
          if (el) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
        }
      };
      await loadAdminLicensing();
    } catch (e) { msgEl.textContent = 'Failed: ' + e.message; }
    finally { btn.disabled = false; btn.textContent = 'Generate key'; }
  };
}
// Test-license picker value from the create-user modal (minutes, or null).
function selectedTrialMinutes() {
  const sel = document.querySelector('#um-trial-chips .chip.sel');
  if (!sel) return null;
  if (sel.dataset.min === 'custom') {
    const n = Number($('um-trial-custom').value);
    return n > 0 ? n : null;
  }
  const n = Number(sel.dataset.min);
  return n > 0 ? n : null;
}
function featureCheckGrid(elId, features, checked) {
  $(elId).innerHTML = (features || []).map(f => {
    const k = f.key || f.id || '';
    const l = f.label || f.name || k;
    const d = f.desc || f.description || '';
    return `<label class="check"><input type="checkbox" value="${esc(k)}" ${checked ? 'checked' : ''}>
      <span><b>${esc(l)}</b><small>${esc(d)}</small></span></label>`;
  }).join('');
}
function checkedFeatures(elId) {
  return [...document.querySelectorAll(`#${elId} input:checked`)].map(i => i.value);
}
function planKindMeta(p) {
  if (p.kind === 'time') return PERIOD_LABEL[p.billing_period] || 'Monthly';
  if (p.kind === 'credit') return `${p.credits_included} credits`;
  return 'Per-feature';
}
// --- single Create: Package | Credit System toggle, form adapts ---
function renderCreateSection(features) {
  featureCheckGrid('crt-features', features, true);
  document.querySelectorAll('#crt-mode .mode-opt').forEach(b => b.onclick = () => {
    _createMode = b.dataset.mode;
    document.querySelectorAll('#crt-mode .mode-opt').forEach(x => x.classList.toggle('sel', x === b));
    $('crt-period-row').classList.toggle('hidden', _createMode !== 'package');
    $('crt-credits-row').classList.toggle('hidden', _createMode !== 'credit');
  });
  document.querySelectorAll('#crt-period-chips .chip').forEach(b => b.onclick = () => {
    _createPeriod = b.dataset.p;
    document.querySelectorAll('#crt-period-chips .chip').forEach(x => x.classList.toggle('sel', x === b));
  });
  $('crt-msg').textContent = '';
  $('btn-create').onclick = async () => {
    const name = $('crt-name').value.trim();
    if (!name) { $('crt-msg').textContent = 'Give it a name first.'; return; }
    const targetWs = $('crt-workspace') ? $('crt-workspace').value : '';
    const body = _createMode === 'package'
      ? { name, kind: 'time', billing_period: _createPeriod, features: checkedFeatures('crt-features'), price_bdt: Number($('crt-price').value) || 0 }
      : { name, kind: 'credit', credits_included: Math.max(1, Number($('crt-credits').value) || 0), features: checkedFeatures('crt-features'), price_bdt: Number($('crt-price').value) || 0 };
    if (_createMode === 'credit' && !(Number($('crt-credits').value) > 0)) { $('crt-msg').textContent = 'Enter how many credits.'; return; }
    $('crt-msg').textContent = 'Creating…';
    try {
      const plan = await api('/api/admin/plans', { method: 'POST', body: JSON.stringify(body) });
      if (targetWs) {
        const lic = await api(`/api/admin/clients/${targetWs}/assign-license`, { method: 'POST', body: JSON.stringify({ planId: plan.id }) });
        toast(`License issued: ${lic.code} to workspace!`, 'ok');
      } else {
        toast(`Package "${plan.name}" created!`, 'ok');
      }
      $('crt-name').value = ''; $('crt-credits').value = ''; $('crt-price').value = '';
      $('crt-msg').textContent = '';
      await loadAdminLicensing();
      loadAdmin();
    } catch (e) { $('crt-msg').textContent = 'Failed: ' + e.message; }
  };
}
// --- existing plans ---
function renderPlanCards(plans) {
  $('plans-grid').innerHTML = plans.map(p => `
    <div class="plan-card">
      <div class="pn">${esc(p.name)}</div>
      <div class="prow"><span class="pill blue">${esc(KIND_LABEL[p.kind] || p.kind)}</span>
        <span class="pill">${esc(planKindMeta(p))}</span>${p.active ? '' : '<span class="pill red">OFF</span>'}</div>
      <div class="pmeta">${(p.features || []).length} features${p.price_bdt ? ' · ৳' + esc(String(p.price_bdt)) : ''}</div>
      <button class="btn-soft danger pdel" data-plandel="${p.id}">Delete package</button>
    </div>`).join('') || '<div class="card"><p class="muted">No packages yet — create one above.</p></div>';
  document.querySelectorAll('[data-plandel]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this plan? Issued licenses keep working.')) return;
    try { await api(`/api/admin/plans/${b.dataset.plandel}`, { method: 'DELETE' }); loadAdminLicensing(); }
    catch (e) { toast('Failed: ' + e.message, 'err'); }
  });
}
// --- assign license from a workspace card ---
async function openAssignModal(clientId, workspaces) {
  const w = workspaces.find(x => x.client_id === clientId);
  const nm = w ? (w.client_name || w.username) : ('#' + clientId);
  $('assign-sub').textContent = `Pick a package for "${nm}". It becomes the workspace's license right away.`;
  const cur = w && w.license
    ? `<div class="ws-lic"><code>${esc(w.license.code)}</code><span class="muted">${esc(w.license.plan_name || '')} · ${esc(w.license.status)}</span></div>`
    : '<div class="ws-lic"><span class="muted">No license yet</span></div>';
  $('assign-current').innerHTML = cur;
  let plans = [];
  try { plans = (await api('/api/admin/plans')).filter(p => p.active); }
  catch (e) { toast('Failed to load plans: ' + e.message, 'err'); return; }
  $('assign-plans').innerHTML = plans.map(p => `
    <div class="plan-card" style="margin-bottom:10px;">
      <div class="pn">${esc(p.name)}</div>
      <div class="prow"><span class="pill blue">${esc(KIND_LABEL[p.kind] || p.kind)}</span>
        <span class="pill">${esc(planKindMeta(p))}</span></div>
      <div class="pmeta">${(p.features || []).length} features${p.price_bdt ? ' · ৳' + esc(String(p.price_bdt)) : ''}</div>
      <button class="btn-primary btn-soft-assign" data-assign="${p.id}" style="width:100%;">Assign this plan</button>
    </div>`).join('') || '<p class="muted">No packages yet — create one in Packages & licenses.</p>';
  document.querySelectorAll('[data-assign]').forEach(b => b.onclick = async () => {
    const p = plans.find(x => x.id === Number(b.dataset.assign));
    if (!confirm(`Assign "${p ? p.name : ''}" to "${nm}"?` + (w && w.license ? '\nThe current license will be retired.' : ''))) return;
    try {
      const lic = await api(`/api/admin/clients/${clientId}/assign-license`, { method: 'POST', body: JSON.stringify({ planId: b.dataset.assign }) });
      $('assign-modal').classList.add('hidden');
      toast('Assigned: ' + lic.code);
      loadAdmin();
    } catch (e) { toast('Failed: ' + e.message, 'err'); }
  });
  $('assign-modal').classList.remove('hidden');
}
// --- licenses table ---
function licenseValidity(l) {
  if (l.kind === 'time') {
    if (!l.ends_at) return '—';
    const left = Math.max(0, Math.ceil((new Date(l.ends_at) - Date.now()) / 86400000));
    return `until ${fmtDate(l.ends_at)} · ${left}d left`;
  }
  if (l.kind === 'credit') return `${l.credits_used}/${l.credits_total} used`;
  return (l.feature_grants || []).map(g =>
    `${esc(g.feature)}: ${g.mode === 'unlimited' ? '∞' : g.credits_used + '/' + g.credits_total}`).join('<br>') || '—';
}
function renderLicensesTable(licenses) {
  const pill = (s) => {
    if (s === 'pending_activation') return `<span class="pill blue">Issued — awaiting activation</span>`;
    return `<span class="pill ${s === 'active' ? 'green' : s === 'paused' ? 'amber' : 'red'}">${esc(s.toUpperCase())}</span>`;
  };
  $('licenses-body').innerHTML = licenses.map(l => `
    <tr>
      <td data-label="Code"><b style="color:var(--ink); font-family:monospace;">${esc(l.code)}</b></td>
      <td data-label="Workspace" class="muted">#${l.client_id} · ${esc(l.client_name || '—')}</td>
      <td data-label="Plan" class="muted">${esc(l.plan_name || 'Custom')} <span class="pill blue" style="font-size:10px;">${esc(KIND_LABEL[l.kind] || l.kind)}</span></td>
      <td data-label="Validity / Credits" class="small muted">${licenseValidity(l)}</td>
      <td data-label="Status">${pill(l.status)}</td>
      <td data-label=""><div style="display:flex; gap:6px; flex-wrap:wrap;">
        ${l.status === 'active' ? `<button class="btn-soft" data-licpause="${l.id}">Pause</button>` : ''}
        ${l.status === 'paused' ? `<button class="btn-soft" data-licresume="${l.id}">Resume</button>` : ''}
        ${l.status === 'pending_activation' ? `<button class="btn-soft danger" data-licrevoke="${l.id}">Revoke</button>` : ''}
        ${l.kind !== 'time' ? `<button class="btn-soft" data-lictopup="${l.id}">+ Credits</button>` : ''}
        ${['active', 'paused'].includes(l.status) ? `<button class="btn-soft danger" data-liccancel="${l.id}">Cancel</button>` : ''}
      </div></td>
    </tr>`).join('') || '<tr><td colspan="6" class="tbl-empty">No licenses issued yet.</td></tr>';
  document.querySelectorAll('[data-licpause]').forEach(b => b.onclick = () => licAction(b.dataset.licpause, 'pause'));
  document.querySelectorAll('[data-licresume]').forEach(b => b.onclick = () => licAction(b.dataset.licresume, 'resume'));
  document.querySelectorAll('[data-licrevoke]').forEach(b => b.onclick = async () => {
    if (!confirm('Revoke this issued key? The client will not be able to activate it.')) return;
    licAction(b.dataset.licrevoke, 'cancel');
  });
  document.querySelectorAll('[data-liccancel]').forEach(b => b.onclick = async () => {
    if (!confirm('Cancel this license? The workspace loses its licensed features.')) return;
    licAction(b.dataset.liccancel, 'cancel');
  });
  document.querySelectorAll('[data-lictopup]').forEach(b => b.onclick = async () => {
    const n = prompt('Add how many credits?');
    if (!n || !(Number(n) > 0)) return;
    try { await api(`/api/admin/licenses/${b.dataset.lictopup}/topup`, { method: 'POST', body: JSON.stringify({ credits: Number(n) }) }); loadAdminLicensing(); }
    catch (e) { toast('Failed: ' + e.message, 'err'); }
  });
}
async function licAction(id, action) {
  try { await api(`/api/admin/licenses/${id}/${action}`, { method: 'POST' }); loadAdminLicensing(); }
  catch (e) { toast('Failed: ' + e.message, 'err'); }
}
async function loadNotifyTab() {
  const sel = $('nt-target');
  sel.innerHTML = '<option value="all">All workspaces</option>';
  try {
    const users = await api('/api/admin/users');
    const seen = {};
    (users.users || users || []).forEach(u => {
      const cid = u.client_id || u.clientId;
      if (isAdmin(u.role) || !cid || seen[cid]) return;
      seen[cid] = 1;
      const o = document.createElement('option');
      o.value = cid; o.textContent = 'Workspace #' + cid + ' (' + (u.username || '') + ')';
      sel.appendChild(o);
    });
  } catch {}
  $('btn-send-notif').onclick = async () => {
    const body = $('nt-body').value.trim();
    if (!body) { $('nt-status').textContent = 'Write a message first.'; return; }
    $('btn-send-notif').disabled = true;
    try {
      const target = $('nt-target').value;
      const r = await api('/api/admin/notify', { method: 'POST',
        body: JSON.stringify({ target: target === 'all' ? 'all' : undefined,
          client_id: target === 'all' ? undefined : +target,
          title: $('nt-title').value.trim() || 'Tectobox', body }) });
      $('nt-status').textContent = r && r.ok ? `Sent to ${r.sent} device(s).` : 'Send failed.';
      if (r && r.ok) $('nt-body').value = '';
    } catch (e) { $('nt-status').textContent = 'Send failed: ' + (e.message || ''); }
    $('btn-send-notif').disabled = false;
  };
}
async function loadAdminConfig() {
  const c = await api('/api/admin/config');
  $('cfg-autoreply').checked = !!c.autoReply;
  $('cfg-model').value = c.aiModel || '';
  $('cfg-modelpool').value = c.aiModelPool || '';
  $('cfg-baseurl').value = c.aiBaseUrl || '';
  $('cfg-msg').textContent = '';
  let urls = {};
  try { urls = await api('/api/webhook-urls'); } catch {}
  $('admin-webhook-urls').innerHTML = `
    <div class="code-box"><span class="cl">Meta (Messenger + Instagram)</span>${esc(urls.meta || '—')}</div>
    <div class="code-box"><span class="cl">Telegram bot</span>${esc(urls.telegram || '—')}</div>`;
  loadTotpBox();
}
