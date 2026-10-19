// Encrypted multi-file auth state for Baileys — a drop-in replacement for
// useMultiFileAuthState with identical file layout (creds.json,
// <type>-<id>.json) but every file's bytes are an AES-256-GCM envelope
// (see src/crypto.js). A stolen disk / backup / session copy is opaque
// noise without SESSION_ENC_KEY.
//
// Transparent migration: plaintext JSON files written by the old
// useMultiFileAuthState are read as-is and re-saved encrypted on the
// next write, so existing pairings survive the upgrade.
const fsp = require('fs').promises;
const path = require('path');
const { encryptSecret, decryptSecret, isEncrypted } = require('./crypto');

// Tiny per-file mutex (same reason as upstream: concurrent creds.update
// writes must not interleave).
function makeMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

async function useEncryptedAuthState(folder) {
  const baileys = require('@whiskeysockets/baileys');
  const { initAuthCreds } = require('@whiskeysockets/baileys/lib/Utils/auth-utils.js');
  const { proto } = baileys;
  const { BufferJSON } = baileys;

  const locks = new Map();
  const withLock = (fp, fn) => {
    let m = locks.get(fp);
    if (!m) { m = makeMutex(); locks.set(fp, m); }
    return m(fn);
  };
  const fixFileName = (f) => f && f.replace(/\//g, '__').replace(/:/g, '-');

  const readData = (file) => withLock(path.join(folder, fixFileName(file)), async () => {
    let raw;
    try {
      raw = await fsp.readFile(path.join(folder, fixFileName(file)), 'utf8');
    } catch { return null; }
    try {
      if (isEncrypted(raw)) raw = decryptSecret(raw);
      // else: legacy plaintext — accepted, re-saved encrypted on next write
      return JSON.parse(raw, BufferJSON.reviver);
    } catch (e) {
      console.error(`[wa-auth] unreadable ${file}:`, e.message);
      return null;
    }
  });

  const writeData = (data, file) => withLock(path.join(folder, fixFileName(file)), async () => {
    const json = JSON.stringify(data, BufferJSON.replacer);
    await fsp.writeFile(path.join(folder, fixFileName(file)), encryptSecret(json), { mode: 0o600 });
  });

  const removeData = (file) => withLock(path.join(folder, fixFileName(file)), async () => {
    try { await fsp.unlink(path.join(folder, fixFileName(file))); } catch {}
  });

  await fsp.mkdir(folder, { recursive: true });
  try { require('fs').chmodSync(folder, 0o700); } catch {}

  const creds = (await readData('creds.json')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}.json`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds.json'),
  };
}

module.exports = { useEncryptedAuthState };
