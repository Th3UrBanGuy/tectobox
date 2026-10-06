// Tectonic public API (v1) — per-workspace API keys + signed outbound webhooks.
// Lets any business integrate Tectonic into their own site/app/ERP without
// touching the dashboard: Bearer-token REST reads + event webhooks.
const crypto = require('crypto');
const dns = require('dns').promises;

const KEY_PREFIX = 'tk_';
const API_KEY_BYTES = 32;

// ---- key issuance / verification (only the SHA-256 hash is ever stored) ----
function mintApiKey() {
  const raw = KEY_PREFIX + crypto.randomBytes(API_KEY_BYTES).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash, prefix: raw.slice(0, 12) + '…' };
}

// ---- SSRF guard for outbound webhook URLs ----
function ipIsPrivate(ip) {
  if (ip.startsWith('127.') || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return true;
  if (ip.startsWith('169.254.') || ip === '::ffff:169.254.169.254') return true; // cloud metadata
  if (ip.startsWith('fc00:') || ip.startsWith('fd00:') || ip.startsWith('fe80:')) return true;
  if (ip === '0.0.0.0' || ip === '::') return true;
  return false;
}
async function webhookUrlAllowed(url) {
  let u;
  try { u = new URL(String(url)); } catch { return 'not a valid URL'; }
  if (!['http:', 'https:'].includes(u.protocol)) return 'only http(s) URLs allowed';
  if (u.username || u.password) return 'credentials in URL are not allowed';
  let addrs;
  try { addrs = await dns.lookup(u.hostname, { all: true }); }
  catch { return 'hostname does not resolve'; }
  if (addrs.some(a => ipIsPrivate(a.address))) return 'private/loopback targets are not allowed';
  return null;
}

// ---- signed outbound delivery ----
function signPayload(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}
// Fire-and-forget: never blocks the inbox hot path, never throws.
function emitClientEvent(db, clientId, event, payload) {
  if (!clientId) return;
  let hooks;
  try { hooks = db.activeWebhooksFor(clientId); } catch { return; }
  for (const h of hooks) {
    const wanted = String(h.events || '').split(',').map(s => s.trim());
    if (wanted.length && !wanted.includes(event)) continue;
    (async () => {
      try {
        const blocked = await webhookUrlAllowed(h.url);
        if (blocked) { console.warn(`[webhook] not delivering to ${h.url}: ${blocked}`); return; }
        const body = JSON.stringify({ event, client_id: clientId, at: new Date().toISOString(), data: payload });
        const res = await fetch(h.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Tectonic-Event': event,
            'X-Tectonic-Signature': signPayload(h.secret, body),
            'User-Agent': 'Tectonic-Webhooks/1.0',
          },
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) console.warn(`[webhook] ${h.url} → HTTP ${res.status} (${event})`);
      } catch (e) {
        console.warn(`[webhook] delivery failed ${h.url} (${event}):`, e.message);
      }
    })();
  }
}

module.exports = { mintApiKey, webhookUrlAllowed, emitClientEvent, signPayload, API_KEY_BYTES };
