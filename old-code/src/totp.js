// TOTP (RFC 6238) two-factor auth for admin logins.
// Dependency-free: HMAC-SHA1 over a 30-second counter, base32 secrets,
// ±1 step tolerance for clock skew. Secrets are stored AES-256-GCM
// encrypted (see server.js); this module never touches storage.
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function generateSecret(bytes = 20) {
  const buf = crypto.randomBytes(bytes);
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const bytes = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

function hotp(secret, counter) {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const code = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000;
  return String(code).padStart(6, '0');
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// token: 6 digits. Accepts ±windowSteps 30s steps around now.
function verifyTotp(secret, token, windowSteps = 1) {
  const t = String(token || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(t)) return false;
  const step = Math.floor(Date.now() / 30000);
  for (let d = -windowSteps; d <= windowSteps; d++) {
    if (timingSafeEqualStr(hotp(secret, step + d), t)) return true;
  }
  return false;
}

function otpauthUrl(secret, account, issuer = 'Tectonic') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}

module.exports = { generateSecret, verifyTotp, otpauthUrl };
