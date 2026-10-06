// Session credential encryption at rest (AES-256-GCM).
// Format: enc:v1:<iv-b64>:<tag-b64>:<data-b64>
// Key: 32 bytes from SESSION_ENC_KEY (hex). If unset, a key is generated
// once and appended to the project .env so sessions stay decryptable
// across restarts. Without the key the auth files are opaque noise.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');
const PREFIX = 'enc:v1:';

function loadOrCreateKey() {
  let hex = (process.env.SESSION_ENC_KEY || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  // Generate once and persist — otherwise a restart would orphan every session.
  const fresh = crypto.randomBytes(32);
  try {
    let env = '';
    try { env = fs.readFileSync(ENV_PATH, 'utf8'); } catch {}
    if (!env.includes('SESSION_ENC_KEY=')) {
      if (env && !env.endsWith('\n')) env += '\n';
      env += `SESSION_ENC_KEY=${fresh.toString('hex')}\n`;
      fs.writeFileSync(ENV_PATH, env, { mode: 0o600 });
      try { fs.chmodSync(ENV_PATH, 0o600); } catch {}
    }
  } catch (e) {
    console.error('[crypto] could not persist SESSION_ENC_KEY:', e.message);
  }
  process.env.SESSION_ENC_KEY = fresh.toString('hex');
  console.log('[crypto] generated new SESSION_ENC_KEY and stored it in .env');
  return fresh;
}

let _key = null;
function sessionKey() {
  if (!_key) _key = loadOrCreateKey();
  return _key;
}

function isEncrypted(s) {
  return typeof s === 'string' && s.startsWith(PREFIX);
}

// Encrypt a UTF-8 string (or Buffer). Returns the enc:v1 envelope.
function encryptSecret(plain) {
  const key = sessionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.isBuffer(plain) ? plain : Buffer.from(String(plain), 'utf8');
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString('base64') + ':' + tag.toString('base64') + ':' + enc.toString('base64');
}

// Decrypt an enc:v1 envelope. Throws on wrong key / tampered data.
function decryptSecret(envelope) {
  if (!isEncrypted(envelope)) throw new Error('not an enc:v1 envelope');
  const parts = envelope.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('malformed enc:v1 envelope');
  const [ivB, tagB, dataB] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey(), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  const out = Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]);
  return out.toString('utf8');
}

module.exports = { encryptSecret, decryptSecret, isEncrypted, sessionKey };
