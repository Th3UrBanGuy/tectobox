import { RabbitMQClient } from '@tectonic/messaging';
import { RedisCoordinator } from '@tectonic/coordination';
import { Redis } from 'ioredis';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, ConnectionState } from '@whiskeysockets/baileys';
import { pacedSend, clearPacerQueue } from './pacer.js';
import * as path from 'path';
import QRCode from 'qrcode';

export async function startWhatsappWorker() {
  const mq = new RabbitMQClient({
    url: process.env.RABBITMQ_URL || 'amqp://tectobox:tectobox_dev@localhost:5672/',
    exchange: 'tectobox.events'
  });
  await mq.connect();

  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  const coordinator = new RedisCoordinator(redis);

  const sockets = new Map<string, { sock: any; token: number }>();
  let consumerTag: string | null = null;
  const channel = mq.getChannel();

  const getSocketWithFencing = async (clientId: string, slot: string) => {
    const key = `wa:${clientId}:${slot}`;
    const cached = sockets.get(key);
    if (cached) {
      // Validate lease ownership immediately before use
      const valid = await coordinator.validateLease(`lease:${key}`, cached.token);
      if (valid) return cached;
      sockets.delete(key);
    }

    const leaseKey = `lease:${key}`;
    const token = await coordinator.acquireLease(leaseKey, 60);
    if (!token) {
      console.log(`[whatsapp] could not acquire lease for ${key}`);
      return null;
    }
    
    let sock: any = null;
    let isLeaseValid = true;
    const renewInterval = setInterval(async () => {
      const ok = await coordinator.renewLease(leaseKey, token, 60);
      if (!ok) {
        isLeaseValid = false;
        clearInterval(renewInterval);
        sockets.delete(key);

        // 1. Drain & abort queued pacer tasks
        clearPacerQueue(clientId, slot, new Error(`Lease lost for WhatsApp client ${clientId}:${slot}`));

        // 2. Disconnect socket
        if (sock) {
          try {
            sock.end(new Error('Lease expired or fenced'));
          } catch (e) {
            console.error(`[whatsapp] error closing socket on lease loss for ${key}:`, e);
          }
        }

        // 3. Stop consumer immediately upon lease renewal failure to prevent split-brain processing
        if (consumerTag && channel) {
          try {
            await channel.cancel(consumerTag);
            console.warn(`[whatsapp] consumer cancelled for ${consumerTag} due to lease loss`);
          } catch (e) {
            console.error('[whatsapp] error cancelling consumer on lease loss:', e);
          }
        }
      }
    }, 30000);

    const baseSessionDir = process.env.SESSION_DIR || path.join(process.cwd(), 'wa-auth');
    const authDir = path.join(baseSessionDir, key);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const dataUrl = await QRCode.toDataURL(qr);
          await redis.set(`wa:qr:${clientId}:${slot}`, dataUrl, 'EX', 120);
          await coordinator.publishEvent(`tenant:${clientId}:events`, {
            type: 'qr',
            clientId: Number(clientId),
            channel: 'whatsapp',
            slot,
            dataUrl,
          });
        } catch (e: any) {
          console.error('[whatsapp] failed to render QR:', e.message);
        }
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('[whatsapp] connection closed, reconnecting:', shouldReconnect);
        clearInterval(renewInterval);
        sockets.delete(key);
        clearPacerQueue(clientId, slot, new Error(`Connection closed for WhatsApp client ${clientId}:${slot}`));
        coordinator.releaseLease(leaseKey, token);
        await redis.del(`wa:qr:${clientId}:${slot}`).catch(() => {});
        await coordinator.publishEvent(`tenant:${clientId}:events`, {
          type: 'channel_status',
          clientId: Number(clientId),
          channel: 'whatsapp',
          slot,
          status: 'disconnected',
        });
      } else if (connection === 'open') {
        console.log('[whatsapp] opened connection');
        await redis.del(`wa:qr:${clientId}:${slot}`).catch(() => {});
        await coordinator.publishEvent(`tenant:${clientId}:events`, {
          type: 'channel_status',
          clientId: Number(clientId),
          channel: 'whatsapp',
          slot,
          status: 'connected',
        });
      }
    });

    sock.ev.on('messages.upsert', async (m: any) => {
      for (const msg of m.messages) {
        if (!msg.message || msg.key.fromMe) continue;
        
        await mq.publish('message.incoming.whatsapp', {
          clientId,
          slot,
          message: msg
        });
      }
    });

    const entry = { sock, token };
    sockets.set(key, entry);
    return entry;
  };

  if (channel) {
    await channel.prefetch(1);

    // Setup durable main, retry (TTL + DLX), and dead-letter topology
    await mq.setupRetryTopology('message.outgoing.whatsapp', 'message.outgoing.whatsapp', {
      dlxExchange: 'tectobox.dlx',
      dlqQueue: 'message.outgoing.whatsapp.dlq',
      retryExchange: 'tectobox.retry',
      retryQueue: 'message.outgoing.whatsapp.retry',
      retryTtlMs: 5000,
    });
    
    const consumeResult = await channel.consume('message.outgoing.whatsapp', async (msg: any) => {
      if (!msg) return;

      let payload: any;
      try {
        payload = JSON.parse(msg.content.toString());
      } catch (err) {
        console.error('[whatsapp] malformed JSON payload, routing to DLQ:', err);
        channel.nack(msg, false, false);
        return;
      }

      const { clientId, slot, to, text, attempt } = payload || {};
      if (!clientId || !to || !text) {
        console.warn('[whatsapp] missing required fields, routing to DLQ:', payload);
        channel.nack(msg, false, false);
        return;
      }

      // Read retry attempt from message header if present (broker-managed retry) or payload
      const headerAttempt = msg.properties?.headers?.['x-retry-count'];
      const currentAttempt = Number(headerAttempt ?? attempt) || 1;
      const MAX_RETRIES = 3;

      // Never generate a different idempotency key for the same logical send on redelivery!
      // If payload already has an idempotencyKey, preserve it deterministically.
      // If not, derive deterministic key from clientId, slot, to, and message text hash/content.
      const stableIdKey = payload.idempotencyKey || `wa:${clientId}:${slot || 'default'}:${to}:${Buffer.from(text).toString('base64').slice(0, 32)}`;

      // Atomic send-state claim via Redis Lua script
      const claimResult = await coordinator.claimSendAttempt(stableIdKey);
      if (!claimResult.claimed) {
        if (claimResult.state === 'sent') {
          console.log(`[whatsapp] message ${stableIdKey} already sent, acknowledging duplicate`);
          channel.ack(msg);
          return;
        }
        if (claimResult.state === 'outcome-unknown') {
          console.warn(`[whatsapp] message ${stableIdKey} has ambiguous outcome from prior attempt; holding for manual reconciliation and routing to DLQ`);
          channel.nack(msg, false, false);
          return;
        }
        if (claimResult.state === 'sending') {
          console.warn(`[whatsapp] message ${stableIdKey} is currently being sent concurrently; rejecting redelivery`);
          channel.nack(msg, false, false);
          return;
        }
      }

      try {
        await pacedSend(
          clientId,
          slot || 'default',
          to,
          text,
          async (target, txt) => {
            const entry = await getSocketWithFencing(clientId, slot || 'default');
            if (!entry) {
              throw new Error(`Failed to acquire active lease for WhatsApp ${clientId}:${slot || 'default'}`);
            }

            // Atomically validate lease and monotonic fencing token at the provider call boundary
            const isValid = await coordinator.validateAndTouchLease(`lease:wa:${clientId}:${slot || 'default'}`, entry.token);
            if (!isValid) {
              throw new Error(`Stale fencing token ${entry.token} for WhatsApp ${clientId}:${slot || 'default'}; side-effect aborted`);
            }

            try {
              const res = await entry.sock.sendMessage(target, { text: txt });
              await coordinator.recordSendState(stableIdKey, 'sent');
              return res;
            } catch (err) {
              // Ambiguous outcome if timeout or network failure occurred during send
              await coordinator.recordSendState(stableIdKey, 'outcome-unknown');
              throw err;
            }
          },
          async (target, isTyping) => {
            const entry = await getSocketWithFencing(clientId, slot || 'default');
            if (entry) {
              await entry.sock.sendPresenceUpdate(isTyping ? 'composing' : 'paused', target);
            }
          }
        );

        channel.ack(msg);
      } catch (err) {
        console.error(`[whatsapp] send error (attempt ${currentAttempt}/${MAX_RETRIES}):`, err);
        const latestState = await coordinator.getSendState(stableIdKey);
        if (latestState === 'outcome-unknown') {
          console.warn(`[whatsapp] send encountered ambiguous outcome for ${to}, routing to DLQ without blind retry`);
          channel.nack(msg, false, false);
          return;
        }

        if (currentAttempt < MAX_RETRIES) {
          // Broker-managed durable retry routing: publish to durable retry exchange with TTL and headers
          const nextAttempt = currentAttempt + 1;
          const nextPayload = { ...payload, attempt: nextAttempt, idempotencyKey: stableIdKey };
          const delayMs = Math.min(1000 * Math.pow(2, currentAttempt - 1), 10000);

          try {
            await mq.publish(
              'message.outgoing.whatsapp',
              nextPayload,
              {
                exchange: 'tectobox.retry',
                expiration: delayMs,
                headers: { 'x-retry-count': nextAttempt },
                mandatory: true,
              }
            );
            // Only ack original message after confirmed republish to retry queue
            channel.ack(msg);
          } catch (publishErr) {
            console.error('[whatsapp] failed to publish to retry queue, routing original to DLQ:', publishErr);
            channel.nack(msg, false, false);
          }
        } else {
          console.error(`[whatsapp] max retries reached for ${to}, sending to DLQ`);
          await coordinator.recordSendState(stableIdKey, 'failed');
          channel.nack(msg, false, false); // Route to DLQ
        }
      }
    });
    consumerTag = consumeResult?.consumerTag || null;
  }

  console.log('[whatsapp-worker] started');
}
