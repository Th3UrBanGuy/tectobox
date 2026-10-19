// Google Drive backup integration — per-client OAuth 2.0 (SSO).
// Each shop owner connects their OWN Google account; backups go to a
// "Tectonic Backups" folder in their Drive.
//
// Setup (Tectonic owner, one time):
//   1. Google Cloud Console → create project → enable Google Drive API
//   2. OAuth consent screen → External → add scope .../auth/drive.file
//   3. Credentials → OAuth client ID (Web) → authorized redirect URI:
//        https://<your-domain>/api/backup/drive/callback
//   4. Put the client ID + secret in .env:
//        GOOGLE_DRIVE_CLIENT_ID=...
//        GOOGLE_DRIVE_CLIENT_SECRET=...
//        GOOGLE_DRIVE_REDIRECT_URI=https://<your-domain>/api/backup/drive/callback
//
// Security notes:
// - OAuth `state` is a SIGNED, expiring, single-use token (see server.js),
//   never a bare client ID — prevents CSRF / session-fixation on the callback.
// - access_token + refresh_token are AES-256-GCM encrypted (enc:v1) at rest
//   via src/crypto.js. Reads transparently migrate old plaintext rows.

const db = require('./db');
const { encryptSecret, decryptSecret, isEncrypted } = require('./crypto');

const DRIVE_FOLDER_NAME = 'Tectonic Backups';

function driveConfigured() {
  return !!(process.env.GOOGLE_DRIVE_CLIENT_ID && process.env.GOOGLE_DRIVE_CLIENT_SECRET
    && process.env.GOOGLE_DRIVE_REDIRECT_URI);
}

// --- egress proxy ---------------------------------------------------------
// Direct TCP to the internet is blocked from this VM; Google APIs must go
// through the egress proxy (same pattern as src/crawler.js). Cached per process.
let _dispatcher = false; // false = not tried yet, null = no proxy
function proxyDispatcher() {
  if (_dispatcher !== false) return _dispatcher;
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY;
  if (!proxyUrl) { _dispatcher = null; return null; }
  try {
    const { ProxyAgent } = require('undici');
    _dispatcher = new ProxyAgent(proxyUrl);
  } catch { _dispatcher = null; }
  return _dispatcher;
}
function gfetch(url, opts = {}) {
  const d = proxyDispatcher();
  return fetch(url, d ? { ...opts, dispatcher: d } : opts);
}

// --- token storage (encrypted at rest) ------------------------------------
function saveDriveTokenSecure(clientId, t) {
  db.saveDriveToken(clientId, {
    access_token: encryptSecret(t.access_token || ''),
    refresh_token: encryptSecret(t.refresh_token || ''),
    expires_at: t.expires_at || 0,
    email: t.email || null,
  });
}

// Returns { access_token, refresh_token, expires_at, email, connected_at } with
// tokens DECRYPTED. Transparently handles legacy plaintext rows.
function getDriveTokenSecure(clientId) {
  const row = db.getDriveToken(clientId);
  if (!row) return null;
  const dec = (v) => {
    if (!v) return '';
    try { return isEncrypted(v) ? decryptSecret(v) : v; }
    catch { return ''; }
  };
  return {
    access_token: dec(row.access_token),
    refresh_token: dec(row.refresh_token),
    expires_at: row.expires_at,
    email: row.email,
    connected_at: row.connected_at,
  };
}

function driveConnected(clientId) {
  const t = getDriveTokenSecure(clientId);
  return !!(t && t.refresh_token);
}

// --- OAuth ----------------------------------------------------------------
function driveAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_DRIVE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_DRIVE_REDIRECT_URI,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file',
    access_type: 'offline',
    prompt: 'consent',
    state: String(state),
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_DRIVE_CLIENT_ID,
    client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET,
    redirect_uri: process.env.GOOGLE_DRIVE_REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  const r = await gfetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('Token exchange failed: ' + r.status + ' ' + txt.slice(0, 200));
  }
  return r.json();
}

async function refreshAccessToken(clientId) {
  const tok = getDriveTokenSecure(clientId);
  if (!tok || !tok.refresh_token) throw new Error('Drive not connected');
  const body = new URLSearchParams({
    refresh_token: tok.refresh_token,
    client_id: process.env.GOOGLE_DRIVE_CLIENT_ID,
    client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const r = await gfetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('Token refresh failed: ' + r.status + ' ' + txt.slice(0, 200));
  }
  const data = await r.json();
  saveDriveTokenSecure(clientId, {
    access_token: data.access_token,
    refresh_token: tok.refresh_token, // Google doesn't rotate refresh tokens here
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    email: tok.email,
  });
  return data.access_token;
}

async function driveAccessToken(clientId) {
  const tok = getDriveTokenSecure(clientId);
  if (!tok) throw new Error('Drive not connected');
  if (tok.expires_at && Date.now() < tok.expires_at - 60000) return tok.access_token;
  return refreshAccessToken(clientId);
}

// --- Drive API --------------------------------------------------------------
async function driveApi(clientId, path, { method = 'GET', json = null, query = '' } = {}) {
  const doCall = async (token) => gfetch(`https://www.googleapis.com${path}${query}`, {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    },
    body: json ? JSON.stringify(json) : undefined,
  });
  let r = await doCall(await driveAccessToken(clientId));
  if (r.status === 401) { // token died — force refresh once
    r = await doCall(await refreshAccessToken(clientId));
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('Drive API failed: ' + r.status + ' ' + txt.slice(0, 200));
  }
  if (r.status === 204) return null; // No Content
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

// SSO identity: who just connected? (OpenID Connect userinfo via Drive scope)
async function getAccountEmail(clientId) {
  try {
    const me = await driveApi(clientId, '/drive/v3/about', { query: '?fields=user(emailAddress)' });
    return (me && me.user && me.user.emailAddress) || null;
  } catch { return null; }
}

// Find or create the "Tectonic Backups" folder. Returns folder ID.
async function ensureBackupFolder(clientId) {
  const q = encodeURIComponent(`name = '${DRIVE_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const found = await driveApi(clientId, '/drive/v3/files', { query: `?q=${q}&fields=files(id,name)&pageSize=1` });
  if (found.files && found.files.length) return found.files[0].id;
  const created = await driveApi(clientId, '/drive/v3/files', {
    method: 'POST',
    json: { name: DRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
  });
  return created.id;
}

// Upload a file (multipart) into the backup folder. Returns { id, webViewLink }.
async function uploadBackupFile(clientId, folderId, filename, content, mimeType) {
  const token = await driveAccessToken(clientId);
  const boundary = 'tectonic-backup-' + Date.now();
  const meta = JSON.stringify({ name: filename, parents: [folderId] });
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n${content}\r\n` +
    `--${boundary}--`;
  const r = await gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('Drive upload failed: ' + r.status + ' ' + txt.slice(0, 200));
  }
  return r.json();
}

// List backup files in the folder (newest first).
async function listBackups(clientId) {
  const folderId = await ensureBackupFolder(clientId);
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const res = await driveApi(clientId, '/drive/v3/files', {
    query: `?q=${q}&fields=files(id,name,mimeType,modifiedTime,size,webViewLink)&orderBy=modifiedTime desc&pageSize=50`,
  });
  return { folderId, files: res.files || [] };
}

// Download a backup file's content.
async function downloadBackup(clientId, fileId) {
  const token = await driveAccessToken(clientId);
  const r = await gfetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { 'Authorization': 'Bearer ' + token },
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('Drive download failed: ' + r.status + ' ' + txt.slice(0, 200));
  }
  return r.text();
}

module.exports = {
  DRIVE_FOLDER_NAME,
  driveConfigured,
  driveAuthUrl,
  exchangeCode,
  driveAccessToken,
  driveApi,
  getAccountEmail,
  getDriveTokenSecure,
  saveDriveTokenSecure,
  driveConnected,
  ensureBackupFolder,
  uploadBackupFile,
  listBackups,
  downloadBackup,
};
