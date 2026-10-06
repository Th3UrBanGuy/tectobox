// Tectonic Inbox v2 — multi-tenant social-commerce SaaS.
// Run: npm install && npm start   →  http://localhost:3120 (or $PORT)
// Load .env first so every module below sees the configured keys.
require('./src/loadenv');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Project-local bin/ first (zstd shim for @open-wa/session-sync — see README).
process.env.PATH = path.join(__dirname, 'bin') + path.delimiter + (process.env.PATH || '');

const express = require('express');
let webpush = null;
try {
  webpush = require('web-push');
  const _vp = process.env.VAPID_PUBLIC_KEY, _vs = process.env.VAPID_PRIVATE_KEY;
  if (_vp && _vs) webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@kalandar.me', _vp, _vs);
  else webpush = null;
} catch (e) { webpush = null; }
async function sendPushToClient(clientId, payload) {
  if (!webpush) return { sent: 0 };
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE client_id = ?').all(clientId);
  let sent = 0;
  for (const st of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: st.endpoint, keys: { p256dh: st.p256dh, auth: st.auth } },
        JSON.stringify(payload), { TTL: 86400 });
      sent++;
      db.prepare("UPDATE push_subscriptions SET last_used_at = datetime('now') WHERE id = ?").run(st.id);
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410))
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(st.id);
    }
  }
  return { sent };
}

// ---- tiny .env loader (no dependency) ----
(function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();

const db = require('./src/db');
const { normalizeMessage } = require('./src/normalize');
const { mintApiKey, webhookUrlAllowed, emitClientEvent } = require('./src/publicapi');
const { aiResponder, autoReplyEnabled, commentResponder, setBusyRetryHook, APOLOGY_NOTE, BUSY_NOTE } = require('./src/ai');
const crawler = require('./src/crawler');
const leadIntel = require('./src/lead-intel');
const { sendPlatformMessage, setTypingIndicator, platformStatus, metaTokenFor } = require('./src/senders');
const senders = require('./src/senders');
const connectors = require('./src/connectors');
const { maybeSeed } = require('./seed');

maybeSeed();

const app = express();
app.disable('x-powered-by');
// Behind cloudflared the TLS terminates at the edge; trust the loopback proxy
// so req.protocol/req.ip honor X-Forwarded-* (needed for Secure cookies + audit IPs).
app.set('trust proxy', 'loopback');
// Security headers. The frontend is fully self-contained (no inline scripts,
// no external resources), so a strict CSP is safe and blocks injected
// third-party scripts/beacons (e.g. malicious browser extensions loading
// remote JS or exfiltrating page views) from affecting the app.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  // TLS terminates at the Cloudflare edge; tell browsers to never use
  // plain HTTP for this host again (mitigates SSL-stripping / downgrade).
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
const PORT = parseInt(process.env.PORT, 10) || 3120;

// ---- fail-fast config validation (never boot with a nonsense config) ----
(function validateConfig() {
  if (process.env.PORT && (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535)) {
    console.error(`[config] FATAL: invalid PORT=${process.env.PORT}`);
    process.exit(1);
  }
  const urlVars = { AI_BASE_URL: process.env.AI_BASE_URL, AI_API_KEY: undefined };
  if (urlVars.AI_BASE_URL && !/^https?:\/\//.test(urlVars.AI_BASE_URL)) {
    console.error(`[config] FATAL: AI_BASE_URL must be an http(s) URL, got: ${urlVars.AI_BASE_URL}`);
    process.exit(1);
  }
  const secrets = ['META_APP_ID', 'META_APP_SECRET', 'META_VERIFY_TOKEN', 'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_API_ID', 'TELEGRAM_API_HASH'];
  for (const k of secrets) {
    if (!process.env[k]) console.warn(`[config] ${k} not set — related feature runs in demo/disabled mode`);
  }
  if (process.env.DEMO_WEBHOOKS === '1') {
    console.warn('[config] DEMO_WEBHOOKS=1 — webhooks accept unsigned payloads. NEVER use in production.');
  }
})();

// Real client IP behind the Cloudflare tunnel. cloudflared connects from
// loopback, so req.ip alone is always 127.0.0.1 — Cloudflare sets
// CF-Connecting-IP to the true client IP on every request. Prefer it;
// fall back to Express' (proxy-aware) req.ip.
function realIp(req) {
  const cf = req.get('cf-connecting-ip');
  if (cf && /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]+$/.test(cf.trim())) return cf.trim();
  return req.ip;
}
// Timing-safe string compare for webhook secrets (defeats byte-at-a-time guessing).
function secretsEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Global rate limits (DDoS / credential-stuffing / webhook-flood guard).
// Authenticated API traffic is human-speed; webhooks are provider-speed.
app.use('/api', (req, res, next) => {
  if (!rateLimit(`api:${realIp(req)}`, 600, 10 * 60 * 1000)) {
    return res.status(429).json({ error: 'rate limit exceeded — slow down' });
  }
  next();
});
app.use('/webhooks', (req, res, next) => {
  if (!rateLimit(`wh:${realIp(req)}`, 240, 60 * 1000)) return res.sendStatus(429);
  next();
});
// Tiny request log (skip the long-lived SSE stream).
app.use((req, res, next) => {
  if (req.path === '/api/events') return next();
  const t = Date.now();
  res.on('finish', () => {
    console.log(`[http] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`);
  });
  next();
});

// Keep the raw body so we can verify Meta's HMAC signature.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
  limit: '1mb', // DoS guard: webhook/AI payloads are KBs; nothing legit needs more
}));
// Static assets: always revalidate (no-cache + etag) so deploys reach
// browsers immediately instead of sitting behind max-age caches.
// Defense in depth: never serve dotfiles or sensitive extensions even if one
// ever lands under public/ — internal files (.env, *.db, sessions/) must not
// be reachable over HTTP under any circumstance.
const BLOCKED_ASSET = /(^|\/)\.|(\.db|\.sqlite3?|\.db-shm|\.db-wal|\.env|\.log|\.bak|\.backup|\.old|\.tmp|\.swp|\.swo)~?$/i;
app.use((req, res, next) => {
  if (BLOCKED_ASSET.test(req.path)) return res.sendStatus(404);
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'deny',
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// ---------------- SaaS auth: sessions + password hashing ----------------
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24h

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'));
}
// Pre-computed scrypt hash of a random secret: used for unknown usernames so
// the login path takes the same time whether the user exists or not.
const DUMMY_HASH = hashPassword(crypto.randomBytes(32).toString('hex'));

// In-memory token bucket: key -> { count, resetAt }. Enough for a single
// process; each login node rate-limits its own traffic.
const _rlBuckets = new Map();
function rateLimit(key, maxAttempts, windowMs) {
  const nowMs = Date.now();
  let b = _rlBuckets.get(key);
  if (!b || nowMs > b.resetAt) { b = { count: 0, resetAt: nowMs + windowMs }; _rlBuckets.set(key, b); }
  b.count += 1;
  if (_rlBuckets.size > 10000) for (const [k, v] of _rlBuckets) { if (nowMs > v.resetAt) _rlBuckets.delete(k); if (_rlBuckets.size < 9000) break; }
  return b.count <= maxAttempts;
}
function checkPasswordPolicy(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password needs upper-case, lower-case and a digit.';
  return null;
}
// Sessions live in SQLite: they survive process restarts and can be revoked
// when a user is disabled, deleted, or resets their password.
function newSession(user) {
  const id = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL).toISOString();
  db.createSession(id, user.id, expiresAt);
  return id;
}
function sessionFromReq(req) {
  const sid = parseCookies(req).tb_session;
  if (!sid) return null;
  const s = db.getSession(sid);
  if (!s) return null;
  if (!s.active) { db.deleteSession(sid); return null; } // disabled/deleted user
  return { id: s.user_id, username: s.username, role: s.role, clientId: s.client_id, sid };
}
function setSessionCookie(res, sid) {
  const secure = process.env.COOKIE_SECURE === '1' || (process.env.NODE_ENV === 'production');
  res.setHeader('Set-Cookie',
    `tb_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure ? '; Secure' : ''}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'tb_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
// Bootstrap: initial admin ONLY via explicit env opt-in. No credentials are ever
// baked into code. Set BOOTSTRAP_ADMIN=1 AND ADMIN_PASSWORD (min 12 chars) on
// FIRST run to create the initial admin, then remove ADMIN_PASSWORD.
// Existing deployments keep their current users untouched — this block never
// creates, resets, or touches accounts unless BOOTSTRAP_ADMIN=1 is set.
(function maybeBootstrapAdmin() {
  if (process.env.BOOTSTRAP_ADMIN !== '1') return;
  const pw = process.env.ADMIN_PASSWORD || '';
  if (pw.length < 12) {
    console.error('[auth] BOOTSTRAP_ADMIN=1 but ADMIN_PASSWORD missing or <12 chars. Refusing to boot.');
    process.exit(1);
  }
  if (!db.getUserByUsername('admin')) {
    db.createUser({ username: 'admin', passwordHash: hashPassword(pw), role: 'admin', clientId: null });
    console.log('[auth] Bootstrap admin created. Unset ADMIN_PASSWORD now.');
  } else {
    console.warn('[auth] BOOTSTRAP_ADMIN=1 but admin user already exists — skipping.');
  }
})();

// Public API paths that don't need a session.
const PUBLIC_API = new Set([
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'GET /api/push/vapid-key',
  'GET /api/meta/oauth/callback',
  'GET /api/meta/oauth/pending/',
  'POST /api/meta/oauth/pick',
]);
function isPublicApi(req) {
  // NOTE: mounted under app.use('/api'), so req.path is stripped of the /api prefix.
  const fullPath = (req.baseUrl || '') + req.path;
  const key = `${req.method} ${fullPath}`;
  if (PUBLIC_API.has(key)) return true;
  if (req.method === 'GET' && fullPath.startsWith('/api/meta/oauth/pending/')) return true;
  if (fullPath.startsWith('/api/widget/')) return true; // webchat widget — public by design
  return false;
}
function authRequired(req, res, next) {
  if (isPublicApi(req)) return next();
  // Public API v1 uses Bearer API keys, not dashboard sessions.
  if (req.path === '/v1' || req.path.startsWith('/v1/')) return apiKeyAuth(req, res, next);
  const s = sessionFromReq(req);
  if (!s) return res.status(401).json({ error: 'login required' });
  req.user = s;
  next();
}
// Public API key auth: Authorization: Bearer tk_<64 hex>. Keys are
// workspace-scoped; only the SHA-256 hash is stored server-side.
function apiKeyAuth(req, res, next) {
  const h = req.get('authorization') || '';
  const m = h.match(/^Bearer\s+(tk_[0-9a-fA-F]{64})$/);
  if (!m) return res.status(401).json({ error: 'Authorization: Bearer <api_key> required' });
  const hash = crypto.createHash('sha256').update(m[1]).digest('hex');
  const key = db.getApiKeyByHash(hash);
  if (!key) return res.status(401).json({ error: 'invalid or revoked API key' });
  if (!rateLimit(`apikey:${key.id}`, 300, 60 * 1000)) {
    return res.status(429).json({ error: 'API key rate limit exceeded' });
  }
  db.touchApiKey(key.id);
  req.apiKey = key;
  req.user = { id: 0, username: `apikey:${key.key_prefix}`, role: 'apikey', clientId: key.client_id };
  next();
}
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  next();
}
app.use('/api', authRequired);
app.use('/api/admin', adminOnly);
// CSRF: state-changing requests carry the cookie automatically, so require a
// same-origin signal. Browsers always send Origin/Referer on fetch/XHR; a
// missing-or-cross-origin value is rejected (safe methods skip the check).
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Bearer API keys are never auto-sent by browsers — CSRF does not apply.
  if (req.path === '/v1' || req.path.startsWith('/v1/')) return next();
  // Webchat widget: intentionally cross-origin (embedded on client websites).
  if (req.path === '/widget' || req.path.startsWith('/widget/')) return next();
  const origin = req.get('origin') || req.get('referer');
  if (!origin) return res.status(403).json({ error: 'missing origin' });
  let oHost;
  try { oHost = new URL(origin).host; } catch { return res.status(403).json({ error: 'bad origin' }); }
  const host = req.get('host');
  if (oHost !== host) return res.status(403).json({ error: 'cross-origin request blocked' });
  next();
});
// Client users are locked to their own workspace; admins may pass any client_id.
function cid(req) {
  if (req.user && req.user.role !== 'admin') return req.user.clientId;
  return parseInt(req.query.client_id || (req.body && req.body.client_id) || req.params.clientId || '1', 10) || 1;
}
// Guard /api/clients/:clientId/* so a client can't touch another workspace.
app.use('/api/clients/:clientId', (req, res, next) => {
  if (req.user && req.user.role !== 'admin' && Number(req.params.clientId) !== req.user.clientId) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const uname = String(username || '').trim();
  // Rate limit: 5 attempts per minute per IP+username — slows credential stuffing.
  const rlKey = `login:${realIp(req)}:${uname.toLowerCase()}`;
  if (!rateLimit(rlKey, 5, 60 * 1000)) {
    db.addAudit(uname, 'auth.login.ratelimited', null, realIp(req));
    return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  }
  const user = uname && db.getUserByUsername(uname);
  // Always run the (slow) scrypt check, even for unknown users, so timing
  // doesn't reveal which usernames exist.
  const stored = user ? user.password_hash : DUMMY_HASH;
  const ok = verifyPassword(String(password || ''), stored);
  if (!user || !user.active || !ok) {
    db.addAudit(uname, 'auth.login.failed', null, realIp(req));
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const sid = newSession(user);
  setSessionCookie(res, sid);
  db.addAudit(user.username, 'auth.login.success', null, realIp(req));
  res.json({ ok: true, user: { username: user.username, role: user.role, clientId: user.client_id } });
});
app.post('/api/auth/logout', (req, res) => {
  const s = sessionFromReq(req);
  if (s) { db.deleteSession(s.sid); db.addAudit(s.username, 'auth.logout', null, realIp(req)); }
  clearSessionCookie(res);
  res.json({ ok: true });
});
app.get('/api/auth/me', (req, res) => {
  res.json({ user: { username: req.user.username, role: req.user.role, clientId: req.user.clientId } });
});

// ---------------- Server-Sent Events ----------------
// Each stream is tagged with the subscriber's role/client; broadcast() filters
// server-side so a client user never receives another workspace's data.
// (Frontend filtering alone is not a security boundary.)
const sseClients = new Set(); // { res, role, clientId }
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  const entry = { res, role: req.user.role, clientId: req.user.clientId };
  sseClients.add(entry);
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(heartbeat); sseClients.delete(entry); });
});
function broadcast(type, payload, clientId) {
  const data = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const c of sseClients) {
    if (c.role !== 'admin' && c.clientId !== clientId) continue;
    try { c.res.write(data); } catch {}
  }
}
// ---------------- Inbound pipeline ----------------
// Conversations with an AI reply currently being composed. Used for burst
// coalescing: a second inbound for the same conversation while a reply is in
// flight is stored but does not spawn a second reply task.
const replyingNow = new Set();

// clientId: explicit for connector sessions; resolved for webhooks.
async function resolveMetaName(platform, platformUserId, clientId) {
  const token = metaTokenFor(clientId, platform);
  if (!token) return null;
  try {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${platformUserId}?fields=name&access_token=${token}`,
      { signal: AbortSignal.timeout(4000) }
    );
    const data = await res.json();
    return data && data.name ? data.name : null;
  } catch { return null; }
}

async function handleInbound(clientId, platform, rawEvent, opts = {}) {
  const norm = normalizeMessage(platform, rawEvent);
  if (!norm) return null;
  // Routing: an explicitly resolved workspace wins. The channel fallback
  // (clientForChannel) is ONLY for the single global Telegram bot webhook,
  // which has no page id to route by. Meta webhooks must never fall back —
  // an unknown Page is quarantined, never written into another workspace.
  const cid = clientId || (opts.allowChannelFallback ? db.clientForChannel(platform) : null);
  // Fail closed: an inbound message that can't be attributed to a workspace is
  // quarantined, never written into someone else's inbox.
  if (!cid) {
    console.warn(`[webhook] quarantined ${platform} message: no workspace matched`);
    return null;
  }

  const conv = db.upsertConversation({
    clientId: cid,
    platform: norm.platform,
    platformUserId: norm.platformUserId,
    customerName: norm.customerName,
    slot: opts.slot || 'default',
  });
  // Meta display-name lookup runs AFTER the store (never blocks webhook ACK —
  // the Graph call can take up to its 4s timeout). COALESCE in upsertConversation
  // fills the name in without touching anything already set.
  if (!norm.customerName && (platform === 'messenger' || platform === 'instagram')) {
    resolveMetaName(platform, norm.platformUserId, cid).then(name => {
      if (!name) return;
      db.upsertConversation({
        clientId: cid, platform: norm.platform, platformUserId: norm.platformUserId,
        customerName: name, slot: opts.slot || 'default', bumpUnread: false,
      });
      broadcast('message', { conversation: db.getConversation(conv.id) }, conv.client_id);
    }).catch(e => console.error('[webhook] meta name lookup failed:', e.message));
  }
  // Idempotency: platforms redeliver webhooks on retry/network blips.
  // A repeated platform message id is acknowledged, not re-processed
  // (no duplicate row, no duplicate AI reply, no duplicate order).
  if (norm.externalId && db.findMessageByExternalId(conv.id, norm.externalId)) {
    console.log(`[webhook] duplicate ${platform} message ${norm.externalId} ignored`);
    return null;
  }
  const inbound = db.addMessage(conv.id, 'in', norm.text, JSON.stringify(rawEvent), null, norm.externalId);
  // Push notification to the client's installed app (PWA) — new message alert.
  try {
    const _c = db.getConversation(conv.id);
    const _who = (_c && (_c.customer_name || _c.customer_phone)) || 'New message';
    sendPushToClient(conv.client_id, {
      title: _who, body: String(norm.text || '').slice(0, 120),
      tag: 'msg-' + conv.id, url: '/?view=inbox',
    }).catch(() => {});
  } catch {}
  // Lead rows are created ONLY by the qualification gate in src/ai.js
  // (real product interest + details). No junk rows on first contact.
  // The 'lead.created' webhook fires from ai.js when a row is actually created.
  broadcast('message', { conversation: db.getConversation(conv.id) }, conv.client_id);
  emitClientEvent(db, conv.client_id, 'message.received', {
    conversation_id: conv.id, platform: norm.platform, platform_user_id: norm.platformUserId,
    text: norm.text, message_id: inbound.id,
  });

  // ---- AI reply task (extracted so the deferred budget-retry can reuse it) ----
  // Burst coalescing: one AI reply per conversation turn. If a reply task is
  // already composing for this conversation, this message is stored (above)
  // and the in-flight task's send-time re-check answers the latest text —
  // a burst of 4 rapid messages gets exactly ONE reply, not four.
  // NEVER goes silent: on any failure the customer gets an apology note plus
  // a background retry. Silence is the one unacceptable outcome.
  // ACK fast: the message is stored + broadcast above; the reply composes
  // in the background. Webhook/socket handlers must never wait for the AI —
  // under burst, awaiting here serializes the socket behind the slowest call.
  runReplyTask(conv, platform, norm, opts, inbound, cid).catch(e =>
    console.error('[inbound] background reply failed:', e.message));
  return inbound;
}

// Deferred retry: after a budget-exhausted busy note (or a compose failure),
// deliver the REAL answer once budget frees up. At most one pending retry
// per conversation; no-ops if the conversation was answered meanwhile.
const replyRetryTimers = new Map();
// Provisional outbounds (busy/apology notes) are placeholders, not real
// answers and not operator replies — every "was this answered?" check must
// ignore them, or the deferred real reply gets swallowed.
function isProvisionalOutbound(m) {
  try { return !!m && m.direction === 'out' && !!JSON.parse(m.raw_json || '{}').provisional; }
  catch { return false; }
}
function scheduleReplyRetry(conv) {
  if (!conv || replyRetryTimers.has(conv.id)) return;
  const t = setTimeout(async () => {
    replyRetryTimers.delete(conv.id);
    try {
      const fresh = db.getConversation(conv.id);
      if (!fresh) return;
      const recent = db.getRecentMessages(fresh.id, 4);
      const lastIn = [...recent].reverse().find(m => m.direction === 'in');
      if (!lastIn) return;
      const lastOut = [...recent].reverse().find(m => m.direction === 'out' && !isProvisionalOutbound(m));
      if (lastOut && lastOut.id > lastIn.id) return; // already answered
      if (replyingNow.has(fresh.id)) { scheduleReplyRetry(fresh); return; }
      console.log(`[ai] retry: composing deferred reply for conv ${fresh.id}`);
      await runReplyTask(fresh, fresh.platform,
        { text: lastIn.text, platformUserId: fresh.platform_user_id },
        { slot: 'default' }, lastIn, fresh.client_id);
    } catch (e) { console.error('[ai] deferred retry failed:', e.message); }
  }, 30000);
  if (t.unref) t.unref();
  replyRetryTimers.set(conv.id, t);
}
setBusyRetryHook(scheduleReplyRetry);

async function runReplyTask(conv, platform, norm, opts = {}, inbound = null, cid = null) {
  const clientId = cid || conv.client_id;
  // Per-gateway AI pause: the operator turned auto-replies off for this account.
  // The inbound message is already stored + broadcast by the caller — stay
  // completely silent (no reply, no busy note, no deferred retry). The human
  // replies manually from the inbox; nothing is lost.
  const pauseSlot = conv.slot || opts.slot || 'default';
  if (db.isAiPaused(clientId, platform, pauseSlot)) {
    console.log(`[ai] paused for ${platform}/${pauseSlot} (client ${clientId}) — inbound stored, no auto-reply (conv ${conv.id})`);
    return null;
  }
  if (replyingNow.has(conv.id)) {
    console.log(`[ai] burst: conv ${conv.id} already has a reply in flight — stored, no duplicate reply`);
    return null;
  }
  replyingNow.add(conv.id);
  let replyText = null;
  try {
    // The platform admin can flip the global auto-reply switch from the admin panel.
    try {
      if (autoReplyEnabled()) {
        // WhatsApp: show "typing…" while the AI composes (cosmetic, best-effort).
        setTypingIndicator(platform, norm.platformUserId, true, clientId, opts.slot || 'default');
        try {
          replyText = await aiResponder(conv, norm.text, {
            isGroup: norm.isGroup, senderName: norm.senderName,
            groupTitle: norm.groupTitle, groupHistory: norm.groupHistory,
            pageUrl: opts.pageUrl, pageTitle: opts.pageTitle,
          });
          // Send-time re-check: while the LLM was thinking, did a newer
          // customer message arrive? Answer the LATEST turn, not a stale one.
          const latest = db.getRecentMessages(conv.id, 1)[0];
          if (latest && latest.direction === 'in' && (!inbound || latest.id !== inbound.id)) {
            console.log(`[ai] burst: newer message ${latest.id} arrived during compose — re-answering latest turn`);
            replyText = await aiResponder(conv, latest.text, {
              isGroup: norm.isGroup, senderName: norm.senderName,
              groupTitle: norm.groupTitle, groupHistory: norm.groupHistory,
            pageUrl: opts.pageUrl, pageTitle: opts.pageTitle,
            });
          }
          // ...but if a human operator replied meanwhile, stay silent.
          const lastNow = db.getRecentMessages(conv.id, 1)[0];
          if (lastNow && lastNow.direction === 'out' && !isProvisionalOutbound(lastNow)) {
            console.log(`[ai] operator replied during compose — dropping AI reply for conv ${conv.id}`);
            replyText = null;
          }
        } finally {
          setTypingIndicator(platform, norm.platformUserId, false, clientId, opts.slot || 'default');
        }
      }
    } catch (err) {
      // No silent failure, ever: apologize now, retry in the background.
      console.error('[ai] responder failed:', err.message);
      replyText = APOLOGY_NOTE;
      scheduleReplyRetry(conv);
    }
    // Human-handover contract: the AI ends its reply with [NEEDS_HUMAN] when
    // the customer genuinely needs a person. Strip the token before delivery,
    // flag the conversation, notify over SSE (no UI change — the event is
    // there for clients that render it).
    let needsHuman = false;
    if (replyText && replyText.includes('[NEEDS_HUMAN]')) {
      needsHuman = true;
      replyText = replyText.replaceAll('[NEEDS_HUMAN]', '').trim();
    }
    // Hard reply-length guard: never send a wall of text into a chat.
    if (replyText && replyText.length > 900) replyText = replyText.slice(0, 899) + '…';
    if (replyText) {
      // Provisional notes (busy/apology) are NOT real answers — tag them so the
      // deferred retry doesn't mistake them for "already answered" and skip the
      // real reply it promised.
      const provisional = replyText === BUSY_NOTE || replyText === APOLOGY_NOTE;
      const out = db.addMessage(conv.id, 'out', replyText,
        provisional ? JSON.stringify({ provisional: true, kind: 'note' }) : null);
      // Webchat has no platform sender — the widget delivers via HTTP/poll.
      const sendResult = platform === 'webchat'
        ? { sent: true, mode: 'webchat' }
        : await sendPlatformMessage(platform, norm.platformUserId, replyText, clientId, opts.slot || 'default', { replyTo: norm.replyToMsgId });
      if (!sendResult.sent) console.log(`[send] demo mode (${platform}): ${sendResult.reason}`);
      broadcast('message', { conversation: db.getConversation(conv.id), outbound: out }, conv.client_id);
      broadcast('lead', { clientId }, clientId);
    }
    if (needsHuman) {
      db.flagNeedsHuman(conv.id, 'AI requested human handover');
      broadcast('conversation:flag', { conversationId: conv.id, needsHuman: true }, conv.client_id);
      console.log(`[ai] conv ${conv.id} flagged: needs human`);
    }
  } finally {
    replyingNow.delete(conv.id);
  }
  return replyText;
}

connectors.initConnectors({
  onInbound: (clientId, platform, raw, opts) => handleInbound(clientId, platform, raw, opts || {}),
  emit: broadcast,
});

// ---------------- Meta webhook ----------------
function verifyMetaSignature(req) {
  const secret = process.env.META_APP_SECRET;
  // Fail closed: without the app secret we cannot verify the payload came
  // from Meta. Unsigned acceptance is only allowed with explicit DEMO_WEBHOOKS=1.
  if (!secret) {
    if (process.env.DEMO_WEBHOOKS === '1') {
      console.warn('[meta] META_APP_SECRET not set — accepting UNSIGNED payload (demo mode)');
      return true;
    }
    console.error('[meta] META_APP_SECRET not set — rejecting webhook (fail closed)');
    return false;
  }
  const sig = req.get('X-Hub-Signature-256');
  if (!sig || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

app.get('/webhooks/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected = process.env.META_VERIFY_TOKEN;
  // Fail closed: accepting a subscription challenge without a verify token
  // would let anyone subscribe their own endpoint. Demo override only.
  if (!expected) {
    if (process.env.DEMO_WEBHOOKS === '1') {
      console.warn('[meta] META_VERIFY_TOKEN not set — accepting challenge (demo mode)');
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  }
  if (mode === 'subscribe' && secretsEqual(token, expected)) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post('/webhooks/meta', async (req, res) => {
  if (!verifyMetaSignature(req)) return res.sendStatus(401);
  const body = req.body || {};
  if (body.object !== 'page' && body.object !== 'instagram') return res.sendStatus(404);

  const platform = body.object === 'instagram' ? 'instagram' : 'messenger';
  try {
    for (const entry of body.entry || []) {
      // SaaS routing: entry.id is the Page ID (object=page) or IG user ID
      // (object=instagram) → find which client owns it.
      const owner = db.findClientByMetaPage(String(entry.id));
      const cid = owner ? owner.client_id : null;
      for (const event of entry.messaging || []) {
        if (event.message && event.message.text && !event.message.is_echo) {
          await handleInbound(cid, platform, event);
        }
      }
      // FB Page feed changes: post comments → comment automation funnel
      // (comment → AI public reply → DM follow-up → lead → inbox → customer).
      for (const change of entry.changes || []) {
        if (change.field === 'feed') {
          await handleFeedChange(cid, String(entry.id), change.value || {});
        }
      }
    }
  } catch (err) {
    console.error('[meta] webhook handling failed:', err.message);
  }
  res.status(200).send('EVENT_RECEIVED');
});

// ---------------- FB comment → AI reply → lead → customer ----------------
// Inbound: webhook "feed" change { item:'comment', verb:'add', comment_id, post_id,
//   from:{id,name}, message, created_time }. Outbound: like + public AI reply +
// private_replies DM (opens a Messenger thread → normal inbox/AI pipeline continues).
async function handleFeedChange(clientId, pageId, value) {
  try {
    if (!clientId) { console.warn('[comment] quarantined: no workspace for page', pageId); return; }
    if (value.item !== 'comment' || value.verb !== 'add') return;
    const commentId = String(value.comment_id || '');
    const text = String(value.message || '').trim();
    const from = value.from || {};
    const commenterId = String(from.id || '');
    // Skip: our own page's comments, empty text, already handled (idempotency +
    // reply-loop protection — never answer our own reply twice).
    if (!commentId || !text) return;
    if (commenterId && commenterId === pageId) return;
    // Claim-first: a redelivered/concurrent duplicate loses the claim and stops here.
    if (!db.claimComment({ clientId, pageId, commentId, postId: value.post_id,
      commenterId, commenterName: from.name, commentText: text })) {
      console.log(`[comment] duplicate ${commentId} ignored`);
      return;
    }

    const cfg = db.getCommentConfig(clientId);
    if (!cfg.autoReply) return; // logged by the claim; nothing further to do

    // Keyword rules first (instant, no AI cost); AI fallback otherwise.
    const lower = text.toLowerCase();
    const rule = cfg.rules.find(r => r.keywords.some(k => lower.includes(k)));
    let replyText = rule ? rule.reply : await commentResponder({
      clientId,
      commenterName: from.name,
      commentText: text,
      postText: value.post_text || '',
    });

    // Every commenter becomes a lead (lead -> user -> confirmed), even if the
    // AI brain is down. platform='messenger': the commenter PSID matches the
    // messaging PSID, so the lead row continues seamlessly when they DM back.
    try {
      db.upsertLead({ clientId, platform: 'messenger', platformUserId: commenterId,
        fields: { name: from.name } });
    } catch (e) { console.warn('[comment] lead upsert failed:', e.message); }

    let dmSent = false;
    let replySent = false;
    if (replyText) {
      if (cfg.likeComment) {
        try { await senders.likeComment(commentId, clientId); } catch (e) { console.warn('[comment] like failed:', e.message); }
      }
      try {
        const r = await senders.replyToComment(commentId, replyText, clientId);
        replySent = r.sent;
        if (!r.sent) console.log(`[comment] reply generated but not sent (demo mode): ${r.reason}`);
      } catch (e) { console.warn('[comment] reply failed:', e.message); }
    }
    // Comment → inbox funnel: private DM follow-up opens a Messenger thread.
    // Their reply lands in the normal messaging webhook → AI chat → order → customer.
    if (cfg.dmFollowup && commenterId) {
      const dmText = `Assalamu Alaikum ${from.name || ''}! 🌸 Comment-er jonno dhonnobad! ` +
        `Apnar proshner details inbox-e pathiye diyechi — ekhanei reply korun, amra help korbo.`;
      try {
        const r = await senders.privateReplyToComment(commentId, dmText.trim(), clientId);
        dmSent = r.sent;
        if (!r.sent) console.log(`[comment] DM demo mode: ${r.reason}`);
      } catch (e) { console.warn('[comment] DM failed:', e.message); }
    }
    db.updateCommentResult(commentId, { replyText, dmSent });
    broadcast('comment', { clientId, commentId, commenterName: from.name, text, replyText }, clientId);
    broadcast('lead', { clientId }, clientId);
    console.log(`[comment] handled ${commentId} from ${from.name || commenterId} ` +
      `(reply: ${replyText ? (replySent ? 'sent' : 'generated') : 'skip'}, dm: ${dmSent})`);
  } catch (err) {
    console.error('[comment] handling failed:', err.message);
  }
}

// ---------------- Meta OAuth: per-client Facebook Page connect (SaaS) ----------------
// One Meta app (ours) serves ALL clients. Each client OAuth-connects THEIR OWN
// Page; the page access token is stored per client and webhooks route by page ID.
// NOTE: the redirect URI below must be registered in the Meta app dashboard under
// Facebook Login → Valid OAuth Redirect URIs.
const META_GRAPH = 'v21.0';
const META_SCOPES = 'pages_show_list,pages_messaging,pages_manage_metadata,instagram_basic,instagram_manage_messages';
const pendingMetaOAuth = new Map(); // state -> { clientId, createdAt }
const pendingMetaPick = new Map();  // pid -> { clientId, pages, createdAt }

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function metaRedirectUri(req) {
  return `${req.protocol}://${req.get('host')}/api/meta/oauth/callback`;
}
async function graphFetch(path, params = {}, method = 'GET', body) {
  const url = `https://graph.facebook.com/${META_GRAPH}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    method,
    body: body ? new URLSearchParams(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ? data.error.message : `Graph HTTP ${res.status}`);
  return data;
}
// Persist the client's Page (+ linked IG account) and subscribe our app to its webhooks.
// subscribed_fields includes 'feed' so post comments arrive for the comment
// automation funnel (comment → AI reply → DM → lead → customer).
const META_SUBSCRIBED_FIELDS = 'messages,messaging_postbacks,feed';
async function connectMetaPage(clientId, page) {
  await graphFetch(`/${page.id}/subscribed_apps`, { access_token: page.access_token }, 'POST',
    { subscribed_fields: META_SUBSCRIBED_FIELDS });
  let ig = null;
  try {
    const p = await graphFetch(`/${page.id}`,
      { fields: 'instagram_business_account{id,username}', access_token: page.access_token });
    ig = p.instagram_business_account || null;
  } catch (e) { console.warn('[meta] IG lookup failed:', e.message); }
  db.saveMetaPage(clientId, 'messenger',
    { pageId: page.id, pageName: page.name, pageAccessToken: page.access_token });
  if (ig) {
    db.saveMetaPage(clientId, 'instagram',
      { pageId: page.id, pageName: page.name, pageAccessToken: page.access_token, igUserId: ig.id, igUsername: ig.username });
  }
  broadcast('connectors', { clientId }, clientId);
  console.log(`[meta] client ${clientId} connected page "${page.name}"${ig ? ` + IG @${ig.username}` : ''}`);
  return { page: page.name, instagram: ig ? ig.username : null };
}

app.get('/api/clients/:clientId/connectors/messenger/oauth/start', (req, res) => {
  const appId = process.env.META_APP_ID;
  if (!appId) return res.status(400).json({ error: 'META_APP_ID is not set on the server' });
  const state = `${req.params.clientId}.${crypto.randomBytes(10).toString('hex')}`;
  pendingMetaOAuth.set(state, { clientId: Number(req.params.clientId), createdAt: Date.now() });
  const url = `https://www.facebook.com/${META_GRAPH}/dialog/oauth` +
    `?client_id=${appId}&redirect_uri=${encodeURIComponent(metaRedirectUri(req))}` +
    `&scope=${encodeURIComponent(META_SCOPES)}&state=${state}&response_type=code`;
  res.json({ url });
});

app.get('/api/meta/oauth/callback', async (req, res) => {
  const { code, state } = req.query;
  const pending = pendingMetaOAuth.get(state);
  if (!code || !pending) {
    return res.status(400).send('<h3>Invalid or expired connection session.</h3><p>Please start again from the Connectors tab in the app.</p>');
  }
  pendingMetaOAuth.delete(state);
  try {
    const tok = await graphFetch('/oauth/access_token', {
      client_id: process.env.META_APP_ID,
      redirect_uri: metaRedirectUri(req),
      client_secret: process.env.META_APP_SECRET,
      code,
    });
    const acc = await graphFetch('/me/accounts',
      { fields: 'id,name,access_token', access_token: tok.access_token, limit: 50 });
    const pages = (acc.data || []).filter(p => p.access_token);
    if (!pages.length) {
      return res.send('<h3>No Facebook Pages found</h3><p>This Facebook account has no Pages. Create a Page first, then reconnect.</p>');
    }
    if (pages.length === 1) {
      const r = await connectMetaPage(pending.clientId, pages[0]);
      return res.send(`<h3>Connected: ${escHtml(r.page)} ✅</h3>` +
        (r.instagram ? `<p>Instagram @${escHtml(r.instagram)} also connected.</p>` : '') +
        '<p>You can close this tab and return to the app.</p>');
    }
    const pid = crypto.randomBytes(10).toString('hex');
    pendingMetaPick.set(pid, { clientId: pending.clientId, pages, createdAt: Date.now() });
    return res.redirect(`/#meta-pick?pid=${pid}`);
  } catch (err) {
    console.error('[meta] OAuth failed:', err.message);
    return res.status(500).send(`<h3>Facebook connection failed</h3><p>${escHtml(err.message)}</p>`);
  }
});

app.get('/api/meta/oauth/pending/:pid', (req, res) => {
  const p = pendingMetaPick.get(req.params.pid);
  if (!p) return res.status(404).json({ error: 'This connection session expired — please start again from the Connectors tab.' });
  res.json({ pages: p.pages.map(x => ({ id: x.id, name: x.name })) });
});

app.post('/api/meta/oauth/pick', async (req, res) => {
  const { pid, pageId } = req.body || {};
  const p = pendingMetaPick.get(pid);
  if (!p) return res.status(404).json({ error: 'expired' });
  const page = p.pages.find(x => String(x.id) === String(pageId));
  if (!page) return res.status(400).json({ error: 'unknown page' });
  pendingMetaPick.delete(pid);
  try {
    const r = await connectMetaPage(p.clientId, page);
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error('[meta] page connect failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// (stale OAuth + login session pruning runs on the single 10-min timer near the bottom)

// ---------------- Telegram bot webhook ----------------
app.post('/webhooks/telegram/:secret', async (req, res) => {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  // Fail closed: without a secret token, anyone could post fake inbound
  // messages. Unsigned acceptance only with explicit DEMO_WEBHOOKS=1.
  if (!expected && process.env.DEMO_WEBHOOKS !== '1') return res.sendStatus(401);
  if (expected && !secretsEqual(req.params.secret, expected)) return res.sendStatus(401);
  if (!expected) console.warn('[telegram] TELEGRAM_WEBHOOK_SECRET not set — accepting any path (demo mode)');
  try {
    const update = req.body || {};
    // The global Telegram bot has no page id to route by, so the channel
    // fallback (connected workspace for 'telegram') is allowed here.
    if (update.message) await handleInbound(null, 'telegram', update.message, { allowChannelFallback: true });
  } catch (err) {
    console.error('[telegram] webhook handling failed:', err.message);
  }
  res.sendStatus(200);
});

// A client user may only touch conversations inside their own workspace.
app.use('/api/conversations/:id', (req, res, next) => {
  if (req.user && req.user.role !== 'admin') {
    const conv = db.getConversation(req.params.id);
    if (!conv || conv.client_id !== req.user.clientId) return res.status(403).json({ error: 'forbidden' });
  }
  next();
});

// ---------------- REST API: clients (Super Admin) ----------------
app.get('/api/clients', adminOnly, (_req, res) => {
  res.json(db.getClients().map(c => ({
    ...c,
    stats: db.getStats(c.id),
    connectors: connectors.getConnectorStatus(c.id),
  })));
});

app.post('/api/clients', adminOnly, (req, res) => {
  const { name, business_type, lead_fields } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const c = db.createClient({ name, business_type, lead_fields });
  db.addAudit(req.user.username, 'admin.client.created', name, realIp(req));
  res.status(201).json(c);
});

app.patch('/api/clients/:id', adminOnly, (req, res) => {
  const c = db.updateClient(req.params.id, req.body || {});
  if (!c) return res.status(404).json({ error: 'Client not found' });
  res.json(c);
});

app.delete('/api/clients/:id', adminOnly, (req, res) => {
  db.deleteClient(req.params.id);
  db.addAudit(req.user.username, 'admin.client.deleted', String(req.params.id), realIp(req));
  res.json({ ok: true });
});

app.get('/api/global-stats', adminOnly, (_req, res) => res.json(db.globalStats()));

// ---------------- REST API: client-scoped ----------------
app.get('/api/status', (req, res) => res.json({ platforms: platformStatus(cid(req)) }));
app.get('/api/stats', (req, res) => res.json(db.getStats(cid(req))));

app.get('/api/conversations', (req, res) => {
  res.json(db.getConversations({ clientId: cid(req), platform: req.query.platform || null, q: req.query.q || null }));
});

app.get('/api/conversations/:id/messages', (req, res) => {
  res.json(db.getMessages(req.params.id));
});

app.post('/api/conversations/:id/read', (req, res) => {
  db.markRead(req.params.id);
  res.json({ ok: true });
});

app.post('/api/conversations/:id/reply', async (req, res) => {
  const conv = db.getConversations().find(c => String(c.id) === String(req.params.id));
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  const text = (req.body && req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });

  const msg = db.addMessage(conv.id, 'out', text, null);
  // A human operator took over — clear any AI-requested handover flag.
  db.clearNeedsHuman(conv.id);
  const sendResult = await sendPlatformMessage(conv.platform, conv.platform_user_id, text, conv.client_id, conv.slot || 'default');
  broadcast('message', { conversation: db.getConversation(conv.id), outbound: msg }, conv.client_id);
  broadcast('conversation:flag', { conversationId: conv.id, needsHuman: false }, conv.client_id);
  res.json({ message: msg, send: sendResult });
});

// ---------------- Public API v1 (Bearer API key — see /api/docs) ----------------
function v1ConvOwned(req, id) {
  const conv = db.getConversation(id);
  if (!conv || Number(conv.client_id) !== Number(req.user.clientId)) return null;
  return conv;
}
app.get('/api/v1/conversations', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  res.json(db.getConversations({ clientId: req.user.clientId, platform: req.query.platform || null, q: req.query.q || null }).slice(0, limit));
});
app.get('/api/v1/conversations/:id/messages', (req, res) => {
  const conv = v1ConvOwned(req, req.params.id);
  if (!conv) return res.status(404).json({ error: 'conversation not found' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  res.json(db.getMessages(conv.id).slice(-limit));
});
app.post('/api/v1/conversations/:id/reply', async (req, res) => {
  const conv = v1ConvOwned(req, req.params.id);
  if (!conv) return res.status(404).json({ error: 'conversation not found' });
  const text = String((req.body && req.body.text) || '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'text is required' });
  const msg = db.addMessage(conv.id, 'out', text, null);
  db.clearNeedsHuman(conv.id);
  const sendResult = await sendPlatformMessage(conv.platform, conv.platform_user_id, text, conv.client_id, conv.slot || 'default');
  broadcast('message', { conversation: db.getConversation(conv.id), outbound: msg }, conv.client_id);
  broadcast('conversation:flag', { conversationId: conv.id, needsHuman: false }, conv.client_id);
  res.json({ message: msg, send: sendResult });
});
app.get('/api/v1/leads', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  res.json(db.getLeads({ clientId: req.user.clientId }).slice(0, limit));
});
app.get('/api/v1/products', (req, res) => {
  res.json(db.searchProducts(req.query.q || '', req.user.clientId));
});

// ---- API key + webhook management (dashboard session, workspace-scoped) ----
app.get('/api/clients/:clientId/api-keys', (req, res) => {
  res.json(db.listApiKeys(cid(req)));
});
app.post('/api/clients/:clientId/api-keys', (req, res) => {
  const name = String((req.body && req.body.name) || 'integration').trim().slice(0, 60) || 'integration';
  const { raw, hash, prefix } = mintApiKey();
  const id = db.createApiKey(cid(req), name, hash, prefix);
  db.addAudit(req.user.username, 'apikey.created', `${name} (client ${cid(req)})`, realIp(req));
  // The raw key is shown exactly once — it is never stored.
  res.status(201).json({ id, name, key_prefix: prefix, api_key: raw });
});
app.delete('/api/clients/:clientId/api-keys/:id', (req, res) => {
  if (!db.revokeApiKey(req.params.id, cid(req))) return res.status(404).json({ error: 'key not found' });
  db.addAudit(req.user.username, 'apikey.revoked', `key ${req.params.id} (client ${cid(req)})`, realIp(req));
  res.json({ ok: true });
});
app.get('/api/clients/:clientId/webhooks', (req, res) => {
  res.json(db.listClientWebhooks(cid(req)));
});
app.post('/api/clients/:clientId/webhooks', async (req, res) => {
  const url = String((req.body && req.body.url) || '').trim();
  const events = String((req.body && req.body.events) || 'message.received,lead.created,order.created')
    .split(',').map(s => s.trim()).filter(s => ['message.received', 'lead.created', 'order.created'].includes(s));
  if (!url) return res.status(400).json({ error: 'url is required' });
  if (!events.length) return res.status(400).json({ error: 'at least one known event is required' });
  const blocked = await webhookUrlAllowed(url);
  if (blocked) return res.status(400).json({ error: `URL rejected: ${blocked}` });
  const secret = crypto.randomBytes(24).toString('hex');
  const id = db.createClientWebhook(cid(req), url, events.join(','), secret);
  db.addAudit(req.user.username, 'webhook.created', `${url} (client ${cid(req)})`, realIp(req));
  // Signing secret shown once — used to verify X-Tectonic-Signature.
  res.status(201).json({ id, url, events, signing_secret: secret });
});
app.delete('/api/clients/:clientId/webhooks/:id', (req, res) => {
  if (!db.deleteClientWebhook(req.params.id, cid(req))) return res.status(404).json({ error: 'webhook not found' });
  db.addAudit(req.user.username, 'webhook.deleted', `webhook ${req.params.id} (client ${cid(req)})`, realIp(req));
  res.json({ ok: true });
});

// ---------------- products ----------------
app.get('/api/products', (req, res) => {
  res.json(db.searchProducts(req.query.q || '', cid(req)));
});

app.post('/api/products', (req, res) => {
  const { sku, name, category, price_bdt, stock, image_url } = req.body || {};
  if (!sku || !name || price_bdt === undefined) {
    return res.status(400).json({ error: 'sku, name and price_bdt are required' });
  }
  const price = Number(price_bdt);
  if (!Number.isFinite(price) || price < 0) {
    return res.status(400).json({ error: 'price_bdt must be a number >= 0' });
  }
  const st = stock === undefined ? 0 : Number(stock);
  if (!Number.isInteger(st) || st < 0) {
    return res.status(400).json({ error: 'stock must be an integer >= 0' });
  }
  try {
    res.status(201).json(db.addProduct({ clientId: cid(req), sku, name, category, price_bdt: price, stock: st, image_url }));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.patch('/api/products/:id', (req, res) => {
  const { price_bdt, stock, name, sku, category, image_url } = req.body || {};
  if (price_bdt !== undefined) {
    const p = Number(price_bdt);
    if (!Number.isFinite(p) || p < 0) return res.status(400).json({ error: 'price_bdt must be a number >= 0' });
  }
  if (stock !== undefined) {
    const s = Number(stock);
    if (!Number.isInteger(s) || s < 0) return res.status(400).json({ error: 'stock must be an integer >= 0' });
  }
  if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: 'name cannot be empty' });
  if (sku !== undefined && !String(sku).trim()) return res.status(400).json({ error: 'sku cannot be empty' });
  let p;
  try {
    p = db.updateProductOwned(req.params.id, cid(req), { price_bdt, stock, name, sku, category, image_url });
  } catch (e) {
    if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That SKU is already used by another product' });
    throw e;
  }
  if (!p) return res.status(404).json({ error: 'Product not found' });
  res.json(p);
});

app.delete('/api/products/:id', (req, res) => {
  db.deleteProductOwned(req.params.id, cid(req));
  res.json({ ok: true });
});

// ---------------- orders ----------------
app.get('/api/conversations/:id/orders', (req, res) => {
  res.json(db.getOrdersByConversation(req.params.id));
});

app.get('/api/orders', (req, res) => {
  res.json(db.getOrders(cid(req)));
});

app.post('/api/orders', async (req, res) => {
  const { conversation_id, items, idempotency_key, payment } = req.body || {};
  if (!conversation_id || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'conversation_id and items:[{sku, qty}] are required' });
  }
  // The conversation must live in the caller's own workspace.
  const conv0 = db.getConversation(conversation_id);
  if (!conv0) return res.status(404).json({ error: 'Conversation not found' });
  if (req.user.role !== 'admin' && conv0.client_id !== req.user.clientId) {
    return res.status(403).json({ error: 'forbidden' });
  }
  let order;
  try {
    order = db.createOrder(conversation_id, items, idempotency_key, payment || {});
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (order.replay) {
    // Idempotent replay: the same request already created this order
    // (double-click / retry). Return the original — don't touch stock again.
    return res.status(200).json({ order, items: JSON.parse(order.items_json), replay: true });
  }
  emitClientEvent(db, cid(req), 'order.created', {
    order_id: order.id, conversation_id: order.conversation_id,
    items: JSON.parse(order.items_json), total_bdt: order.total_bdt,
  });
  const lines = JSON.parse(order.items_json);
  const conv = db.getConversations().find(c => String(c.id) === String(conversation_id));
  // Physical clients: show delivery location from the lead.
  let locLine = '';
  if (conv) {
    const leads = db.getLeads({ clientId: conv.client_id });
    const lead = leads.find(l => l.platform === conv.platform && l.platform_user_id === conv.platform_user_id);
    if (lead && lead.location) locLine = ` Delivery: ${lead.location}.`;
    db.markLeadConfirmed(conv.client_id, conv.platform, conv.platform_user_id);
  }
  const summary = `Order #${order.id} confirmed: ` +
    lines.map(l => `${l.qty}x ${l.name}`).join(', ') +
    ` — Total ${Number(order.total_bdt).toLocaleString('en-US')} BDT.${locLine} Delivery in 2-3 days. Dhonnobad!`;
  if (conv) {
    const msg = db.addMessage(conv.id, 'out', summary, null);
    const sendResult = await sendPlatformMessage(conv.platform, conv.platform_user_id, summary, conv.client_id, conv.slot || 'default');
    // Honest delivery state: the ORDER is committed (stock moved, money owed);
    // whether the confirmation message actually reached the customer is
    // reported separately — the API never claims a failed send succeeded.
    if (!sendResult.sent) {
      db.addMessage(conv.id, 'out', `[system] Order #${order.id} confirmed in the system, but the customer message failed to send (${sendResult.reason || 'delivery failed'}).`, null);
    }
    broadcast('message', { conversation: db.getConversation(conv.id), outbound: msg }, conv.client_id);
    res.status(201).json({ order, items: lines, delivery: sendResult.sent ? 'sent' : 'failed', delivery_reason: sendResult.sent ? undefined : (sendResult.reason || 'delivery failed') });
    return;
  }
  res.status(201).json({ order, items: lines });
});

// ---------------- leads ----------------
app.get('/api/leads', (req, res) => {
  res.json(db.getLeads({ clientId: cid(req), status: req.query.status || null, q: req.query.q || null, temperature: req.query.temperature || null, stage: req.query.stage || null }));
});

app.patch('/api/leads/:id', (req, res) => {
  const lead = db.updateLeadOwned(req.params.id, cid(req), req.body || {});
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  broadcast('lead', { clientId: lead.client_id }, lead.client_id);
  res.json(lead);
});

// Lead intelligence: manual re-analyze of one lead (debounce bypassed).
app.post('/api/leads/:id/analyze', async (req, res) => {
  try {
    const lead = db.getLead(req.params.id);
    if (!lead || lead.client_id !== cid(req)) return res.status(404).json({ error: 'Lead not found' });
    const r = await leadIntel.analyzeLead(lead.client_id, lead.platform, lead.platform_user_id, { force: true });
    const fresh = db.getLead(lead.id);
    broadcast('lead', { clientId: fresh.client_id }, fresh.client_id);
    res.json({ result: r.skipped || 'ok', lead: fresh });
  } catch (err) {
    console.warn('[api] lead analyze failed:', err.message);
    res.status(500).json({ error: 'analysis failed' });
  }
});

// Lead intelligence: counts by stage / temperature for the workspace.
app.get('/api/leads/intel-stats', (req, res) => {
  res.json(db.getLeadIntelStats(cid(req)));
});

// ---------------- knowledge ----------------
app.get('/api/clients/:clientId/knowledge', (req, res) => {
  res.json(db.getKnowledge(req.params.clientId));
});

app.post('/api/clients/:clientId/knowledge', (req, res) => {
  const { title, content, category } = req.body || {};
  if (!title || !content) return res.status(400).json({ error: 'title and content are required' });
  res.status(201).json(db.addKnowledge(req.params.clientId, { title, content, category }));
});

app.patch('/api/knowledge/:id', (req, res) => {
  const k = db.updateKnowledgeOwned(req.params.id, cid(req), req.body || {});
  if (!k) return res.status(404).json({ error: 'Not found' });
  res.json(k);
});

app.delete('/api/knowledge/:id', (req, res) => {
  db.deleteKnowledgeOwned(req.params.id, cid(req));
  res.json({ ok: true });
});

// ---------------- webchat: website → knowledge importer ----------------
// Import runs in the background (crawling 50 pages takes a while); the
// dashboard polls /import-status for progress.
const WC_DEFAULTS = {
  title: 'Chat with us',
  greeting: 'Hi there! \uD83D\uDC4B How can I help you today?',
  color: '#7c5cff',
  position: 'bottom-right',
  avatar: '',
  subtitle: 'Online \u2014 replies instantly',
  require_intro: 1,
  captcha: 1,
};
function webchatConfigFor(clientId) {
  const saved = db.getWebchatAppearance(clientId) || {};
  const cfg = {};
  for (const k of Object.keys(WC_DEFAULTS)) cfg[k] = saved[k] || WC_DEFAULTS[k];
  return cfg;
}
// ---- Web Push (PWA/app notifications) ----
// Public SaaS landing page.
app.get('/welcome', (req, res) => res.sendFile(path.join(__dirname, 'public', 'welcome.html')));

app.get('/api/push/vapid-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});
app.post('/api/push/subscribe', (req, res) => {
  const u = req.user; if (!u) return res.status(401).json({ error: 'login required' });
  const b = req.body || {};
  const endpoint = String(b.endpoint || '').slice(0, 500);
  const p256dh = String(b.p256dh || '').slice(0, 200);
  const auth = String(b.auth || '').slice(0, 100);
  if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: 'bad subscription' });
  const clientId = u.role === 'admin' ? 0 : (u.clientId || 0);
  db.prepare(`INSERT INTO push_subscriptions (client_id, user_id, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
      client_id = excluded.client_id, last_used_at = datetime('now')`)
    .run(clientId, u.id || null, endpoint, p256dh, auth);
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', (req, res) => {
  const u = req.user; if (!u) return res.status(401).json({ error: 'login required' });
  const endpoint = String((req.body || {}).endpoint || '');
  if (endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  res.json({ ok: true });
});
app.post('/api/admin/notify', async (req, res) => {
  const u = req.user;
  if (!u || u.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const b = req.body || {};
  const title = String(b.title || 'Tectobox').slice(0, 80);
  const body = String(b.body || '').slice(0, 200);
  if (!body) return res.status(400).json({ error: 'message body required' });
  const target = b.target === 'all' ? 'all' : parseInt(b.client_id || '0', 10);
  let total = 0;
  const payload = { title, body, tag: 'admin-' + Date.now(), url: '/' };
  if (target === 'all') {
    const rows = db.prepare('SELECT DISTINCT client_id FROM push_subscriptions').all();
    for (const r of rows) total += (await sendPushToClient(r.client_id, payload)).sent;
  } else {
    total = (await sendPushToClient(target, payload)).sent;
  }
  try { db.addAudit(u.username, 'admin.notify', target === 'all' ? 'all' : String(target), realIp(req)); } catch {}
  res.json({ ok: true, sent: total });
});

app.get('/api/webchat/config', (req, res) => {
  const id = cid(req);
  const c = db.getClient(id);
  const website = c ? c.website_url : null;
  res.json({
    widget_key: db.ensureWidgetKey(id),
    website_url: website,
    imported_pages: website ? db.countKnowledgeBySourcePrefix(id, website) : 0,
    appearance: webchatConfigFor(id),
  });
});
app.post('/api/webchat/config', (req, res) => {
  const id = cid(req);
  const b = req.body || {};
  const f = {};
  if (b.title !== undefined) f.title = String(b.title).slice(0, 60);
  if (b.greeting !== undefined) f.greeting = String(b.greeting).slice(0, 300);
  if (b.subtitle !== undefined) f.subtitle = String(b.subtitle).slice(0, 80);
  if (b.avatar !== undefined) f.avatar = String(b.avatar).slice(0, 500);
  if (b.color !== undefined) {
    const col = String(b.color).trim();
    if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(col)) return res.status(400).json({ error: 'color must be a hex like #7c5cff' });
    f.color = col;
  }
  if (b.position !== undefined) {
    if (!['bottom-right', 'bottom-left'].includes(b.position)) return res.status(400).json({ error: 'bad position' });
    f.position = b.position;
  }
  if (b.require_intro !== undefined) f.require_intro = !!+b.require_intro;
  if (b.captcha !== undefined) f.captcha = !!+b.captcha;
  if (Object.keys(f).length) db.setWebchatAppearance(id, f);
  res.json({ ok: true, appearance: webchatConfigFor(id) });
});
// ---- Knowledge Base: website import jobs (persistent, per-page detail) ----
app.post('/api/kb/import-website', (req, res) => {
  const id = cid(req);
  const url = String((req.body && req.body.url) || '').trim();
  if (!url) return res.status(400).json({ error: 'url is required' });
  const latest = db.getLatestWebsiteImport(id);
  if (latest && latest.status === 'running') {
    return res.status(409).json({ error: 'import already running' });
  }
  let origin;
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('bad protocol');
    origin = u.origin + '/';
  } catch { return res.status(400).json({ error: 'Invalid website URL' }); }
  const job = db.createWebsiteImport(id, origin);
  res.status(202).json({ ok: true, status: 'running', import_id: job.id });
  (async () => {
    try {
      const result = await crawler.importWebsite(id, origin, { importId: job.id });
      db.finishWebsiteImport(job.id, { status: 'done', ...result });
    } catch (e) {
      db.finishWebsiteImport(job.id, { status: 'error', error: e.message });
    }
  })();
});

// ---------------- Backup & Google Drive ----------------
const backup = require('./src/backup');
const drive = require('./src/drive');

function backupFilename(clientName, ext) {
  const safe = String(clientName || 'backup').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'backup';
  const stamp = new Date().toISOString().slice(0, 10);
  return `tectonic-backup-${safe}-${stamp}.${ext}`;
}

// Download full JSON backup.
app.get('/api/clients/:id/backup/export', (req, res) => {
  const id = cid(req);
  try {
    const bundle = backup.exportClientData(id);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${backupFilename(bundle.client.name, 'json')}"`);
    res.send(JSON.stringify(bundle, null, 2));
  } catch (e) { res.status(404).json({ error: e.message }); }
});

// Download human-readable MD summary.
app.get('/api/clients/:id/backup/export-md', (req, res) => {
  const id = cid(req);
  try {
    const bundle = backup.exportClientData(id);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${backupFilename(bundle.client.name, 'md')}"`);
    res.send(backup.bundleToMarkdown(bundle));
  } catch (e) { res.status(404).json({ error: e.message }); }
});

// Restore from an uploaded JSON backup.
app.post('/api/clients/:id/backup/import', express.json({ limit: '50mb' }), (req, res) => {
  const id = cid(req);
  try {
    const counts = backup.importClientData(id, req.body);
    res.json({ ok: true, imported: counts });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Drive: connection status for this client.
app.get('/api/backup/drive/status', (req, res) => {
  const id = cid(req);
  const tok = drive.getDriveTokenSecure(id);
  res.json({
    configured: drive.driveConfigured(),
    connected: drive.driveConnected(id),
    email: (tok || {}).email || null,
    folder: drive.DRIVE_FOLDER_NAME,
  });
});

// ---- Google Drive OAuth state: signed, expiring, single-use, session-bound ----
// The old code used the bare client ID as `state` — anyone observing or
// crafting a callback URL could bind a Google account to an arbitrary
// workspace (OAuth CSRF). Now the state is an HMAC-signed token (src/drive-state.js)
// that only the session which started the flow can complete, and it burns after one use.
const { issueState: issueDriveState, verifyState: verifyDriveState } = require('./src/drive-state');

// Drive: start OAuth (redirects to Google).
app.get('/api/backup/drive/connect', (req, res) => {
  const id = cid(req);
  if (!drive.driveConfigured()) return res.status(500).send('Google Drive is not configured on this server. The owner must set GOOGLE_DRIVE_CLIENT_ID/SECRET/REDIRECT_URI in .env.');
  res.redirect(drive.driveAuthUrl(issueDriveState(req.user, id)));
});

// Drive: OAuth callback.
app.get('/api/backup/drive/callback', async (req, res) => {
  let clientId;
  try {
    clientId = verifyDriveState(req, req.query.state);
  } catch (e) {
    return res.status(400).send('Drive connection failed: ' + e.message);
  }
  const code = req.query.code;
  if (!code) return res.status(400).send('Drive connection failed: missing code');
  try {
    const tokens = await drive.exchangeCode(code);
    drive.saveDriveTokenSecure(clientId, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
    });
    // SSO identity: record which Google account was connected.
    try {
      const email = await drive.getAccountEmail(clientId);
      if (email) {
        const t = db.getDriveToken(clientId) || {};
        db.saveDriveToken(clientId, { ...t, email });
      }
    } catch {}
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px;">' +
      '<h2>✅ Google Drive connected!</h2><p>You can close this tab and return to Tectonic.</p>' +
      '<script>setTimeout(() => window.close(), 3000);</script></body></html>');
  } catch (e) {
    res.status(500).send('Drive connection failed: ' + e.message);
  }
});

// Drive: disconnect.
app.post('/api/backup/drive/disconnect', (req, res) => {
  const id = cid(req);
  db.deleteDriveToken(id);
  res.json({ ok: true, connected: false });
});

// Drive: upload current backup (JSON + MD) to the client's Drive folder.
app.post('/api/clients/:id/backup/drive/upload', async (req, res) => {
  const id = cid(req);
  try {
    const bundle = backup.exportClientData(id);
    const folderId = await drive.ensureBackupFolder(id);
    const jsonFile = await drive.uploadBackupFile(id, folderId, backupFilename(bundle.client.name, 'json'),
      JSON.stringify(bundle, null, 2), 'application/json');
    const mdFile = await drive.uploadBackupFile(id, folderId, backupFilename(bundle.client.name, 'md'),
      backup.bundleToMarkdown(bundle), 'text/markdown');
    res.json({ ok: true, folder: drive.DRIVE_FOLDER_NAME, files: [jsonFile, mdFile] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Drive: list backups in the folder.
app.get('/api/clients/:id/backup/drive/list', async (req, res) => {
  const id = cid(req);
  try {
    res.json({ ok: true, ...(await drive.listBackups(id)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Super-admin: one bundle with the client list + ALL business data.
app.get('/api/admin/backup/export-all', (req, res) => {
  try {
    const bundle = backup.exportAllClients();
    res.setHeader('Content-Type', 'application/json');
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="tectonic-backup-ALL-CLIENTS-${stamp}.json"`);
    res.send(JSON.stringify(bundle, null, 2));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Drive: restore from a Drive backup file.
app.post('/api/clients/:id/backup/drive/restore', express.json(), async (req, res) => {
  const id = cid(req);
  const fileId = String((req.body && req.body.fileId) || '');
  if (!fileId) return res.status(400).json({ error: 'fileId is required' });
  try {
    const text = await drive.downloadBackup(id, fileId);
    const counts = backup.importClientData(id, JSON.parse(text));
    res.json({ ok: true, imported: counts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/kb/import-status', (req, res) => {
  const id = cid(req);
  const job = db.getLatestWebsiteImport(id);
  if (!job) return res.json({ status: 'idle' });
  const out = { ...job };
  if (job.status === 'running') {
    // Live progress from the per-page rows written so far.
    const c = db.countWebsiteImportPages(job.id);
    out.progress = { processed: c.processed, imported: c.imported, skipped: c.skipped };
  }
  return res.json(out);
});
app.get('/api/kb/imports', (req, res) => {
  res.json(db.listWebsiteImports(cid(req), 10));
});
app.get('/api/kb/imports/:importId/pages', (req, res) => {
  const id = cid(req);
  const pages = db.listWebsiteImportPages(Number(req.params.importId));
  // Tenant guard: pages must belong to this client's import.
  const imp = db.listWebsiteImports(id, 50).find(j => j.id === Number(req.params.importId));
  if (!imp) return res.status(404).json({ error: 'not found' });
  res.json(pages);
});

// ---------------- connectors ----------------
app.get('/api/clients/:clientId/connectors', (req, res) => {
  res.json(connectors.getConnectorStatus(req.params.clientId));
});

app.post('/api/clients/:clientId/connectors/:channel/connect', async (req, res) => {
  const { clientId, channel } = req.params;
  // Multi-account: slot identifies which account (default, or user-named like "support").
  const slot = String(req.body?.slot || req.query?.slot || 'default').slice(0, 40).replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  const label = String(req.body?.label || '').slice(0, 80) || null;
  if (label) db.setChannelSession(Number(clientId), channel, { label }, slot);
  let result;
  if (channel === 'whatsapp') result = await connectors.startWhatsAppConnect(Number(clientId), slot);
  else if (channel === 'telegram') result = await connectors.startTelegramConnect(Number(clientId), slot);
  else return res.status(400).json({ error: `Direct connect not supported for '${channel}' — use “Connect Facebook Page” (OAuth) in the Connectors tab` });
  if (!result.started) {
    // Re-opening while a pairing is already in flight: the latest QR was
    // re-pushed — not an error, open the modal and show it.
    if (/qr re-sent/i.test(result.reason || '')) {
      return res.json({ ok: true, channel, slot, resent: true, message: 'Scan the QR code shown in the app' });
    }
    return res.status(400).json({ error: result.reason });
  }
  res.json({ ok: true, channel, slot, message: 'Scan the QR code shown in the app' });
});

app.post('/api/clients/:clientId/connectors/:channel/disconnect', async (req, res) => {
  const clientId = Number(req.params.clientId);
  const { channel } = req.params;
  const slot = String(req.body?.slot || req.query?.slot || 'default').slice(0, 40).replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  if (channel === 'messenger' || channel === 'instagram') {
    // Unsubscribe our app from the Page, then forget the per-client token.
    const rows = db.getMetaPages(clientId).filter(r => r.channel === channel);
    for (const r of rows) {
      try {
        await graphFetch(`/${r.page_id}/subscribed_apps`, { access_token: r.page_access_token }, 'DELETE');
      } catch (e) { console.warn('[meta] unsubscribe failed:', e.message); }
    }
    db.deleteMetaPage(clientId, channel);
    broadcast('connectors', { clientId }, clientId);
    return res.json({ ok: true });
  }
  res.json(await connectors.disconnectChannel(clientId, req.params.channel, slot));
});

// Pause / resume AI auto-replies for one gateway account (whatsapp/telegram slot).
// Inbound messages keep flowing into the inbox; the AI just stays silent until
// resumed. Sticky across disconnects/restarts — it's metadata, not socket state.
app.post('/api/clients/:clientId/connectors/:channel/ai-pause', (req, res) => {
  const clientId = Number(req.params.clientId);
  const { channel } = req.params;
  if (channel !== 'whatsapp' && channel !== 'telegram') {
    return res.status(400).json({ error: 'AI pause is only supported for whatsapp/telegram accounts' });
  }
  const slot = String(req.body?.slot || 'default').slice(0, 40).replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  const paused = req.body?.paused !== false; // default true; explicit false resumes
  db.setAiPaused(clientId, channel, slot, paused);
  broadcast('connectors', { clientId }, clientId);
  res.json({ ok: true, channel, slot, paused });
});

// ---------------- FB comment automation config ----------------
// Per-client toggles + keyword rules for the comment → reply → DM → lead funnel.
app.get('/api/clients/:clientId/comment-config', (req, res) => {
  res.json(db.getCommentConfig(cid(req)));
});
app.put('/api/clients/:clientId/comment-config', (req, res) => {
  res.json(db.setCommentConfig(cid(req), req.body || {}));
});
// Recent comment activity (for the Connectors tab panel).
app.get('/api/clients/:clientId/comments', (req, res) => {
  res.json(db.getRecentComments(cid(req), 30));
});

// Delete an account slot entirely (disconnect + forget session).
app.delete('/api/clients/:clientId/connectors/:channel/:slot', async (req, res) => {
  const clientId = Number(req.params.clientId);
  const { channel, slot } = req.params;
  if (channel === 'whatsapp' || channel === 'telegram') {
    await connectors.disconnectChannel(clientId, channel, slot);
    if (channel === 'whatsapp') connectors.deleteWaSessionFiles(clientId, slot);
    db.deleteChannelSession(clientId, channel, slot);
    broadcast('connectors', { clientId }, clientId);
    return res.json({ ok: true });
  }
  return res.status(400).json({ error: 'Only whatsapp/telegram slots can be deleted' });
});

app.get('/api/webhook-urls', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const tgSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const isAdmin = req.user && req.user.role === 'admin';
  // The Telegram secret is the sole auth for the webhook endpoint — never leak
  // it to non-admin users. Clients see a masked placeholder.
  const tgUrl = tgSecret
    ? (isAdmin ? `${base}/webhooks/telegram/${tgSecret}` : `${base}/webhooks/telegram/<configured>`)
    : `${base}/webhooks/telegram/<not configured — set TELEGRAM_WEBHOOK_SECRET>`;
  res.json({
    meta: `${base}/webhooks/meta`,
    telegram: tgUrl,
  });
});

// ---------------- Platform admin API (admin only) ----------------
app.get('/api/admin/overview', (req, res) => res.json(db.adminOverview()));

app.get('/api/admin/users', (req, res) => res.json(db.getUsers()));

// Create a workspace (client) + its login user in one step.
app.post('/api/admin/users', (req, res) => {
  const { username, password, workspaceName, businessType } = req.body || {};
  if (!username || !password || !workspaceName) {
    return res.status(400).json({ error: 'username, password and workspaceName are required' });
  }
  if (db.getUserByUsername(username)) return res.status(409).json({ error: 'username already exists' });
  const pwErr = checkPasswordPolicy(String(password));
  if (pwErr) return res.status(400).json({ error: pwErr });
  // Create workspace + user atomically: never leave an orphan workspace
  // if the user insert fails (e.g. race on username uniqueness).
  const client = db.createClient({ name: workspaceName, business_type: businessType || 'physical', lead_fields: null });
  try {
    const user = db.createUser({ username, passwordHash: hashPassword(String(password)), role: 'client', clientId: client.id });
    db.addAudit(req.user.username, 'admin.user.created', `${username} → ${workspaceName}`, realIp(req));
    res.status(201).json({ id: user.id, username: user.username, role: user.role, client_id: user.client_id, client_name: workspaceName });
  } catch (e) {
    db.deleteClient(client.id); // roll back the orphaned workspace
    throw e;
  }
});

app.post('/api/admin/users/:id/reset-password', (req, res) => {
  const user = db.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  const { password } = req.body || {};
  const pwErr = checkPasswordPolicy(String(password || ''));
  if (pwErr) return res.status(400).json({ error: pwErr });
  db.setUserPassword(user.id, hashPassword(String(password)));
  db.deleteUserSessions(user.id); // all existing logins die on password reset
  db.addAudit(req.user.username, 'admin.user.password_reset', user.username, realIp(req));
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/toggle', (req, res) => {
  const user = db.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'user not found' });
  if (user.role === 'admin') return res.status(400).json({ error: 'cannot disable the admin' });
  db.setUserActive(user.id, !user.active);
  if (user.active) db.deleteUserSessions(user.id); // was active → now disabled: kill all logins
  db.addAudit(req.user.username, 'admin.user.toggled', `${user.username} → ${!user.active ? 'active' : 'disabled'}`, realIp(req));
  res.json({ ok: true, active: !user.active });
});

app.get('/api/admin/resources', (req, res) => res.json(db.connectedResources()));

// Platform config: AI model pool (smart router) + global auto-reply switch.
app.get('/api/admin/config', (req, res) => res.json({
  aiModel: db.getSetting('ai.model', process.env.AI_MODEL || '@cf/zai-org/glm-4.7-flash'),
  aiModelPool: db.getSetting('ai.model_pool', process.env.AI_MODEL_POOL || ''),
  aiBaseUrl: db.getSetting('ai.base_url', process.env.AI_BASE_URL || 'http://127.0.0.1:18080/v1'),
  autoReply: db.getSetting('ai.auto_reply', '1') === '1',
}));
app.put('/api/admin/config', (req, res) => {
  const { aiModel, aiModelPool, aiBaseUrl, autoReply } = req.body || {};
  if (aiModel !== undefined) db.setSetting('ai.model', String(aiModel));
  if (aiModelPool !== undefined) db.setSetting('ai.model_pool', String(aiModelPool));
  if (aiBaseUrl !== undefined) {
    // SSRF guard: the server fetches this URL on every AI reply, so only
    // http(s) loopback or explicitly allowlisted hosts are permitted.
    let u;
    try { u = new URL(String(aiBaseUrl)); } catch { return res.status(400).json({ error: 'aiBaseUrl must be a valid URL' }); }
    if (!['http:', 'https:'].includes(u.protocol)) return res.status(400).json({ error: 'aiBaseUrl must be http(s)' });
    const allow = (process.env.AI_URL_ALLOWLIST || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const host = u.hostname.toLowerCase();
    // Loopback detection: catch localhost, 127.0.0.1, ::1, 0.0.0.0,
    // decimal/octal forms, and IPv4-mapped IPv6 (::ffff:127.0.0.1).
    const isLoopback = (() => {
      if (host === 'localhost' || host === '::1' || host === '::') return true;
      const m6 = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
      const v4 = m6 ? m6[1] : host;
      // decimal (2130706433) and octal (0177.0.0.1) forms of 127.0.0.1
      if (/^\d+$/.test(v4) && Number(v4) === 2130706433) return true;
      const parts = v4.split('.');
      if (parts.length === 4) {
        const nums = parts.map(p => p.startsWith('0') && p.length > 1 ? parseInt(p, 8) : parseInt(p, 10));
        if (nums[0] === 127) return true;
        if (nums.every(n => n === 0)) return true; // 0.0.0.0
      }
      return v4 === '127.0.0.1';
    })();
    if (!isLoopback && !allow.includes(host)) {
      return res.status(400).json({ error: `aiBaseUrl host not allowlisted (set AI_URL_ALLOWLIST to permit ${host})` });
    }
    db.setSetting('ai.base_url', String(aiBaseUrl));
  }
  if (autoReply !== undefined) db.setSetting('ai.auto_reply', autoReply ? '1' : '0');
  db.addAudit(req.user.username, 'admin.settings.updated', 'ai config', realIp(req));
  res.json({ ok: true });
});

app.get('/api/admin/audit', (req, res) => res.json(db.getAudit(100)));

// ---------------- liveness (unauthenticated — for uptime monitors) ----------------
app.get('/healthz', (req, res) => {
  // PURE liveness check: never touches the DB. If the event loop is alive,
  // this answers in ~1ms. DB/pruning issues must not flap the watchers.
  res.json({ ok: true, lagMs: loopLagMs, time: new Date().toISOString() });
});

// ---------------- webchat widget (public — embedded on client websites) ----------------
// One-line embed: <script src="https://ss.kalandar.me/widget.js" data-client="WIDGET_KEY"></script>
// Embeddable on ANY third-party site: CORS is open by design — the per-workspace
// widget key in the URL is the credential, plus per-IP rate limiting.
app.use('/api/widget', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.post('/api/widget/:widgetKey/message', async (req, res) => {
  const client = db.getClientByWidgetKey(req.params.widgetKey);
  if (!client) return res.status(404).json({ error: 'unknown widget' });
  if (!rateLimit(`widget:${realIp(req)}`, 60, 60 * 1000)) return res.status(429).json({ error: 'rate limited' });
  const b = req.body || {};
  const visitorId = String(b.visitor_id || '').slice(0, 128);
  const text = String(b.text || '').trim().slice(0, 2000);
  if (!visitorId || !text) return res.status(400).json({ error: 'visitor_id and text are required' });
  const pageUrl = typeof b.page_url === 'string' ? b.page_url.slice(0, 500) : null;
  const pageTitle = typeof b.page_title === 'string' ? b.page_title.slice(0, 200) : null;
  // Pre-chat intro: visitor's name + phone/email. A phone-like contact also
  // fills customer_phone so lead qualification sees it directly.
  const contact = (typeof b.contact === 'string' && b.contact.trim()) ? b.contact.trim().slice(0, 120) : null;
  const contactDigits = contact ? contact.replace(/\D/g, '') : '';
  const contactIsPhone = contactDigits.length >= 7 && contactDigits.length <= 15 && !contact.includes('@');

  const conv = db.upsertConversation({
    clientId: client.id, platform: 'webchat', platformUserId: visitorId,
    customerName: (typeof b.name === 'string' && b.name.trim()) ? b.name.trim().slice(0, 120) : null,
    customerPhone: contactIsPhone ? contactDigits : null,
    customerContact: contact,
    slot: 'default',
  });
  const extId = typeof b.message_id === 'string' ? b.message_id.slice(0, 128) : null;
  if (extId && db.findMessageByExternalId(conv.id, extId)) {
    return res.json({ deduped: true, conversation_id: conv.id });
  }
  const inbound = db.addMessage(conv.id, 'in', text,
    JSON.stringify({ page_url: pageUrl, page_title: pageTitle, via: 'widget' }), null, extId);
  broadcast('message', { conversation: db.getConversation(conv.id) }, conv.client_id);
  emitClientEvent(db, conv.client_id, 'message.received', {
    conversation_id: conv.id, platform: 'webchat', platform_user_id: visitorId,
    text, message_id: inbound.id,
  });

  let replyText = null;
  try {
    if (autoReplyEnabled()) {
      if (replyingNow.has(conv.id)) {
        // Burst: another reply is already composing for this conversation —
        // wait for it (bounded) and return its answer instead of composing
        // a duplicate.
        const deadline = Date.now() + 75000;
        while (replyingNow.has(conv.id) && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 300));
        }
        const lastOut = db.getRecentMessages(conv.id, 2).reverse().find(m => m.direction === 'out');
        replyText = lastOut ? lastOut.text : null;
      } else {
        // runReplyTask: coalescing, budget, [NEEDS_HUMAN], 900-cap, store,
        // broadcast — and never silent (apology + deferred retry on failure).
        replyText = await runReplyTask(conv, 'webchat',
          { text, platformUserId: visitorId },
          { slot: 'default', pageUrl, pageTitle }, inbound, client.id);
      }
    }
  } catch (e) {
    // Backstop: runReplyTask already apologizes + retries internally.
    console.error('[widget] ai failed:', e.message);
    replyText = APOLOGY_NOTE;
    try { scheduleReplyRetry(conv); } catch {}
  }
  // Widget dedup: the client adds the reply optimistically AND polls for new
  // messages — without the reply's id both paths render it (double reply).
  // Return reply_id so the widget can dedupe + advance its poll cursor past it.
  let replyId = null;
  if (replyText) {
    const lastOut = db.getRecentMessages(conv.id, 3).reverse().find(m => m.direction === 'out');
    if (lastOut && lastOut.id > inbound.id) replyId = lastOut.id;
  }
  res.json({ reply: replyText, conversation_id: conv.id, message_id: inbound.id, reply_id: replyId });
});

// Visitor identity update (pre-chat form submit / "Change" button). The
// dashboard AI addresses the visitor by customer_name — without this, a
// corrected identity would never reach the server and the AI would keep
// using the stale name.
app.post('/api/widget/:widgetKey/identify', async (req, res) => {
  const client = db.getClientByWidgetKey(req.params.widgetKey);
  if (!client) return res.status(404).json({ error: 'unknown widget' });
  if (!rateLimit(`widget:${realIp(req)}`, 60, 60 * 1000)) return res.status(429).json({ error: 'rate limited' });
  const b = req.body || {};
  const visitorId = String(b.visitor_id || '').slice(0, 128);
  if (!visitorId) return res.status(400).json({ error: 'visitor_id required' });
  const name = (typeof b.name === 'string' && b.name.trim()) ? b.name.trim().slice(0, 120) : null;
  const contact = (typeof b.contact === 'string' && b.contact.trim()) ? b.contact.trim().slice(0, 120) : null;
  const digits = contact ? contact.replace(/\D/g, '') : '';
  const phone = (digits.length >= 7 && digits.length <= 15 && !contact.includes('@')) ? digits : null;
  const conv = db.findConversation(client.id, 'webchat', visitorId, 'default');
  if (!conv) return res.json({ ok: true, noop: true });
  // Explicit identity action wins over any stale value — overwrite, don't COALESCE.
  db.prepare('UPDATE conversations SET customer_name = COALESCE(?, customer_name), customer_phone = COALESCE(?, customer_phone), customer_contact = COALESCE(?, customer_contact) WHERE id = ?')
    .run(name || conv.customer_name, phone || conv.customer_phone, contact || conv.customer_contact, conv.id);
  res.json({ ok: true, conversation_id: conv.id });
});

// Public appearance config for the embed widget (CORS-open by design;
// the widget key in the URL is the credential). Rate-limited like /message.
app.get('/api/widget/:widgetKey/config', (req, res) => {
  const client = db.getClientByWidgetKey(req.params.widgetKey);
  if (!client) return res.status(404).json({ error: 'unknown widget' });
  if (!rateLimit(`widget-cfg:${realIp(req)}`, 60, 60 * 1000)) return res.status(429).json({ error: 'rate limited' });
  res.json(webchatConfigFor(client.id));
});

// Poll for operator (human) replies while the widget panel is open.
app.get('/api/widget/:widgetKey/messages', (req, res) => {
  const client = db.getClientByWidgetKey(req.params.widgetKey);
  if (!client) return res.status(404).json({ error: 'unknown widget' });
  if (!rateLimit(`widget-poll:${realIp(req)}`, 60, 60 * 1000)) return res.status(429).json({ error: 'rate limited' });
  const visitorId = String(req.query.visitor_id || '').slice(0, 128);
  const since = Number(req.query.since_id || 0);
  if (!visitorId) return res.status(400).json({ error: 'visitor_id required' });
  const conv = db.findConversation(client.id, 'webchat', visitorId);
  if (!conv) return res.json({ messages: [] });
  const msgs = db.getRecentMessages(conv.id, 20)
    .filter(m => m.id > since)
    .map(m => ({ id: m.id, direction: m.direction, text: m.text, at: m.created_at }));
  res.json({ messages: msgs });
});

// JSON error responses (never leak stack traces to clients).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[http] unhandled error:', err.message);
  res.status(err.status || 500).json({ error: 'internal error' });
});

// Lead-intel sweep every 30 minutes: refresh AI scoring for stale leads.
// Fire-and-forget, guarded — a sweep failure must never crash the server.
setInterval(() => {
  leadIntel.sweepStaleLeads(20).catch(err =>
    console.warn('[lead-intel] periodic sweep failed:', err.message));
}, 30 * 60 * 1000);

// Prune expired login sessions every 10 minutes (alongside OAuth state).
setInterval(() => {
  try { db.pruneSessions(); } catch (e) { console.warn('[auth] session prune failed:', e.message); }
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of pendingMetaOAuth) if (v.createdAt < cutoff) pendingMetaOAuth.delete(k);
  for (const [k, v] of pendingMetaPick) if (v.createdAt < cutoff) pendingMetaPick.delete(k);
}, 10 * 60 * 1000);

// ---------------- start ----------------
// Existing connected Pages were subscribed before 'feed' existed —
// best-effort upgrade their subscription once at boot so comment automation
// works without forcing every client through OAuth again.
async function resubscribeFeedForExistingPages() {
  try {
    const rows = db.getAllConnectedMetaPages();
    for (const r of rows) {
      try {
        await graphFetch(`/${r.page_id}/subscribed_apps`, { access_token: r.page_access_token }, 'POST',
          { subscribed_fields: META_SUBSCRIBED_FIELDS });
        console.log(`[meta] feed subscription ensured for page ${r.page_name || r.page_id} (client ${r.client_id})`);
      } catch (e) {
        console.warn(`[meta] feed resubscribe failed for client ${r.client_id}:`, e.message);
      }
    }
  } catch (e) { console.warn('[meta] feed resubscribe scan failed:', e.message); }
}
// Event-loop lag probe: if the loop stalls, /healthz reports it. Cheap,
// runs once a second, never touches the DB.
let loopLagMs = 0;
{
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    loopLagMs = Math.max(0, now - lastTick - 1000);
    lastTick = now;
    if (loopLagMs > 3000) console.warn(`[health] event-loop lag ${loopLagMs}ms`);
  }, 1000).unref();
}
// Session pruning no longer rides on /healthz (that coupled DB writes to
// liveness and flapped the watchers). Runs on its own quiet interval.
setInterval(() => {
  try { db.pruneSessions(); } catch (e) { console.warn('[health] pruneSessions:', e.message); }
}, 5 * 60 * 1000).unref();

const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const server = app.listen(PORT, BIND_HOST, () => {
  console.log(`\n  Tectonic Inbox v2 running → http://${BIND_HOST}:${PORT}\n`);
  const st = platformStatus(null);
  for (const [p, s] of Object.entries(st)) console.log(`  [${p}] ${s.mode.toUpperCase()} — ${s.note}`);
  console.log('');
  resubscribeFeedForExistingPages();
  // Best-effort: resume persisted WhatsApp/Telegram sessions (Baileys creds
  // reconnect without a re-scan). Never blocks boot.
  connectors.restoreSessions().catch((e) => console.warn('[boot] restoreSessions:', e.message));
});

// Graceful shutdown: stop accepting, close connector clients (browser/user
// sessions), flush DB, then exit — so a restart never leaks resources.
let _shuttingDown = false;
async function gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[shutdown] ${signal} — draining...`);
  server.close(() => console.log('[shutdown] http closed'));
  try { await connectors.shutdownConnectors(); } catch (e) { console.warn('[shutdown] connectors:', e.message); }
  try { db.close(); } catch (e) { console.warn('[shutdown] db:', e.message); }
  setTimeout(() => process.exit(0), 8000).unref();
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
