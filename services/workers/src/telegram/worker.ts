import { RabbitMQClient } from '@tectonic/messaging';
import { RedisCoordinator } from '@tectonic/coordination';
import { Redis } from 'ioredis';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

export async function startTelegramWorker() {
  const mq = new RabbitMQClient({
    url: process.env.RABBITMQ_URL || 'amqp://tectobox:tectobox_dev@localhost:5672/',
    exchange: 'tectobox.events'
  });
  await mq.connect();

  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  const coordinator = new RedisCoordinator(redis);

  const sessions = new Map<string, { client: TelegramClient; token: number }>();
  const leaseRenewers = new Map<string, NodeJS.Timeout>();

  const getClientWithFencing = async (clientId: string, sessionString: string) => {
    const key = `tg:${clientId}`;
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
      client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 5,
      });
      await client.connect();
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
    
    const consumeResult = await channel.consume('message.outgoing.telegram', async (msg) => {
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
  }

  console.log('[telegram-worker] started');
}
