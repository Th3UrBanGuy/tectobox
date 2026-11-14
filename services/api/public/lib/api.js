// Tectobox frontend — lib/api.js.
// Phase 5 modular restructure: split out of the 6,132-line app.js monolith.
// Classic script (NOT an ES module): functions/globals here are shared with
// every other frontend file via the global scope, and index.html loads them
// in dependency order. Do not rename anything — 423 element IDs in
// index.html and inline onclick handlers depend on these exact names.

// ---------------- api ----------------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401) { showLogin(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    let msg = data.message || data.error;
    if (Array.isArray(msg)) msg = msg.join(', ');
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return data;
}

/**
 * P5/P7/P11 (2026-11-15): the ONE path for workspace-scoped calls.
 * The admin user has no clientId of their own (state.clientId is
 * null), so the old template `/api/clients/${state.clientId}/…`
 * produced literal `/api/clients/null/…` requests — backup 404,
 * connectors 400, watchdog noise. clientApi refuses to send a null
 * client id at all: it throws a clear, actionable error the caller
 * turns into "pick a workspace" UI instead of a failed request.
 * Admin flows that legitimately need another workspace pass an
 * explicit id (from the workspace picker); they never pass null.
 */
function requireClientId(explicitId) {
  const id = explicitId ?? state.clientId;
  if (id === null || id === undefined || id === '' || String(id) === 'null' || String(id) === 'undefined') {
    throw new Error('No workspace selected — pick a workspace first');
  }
  return id;
}

function clientApi(path, opts = {}) {
  const id = requireClientId(opts.clientId);
  const { clientId: _picked, ...rest } = opts;
  return api(path.replace(':clientId', encodeURIComponent(String(id))), rest);
}
