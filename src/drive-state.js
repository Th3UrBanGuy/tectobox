// Google Drive OAuth `state` — signed, expiring, single-use, session-bound.
// The old code used the bare client ID as state: anyone observing or crafting
// a callback URL could bind a Google account to an arbitrary workspace
// (OAuth CSRF / login-CSRF). This module issues HMAC-signed tokens that only
// the session which started the flow can complete, and each burns after one use.

const crypto = require('crypto');
const { sessionKey } = require('./crypto');

const STATE_TTL_MS = 10 * 60 * 1000;
const usedNonces = new Map(); // nonce -> exp (single-use)
setInterval(() => {
  const now = Date.now();
  for (const [n, e] of usedNonces) if (e < now) usedNonces.delete(n);
}, 5 * 60 * 1000).unref();

function issueState(user, clientId) {
  const payload = {
    v: 1, clientId, uid: user.id, role: user.role,
    nonce: crypto.randomBytes(16).toString('hex'),
    exp: Date.now() + STATE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// Returns the clientId the flow was started for. Throws on any problem.
function verifyState(req, state) {
  try {
    const [body, sig] = String(state || '').split('.');
    if (!body || !sig) throw new Error('malformed');
    const want = crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url');
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) {
      throw new Error('bad signature');
    }
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p || p.v !== 1 || !p.clientId || !p.nonce || !p.exp) throw new Error('bad payload');
    if (Date.now() > p.exp) throw new Error('expired');
    if (usedNonces.has(p.nonce)) throw new Error('already used');
    // The SAME logged-in user that started the flow must finish it.
    if (!req.user || req.user.id !== p.uid) throw new Error('not your flow');
    // Non-admins can only connect their own workspace.
    if (req.user.role !== 'admin' && req.user.clientId !== p.clientId) throw new Error('forbidden');
    usedNonces.set(p.nonce, p.exp);
    return p.clientId;
  } catch (e) {
    throw new Error('Invalid OAuth state: ' + e.message);
  }
}

module.exports = { issueState, verifyState, STATE_TTL_MS };
