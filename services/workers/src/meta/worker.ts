import { RabbitMQClient } from '@tectonic/messaging';
import { RedisCoordinator } from '@tectonic/coordination';
import { Redis } from 'ioredis';
import { fetch } from 'undici';

export async function handleMetaOutgoingMessage(
  msg: any,
  channel: any,
  coordinator: any,
  redis: any,
  mq: any
): Promise<{ status: string; error?: string }> {
  if (!msg) return { status: 'ignored' };

  let payload: any;
  try {
    payload = JSON.parse(msg.content.toString());
  } catch (err) {
    console.error('[meta] malformed JSON payload, routing to DLQ:', err);
    channel.nack(msg, false, false);
    return { status: 'failed', error: 'malformed_json' };
  }

  const { clientId, to, text, platform, attempt } = payload || {};
  if (!clientId || !to || !text) {
    console.warn('[meta] missing required fields, routing to DLQ:', payload);
    channel.nack(msg, false, false);
    return { status: 'failed', error: 'missing_required_fields' };
  }

  const channelName = platform === 'instagram' ? 'instagram' : 'messenger';
  const headerAttempt = msg.properties?.headers?.['x-retry-count'];
  const currentAttempt = Number(headerAttempt ?? attempt) || 1;
  const MAX_RETRIES = 3;

  const stableIdKey =
    payload.idempotencyKey ||
    `meta:${clientId}:${channelName}:${to}:${Buffer.from(text).toString('base64').slice(0, 32)}`;

  const claimResult = await coordinator.claimSendAttempt(stableIdKey);
  if (!claimResult.claimed) {
    if (claimResult.state === 'sent') {
      console.log(`[meta] message ${stableIdKey} already sent, acknowledging duplicate`);
      channel.ack(msg);
      return { status: 'duplicate_sent' };
    }
    if (claimResult.state === 'outcome-unknown') {
      console.warn(`[meta] message ${stableIdKey} has ambiguous outcome; routing to DLQ`);
      channel.nack(msg, false, false);
      return { status: 'outcome_unknown' };
    }
    if (claimResult.state === 'sending') {
      console.warn(`[meta] message ${stableIdKey} currently in-flight; rejecting redelivery`);
      channel.nack(msg, false, false);
      return { status: 'in_flight' };
    }
  }

  try {
    // Resolve page access token from Redis cache or fallback environment variable
    let token = await redis.get(`meta:token:${clientId}:${channelName}`);
    if (!token) {
      token = process.env.META_PAGE_ACCESS_TOKEN || null;
    }

    if (!token) {
      const errMsg = 'meta_send_not_configured';
      console.error(`[meta] no active Meta page token for client ${clientId} (${channelName}); ${errMsg}`);
      await coordinator.recordSendState(stableIdKey, 'failed');
      if (typeof redis.set === 'function') {
        await redis.set(`send_attempt_error:${stableIdKey}`, errMsg, 'EX', 86400);
      }
      channel.nack(msg, false, false);
      return { status: 'failed', error: errMsg };
    }

    const graphUrl = `https://graph.facebook.com/v19.0/me/messages`;
    const res = await fetch(graphUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        recipient: { id: to },
        messaging_type: 'RESPONSE',
        message: { text },
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const errBody: any = await res.json().catch(() => ({}));
      throw new Error(errBody?.error?.message || `Graph HTTP ${res.status}`);
    }

    await coordinator.recordSendState(stableIdKey, 'sent');
    channel.ack(msg);
    console.log(`[meta] message sent successfully to ${to} on ${channelName}`);
    return { status: 'sent' };
  } catch (err: any) {
    console.error(`[meta] send error (attempt ${currentAttempt}/${MAX_RETRIES}):`, err.message);
    const latestState = await coordinator.getSendState(stableIdKey);
    if (latestState === 'outcome-unknown') {
      channel.nack(msg, false, false);
      return { status: 'failed', error: 'outcome-unknown' };
    }

    if (currentAttempt < MAX_RETRIES) {
      const nextAttempt = currentAttempt + 1;
      const nextPayload = { ...payload, attempt: nextAttempt, idempotencyKey: stableIdKey };
      const delayMs = Math.min(1000 * Math.pow(2, currentAttempt - 1), 10000);

      try {
        await mq.publish('message.outgoing.meta', nextPayload, {
          exchange: 'tectobox.retry',
          expiration: delayMs,
          headers: { 'x-retry-count': nextAttempt },
          mandatory: true,
        });
        channel.ack(msg);
        return { status: 'retried' };
      } catch (publishErr) {
        console.error('[meta] failed to publish to retry queue:', publishErr);
        channel.nack(msg, false, false);
        return { status: 'failed', error: 'publish_retry_failed' };
      }
    } else {
      console.error(`[meta] max retries reached for ${to}, sending to DLQ`);
      await coordinator.recordSendState(stableIdKey, 'failed');
      channel.nack(msg, false, false);
      return { status: 'failed', error: 'max_retries' };
    }
  }
}

export async function startMetaWorker() {
  const mq = new RabbitMQClient({
    url: process.env.RABBITMQ_URL || 'amqp://tectobox:tectobox_dev@localhost:5672/',
    exchange: 'tectobox.events',
  });
  await mq.connect();

  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  const coordinator = new RedisCoordinator(redis);
  const channel = mq.getChannel();

  if (channel) {
    await channel.prefetch(1);

    // Setup durable retry topology for Meta outgoing messages
    await mq.setupRetryTopology('message.outgoing.meta', 'message.outgoing.meta', {
      dlxExchange: 'tectobox.dlx',
      dlqQueue: 'message.outgoing.meta.dlq',
      retryExchange: 'tectobox.retry',
      retryQueue: 'message.outgoing.meta.retry',
      retryTtlMs: 5000,
    });

    // Also bind messenger and instagram routing keys to the meta queue
    await channel.bindQueue('message.outgoing.meta', 'tectobox.events', 'message.outgoing.messenger');
    await channel.bindQueue('message.outgoing.meta', 'tectobox.events', 'message.outgoing.instagram');

    await channel.consume('message.outgoing.meta', async (msg) => {
      await handleMetaOutgoingMessage(msg, channel, coordinator, redis, mq);
    });
  }

  console.log('[meta-worker] started');
}
