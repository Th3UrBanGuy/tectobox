export interface PacerJob {
  to: string;
  text: string;
  sendFn: (to: string, text: string) => Promise<any>;
  typingFn?: (to: string, on: boolean) => Promise<void>;
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
}

export interface PacerQueue {
  items: PacerJob[];
  busy: boolean;
  sentAt: number[];
  paused: boolean;
}

const queues = new Map<string, PacerQueue>();

export const HOURLY_CAP = 50;
export const DAILY_CAP = 400;
const MAX_QUEUE = 100;
const MIN_GAP_MS = 1200;
const MAX_GAP_MS = 3500;

const keyOf = (clientId: string, slot?: string) => `${clientId}:${slot || 'default'}`;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getQueue(clientId: string, slot?: string): PacerQueue {
  const k = keyOf(clientId, slot);
  let q = queues.get(k);
  if (!q) {
    q = { items: [], busy: false, sentAt: [], paused: false };
    queues.set(k, q);
  }
  return q;
}

function prune(q: PacerQueue, now: number) {
  q.sentAt = q.sentAt.filter((t) => now - t < 24 * 3600 * 1000);
}

function capHit(q: PacerQueue, now: number) {
  prune(q, now);
  const hour = q.sentAt.filter((t) => now - t < 3600 * 1000).length;
  return hour >= HOURLY_CAP || q.sentAt.length >= DAILY_CAP;
}

async function pump(clientId: string, slot: string | undefined, q: PacerQueue) {
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
      const job = q.items.shift()!;
      const text = String(job.text || '');
      try {
        if (job.typingFn) {
          try { await job.typingFn(job.to, true); } catch {}
        }
        await sleep(rand(900, 2200) + Math.min(text.length * 12, 2500));
        if (job.typingFn) {
          try { await job.typingFn(job.to, false); } catch {}
        }
        const res = await job.sendFn(job.to, text);
        q.sentAt.push(Date.now());
        await sleep(rand(MIN_GAP_MS, MAX_GAP_MS));
        job.resolve(res);
      } catch (err) {
        if (job.typingFn) {
          try { await job.typingFn(job.to, false); } catch {}
        }
        job.reject(err);
      }
    }
  } finally {
    q.busy = false;
  }
}

export function pacedSend(
  clientId: string,
  slot: string,
  to: string,
  text: string,
  sendFn: (to: string, text: string) => Promise<any>,
  typingFn?: (to: string, on: boolean) => Promise<void>
): Promise<any> {
  const q = getQueue(clientId, slot);
  if (q.items.length >= MAX_QUEUE) {
    console.error(`[pacer] client ${clientId} slot ${slot}: queue overflow — backpressure triggered`);
    return Promise.reject(new Error(`Pacer queue overflow for ${clientId}:${slot} — maximum queue capacity of ${MAX_QUEUE} reached`));
  }
  return new Promise((resolve, reject) => {
    q.items.push({ to, text, sendFn, typingFn, resolve, reject });
    pump(clientId, slot, q).catch((e) => console.error('[pacer] pump failed:', e.message));
  });
}

export function clearPacerQueue(clientId: string, slot?: string, reason?: Error): void {
  const k = keyOf(clientId, slot);
  const q = queues.get(k);
  if (!q) return;
  const err = reason || new Error(`Pacer queue cancelled for ${k}`);
  while (q.items.length) {
    const job = q.items.shift()!;
    job.reject(err);
  }
}

export function pacerStats(clientId: string, slot?: string) {
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
