// Anti-ban outbound pacer for WhatsApp.
// Automated sends at machine speed are the clearest bot signal WhatsApp
// uses. This module makes every outbound message look human:
//   - strictly sequential FIFO queue per (clientId, slot) — never parallel
//   - "composing" typing presence for a beat proportional to message length
//   - random 1.2–3.5s pause between messages (humans don't burst)
//   - rolling safety caps: 50 msgs/hour, 400/day per slot; on breach the
//     queue pauses until the window slides and a loud warning is logged
//   - queue depth guard: beyond 100 pending the newest send is refused
//     (protects against runaway loops instead of blasting the account)
//
// Caps are heuristic (WhatsApp publishes no numbers); they exist to stop
// a bug or a spammy flow from torching a business number, not as a
// guarantee. No pacing scheme can promise "no ban" — this one minimizes
// the automation fingerprint.
const queues = new Map(); // key -> { items: [], busy: bool, sentAt: [ts], paused: bool }

const HOURLY_CAP = 50;
const DAILY_CAP = 400;
const MAX_QUEUE = 100;
const MIN_GAP_MS = 1200;
const MAX_GAP_MS = 3500;

const keyOf = (clientId, slot) => `${clientId}:${slot || 'default'}`;
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getQueue(clientId, slot) {
  const k = keyOf(clientId, slot);
  let q = queues.get(k);
  if (!q) { q = { items: [], busy: false, sentAt: [], paused: false }; queues.set(k, q); }
  return q;
}

function prune(q, now) {
  q.sentAt = q.sentAt.filter((t) => now - t < 24 * 3600 * 1000);
}

function capHit(q, now) {
  prune(q, now);
  const hour = q.sentAt.filter((t) => now - t < 3600 * 1000).length;
  return hour >= HOURLY_CAP || q.sentAt.length >= DAILY_CAP;
}

async function pump(clientId, slot, q) {
  if (q.busy) return;
  q.busy = true;
  try {
    while (q.items.length) {
      const now = Date.now();
      if (capHit(q, now)) {
        if (!q.paused) {
          q.paused = true;
          console.warn(`[pacer] client ${clientId} slot ${slot}: safety cap hit — outbound paused until window slides`);
        }
        await sleep(60 * 1000);
        continue;
      }
      q.paused = false;
      const job = q.items.shift();
      const text = String(job.text || '');
      try {
        // Human beat: typing indicator, longer for longer messages.
        try { await job.typingFn(job.to, true); } catch {}
        await sleep(rand(900, 2200) + Math.min(text.length * 12, 2500));
        try { await job.typingFn(job.to, false); } catch {}
        const res = await job.sendFn(job.to, text);
        q.sentAt.push(Date.now());
        // Human gap before the next message.
        await sleep(rand(MIN_GAP_MS, MAX_GAP_MS));
        job.resolve(res);
      } catch (err) {
        try { await job.typingFn(job.to, false); } catch {}
        job.reject(err);
      }
    }
  } finally {
    q.busy = false;
  }
}

// Enqueue one outbound WhatsApp message. Resolves with sendFn's result
// once the message is actually sent (after human-like pacing).
//   sendFn   — async (to, text) => result  (the real socket send)
//   typingFn — async (to, on) => void      (presence update; may be null)
function pacedSend(clientId, slot, to, text, sendFn, typingFn) {
  const q = getQueue(clientId, slot);
  if (q.items.length >= MAX_QUEUE) {
    console.error(`[pacer] client ${clientId} slot ${slot}: queue overflow — refusing send (possible loop)`);
    return Promise.resolve({ sent: false, mode: 'demo', reason: 'pacer queue overflow — refused to protect the number' });
  }
  return new Promise((resolve, reject) => {
    q.items.push({ to, text, sendFn, typingFn: typingFn || (async () => {}), resolve, reject });
    pump(clientId, slot, q).catch((e) => console.error('[pacer] pump failed:', e.message));
  });
}

function pacerStats(clientId, slot) {
  const q = queues.get(keyOf(clientId, slot));
  if (!q) return { pending: 0, sentHour: 0, sentDay: 0, paused: false };
  const now = Date.now();
  prune(q, now);
  return {
    pending: q.items.length,
    sentHour: q.sentAt.filter((t) => now - t < 3600 * 1000).length,
    sentDay: q.sentAt.length,
    paused: q.paused,
  };
}

module.exports = { pacedSend, pacerStats, HOURLY_CAP, DAILY_CAP };
