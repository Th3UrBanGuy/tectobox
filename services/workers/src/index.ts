import { startWhatsappWorker } from './whatsapp/worker.js';
import { startTelegramWorker } from './telegram/worker.js';
import { startAIWorker } from './ai/worker.js';
import { startMetaWorker } from './meta/worker.js';
import { startBroadcastWorker } from './broadcast/worker.js';

async function main() {
  await Promise.all([
    startWhatsappWorker(),
    startTelegramWorker(),
    startMetaWorker(),
    startAIWorker(),
    startBroadcastWorker()
  ]);
  console.log('All workers started successfully.');
}

main().catch(console.error);
