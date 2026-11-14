import { RabbitMQClient } from '@tectonic/messaging';
import { connectBroker } from '../broker/reconnect.ts';
import { RedisCoordinator } from '@tectonic/coordination';
import { Redis } from 'ioredis';
import { fetch } from 'undici';
import {
  DLX_EXCHANGE,
  EVENTS_EXCHANGE,
  RETRY_EXCHANGE,
  RETRY_TTL_MS,
  SEND_ATTEMPT_TTL_SECONDS,
  OutboundWireMessageSchema,
  dlqQueue,
  metaTokenKey,
  outgoingQueue,
  outgoingRoutingKey,
  retryQueue,
  sendAttemptErrorKey,
} from '@tectonic/contracts';
import {
  runOutgoingMessage,
  shouldAckOutgoing,
  type OutgoingMessageOutcome,
} from '../shared/outgoing-consumer.ts';

/**
 * Meta outgoing send — now a thin wrapper around the shared
 * outgoing-consumer skeleton (Phase 2 of the modular restructure).
 * The claim / retry / DLQ flow is identical to WhatsApp and Telegram;
 * only the payload validation, the idempotency prefix (`meta:`), and
 * the provider call (Facebook Graph API) differ.
 *
 * The `{ status, error? }` return contract is preserved exactly — the
 * meta spec asserts it (H6 fake-send prevention).
 */
function outcomeToStatus(
  result: OutgoingMessageOutcome,
): { status: string; error?: string } {
  switch (result.outcome) {
    case 'ignored':
      return { status: 'ignored' };
    case 'malformed':
      return { status: 'failed', error: 'malformed_json' };
    case 'invalid':
      return { status: 'failed', error: 'missing_required_fields' };
    case 'duplicate-sent':
      return { status: 'duplicate_sent' };
    case 'outcome-unknown':
      return { status: 'outcome_unknown' };
    case 'in-flight':
      return { status: 'in_flight' };
    case 'sent':
      return { status: 'sent' };
    case 'retried':
      return { status: 'retried' };
    case 'failed':
      return { status: 'failed', error: result.error };
  }
}

export async function handleMetaOutgoingMessage(
  msg: any,
  channel: any,
  coordinator: any,
  redis: any,
  mq: any
): Promise<{ status: string; error?: string }> {
  if (!msg) return { status: 'ignored' };

  const result = await runOutgoingMessage({
    msg,
    coordinator,
    mq,
    channel: 'meta',
    validate: (payload) => {
      const parsed = OutboundWireMessageSchema.safeParse(payload);
      return parsed.success
        ? { ok: true as const, data: parsed.data }
        : { ok: false as const };
    },
    buildIdempotencyKey: (data) => {
      const channelName = data.platform === 'instagram' ? 'instagram' : 'messenger';
      return (
        data.idempotencyKey ||
        `meta:${data.clientId}:${channelName}:${data.to}:${Buffer.from(data.text).toString('base64').slice(0, 32)}`
      );
    },
    send: async (data, stableIdKey) => {
      const channelName = data.platform === 'instagram' ? 'instagram' : 'messenger';

      // Resolve page access token from Redis cache or fallback environment variable
      let token = await redis.get(metaTokenKey(data.clientId, channelName));
      if (!token) {
        token = process.env.META_PAGE_ACCESS_TOKEN || null;
      }

      if (!token) {
        const errMsg = 'meta_send_not_configured';
        console.error(`[meta] no active Meta page token for client ${data.clientId} (${channelName}); ${errMsg}`);
        await coordinator.recordSendState(stableIdKey, 'failed');
        if (typeof redis.set === 'function') {
          await redis.set(sendAttemptErrorKey(stableIdKey), errMsg, 'EX', SEND_ATTEMPT_TTL_SECONDS);
        }
        // Terminal failure: never retried (the skeleton returns 'failed'
        // without touching the retry path).
        return { outcome: 'terminal-failed' as const, error: errMsg };
      }

      const graphUrl = `https://graph.facebook.com/v19.0/me/messages`;
      const res = await fetch(graphUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          recipient: { id: data.to },
          messaging_type: 'RESPONSE',
          message: { text: data.text },
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        const errBody: any = await res.json().catch(() => ({}));
        throw new Error(errBody?.error?.message || `Graph HTTP ${res.status}`);
      }

      await coordinator.recordSendState(stableIdKey, 'sent');
      console.log(`[meta] message sent successfully to ${data.to} on ${channelName}`);
      return { outcome: 'sent' as const };
    },
  });

  // The skeleton never acks/nacks; this handler owns the channel.
  if (shouldAckOutgoing(result)) channel.ack(msg);
  else channel.nack(msg, false, false);
  return outcomeToStatus(result);
}

export async function startMetaWorker() {
  const mq = new RabbitMQClient({
    url: process.env.RABBITMQ_URL || 'amqp://tectobox:tectobox_dev@localhost:5672/',
    exchange: EVENTS_EXCHANGE,
  });
  await connectBroker(mq);

  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  const coordinator = new RedisCoordinator(redis);
  const channel = mq.getChannel();

  if (channel) {
    await channel.prefetch(1);

    // Setup durable retry topology for Meta outgoing messages
    await mq.setupRetryTopology(outgoingQueue('meta'), outgoingRoutingKey('meta'), {
      dlxExchange: DLX_EXCHANGE,
      dlqQueue: dlqQueue(outgoingQueue('meta')),
      retryExchange: RETRY_EXCHANGE,
      retryQueue: retryQueue(outgoingQueue('meta')),
      retryTtlMs: RETRY_TTL_MS,
    });

    // Also bind messenger and instagram routing keys to the meta queue
    await channel.bindQueue(outgoingQueue('meta'), EVENTS_EXCHANGE, outgoingRoutingKey('messenger'));
    await channel.bindQueue(outgoingQueue('meta'), EVENTS_EXCHANGE, outgoingRoutingKey('instagram'));

    await channel.consume(outgoingQueue('meta'), async (msg) => {
      await handleMetaOutgoingMessage(msg, channel, coordinator, redis, mq);
    });
  }

  console.log('[meta-worker] started');
}
