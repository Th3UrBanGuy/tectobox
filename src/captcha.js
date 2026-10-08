// Self-hosted CAPTCHA — no external service, no API keys, no tracking.
// The challenge token is an AES-256-GCM envelope (src/crypto.js) holding
// {code, exp}, so the server stays stateless; the answer is checked with a
// timing-safe compare. Used on login after repeated failures and on the
// public widget after abuse thresholds — not on every request.
const crypto = require('crypto');
const { encryptSecret, decryptSecret } = require('./crypto');

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
const TTL_MS = 5 * 60 * 1000;

function randomCode(n = 6) {
  const buf = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += CHARS[buf[i] % CHARS.length];
  return s;
}

function captchaSvg(code) {
  const W = 170, H = 62;
  let chars = '';
  for (let i = 0; i < code.length; i++) {
    const x = 16 + i * 25 + Math.floor(Math.random() * 6);
    const y = 40 + Math.floor(Math.random() * 9) - 4;
    const r = Math.floor(Math.random() * 50) - 25;
    const fs = 30 + Math.floor(Math.random() * 6);
    chars += `<text x="${x}" y="${y}" font-family="ui-monospace,monospace" font-size="${fs}" font-weight="bold" fill="#161616" transform="rotate(${r} ${x} ${y})">${code[i]}</text>`;
  }
  let noise = '';
  for (let i = 0; i < 4; i++) {
    noise += `<line x1="${Math.floor(Math.random() * W)}" y1="${Math.floor(Math.random() * H)}" x2="${Math.floor(Math.random() * W)}" y2="${Math.floor(Math.random() * H)}" stroke="#8a8a8a" stroke-width="1" opacity="0.55"/>`;
  }
  for (let i = 0; i < 42; i++) {
    noise += `<circle cx="${Math.floor(Math.random() * W)}" cy="${Math.floor(Math.random() * H)}" r="1.3" fill="#9a9a9a" opacity="0.5"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#f1f1f1"/>${noise}${chars}</svg>`;
}

function createChallenge() {
  const code = randomCode(6);
  const token = encryptSecret(JSON.stringify({ code, exp: Date.now() + TTL_MS }));
  return { token, svg: captchaSvg(code) };
}

function verifyChallenge(token, answer) {
  try {
    const { code, exp } = JSON.parse(decryptSecret(String(token || '')));
    if (!code || Date.now() > exp) return false;
    const a = String(answer || '').trim().toUpperCase();
    if (a.length !== code.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(code));
  } catch {
    return false;
  }
}

module.exports = { createChallenge, verifyChallenge };
