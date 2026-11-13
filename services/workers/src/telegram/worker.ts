import { RabbitMQClient } from '@tectonic/messaging';
import { RedisCoordinator } from '@tectonic/coordination';
import { Redis } from 'ioredis';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import QRCode from 'qrcode';

export interface TelegramWorkerDeps {
  mq?: any;
  redis?: any;
  coordinator?: any;
  createClient?: (sessionString: string, apiId: number, apiHash: string) => any;
}

export async function startTelegramWorker(deps: TelegramWorkerDeps = {}) {
  const mq = deps.mq || new RabbitMQClient({
    url: process.env.RABBITMQ_URL || 'amqp://tectobox:tectobox_dev@localhost:5672/',
    exchange: 'tectobox.events'
  });
  if (!deps.mq) {
    await mq.connect();
  }

  const redis = deps.redis || new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  const coordinator = deps.coordinator || new RedisCoordinator(redis);

  const sessions = new Map<string, { client: TelegramClient; token: number }>();
  const leaseRenewers = new Map<string, NodeJS.Timeout>();

  const publishChannelStatus = async (clientId: string, slot: string, status: string) => {
    try {
      await mq.publish('channel.status.telegram', {
        clientId: Number(clientId),
        channel: 'telegram',
        slot,
        status,
      });
    } catch (e: any) {
      console.warn('[telegram] channel status publish failed:', e.message);
    }
  };

  const getClientWithFencing = async (clientId: string, sessionStringOrSlot?: string, explicitSlot?: string) => {
    // Support signature: (clientId, sessionString) or (clientId, slot, sessionString)
    let slot = 'default';
    let sessionString = '';
    if (explicitSlot !== undefined) {
      slot = sessionStringOrSlot || 'default';
      sessionString = explicitSlot || '';
    } else if (sessionStringOrSlot) {
      // If single optional arg, could be sessionString or slot
      if (sessionStringOrSlot.length > 30) {
        sessionString = sessionStringOrSlot;
        slot = 'default';
      } else {
        slot = sessionStringOrSlot;
      }
    }

    const key = slot && slot !== 'default' ? `tg:${clientId}:${slot}` : `tg:${clientId}`;
    const cached = sessions.get(key);
    if (cached) {
      const valid = await coordinator.validateLease(`lease:${key}`, cached.token);
      if (valid) return cached;
      sessions.delete(key);
    }

    const leaseKey = `lease:${key}`;
    const token = await coordinator.acquireLease(leaseKey, 60);
    if (!token) {
      console.warn(`[telegram] unable to acquire distributed session lease for client ${clientId}`);
      return null;
    }

    const apiId = parseInt(process.env.TELEGRAM_API_ID || '0');
    const apiHash = process.env.TELEGRAM_API_HASH || '';
    
    let client: TelegramClient;
    try {
      if (!sessionString) {
        sessionString = (await redis.get(`tg:session:${clientId}:${slot}`)) || '';
      }
      if (deps.createClient) {
        client = deps.createClient(sessionString, apiId, apiHash);
      } else {
        client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
          connectionRetries: 5,
        });
      }
      if (typeof client.connect === 'function') {
        await client.connect();
      }

      // Check if signInUserWithQrCode is available on client
      if (typeof (client as any).checkAuthorization === 'function') {
        const isAuth = await (client as any).checkAuthorization();
        if (!isAuth && typeof (client as any).signInUserWithQrCode === 'function') {
          (client as any).signInUserWithQrCode({ apiId, apiHash }, {
            qrCode: async ({ token: qrTok }: any) => {
              try {
                const qrLink = `tg://login?token=${qrTok.toString('base64url')}`;
                const dataUrl = await QRCode.toDataURL(qrLink);
                await redis.set(`tg:qr:${clientId}:${slot}`, dataUrl, 'EX', 120);
                await coordinator.publishEvent(`tenant:${clientId}:events`, {
                  type: 'qr',
                  clientId: Number(clientId),
                  channel: 'telegram',
                  slot,
                  dataUrl,
                });
              } catch (e: any) {
                console.error('[telegram] failed to render QR:', e.message);
              }
            },
            onError: async (err: any) => {
              console.error('[telegram] sign-in error:', err?.message);
              return false;
            },
            password: async () => {
              throw new Error('Telegram account has 2FA enabled');
            },
          }).then(async () => {
            await redis.del(`tg:qr:${clientId}:${slot}`).catch(() => {});
            const savedStr = typeof (client.session as any)?.save === 'function' ? (client.session as any).save() : '';
            if (savedStr) {
              await redis.set(`tg:session:${clientId}:${slot}`, savedStr);
            }
            await coordinator.publishEvent(`tenant:${clientId}:events`, {
              type: 'channel_status',
              clientId: Number(clientId),
              channel: 'telegram',
              slot,
              status: 'connected',
            });
            await publishChannelStatus(clientId, slot, 'connected');
          }).catch((err: any) => {
            console.error('[telegram] QR login failed:', err.message);
          });
        } else if (isAuth) {
          await redis.del(`tg:qr:${clientId}:${slot}`).catch(() => {});
          await coordinator.publishEvent(`tenant:${clientId}:events`, {
            type: 'channel_status',
            clientId: Number(clientId),
            channel: 'telegram',
            slot,
            status: 'connected',
          });
          await publishChannelStatus(clientId, slot, 'connected');
        }
      }
    } catch (err) {
      console.error(`[telegram] failed to connect client ${clientId}:`, err);
      await coordinator.releaseLease(leaseKey, token);
      return null;
    }

    // Set up lease renewal with heartbeat and teardown on loss
    const renewInterval = setInterval(async () => {
      const ok = await coordinator.renewLease(leaseKey, token, 60);
      if (!ok) {
        clearInterval(renewInterval);
        leaseRenewers.delete(key);
        sessions.delete(key);
        try {
          await client.disconnect();
        } catch (e) {
          console.error(`[telegram] error disconnecting on lease loss for ${clientId}:`, e);
        }
        // Stop consumer immediately upon lease renewal failure to prevent split-brain processing
        if (consumerTag && channel) {
          try {
            await channel.cancel(consumerTag);
            console.warn(`[telegram] consumer cancelled for ${consumerTag} due to lease loss`);
          } catch (e) {
            console.error('[telegram] error cancelling consumer on lease loss:', e);
          }
        }
      }
    }, 30000);

    renewInterval.unref?.();
    leaseRenewers.set(key, renewInterval);
    const entry = { client, token };
    sessions.set(key, entry);
    return entry;
  };

  const channel = mq.getChannel();
  let consumerTag: string | null = null;
  if (channel) {
    await channel.prefetch(1);

    // Setup durable main, retry (TTL + DLX), and dead-letter topology
    await mq.setupRetryTopology('message.outgoing.telegram', 'message.outgoing.telegram', {
      dlxExchange: 'tectobox.dlx',
      dlqQueue: 'message.outgoing.telegram.dlq',
      retryExchange: 'tectobox.retry',
      retryQueue: 'message.outgoing.telegram.retry',
      retryTtlMs: 5000,
    });
    
    const consumeResult = await channel.consume('message.outgoing.telegram', async (msg: any) => {
      if (!msg) return;

      let payload: any;
      try {
        payload = JSON.parse(msg.content.toString());
      } catch (err) {
        console.error('[telegram] malformed JSON payload, routing to DLQ:', err);
        channel.nack(msg, false, false);
        return;
      }

      const { clientId, sessionString, to, text, attempt } = payload || {};
      if (!clientId || !sessionString || !to || !text) {
        console.warn('[telegram] missing required fields, routing to DLQ:', payload);
        channel.nack(msg, false, false);
        return;
      }

      const headerAttempt = msg.properties?.headers?.['x-retry-count'];
      const currentAttempt = Number(headerAttempt ?? attempt) || 1;
      const MAX_RETRIES = 3;

      // Never generate a different idempotency key for the same logical send on redelivery!
      const stableIdKey = payload.idempotencyKey || `tg:${clientId}:${to}:${Buffer.from(text).toString('base64').slice(0, 32)}`;

      // Atomic send-state claim via Redis Lua script
      const claimResult = await coordinator.claimSendAttempt(stableIdKey);
      if (!claimResult.claimed) {
        if (claimResult.state === 'sent') {
          console.log(`[telegram] message ${stableIdKey} already sent, acknowledging duplicate`);
          channel.ack(msg);
          return;
        }
        if (claimResult.state === 'outcome-unknown') {
          console.warn(`[telegram] message ${stableIdKey} has ambiguous outcome from prior attempt; holding for manual reconciliation and routing to DLQ`);
          channel.nack(msg, false, false);
          return;
        }
        if (claimResult.state === 'sending') {
          console.warn(`[telegram] message ${stableIdKey} is currently being sent concurrently; rejecting redelivery`);
          channel.nack(msg, false, false);
          return;
        }
      }

      try {
        const entry = await getClientWithFencing(clientId, sessionString);
        if (!entry) {
          throw new Error(`Failed to acquire active lease for Telegram client ${clientId}`);
        }

        // Atomically validate fencing token and touch lease at provider boundary
        const isValid = await coordinator.validateAndTouchLease(`lease:tg:${clientId}`, entry.token);
        if (!isValid) {
          throw new Error(`Stale fencing token ${entry.token} for Telegram client ${clientId}; side-effect aborted`);
        }

        try {
          await entry.client.sendMessage(to, { message: text });
          await coordinator.recordSendState(stableIdKey, 'sent');
          channel.ack(msg);
        } catch (err) {
          await coordinator.recordSendState(stableIdKey, 'outcome-unknown');
          throw err;
        }
      } catch (err) {
        console.error(`[telegram] send error (attempt ${currentAttempt}/${MAX_RETRIES}):`, err);
        const latestState = await coordinator.getSendState(stableIdKey);
        if (latestState === 'outcome-unknown') {
          console.warn(`[telegram] send encountered ambiguous outcome for ${to}, routing to DLQ without blind retry`);
          channel.nack(msg, false, false);
          return;
        }

        if (currentAttempt < MAX_RETRIES) {
          const nextAttempt = currentAttempt + 1;
          const nextPayload = { ...payload, attempt: nextAttempt, idempotencyKey: stableIdKey };
          const delayMs = Math.min(1000 * Math.pow(2, currentAttempt - 1), 10000);

          try {
            await mq.publish(
              'message.outgoing.telegram',
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
            console.error('[telegram] failed to publish to retry queue, routing original to DLQ:', publishErr);
            channel.nack(msg, false, false);
          }
        } else {
          console.error(`[telegram] max retries reached for message to ${to}, routing to DLQ`);
          await coordinator.recordSendState(stableIdKey, 'failed');
          channel.nack(msg, false, false);
        }
      }
    });
    consumerTag = consumeResult?.consumerTag || null;

    // channel.connect.telegram consumer
    const connectQueue = 'channel.connect.telegram';
    await channel.assertQueue(connectQueue, { durable: true });
    await channel.bindQueue(connectQueue, 'tectobox.events', connectQueue);
    await channel.consume(connectQueue, async (msg: any) => {
      if (!msg) return;

      let payload: any;
      try {
        payload = JSON.parse(msg.content.toString());
      } catch (err) {
        console.error('[telegram] malformed connect payload, dropping:', err);
        channel.nack(msg, false, false);
        return;
      }

      const { clientId, slot, channelRowId, id, label } = payload || {};
      if (!clientId) {
        console.warn('[telegram] connect command without clientId, dropping:', payload);
        channel.nack(msg, false, false);
        return;
      }

      const effectiveSlot = slot || 'default';
      try {
        const entry = await getClientWithFencing(String(clientId), effectiveSlot);
        if (entry) {
          console.log(`[telegram] connect command started session for ${clientId}:${effectiveSlot}`);
          await publishChannelStatus(String(clientId), effectiveSlot, 'connected');
        } else {
          console.warn(`[telegram] connect ${clientId}:${effectiveSlot} could not acquire lease`);
        }
        channel.ack(msg);
      } catch (err) {
        console.error('[telegram] connect command failed:', err);
        channel.ack(msg);
      }
    });

    // channel.disconnect.telegram consumer
    const disconnectQueue = 'channel.disconnect.telegram';
    await channel.assertQueue(disconnectQueue, { durable: true });
    await channel.bindQueue(disconnectQueue, 'tectobox.events', disconnectQueue);
    await channel.consume(disconnectQueue, async (msg: any) => {
      if (!msg) return;

      let payload: any;
      try {
        payload = JSON.parse(msg.content.toString());
      } catch (err) {
        console.error('[telegram] malformed disconnect payload, dropping:', err);
        channel.nack(msg, false, false);
        return;
      }

      const { clientId, slot } = payload || {};
      if (!clientId) {
        console.warn('[telegram] disconnect command without clientId, dropping:', payload);
        channel.nack(msg, false, false);
        return;
      }

      const effectiveSlot = slot || 'default';
      const key = effectiveSlot && effectiveSlot !== 'default' ? `tg:${clientId}:${effectiveSlot}` : `tg:${clientId}`;
      const leaseKey = `lease:${key}`;

      try {
        const renewInterval = leaseRenewers.get(key);
        if (renewInterval) {
          clearInterval(renewInterval);
          leaseRenewers.delete(key);
        }

        const entry = sessions.get(key);
        if (entry) {
          sessions.delete(key);
          if (entry.client) {
            try {
              if (typeof (entry.client as any).destroy === 'function') {
                await (entry.client as any).destroy();
              } else if (typeof entry.client.disconnect === 'function') {
                await entry.client.disconnect();
              }
            } catch (e: any) {
              console.error(`[telegram] error destroying client for ${key}:`, e);
            }
          }
          await coordinator.releaseLease(leaseKey, entry.token).catch(() => {});
        }

        await redis.del(`tg:qr:${clientId}:${effectiveSlot}`).catch(() => {});
        await redis.del(`tg:session:${clientId}:${effectiveSlot}`).catch(() => {});
        await publishChannelStatus(String(clientId), effectiveSlot, 'disconnected');
        await coordinator.publishEvent(`tenant:${clientId}:events`, {
          type: 'channel_status',
          clientId: Number(clientId),
          channel: 'telegram',
          slot: effectiveSlot,
          status: 'disconnected',
        });

        channel.ack(msg);
      } catch (err) {
        console.error('[telegram] disconnect command failed:', err);
        channel.ack(msg);
      }
    });
  }

  console.log('[telegram-worker] started');
}
