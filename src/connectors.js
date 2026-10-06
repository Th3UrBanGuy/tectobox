// Connectors — live channel sessions with QR-code login.
//
//  WhatsApp: @whiskeysockets/baileys (pure WebSocket multi-device, NO browser).
//            One socket per (client, slot); auth creds persist in
//            ./sessions/baileys-<clientId>-<slot>/ so restarts reconnect
//            without a re-scan. QR shown in the UI on first pairing.
//            Egress goes through the authenticated proxy via https-proxy-agent.
//  Telegram: gramjs `telegram` package, USER-account login via QR
//            (signInUserWithQrCode). Needs TELEGRAM_API_ID / TELEGRAM_API_HASH.
//            Session string persisted in channel_sessions.
//  Messenger/Instagram: keep the existing Meta webhook + page-token flow
//            (see README); status only here.
//
//  ⚠ WhatsApp Web automation can get the number banned by WhatsApp.
//  The UI and README show this warning; the user accepts the risk.
//
//  Wiring: server.js calls initConnectors({ onInbound, emit }) once.
//    onInbound(clientId, platform, rawEvent, opts) — same pipeline as webhooks.
//      opts.slot identifies which account received the message.
//    emit(type, payload)                    — SSE broadcast.
const path = require('path');
const fs = require('fs');
const db = require('./db');

const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, '..', 'sessions');
fs.mkdirSync(SESSION_DIR, { recursive: true });

let hooks = null;
const waSockets = new Map();   // "clientId:slot" -> { sock, qr, reconnectAttempts, stopping }
const waStarting = new Set();  // "clientId:slot" with a bootstrap in flight
const tgClients = new Map();   // "clientId:slot" -> gramjs client (live)
const tgConnecting = new Set();
const tgSelf = new Map();      // "clientId:slot" -> { username } (lowercased, for group mention checks)

const slotKey = (clientId, slot = 'default') => `${clientId}:${slot}`;

function initConnectors({ onInbound, emit }) {
  hooks = { onInbound, emit };
}

// Per-slot latest QR (dataUrl). Keyed "clientId:channel:slot" — a single
// global lost QRs when several accounts connected at once, and the frontend
// now also reads the QR through the status poll (SSE fallback).
const lastQrBySlot = new Map(); // key -> { dataUrl, at }
const qrKey = (clientId, channel, slot = 'default') => `${clientId}:${channel}:${slot || 'default'}`;
function emitQr(clientId, channel, dataUrl, slot = 'default') {
  lastQrBySlot.set(qrKey(clientId, channel, slot), { dataUrl, at: Date.now() });
  if (hooks) hooks.emit('qr', { clientId, channel, slot, dataUrl }, clientId);
}
// Re-push the latest QR (e.g. user reopened the modal mid-connect).
function resendLastQr(clientId, channel, slot = 'default') {
  const q = lastQrBySlot.get(qrKey(clientId, channel, slot));
  if (q && hooks) {
    hooks.emit('qr', { clientId, channel, slot, dataUrl: q.dataUrl }, clientId);
    return true;
  }
  return false;
}
// Latest QR for a slot, or null. QR codes rotate quickly (WhatsApp ~20s), so
// entries older than 2 minutes are treated as expired — the UI must never show
// a dead code.
function getQrDataUrl(clientId, channel, slot = 'default') {
  const q = lastQrBySlot.get(qrKey(clientId, channel, slot));
  if (!q || Date.now() - q.at > 120000) return null;
  return q.dataUrl;
}
function clearQr(clientId, channel, slot = 'default') {
  lastQrBySlot.delete(qrKey(clientId, channel, slot));
}
function emitChannelStatus(clientId, channel, status, slot = 'default') {
  // A terminal status retires any pending QR — the modal must never show a
  // dead code after connect / disconnect.
  if (status === 'connected' || status === 'disconnected') clearQr(clientId, channel, slot);
  if (hooks) hooks.emit('channel_status', { clientId, channel, slot, status });
}

// ---------------- WhatsApp (Baileys — no browser) ----------------
// One Baileys multi-device socket per (clientId, slot). Auth creds persist in
// SESSION_DIR/baileys-<clientId>-<slot>/ ENCRYPTED (AES-256-GCM, see
// src/crypto.js + src/wa-auth.js) so restarts reconnect without a re-scan
// and a stolen disk/backup reveals nothing. First pairing shows a QR in
// the UI. Reconnects use exponential backoff; a real logout (loggedOut)
// wipes creds and needs a fresh QR.
// Outbound sends go through src/pacer.js: sequential per-slot queue,
// human-like typing beats and gaps, hourly/daily safety caps — the
// automation fingerprint stays minimal so the number is safer.
const { useEncryptedAuthState } = require('./wa-auth');
const { pacedSend, pacerStats } = require('./pacer');
function waAuthDir(clientId, slot = 'default') {
  return path.join(SESSION_DIR, `baileys-${clientId}-${slot}`);
}

function waProxyAgent() {
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
  if (!proxyUrl) return null;
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return new HttpsProxyAgent(proxyUrl);
  } catch (e) {
    console.error('[wa] https-proxy-agent unavailable:', e.message);
    return null;
  }
}

function waJid(to) {
  const s = String(to || '');
  if (s.includes('@')) return s;
  return `${s.replace(/[^\d]/g, '')}@s.whatsapp.net`;
}

function extractWaText(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    (m.extendedTextMessage && m.extendedTextMessage.text) ||
    (m.imageMessage && m.imageMessage.caption) ||
    (m.videoMessage && m.videoMessage.caption) ||
    (m.documentMessage && m.documentMessage.caption) ||
    ''
  );
}

// Remove every on-disk artifact for a WhatsApp slot: Baileys auth dir plus
// legacy OpenWA leftovers (Chrome profile dir, session json, lock file).
function deleteWaSessionFiles(clientId, slot = 'default') {
  try { fs.rmSync(waAuthDir(clientId, slot), { recursive: true, force: true }); } catch {}
  const prefix = `tectonic-${clientId}-${slot}`;
  try {
    for (const f of fs.readdirSync(SESSION_DIR)) {
      if (f === prefix || f.startsWith(prefix + '.')) {
        try { fs.rmSync(path.join(SESSION_DIR, f), { recursive: true, force: true }); } catch {}
      }
    }
  } catch {}
}

function isWaLive(clientId, slot = 'default') {
  const entry = waSockets.get(slotKey(clientId, slot));
  return Boolean(entry && entry.sock && entry.sock.user);
}

async function startWhatsAppConnect(clientId, slot = 'default') {
  const key = slotKey(clientId, slot);
  if (isWaLive(clientId, slot) || waStarting.has(key)) {
    // Already in progress: re-push the QR so a reopened modal isn't blank.
    const resent = resendLastQr(clientId, 'whatsapp', slot);
    return { started: false, reason: resent ? 'already connecting — QR re-sent' : 'already connecting/connected' };
  }
  let baileys;
  try {
    baileys = require('@whiskeysockets/baileys');
  } catch (err) {
    return { started: false, reason: '@whiskeysockets/baileys not installed: ' + err.message };
  }
  // Drop any half-dead entry before re-booting.
  const stale = waSockets.get(key);
  if (stale) { stale.stopping = true; try { stale.sock && stale.sock.end(); } catch {} waSockets.delete(key); }
  waStarting.add(key);
  db.setChannelSession(clientId, 'whatsapp', { status: 'connecting' }, slot);
  emitChannelStatus(clientId, 'whatsapp', 'connecting', slot);

  const entry = { sock: null, qr: null, reconnectAttempts: 0, stopping: false };
  waSockets.set(key, entry);
  // Pino-compatible silent logger for the signal key store (no log spam).
  const silentLogger = {
    level: 'silent',
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    child() { return silentLogger; },
  };

  const boot = async () => {
    // Encrypted auth state: same file layout as useMultiFileAuthState but
    // AES-256-GCM at rest; legacy plaintext files migrate transparently.
    const { state, saveCreds } = await useEncryptedAuthState(waAuthDir(clientId, slot));
    let version;
    try {
      ({ version } = await Promise.race([
        baileys.fetchLatestBaileysVersion(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('version fetch timeout')), 8000)),
      ]));
    } catch {
      version = undefined; // offline fallback: library default
    }

    const agent = waProxyAgent();
    const sock = baileys.makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: baileys.makeCacheableSignalKeyStore(state.keys, silentLogger),
      },
      browser: ['Tectonic', 'Chrome', '1.0.0'],
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      ...(agent ? { agent, fetchAgent: agent } : {}),
    });
    entry.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        entry.qr = qr;
        try {
          const QRCode = require('qrcode');
          emitQr(clientId, 'whatsapp', await QRCode.toDataURL(qr), slot);
        } catch (e) { console.error('[wa] qr render failed:', e.message); }
        db.setChannelSession(clientId, 'whatsapp', { status: 'connecting' }, slot);
        emitChannelStatus(clientId, 'whatsapp', 'connecting', slot);
      }

      if (connection === 'open') {
        entry.qr = null;
        clearQr(clientId, 'whatsapp', slot);
        entry.reconnectAttempts = 0;
        waStarting.delete(key);
        const rawId = sock.user && sock.user.id ? sock.user.id : '';
        const phone = rawId.split(':')[0].replace(/[^\d]/g, '');
        db.setChannelSession(clientId, 'whatsapp', { status: 'connected', label: phone || slot }, slot);
        emitChannelStatus(clientId, 'whatsapp', 'connected', slot);
        console.log(`[wa] client ${clientId} slot ${slot} connected${phone ? ' as ' + phone : ''}`);
      }

      if (connection === 'close') {
        const err = lastDisconnect && lastDisconnect.error;
        const statusCode = (err && err.output && err.output.statusCode) || 0;
        console.log(`[wa] client ${clientId} slot ${slot} closed, code: ${statusCode}`);
        if (entry.stopping) return;
        if (statusCode === baileys.DisconnectReason.loggedOut) {
          // Pairing revoked on the phone — wipe creds; next connect pairs fresh.
          waSockets.delete(key);
          waStarting.delete(key);
          deleteWaSessionFiles(clientId, slot);
          db.setChannelSession(clientId, 'whatsapp', { status: 'disconnected' }, slot);
          emitChannelStatus(clientId, 'whatsapp', 'disconnected', slot);
          return;
        }
        // Transient drop: exponential backoff reconnect (3s → 60s cap).
        entry.reconnectAttempts += 1;
        entry.sock = null;
        const delay = Math.min(3000 * Math.pow(2, Math.min(entry.reconnectAttempts - 1, 5)), 60000);
        db.setChannelSession(clientId, 'whatsapp', { status: 'connecting' }, slot);
        emitChannelStatus(clientId, 'whatsapp', 'connecting', slot);
        setTimeout(() => {
          if (!entry.stopping && waSockets.get(key) === entry) {
            boot().catch((e) => console.error('[wa] reconnect boot failed:', e.message));
          }
        }, delay);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        try {
          if (!m.message || (m.key && m.key.fromMe)) continue;
          const jid = (m.key && m.key.remoteJid) || '';
          if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid === 'status@broadcast') continue;
          let text = extractWaText(m);
          // Voice note / audio message -> transcribe to text, then the normal pipeline.
          if (!text && m.message && m.message.audioMessage) {
            try {
              const buf = await baileys.downloadMediaMessage(m, 'buffer', {});
              const stt = require('./stt');
              text = await stt.transcribeVoice(buf, { source: 'whatsapp' });
            } catch (e) { console.error('[wa] voice transcribe failed:', e.message); }
          }
          if (!text || typeof text !== 'string') continue;
          // Fire-and-forget: the message is stored synchronously inside
          // handleInbound; awaiting the AI here would serialize the socket
          // behind the slowest reply under burst.
          hooks.onInbound(clientId, 'whatsapp', {
            type: 'text',
            from: jid,
            text: { body: text },
            senderName: m.pushName || null,
            id: (m.key && m.key.id) || null,
          }, { slot }).catch(e => console.error('[wa] onInbound failed:', e.message));
        } catch (e) { console.error('[wa] onMessage failed:', e.message); }
      }
    });
  };

  boot().catch((err) => {
    waSockets.delete(key);
    waStarting.delete(key);
    db.setChannelSession(clientId, 'whatsapp', { status: 'disconnected' }, slot);
    emitChannelStatus(clientId, 'whatsapp', 'disconnected', slot);
    console.error(`[wa] client ${clientId} slot ${slot} connect failed:`, err.message);
  });

  return { started: true };
}

async function sendWhatsApp(clientId, to, text, slot = 'default') {
  const entry = waSockets.get(slotKey(clientId, slot));
  const sock = entry && entry.sock;
  if (!sock || !sock.user) return { sent: false, mode: 'demo', reason: 'WhatsApp not connected for this client' };
  // Anti-ban: every send goes through the pacer — sequential per-slot
  // queue, human typing beats and gaps, safety caps.
  try {
    return await pacedSend(
      clientId, slot, to, text,
      (t, txt) => sock.sendMessage(waJid(t), { text: String(txt) })
        .then(() => ({ sent: true, mode: 'live', platform: 'whatsapp' })),
      (t, on) => setWhatsAppTyping(clientId, t, on, slot),
    );
  } catch (err) {
    return { sent: false, mode: 'demo', reason: err.message };
  }
}

// Typing presence ("typing…") while the AI composes. Cosmetic only —
// failures must never break replies.
async function setWhatsAppTyping(clientId, to, on, slot = 'default') {
  try {
    const entry = waSockets.get(slotKey(clientId, slot));
    const sock = entry && entry.sock;
    if (!sock || !sock.user) return;
    await sock.sendPresenceUpdate(on ? 'composing' : 'paused', waJid(to));
  } catch {}
}

// ---------------- Telegram (gramjs user account, QR login) ----------------
async function startTelegramConnect(clientId, slot = 'default') {
  const key = slotKey(clientId, slot);
  if (tgClients.has(key) || tgConnecting.has(key)) {
    const resent = resendLastQr(clientId, 'telegram', slot);
    return { started: false, reason: resent ? 'already connecting — QR re-sent' : 'already connecting/connected' };
  }
  const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) {
    return { started: false, reason: 'TELEGRAM_API_ID / TELEGRAM_API_HASH not set (get them at my.telegram.org)' };
  }
  let tg;
  try {
    tg = require('telegram');
  } catch (err) {
    return { started: false, reason: 'telegram package not installed: ' + err.message };
  }
  tgConnecting.add(key);
  db.setChannelSession(clientId, 'telegram', { status: 'pending' }, slot);
  emitChannelStatus(clientId, 'telegram', 'pending', slot);

  (async () => {
    try {
      const { StringSession } = require('telegram/sessions');
      const { NewMessage } = require('telegram/events');
      const saved = db.getChannelSession(clientId, 'telegram', slot);
      const session = new StringSession(saved && saved.session_json ? saved.session_json : '');
      const client = new tg.TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });
      await client.connect();

      if (!(await client.checkAuthorization())) {
        const QRCode = require('qrcode');
        // gramjs 2.x: authParams.qrCode({token, expires}) — render tg:// link as QR.
        await client.signInUserWithQrCode({ apiId, apiHash }, {
          qrCode: async ({ token }) => {
            try {
              const qrLink = `tg://login?token=${token.toString('base64url')}`;
              const dataUrl = await QRCode.toDataURL(qrLink);
              emitQr(clientId, 'telegram', dataUrl, slot);
            } catch (e) { console.error('[tg] qr render failed:', e.message); }
          },
          onError: async (err) => {
            console.error('[tg] sign-in error:', err && err.message);
            return false; // keep waiting for scan
          },
          password: async () => {
            // 2FA password can't be collected here; abort with a clear message.
            throw new Error('Telegram account has 2FA enabled — disable it or use an account without 2FA for QR login');
          },
        });
      }

      const sessionStr = client.session.save();
      const me = await client.getMe().catch(() => null);
      const label = me ? (me.username ? '@' + me.username : [me.firstName, me.lastName].filter(Boolean).join(' ')) : null;
      // Cache our own username for group mention detection (no getMe per message).
      tgSelf.set(key, { username: me && me.username ? String(me.username).toLowerCase() : '' });
      db.setChannelSession(clientId, 'telegram', { sessionJson: sessionStr, status: 'connected', label }, slot);
      tgClients.set(key, client);
      tgConnecting.delete(key);
      clearQr(clientId, 'telegram', slot);
      emitChannelStatus(clientId, 'telegram', 'connected', slot);
      console.log(`[tg] client ${clientId} slot ${slot} authorized${label ? ' as ' + label : ''}`);

      client.addEventHandler(async (event) => {
        try {
          const msg = event.message;
          if (!msg || msg.out) return;
          // Voice note -> transcribe to text, then the normal pipeline.
          let inboundText = msg.message;
          if ((!inboundText || !String(inboundText).trim()) && msg.voice) {
            try {
              const buf = await msg.downloadMedia();
              const stt = require('./stt');
              inboundText = await stt.transcribeVoice(Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []), { source: 'telegram' });
            } catch (e) { console.error('[tg] voice transcribe failed:', e.message); }
          }
          if (!inboundText || typeof inboundText !== 'string') return;
          const sender = await msg.getSender();
          const senderId = sender && sender.id ? String(sender.id) : String(msg.chatId || 'unknown');
          // Bot filter: never treat another bot as a customer — no reply,
          // no inbox pollution. GramJS marks bots via sender.bot; also match
          // the username convention (*_bot) as a backstop.
          const senderUsername = sender && sender.username ? String(sender.username) : '';
          if ((sender && sender.bot === true) || /_bot$/i.test(senderUsername)) {
            console.log(`[tg] ignoring message from bot ${senderUsername || senderId}`);
            return;
          }
          const name = sender
            ? [sender.firstName, sender.lastName].filter(Boolean).join(' ') || sender.username || 'Telegram user'
            : 'Telegram user';
          // Group/supergroup? Stay silent unless the account is mentioned
          // (or someone replies to one of its messages). DMs keep the old path.
          const peerName = msg.peerId && msg.peerId.className;
          const isGroup = peerName === 'PeerChat' || peerName === 'PeerChannel';
          if (isGroup) {
            const self = tgSelf.get(key) || {};
            const mentioned = msg.mentioned === true
              || (self.username && String(inboundText).toLowerCase().includes('@' + self.username));
            let replyToOwn = false;
            if (!mentioned && msg.replyTo) {
              try {
                const replied = await msg.getReplyMessage();
                replyToOwn = !!(replied && replied.out);
              } catch {}
            }
            if (!mentioned && !replyToOwn) return; // not for us — stay out of the group chat
            // Pull the last few group messages so the reply has real context.
            let groupHistory = [];
            try {
              const recent = await client.getMessages(msg.chatId, { limit: 10 });
              const nameCache = new Map();
              for (const m of (recent || []).slice().reverse()) {
                if (!m || m.id === msg.id || !m.message) continue;
                let who;
                if (m.out) who = 'you';
                else {
                  const sid = m.senderId ? String(m.senderId) : '?';
                  if (!nameCache.has(sid)) {
                    try {
                      const s = await m.getSender();
                      nameCache.set(sid, s
                        ? [s.firstName, s.lastName].filter(Boolean).join(' ') || s.username || sid
                        : sid);
                    } catch { nameCache.set(sid, sid); }
                  }
                  who = nameCache.get(sid);
                }
                groupHistory.push({ name: who, text: String(m.message).slice(0, 300) });
              }
            } catch (e) { console.error('[tg] group history failed:', e.message); }
            let chatTitle = 'Telegram group';
            try { const c = await msg.getChat(); if (c && c.title) chatTitle = String(c.title); } catch {}
            hooks.onInbound(clientId, 'telegram', {
              text: inboundText,
              message_id: msg.id,
              from: { id: senderId, first_name: name },
              chat: { id: String(msg.chatId), type: 'group', title: chatTitle },
              mentioned: true,
              replyToMsgId: msg.id,
              groupHistory,
            }, { slot }).catch(e => console.error('[tg] onInbound failed:', e.message));
            return;
          }
          hooks.onInbound(clientId, 'telegram', {
            text: inboundText,
            message_id: msg.id,
            from: { id: senderId, first_name: name },
            chat: { id: senderId },
          }, { slot }).catch(e => console.error('[tg] onInbound failed:', e.message));
        } catch (e) { console.error('[tg] onMessage failed:', e.message); }
      }, new NewMessage({}));
    } catch (err) {
      tgConnecting.delete(key);
      db.setChannelSession(clientId, 'telegram', { status: 'disconnected' }, slot);
      emitChannelStatus(clientId, 'telegram', 'disconnected', slot);
      console.error(`[tg] client ${clientId} slot ${slot} connect failed:`, err.message);
    }
  })();

  return { started: true };
}

async function sendTelegramUser(clientId, to, text, slot = 'default', extra = {}) {
  const client = tgClients.get(slotKey(clientId, slot));
  if (!client) return { sent: false, mode: 'demo', reason: 'Telegram user session not connected for this client' };
  try {
    const opts = { message: text };
    if (extra.replyTo) opts.replyTo = extra.replyTo;
    await client.sendMessage(to, opts);
    return { sent: true, mode: 'live', platform: 'telegram' };
  } catch (err) {
    return { sent: false, mode: 'demo', reason: err.message };
  }
}

// ---------------- disconnect / status ----------------
async function disconnectChannel(clientId, channel, slot = 'default') {
  const key = slotKey(clientId, slot);
  try {
    if (channel === 'whatsapp') {
      const entry = waSockets.get(key);
      if (entry) {
        entry.stopping = true; // suppress auto-reconnect on the close event
        try { if (entry.sock) entry.sock.end(); } catch {}
        waSockets.delete(key);
      }
      waStarting.delete(key);
      // Disconnect keeps the pairing creds (reconnect won't need a re-scan).
      // Full wipe (deleteWaSessionFiles) happens on slot DELETE.
    }
    if (channel === 'telegram' && tgClients.has(key)) {
      await tgClients.get(key).disconnect().catch(() => {});
      tgClients.delete(key);
    }
  } catch (e) { console.error('[connectors] disconnect failed:', e.message); }
  db.setChannelSession(clientId, channel, { status: 'disconnected' }, slot);
  emitChannelStatus(clientId, channel, 'disconnected', slot);
  return { ok: true };
}

// Graceful shutdown: close all live connector sockets so the sessions they
// hold don't leak across restarts. Auth creds stay on disk for fast resume.
async function shutdownConnectors() {
  for (const [key, entry] of waSockets) {
    try { entry.stopping = true; if (entry.sock) entry.sock.end(); } catch {}
    waSockets.delete(key);
  }
  waStarting.clear();
  for (const [key, client] of tgClients) {
    try { await client.disconnect(); } catch {}
    tgClients.delete(key);
  }
}

// Restore persisted sessions on boot (best-effort, non-blocking):
//  - drop legacy OpenWA artifacts (Chrome profiles) — Baileys doesn't use them
//  - auto-resume WhatsApp slots the DB marks connected/connecting
//    (Baileys creds on disk reconnect without a re-scan; otherwise a fresh
//    QR is emitted)
//  - auto-resume Telegram slots that have a saved session string
async function restoreSessions() {
  try {
    for (const f of fs.readdirSync(SESSION_DIR)) {
      if (f.startsWith('tectonic-')) {
        try { fs.rmSync(path.join(SESSION_DIR, f), { recursive: true, force: true }); } catch {}
      }
    }
  } catch {}
  let clients = [];
  try { clients = db.getClients(); } catch (e) { console.error('[connectors] restore: getClients failed:', e.message); }
  for (const c of clients) {
    const cid = c.id;
    try {
      for (const s of db.listChannelSessions(cid, 'whatsapp')) {
        if (s.status === 'connected' || s.status === 'connecting') {
          console.log(`[connectors] restore: resuming WhatsApp client ${cid} slot ${s.slot}`);
          startWhatsAppConnect(cid, s.slot).catch((e) => console.error('[wa] restore failed:', e.message));
        }
      }
      for (const s of db.listChannelSessions(cid, 'telegram')) {
        if ((s.status === 'connected' || s.status === 'connecting') && s.session_json) {
          console.log(`[connectors] restore: resuming Telegram client ${cid} slot ${s.slot}`);
          startTelegramConnect(cid, s.slot).catch((e) => console.error('[tg] restore failed:', e.message));
        }
      }
    } catch (e) { console.error(`[connectors] restore failed for client ${cid}:`, e.message); }
  }
}

function getConnectorStatus(clientId) {
  const metaToken = Boolean(process.env.META_PAGE_ACCESS_TOKEN);
  // Multi-account: list all slots per channel.
  const waSessions = db.listChannelSessions(clientId, 'whatsapp');
  const tgSessions = db.listChannelSessions(clientId, 'telegram');
  const waAccounts = waSessions.map(s => ({
    slot: s.slot,
    label: s.label || s.slot,
    // Live truth wins: a DB 'connected' with no live socket is stale.
    status: isWaLive(clientId, s.slot) ? 'connected' : (s.status === 'connected' ? 'disconnected' : (s.status || 'disconnected')),
    live: isWaLive(clientId, s.slot),
    aiPaused: Boolean(s.ai_paused),
    // Latest QR (if pairing) — the dashboard polls this as an SSE fallback so
    // the scan modal can never sit blank on "waiting for scan".
    qr: getQrDataUrl(clientId, 'whatsapp', s.slot),
    pacer: pacerStats(clientId, s.slot), // outbound queue / caps (anti-ban)
  }));
  const tgAccounts = tgSessions.map(s => ({
    slot: s.slot,
    label: s.label || s.slot,
    status: tgClients.has(slotKey(clientId, s.slot)) ? 'connected' : (s.status || 'disconnected'),
    live: tgClients.has(slotKey(clientId, s.slot)),
    aiPaused: Boolean(s.ai_paused),
    qr: getQrDataUrl(clientId, 'telegram', s.slot),
  }));
  // SaaS: each client connects their OWN Facebook Page via OAuth.
  const metaPages = db.getMetaPages(clientId);
  const msgr = metaPages.find(p => p.channel === 'messenger');
  const insta = metaPages.find(p => p.channel === 'instagram');
  // Backward-compat single-account view (default slot).
  const waDefault = waAccounts.find(a => a.slot === 'default');
  const tgDefault = tgAccounts.find(a => a.slot === 'default');
  return {
    whatsapp: {
      mode: waAccounts.some(a => a.live) ? 'live' : 'demo',
      status: waDefault ? waDefault.status : 'disconnected',
      method: 'Baileys (QR scan)',
      note: waAccounts.some(a => a.live) ? `${waAccounts.filter(a => a.live).length} WhatsApp account(s) active`
        : 'Connect via QR scan. ⚠ Automation carries a ban risk — use a secondary number.',
      accounts: waAccounts,
    },
    telegram: {
      mode: tgAccounts.some(a => a.live) ? 'live' : 'demo',
      status: tgDefault ? tgDefault.status : 'disconnected',
      method: 'gramjs user session (QR scan)',
      note: tgAccounts.some(a => a.live) ? `${tgAccounts.filter(a => a.live).length} Telegram account(s) active`
        : 'Needs TELEGRAM_API_ID / TELEGRAM_API_HASH, then QR scan.',
      accounts: tgAccounts,
    },
    messenger: {
      mode: msgr || metaToken ? 'live' : 'demo',
      status: msgr ? 'connected' : 'disconnected',
      method: 'Facebook OAuth — your own Page',
      note: msgr ? `Connected: ${msgr.page_name} (page ID ${msgr.page_id})`
        : 'Click “Connect Facebook Page” and approve via Facebook — your Page’s chats will flow here.',
    },
    instagram: {
      mode: insta || metaToken ? 'live' : 'demo',
      status: insta ? 'connected' : 'disconnected',
      method: 'Facebook OAuth — via linked Page',
      note: insta ? `Connected: @${insta.ig_username} (via ${insta.page_name})`
        : 'Connect your Facebook Page above — if an Instagram business account is linked to it, IG DMs connect automatically.',
    },
    webchat: {
      mode: 'live',
      status: 'connected',
      method: 'One-line embed script',
      note: 'Paste the snippet on any website — visitor chats land in this inbox and the AI answers from your products + website.',
    },
  };
}

module.exports = {
  initConnectors,
  startWhatsAppConnect,
  startTelegramConnect,
  sendWhatsApp,
  setWhatsAppTyping,
  deleteWaSessionFiles,
  sendTelegramUser,
  disconnectChannel,
  shutdownConnectors,
  restoreSessions,
  getConnectorStatus,
  getQrDataUrl,
  emitQr, // exported for tests / tooling
};
