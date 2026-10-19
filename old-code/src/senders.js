// Outbound senders. Each returns { sent: true } on success or
// { sent: false, mode: 'demo', reason } when no live channel is available.
const GRAPH_VERSION = 'v19.0';
const db = require('./db');

function getConnectors() {
  try { return require('./connectors'); } catch { return null; }
}

// SaaS: each client's OWN page token first; the global META_PAGE_ACCESS_TOKEN
// (if set) is only a fallback for the operator's own testing.
function metaTokenFor(clientId, channel) {
  if (clientId) {
    try {
      const rows = db.getMetaPages(clientId);
      const row = rows.find(r => r.channel === channel);
      if (row && row.page_access_token) return row.page_access_token;
    } catch {}
  }
  return process.env.META_PAGE_ACCESS_TOKEN || null;
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    // Never hang a webhook/AI pipeline on a stalled third party.
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ? data.error.message : `HTTP ${res.status}`);
  return data;
}

async function sendViaMeta(platform, platformUserId, text, clientId) {  const token = metaTokenFor(clientId, platform);
  if (!token) return { sent: false, mode: 'demo', reason: 'No Meta page connected for this client (Connectors tab → Connect Facebook Page)' };
  await postJson(`https://graph.facebook.com/${GRAPH_VERSION}/me/messages`, {
    recipient: { id: platformUserId },
    messaging_type: 'RESPONSE',
    message: { text },
  }, { Authorization: `Bearer ${token}` });
  return { sent: true, mode: 'live', platform };
}

// ---------------- FB/IG comment automation ----------------
// All comment actions use the client's OWN page access token (per-client SaaS).
async function graphComment(path, pageToken, params = {}, method = 'POST') {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}${path}?access_token=${encodeURIComponent(pageToken)}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ? data.error.message : `HTTP ${res.status}`);
  return data;
}

// Public reply under the comment (visible to everyone).
async function replyToComment(commentId, text, clientId) {
  const token = metaTokenFor(clientId, 'messenger');
  if (!token) return { sent: false, mode: 'demo', reason: 'No Meta page connected' };
  await graphComment(`/${commentId}/comments`, token, { message: text });
  return { sent: true, mode: 'live' };
}
// Like the comment (engagement signal).
async function likeComment(commentId, clientId) {
  const token = metaTokenFor(clientId, 'messenger');
  if (!token) return { sent: false, mode: 'demo', reason: 'No Meta page connected' };
  await graphComment(`/${commentId}/likes`, token);
  return { sent: true, mode: 'live' };
}
// Private DM follow-up to the commenter (comment → inbox funnel).
// Opens a Messenger thread; their reply arrives via the normal messaging webhook.
async function privateReplyToComment(commentId, text, clientId) {
  const token = metaTokenFor(clientId, 'messenger');
  if (!token) return { sent: false, mode: 'demo', reason: 'No Meta page connected' };
  await graphComment(`/${commentId}/private_replies`, token, { message: text });
  return { sent: true, mode: 'live' };
}
// Hide a comment (spam/abuse).
async function hideComment(commentId, clientId) {
  const token = metaTokenFor(clientId, 'messenger');
  if (!token) return { sent: false, mode: 'demo', reason: 'No Meta page connected' };
  await graphComment(`/${commentId}`, token, { is_hidden: 'true' });
  return { sent: true, mode: 'live' };
}

async function sendViaTelegramBot(chatId, text, extra = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { sent: false, mode: 'demo', reason: 'TELEGRAM_BOT_TOKEN not set' };
  const body = { chat_id: chatId, text };
  if (extra.replyTo) body.reply_to_message_id = extra.replyTo;
  await postJson(`https://api.telegram.org/bot${token}/sendMessage`, body);
  return { sent: true, mode: 'live', platform: 'telegram' };
}

async function sendPlatformMessage(platform, platformUserId, text, clientId, slot = 'default', extra = {}) {
  const connectors = getConnectors();
  try {
    if (platform === 'messenger' || platform === 'instagram') {
      return await sendViaMeta(platform, platformUserId, text, clientId);
    }
    if (platform === 'telegram') {
      // Prefer the gramjs user session (QR login); fall back to the Bot API token.
      if (connectors && clientId) {
        const r = await connectors.sendTelegramUser(clientId, platformUserId, text, slot, extra);
        if (r.sent) return r;
      }
      return await sendViaTelegramBot(platformUserId, text, extra);
    }
    if (platform === 'whatsapp') {
      // Baileys session (QR login). No official Cloud API sender wired by design.
      if (connectors && clientId) {
        const r = await connectors.sendWhatsApp(clientId, platformUserId, text, slot);
        if (r.sent) return r;
        return { sent: false, mode: 'demo', reason: r.reason };
      }
      return { sent: false, mode: 'demo', reason: 'WhatsApp not connected (use Connectors tab → QR scan)' };
    }
    return { sent: false, mode: 'demo', reason: `No live sender configured for '${platform}'` };
  } catch (err) {
    return { sent: false, mode: 'demo', reason: err.message };
  }
}

// Typing indicator ("typing…") while the AI composes a reply. WhatsApp only;
// best-effort — failures never break the reply path.
async function setTypingIndicator(platform, platformUserId, on, clientId, slot = 'default') {
  try {
    const connectors = getConnectors();
    if (platform === 'whatsapp' && connectors && clientId && connectors.setWhatsAppTyping) {
      await connectors.setWhatsAppTyping(clientId, platformUserId, on, slot);
    }
  } catch {}
}

// Per-platform connection status for GET /api/status. Never exposes secret values.
function platformStatus(clientId) {
  const connectors = getConnectors();
  if (connectors && clientId) {
    return connectors.getConnectorStatus(clientId);
  }
  const metaToken = Boolean(process.env.META_PAGE_ACCESS_TOKEN);
  const tgToken = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  return {
    messenger: { mode: metaToken ? 'live' : 'demo', needs: ['META_PAGE_ACCESS_TOKEN'],
      note: metaToken ? 'Page token present' : 'Set META_PAGE_ACCESS_TOKEN to send live replies' },
    instagram: { mode: metaToken ? 'live' : 'demo', needs: ['META_PAGE_ACCESS_TOKEN'],
      note: metaToken ? 'Page token present (IG account must be linked to the Page)'
                      : 'Set META_PAGE_ACCESS_TOKEN to send live replies' },
    whatsapp: { mode: 'demo', needs: ['Baileys QR session'],
      note: 'Connect via QR scan in the Connectors tab' },
    telegram: { mode: tgToken ? 'live' : 'demo', needs: ['TELEGRAM_BOT_TOKEN'],
      note: tgToken ? 'Bot token present' : 'Set TELEGRAM_BOT_TOKEN to send live replies' },
  };
}

module.exports = { sendPlatformMessage, setTypingIndicator, platformStatus, metaTokenFor,
  replyToComment, likeComment, privateReplyToComment, hideComment };
