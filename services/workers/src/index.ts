import * as fs from 'fs';
import { startWhatsappWorker } from './whatsapp/worker.js';
import { startTelegramWorker } from './telegram/worker.js';
import { startAIWorker } from './ai/worker.js';
import { startMetaWorker } from './meta/worker.js';
import { startBroadcastWorker } from './broadcast/worker.js';

export const HEARTBEAT_FILE = process.env.WORKERS_HEARTBEAT_FILE || '/tmp/tectobox-workers-heartbeat';
export const HEARTBEAT_INTERVAL_MS = 5000;

let heartbeatTimer: NodeJS.Timeout | null = null;

export function writeHeartbeat(): void {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, String(Date.now()), 'utf8');
  } catch (err: any) {
    console.warn('[workers] Failed to write heartbeat file:', err.message);
  }
}

export function startHeartbeat(): NodeJS.Timeout {
  writeHeartbeat();
  heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref();
  }
  return heartbeatTimer;
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export async function main() {
  try {
    await Promise.all([
      startWhatsappWorker(),
      startTelegramWorker(),
      startMetaWorker(),
      startAIWorker(),
      startBroadcastWorker(),
    ]);
    console.log('All workers started successfully.');
    startHeartbeat();
  } catch (err: any) {
    console.error('[workers] Fatal startup failure:', err?.message || err);
    process.exit(1);
  }
}

// Only auto-run if directly executed
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith('dist/index.js') || process.argv[1].endsWith('src/index.ts'));

if (isDirectExecution) {
  main().catch((err) => {
    console.error('[workers] Fatal unhandled error in main:', err?.message || err);
    process.exit(1);
  });
}
