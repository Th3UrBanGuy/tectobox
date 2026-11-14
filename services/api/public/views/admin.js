// Tectobox frontend — views/admin.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

// ---------------- admin ----------------
async function loadAdmin() {
  const [ov, workspaces, resources] = await Promise.all([
    api('/api/admin/overview'), api('/api/admin/workspaces'), api('/api/admin/resources'),
  ]);
  const stats = [
    ['Workspaces', ov.workspaces, ''],
    ['Channels', ov.channels, ''],
    ['Connected', ov.connected, 'green'],
    ['Errored', ov.errored, 'red'],
  ];
  $('admin-stats').innerHTML = stats.map(([l, v, cls]) =>
    `<div class="hstat"><div class="lbl">${l}</div><div class="num ${cls}">${v}</div></div>`).join('');
  renderWorkspaces(workspaces);
  renderAdminResources(resources);
  switchAdminTab(state.adminTab);
}
function renderAdminResources(resources) {
  $('resources-body').innerHTML = resources.map(r => {
    const m = PLATFORMS[r.channel] || {};
    return `<tr>
      <td data-label="Channel"><span style="display:inline-flex; align-items:center; gap:10px;">${platBadge(r.channel, 34)}<b style="color:var(--ink);">${esc(m.label || r.channel)}</b></span></td>
      <td data-label="Account" class="muted">${esc(r.account || '—')}</td>
      <td data-label="Workspace" class="muted">@${esc(r.workspace || '—')}</td>
      <td data-label="Status">${statusPill(r.status)}</td>
      <td data-label="Last seen" class="small muted">${fmtDT(r.lastSeen)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="tbl-empty">No channel resources yet.</td></tr>';
}
function renderWorkspaces(workspaces) {
  // Unified workspace cards: license + AI pause + suspend + login toggle,
  // everything about one workspace in one place.
  const grid = $('users-grid');
  grid.innerHTML = workspaces.map(w => {
    const nm = w.client_name || w.username;
    const hue = avatarHue(nm);
    const lic = w.license;
    const licPill = !lic ? '<span class="pill">No license</span>'
      : `<span class="pill ${lic.status === 'active' ? 'green' : lic.status === 'paused' ? 'amber' : 'red'}">${esc(lic.code)}</span>`;
    const aiPill = w.suspended ? '<span class="pill red">Suspended</span>'
      : w.ai_paused ? '<span class="pill amber">AI paused</span>'
      : w.ai_allowed ? '<span class="pill green">AI on</span>' : '<span class="pill amber">AI off</span>';
    const licLine = !lic ? '<span class="muted">Legacy — full access, no license issued</span>'
      : `<code>${esc(lic.code)}</code><span class="muted">${esc(lic.plan_name || KIND_LABEL[lic.kind] || lic.kind)}${lic.kind === 'time' && lic.ends_at ? ' · until ' + esc(fmtDate(lic.ends_at)) : ''}${lic.kind === 'credit' ? ' · ' + lic.credits_used + '/' + lic.credits_total + ' credits' : ''}</span>`;
    const delAt = w.delete_scheduled_at ? new Date(w.delete_scheduled_at) : null;
    const delDays = delAt ? Math.max(0, Math.ceil((delAt - Date.now()) / 86400000)) : 0;
    const delBanner = delAt ? `<div class="ws-del-banner">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
      <span><b>Permanent deletion in ${delDays} day${delDays === 1 ? '' : 's'}</b><small>Workspace is off. All data will be wiped.</small></span>
      <button class="btn-soft" data-wsundel="${w.client_id}">Cancel deletion</button>
    </div>` : '';
    const budget = w.ai_budget;
    const budgetText = budget ? `${budget.used}/${budget.cap} AI replies today` : '—';
    const budgetCtl = budget ? `<div class="ws-ctl">
          <div><b>AI budget</b><small>${esc(budgetText)} — caps daily AI spend</small></div>
          <div class="spacer"></div>
          <button class="btn-soft" data-wsbudget="${w.client_id}" data-cap="${budget.cap}">Edit</button>
        </div>` : '';
    return `<div class="ws-card fade-in ${w.suspended ? 'suspended' : ''}">
      ${delBanner}
      <div class="ws-top">
        <span class="ws-avatar" style="background:linear-gradient(135deg,hsl(${hue},65%,55%),hsl(${(hue + 40) % 360},65%,45%));">${esc(avatarInitials(nm))}</span>
        <div style="min-width:0;flex:1;">
          <div class="ws-name">${esc(nm)}</div>
          <div class="ws-sub">@${esc(w.username)} · workspace #${w.client_id || '—'}</div>
        </div>
      </div>
      <div class="ws-pills">${licPill}${aiPill}${w.active ? '' : '<span class="pill red">LOGIN OFF</span>'}</div>
      <div class="ws-lic">${licLine}</div>
      <div class="ws-controls">
        <div class="ws-ctl">
          <div><b>AI replies</b><small>${w.ai_paused ? 'Paused — inbox still works' : 'AI answers customers'}</small></div>
          <div class="spacer"></div>
          <label class="switch" title="Pause AI for this workspace"><input type="checkbox" data-wsai="${w.client_id}" ${w.ai_paused ? 'checked' : ''} ${w.suspended ? 'disabled' : ''}><span class="sl"></span></label>
        </div>
        ${budgetCtl}
        <div class="ws-ctl">
          <div><b>Workspace</b><small>${w.suspended ? 'Switched OFF — logins blocked' : 'Running normally'}</small></div>
          <div class="spacer"></div>
          <label class="switch" title="Switch workspace off/on"><input type="checkbox" data-wssus="${w.client_id}" ${w.suspended ? '' : 'checked'}><span class="sl"></span></label>
        </div>
        <div class="ws-ctl">
          <div><b>User login</b><small>${w.active ? 'Can sign in' : 'Sign-in disabled'}</small></div>
          <div class="spacer"></div>
          <label class="switch" title="Enable/disable login"><input type="checkbox" data-wsuser="${w.id}" ${w.active ? 'checked' : ''}><span class="sl"></span></label>
        </div>
      </div>
      <div class="ws-actions">
        <button class="btn-soft" data-wsassign="${w.client_id}">Assign license</button>
        <button class="btn-soft" data-wspw="${w.id}">Reset password</button>
        ${delAt ? '' : `<button class="btn-soft danger" data-wsdel="${w.client_id}">Delete</button>`}
      </div>
    </div>`;
  }).join('') || '<div class="card"><p class="muted">No workspaces yet.</p></div>';
  document.querySelectorAll('[data-wsai]').forEach(t => t.onchange = async () => {
    try {
      await api(`/api/admin/clients/${t.dataset.wsai}/ai-pause`, { method: 'POST', body: JSON.stringify({ paused: t.checked }) });
      toast(t.checked ? 'AI paused — inbox keeps working' : 'AI resumed');
      loadAdmin();
    } catch (e) { toast('Failed: ' + e.message, 'err'); loadAdmin(); }
  });
  document.querySelectorAll('[data-wssus]').forEach(t => t.onchange = async () => {
    const turnOff = !t.checked;
    if (turnOff && !confirm('Switch this workspace OFF? Its users will be signed out immediately and the widget, API and AI stop working. Data is kept.')) { t.checked = true; return; }
    try {
      await api(`/api/admin/clients/${t.dataset.wssus}/suspend`, { method: 'POST', body: JSON.stringify({ suspended: turnOff }) });
      toast(turnOff ? 'Workspace switched OFF' : 'Workspace switched ON');
      loadAdmin();
    } catch (e) { toast('Failed: ' + e.message, 'err'); loadAdmin(); }
  });
  document.querySelectorAll('[data-wsuser]').forEach(t => t.onchange = async () => {
    try { await api(`/api/admin/users/${t.dataset.wsuser}/toggle`, { method: 'POST' }); loadAdmin(); }
    catch (e) { toast('Failed: ' + e.message, 'err'); loadAdmin(); }
  });
  document.querySelectorAll('[data-wsbudget]').forEach(b => b.onclick = async () => {
    const cur = b.dataset.cap;
    const v = prompt(`Daily AI reply budget for this workspace (used to cap AI spend):`, cur);
    if (v === null) return;
    const cap = Math.floor(Number(v));
    if (!Number.isFinite(cap) || cap < 0 || cap > 100000) { toast('Enter a number 0–100000', 'err'); return; }
    try {
      await api(`/api/admin/clients/${b.dataset.wsbudget}/ai-budget`, { method: 'PUT', body: JSON.stringify({ cap }) });
      toast(`AI budget set to ${cap}/day`);
      loadAdmin();
    } catch (e) { toast('Failed: ' + e.message, 'err'); }
  });
  document.querySelectorAll('[data-wsassign]').forEach(b => b.onclick = () => openAssignModal(Number(b.dataset.wsassign), workspaces));
  document.querySelectorAll('[data-wspw]').forEach(b => b.onclick = () => {
    state.pwUserId = Number(b.dataset.wspw);
    const w = workspaces.find(x => x.id === state.pwUserId);
    $('pw-sub').textContent = `Set a new password for @${w ? w.username : ''}.`;
    $('pw-new').value = '';
    $('pw-modal').classList.remove('hidden');
  });
  document.querySelectorAll('[data-wsdel]').forEach(b => b.onclick = async () => {
    const w = workspaces.find(x => x.client_id === Number(b.dataset.wsdel));
    const name = w ? (w.client_name || w.username) : ('#' + b.dataset.wsdel);
    if (!confirm(`Delete workspace "${name}"?\n\nIt switches OFF immediately and is permanently wiped after 15 days. You can cancel anytime during the wait.`)) return;
    if (!confirm(`Last check — really queue "${name}" for deletion?`)) return;
    try {
      await api(`/api/admin/clients/${b.dataset.wsdel}/delete-schedule`, { method: 'POST' });
      toast('Deletion scheduled — 15 day grace period');
      loadAdmin();
    } catch (e) { toast('Failed: ' + e.message, 'err'); }
  });
  document.querySelectorAll('[data-wsundel]').forEach(b => b.onclick = async () => {
    if (!confirm('Cancel the scheduled deletion? The workspace will be switched back ON.')) return;
    try {
      await api(`/api/admin/clients/${b.dataset.wsundel}/delete-cancel`, { method: 'POST' });
      toast('Deletion cancelled — workspace restored');
      loadAdmin();
    } catch (e) { toast('Failed: ' + e.message, 'err'); }
  });
}
function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return iso; }
}

function switchAdminTab(tab) {
  state.adminTab = tab;
  document.querySelectorAll('#admin-tabs button').forEach(b => b.classList.toggle('active', b.dataset.at === tab));
  $('atab-resources').classList.toggle('hidden', tab !== 'resources');
  $('atab-users').classList.toggle('hidden', tab !== 'users');
  $('atab-licensing').classList.toggle('hidden', tab !== 'licensing');
  $('atab-config').classList.toggle('hidden', tab !== 'config');
  $('atab-notify').classList.toggle('hidden', tab !== 'notify');
  $('atab-audit').classList.toggle('hidden', tab !== 'audit');
  $('atab-watchdog').classList.toggle('hidden', tab !== 'watchdog');
  if (tab === 'config') loadAdminConfig();
  if (tab === 'notify') loadNotifyTab();
  if (tab === 'audit') loadAdminAudit();
  if (tab === 'licensing') loadAdminLicensing();
  if (tab === 'watchdog') loadAdminWatchdog();
}

async function loadAdminWatchdog() {
  const hud = $('watchdog-hud');
  if (!hud) return;
  try {
    hud.innerHTML = '<div style="text-align:center; padding:40px;" class="muted">Fetching real-time Watchdog telemetry…</div>';
    const [metrics, errorsRes] = await Promise.all([
      api('/api/diagnostics/watchdog'),
      api('/api/diagnostics/errors').catch(() => ({ errors: [] })),
    ]);

    const statusCls = metrics.status === 'HEALTHY' ? 'status-pill-healthy' : metrics.status === 'DEGRADED' ? 'status-pill-degraded' : 'status-pill-critical';
    const statusText = metrics.status || 'UNKNOWN';

    const recentErrors = (errorsRes && errorsRes.errors) ? errorsRes.errors : [];
    const slowRequests = metrics.recentSlowRequests || metrics.slowRequests || [];
    const rawEndpoints = metrics.endpoints || {};
    const endpoints = Array.isArray(rawEndpoints)
      ? rawEndpoints
      : Object.entries(rawEndpoints).map(([endpoint, stat]) => ({
          endpoint,
          hits: stat.hits || 0,
          avgDurationMs: stat.avgDurationMs || 0,
          errors: stat.errors || 0,
          lastAccess: stat.lastAccess || new Date().toISOString(),
        })).sort((a, b) => b.hits - a.hits);

    const memRss = metrics.memory?.rssMb ?? metrics.memoryRssMb ?? 0;
    const memHeap = metrics.memory?.heapUsedMb ?? metrics.memoryHeapMb ?? 0;

    hud.innerHTML = `
      <div class="watchdog-header" style="display:flex; align-items:center; justify-content:space-between; margin-bottom:20px; flex-wrap:wrap; gap:12px;">
        <div>
          <h2 style="font-size:20px; font-weight:800; color:var(--ink); margin:0 0 4px; display:flex; align-items:center; gap:10px;">
            <span>⚡ Watchdog Telemetry &amp; System Health</span>
            <span class="watchdog-status-badge ${statusCls}">${esc(statusText)}</span>
          </h2>
          <p class="muted small" style="margin:0;">Real-time API throughput, response latencies, anomalies, and live sanity error buffer.</p>
        </div>
        <button class="btn-sm btn-ghost" id="btn-refresh-watchdog" style="display:flex; align-items:center; gap:6px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          <span>Refresh Live</span>
        </button>
      </div>

      <div class="watchdog-stats-grid">
        <div class="watchdog-stat-card">
          <div class="stat-card-label">Active Requests</div>
          <div class="stat-card-val">${metrics.activeRequests ?? 0}</div>
          <div class="stat-card-sub">In-flight HTTP streams</div>
        </div>
        <div class="watchdog-stat-card">
          <div class="stat-card-label">Throughput</div>
          <div class="stat-card-val">${metrics.requestsPerMinute ?? 0} <span style="font-size:13px; font-weight:500;">RPM</span></div>
          <div class="stat-card-sub">Rolling 60-second window</div>
        </div>
        <div class="watchdog-stat-card">
          <div class="stat-card-label">Total Requests</div>
          <div class="stat-card-val">${metrics.totalRequests ?? 0}</div>
          <div class="stat-card-sub">Since process startup</div>
        </div>
        <div class="watchdog-stat-card">
          <div class="stat-card-label">Avg Latency</div>
          <div class="stat-card-val">${metrics.avgLatencyMs ?? 0}<span style="font-size:13px; font-weight:500;">ms</span></div>
          <div class="stat-card-sub">p95: ${metrics.p95LatencyMs ?? 0}ms &bull; max: ${metrics.maxLatencyMs ?? 0}ms</div>
        </div>
        <div class="watchdog-stat-card">
          <div class="stat-card-label">Memory RSS</div>
          <div class="stat-card-val">${memRss}<span style="font-size:13px; font-weight:500;">MB</span></div>
          <div class="stat-card-sub">Heap: ${memHeap}MB</div>
        </div>
      </div>

      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap:12px; margin-bottom:24px;">
        <div class="stat-mini-badge" style="background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px;">
          <div class="muted small" style="font-size:11px; font-weight:600; text-transform:uppercase;">2xx Success</div>
          <div style="font-size:18px; font-weight:800; color:#10b981;">${metrics.statusCodes?.['2xx'] ?? 0}</div>
        </div>
        <div class="stat-mini-badge" style="background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px;">
          <div class="muted small" style="font-size:11px; font-weight:600; text-transform:uppercase;">3xx Redirect</div>
          <div style="font-size:18px; font-weight:800; color:#6366f1;">${metrics.statusCodes?.['3xx'] ?? 0}</div>
        </div>
        <div class="stat-mini-badge" style="background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px;">
          <div class="muted small" style="font-size:11px; font-weight:600; text-transform:uppercase;">4xx Client Error</div>
          <div style="font-size:18px; font-weight:800; color:#f59e0b;">${metrics.statusCodes?.['4xx'] ?? 0}</div>
        </div>
        <div class="stat-mini-badge" style="background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px;">
          <div class="muted small" style="font-size:11px; font-weight:600; text-transform:uppercase;">5xx Server Error</div>
          <div style="font-size:18px; font-weight:800; color:#ef4444;">${metrics.statusCodes?.['5xx'] ?? 0}</div>
        </div>
      </div>

      <div class="watchdog-section mb24">
        <h3 style="font-size:15px; font-weight:700; margin:0 0 12px; color:var(--ink);">Top Endpoint Activity</h3>
        <div class="tbl-card" style="overflow-x:auto;">
          <table>
            <thead>
              <tr>
                <th>Method &amp; Path</th>
                <th>Hits</th>
                <th>Avg Duration</th>
                <th>Errors</th>
                <th>Last Accessed</th>
              </tr>
            </thead>
            <tbody>
              ${endpoints.length === 0 ? '<tr><td colspan="5" class="muted text-center" style="padding:20px;">No endpoint traffic recorded yet.</td></tr>' :
                endpoints.slice(0, 15).map(ep => `
                  <tr>
                    <td><code>${esc(ep.endpoint)}</code></td>
                    <td><strong>${ep.hits}</strong></td>
                    <td>${ep.avgDurationMs}ms</td>
                    <td>${ep.errors > 0 ? `<span class="badge badge-danger">${ep.errors}</span>` : '<span class="badge badge-success">0</span>'}</td>
                    <td class="muted small">${new Date(ep.lastAccess).toLocaleTimeString()}</td>
                  </tr>
                `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="watchdog-section mb24">
        <h3 style="font-size:15px; font-weight:700; margin:0 0 12px; color:var(--ink);">Slow Requests &amp; Latency Anomalies (&ge; 1000ms)</h3>
        <div class="tbl-card" style="overflow-x:auto;">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Route</th>
                <th>Status</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              ${slowRequests.length === 0 ? '<tr><td colspan="4" class="muted text-center" style="padding:20px;">No slow requests detected — all APIs responding fast.</td></tr>' :
                slowRequests.slice().reverse().slice(0, 10).map(sq => `
                  <tr>
                    <td class="muted small">${new Date(sq.timestamp).toLocaleTimeString()}</td>
                    <td><code>${esc(sq.method)} ${esc(sq.path)}</code></td>
                    <td><span class="badge ${sq.statusCode >= 500 ? 'badge-danger' : 'badge-neutral'}">${sq.statusCode}</span></td>
                    <td><strong style="color:#f59e0b;">${sq.durationMs}ms</strong></td>
                  </tr>
                `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="watchdog-section">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <h3 style="font-size:15px; font-weight:700; margin:0; color:var(--ink);">Error &amp; Sanity Buffer (${recentErrors.length})</h3>
          <button class="btn-xs btn-outline" id="btn-clear-err-buffer">Clear Buffer</button>
        </div>
        <div class="tbl-card" style="overflow-x:auto;">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Source</th>
                <th>Type</th>
                <th>Message</th>
                <th>Path</th>
              </tr>
            </thead>
            <tbody>
              ${recentErrors.length === 0 ? '<tr><td colspan="5" class="muted text-center" style="padding:20px;">Buffer clean — zero active runtime exceptions recorded.</td></tr>' :
                recentErrors.slice().reverse().slice(0, 15).map(er => `
                  <tr>
                    <td class="muted small">${new Date(er.timestamp).toLocaleTimeString()}</td>
                    <td><span class="badge ${er.source === 'frontend' ? 'badge-amber' : 'badge-blue'}">${esc(er.source || 'backend')}</span></td>
                    <td><code>${esc(er.type || 'Error')}</code></td>
                    <td style="max-width:320px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(er.message)}">${esc(er.message)}</td>
                    <td class="muted small"><code>${esc(er.path || '-')}</code></td>
                  </tr>
                `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    const rBtn = $('btn-refresh-watchdog');
    if (rBtn) rBtn.onclick = () => loadAdminWatchdog();

    const cBtn = $('btn-clear-err-buffer');
    if (cBtn) {
      cBtn.onclick = async () => {
        try {
          await api('/api/diagnostics/errors', { method: 'DELETE' });
          toast('Error buffer cleared');
          loadAdminWatchdog();
        } catch (e) {
          toast('Failed: ' + e.message, 'err');
        }
      };
    }
  } catch (err) {
    hud.innerHTML = `<div class="notice warn">Failed to load Watchdog telemetry: ${esc(err.message)}</div>`;
  }
}

// ---- admin two-factor (TOTP) ----
async function loadTotpBox() {
  const box = $('totp-box');
  if (!box) return;
  let st = {};
  try { st = await api('/api/admin/totp/status'); } catch { box.innerHTML = '<div class="muted small">Could not load 2FA status.</div>'; return; }
  if (st.enabled) {
    box.innerHTML = `
      <div class="kv"><span class="k"><b style="color:var(--ink);">Two-factor is ON</b><br><span class="small">Login requires your authenticator code.</span></span>
      <span class="pill pill-on">Enabled</span></div>
      <div class="frow mt16"><label>Current password <span class="muted small">(to disable 2FA)</span></label>
      <input id="totp-disable-pw" class="input no-icon" type="password" autocomplete="current-password"></div>
      <button class="btn-ghost" id="btn-totp-disable">Disable two-factor</button>
      <div id="totp-msg" class="small muted mt8"></div>`;
    $('btn-totp-disable').onclick = async () => {
      const pw = $('totp-disable-pw').value;
      if (!pw) { $('totp-msg').textContent = 'Enter your password first.'; return; }
      try {
        await api('/api/admin/totp/disable', { method: 'POST', body: JSON.stringify({ password: pw }) });
        toast('Two-factor disabled', 'ok'); loadTotpBox();
      } catch (e) { $('totp-msg').textContent = 'Failed: ' + e.message; }
    };
    return;
  }
  box.innerHTML = `
    <div class="kv"><span class="k"><b style="color:var(--ink);">Two-factor is OFF</b><br><span class="small">Add an extra login step for this admin account.</span></span>
    <span class="pill">Disabled</span></div>
    <div class="frow mt16"><label>Current password <span class="muted small">(to start setup)</span></label>
    <input id="totp-setup-pw" class="input no-icon" type="password" autocomplete="current-password"></div>
    <button class="btn-primary mt16" id="btn-totp-setup">Set up two-factor</button>
    <div id="totp-setup-area" class="mt16"></div>
    <div id="totp-msg" class="small muted mt8"></div>`;
  $('btn-totp-setup').onclick = async () => {
    const pw = $('totp-setup-pw').value;
    if (!pw) { $('totp-msg').textContent = 'Enter your password first.'; return; }
    try {
      const s = await api('/api/admin/totp/setup', { method: 'POST', body: JSON.stringify({ password: pw }) });
      $('totp-setup-area').innerHTML = `
        <p class="small mb16">Add this key to your authenticator app (Google Authenticator, 1Password, …), then enter the 6-digit code to confirm.</p>
        <div class="code-box mb16"><span class="cl">Manual key</span>${esc(s.secret)}</div>
        <div class="frow"><label>6-digit code</label><input id="totp-confirm-code" class="input no-icon" inputmode="numeric" maxlength="6" placeholder="123456"></div>
        <button class="btn-primary" id="btn-totp-enable">Verify & enable</button>`;
      $('btn-totp-enable').onclick = async () => {
        const token = $('totp-confirm-code').value.trim();
        if (!/^\d{6}$/.test(token)) { $('totp-msg').textContent = 'Enter the 6-digit code.'; return; }
        try {
          await api('/api/admin/totp/enable', { method: 'POST', body: JSON.stringify({ token }) });
          toast('Two-factor enabled', 'ok'); loadTotpBox();
        } catch (e) { $('totp-msg').textContent = 'Failed: ' + e.message; }
      };
    } catch (e) { $('totp-msg').textContent = 'Setup failed: ' + e.message; }
  };
}
async function saveAdminConfig() {
  try {
    await api('/api/admin/config', {
      method: 'PUT',
      body: JSON.stringify({
        autoReply: $('cfg-autoreply').checked,
        aiModel: $('cfg-model').value.trim(),
        aiModelPool: $('cfg-modelpool').value.trim(),
        aiBaseUrl: $('cfg-baseurl').value.trim(),
      }),
    });
    $('cfg-msg').textContent = 'Saved ✓';
  } catch (e) { $('cfg-msg').textContent = 'Save failed: ' + e.message; }
}
async function loadAdminAudit() {
  const rows = await api('/api/admin/audit');
  $('audit-list').innerHTML = rows.map(a => `
    <div class="audit-row">
      <span class="ev">${esc(a.event)}</span>
      <span class="muted small">${esc(a.actor || '')}${a.target ? ' → ' + esc(a.target) : ''}</span>
      <span class="right"><span>${esc(a.ip || '')}</span><span>${fmtDT(a.created_at)}</span></span>
    </div>`).join('') || '<div class="tbl-empty">No audit events yet.</div>';
}
