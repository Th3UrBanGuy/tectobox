// Minimal .env loader (no dependency) — runs before anything reads process.env.
// Only fills in vars that are NOT already set; the real environment always wins.
// This keeps the supervised host process working no matter which launcher starts it.
const fs = require('fs');
const path = require('path');

try {
  const text = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  for (let rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 &&
        ((val.startsWith('"') && val.endsWith('"')) ||
         (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch (err) {
  console.warn('[loadenv] .env not loaded:', err.message);
}

module.exports = {};
