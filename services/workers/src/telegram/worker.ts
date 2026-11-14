import { RabbitMQClient } from '@tectonic/messaging';
import { connectBroker } from '../broker/reconnect.ts';
import { RedisCoordinator } from '@tectonic/coordination';
import { Redis } from 'ioredis';
import {
  DEFAULT_SLOT,
  DLX_EXCHANGE,
  EVENTS_EXCHANGE,
  QR_TTL_SECONDS,
  RETRY_EXCHANGE,
  RETRY_TTL_MS,
  SSE_EVENT_TYPES,
  ChannelCommandWireMessageSchema,
  TelegramOutboundWireMessageSchema,
  TelegramSigninWireMessageSchema,
  connectQueue,
  connectRoutingKey,
  disconnectQueue,
  disconnectRoutingKey,
  dlqQueue,
  leaseKey,
  outgoingQueue,
  outgoingRoutingKey,
  retryQueue,
  signinQueue,
  signinRoutingKey,
  tenantEventsChannel,
  telegramSessionKey,
  tgCodeHashKey,
  tgCodeSentKey,
  tgPhoneKey,
  tgQrKey,
  tgSessionKey,
} from '@tectonic/contracts';
import { createChannelStatusPublisher } from '../shared/channel-status.ts';
import { FencedSessionRegistry } from '../shared/session-lease.ts';
import {
  runOutgoingMessage,
  shouldAckOutgoing,
} from '../shared/outgoing-consumer.ts';
import {
  handleTelegramSignin,
  requestTelegramLoginCode,
} from './phone-login.ts';
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
    exchange: EVENTS_EXCHANGE
  });
  if (!deps.mq) {
    await connectBroker(mq);
  }

  const redis = deps.redis || new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  const coordinator = deps.coordinator || new RedisCoordinator(redis);

  const channel = mq.getChannel();
  // Mutable holder for the outgoing consumer, read by the session
  // registry at lease-loss fire time (the consumer registers below,
  // after sessions are created).
  const consumerHolder: { tag: string | null; channel: any } = { tag: null, channel };

  // Fenced session lifecycle (lease acquire/validate/renew + on-loss
  // teardown) — shared with WhatsApp via FencedSessionRegistry.
  const sessionRegistry = new FencedSessionRegistry<{ client: TelegramClient; token: number }>({
    coordinator,
    channel: 'telegram',
    consumer: consumerHolder,
    unrefInterval: true,
    onLeaseLoss: async (entry, { clientId }) => {
      if (entry?.client) {
        try {
          await entry.client.disconnect();
        } catch (e) {
          console.error(`[telegram] error disconnecting on lease loss for ${clientId}:`, e);
        }
      }
    },
  });

  // Paired channel-status flip (SSE channel_status event + MQ
  // channel.status.telegram publish) — shared with WhatsApp.
  const publishChannelStatus = createChannelStatusPublisher({
    mq,
    coordinator,
    channel: 'telegram',
  });

  const getClientWithFencing = async (clientId: string, sessionStringOrSlot?: string, explicitSlot?: string, opts?: { autoLogin?: 'qr' | 'none' }) => {
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

    const key = telegramSessionKey(clientId, slot);
    const cached = await sessionRegistry.getCached(key);
    if (cached) return cached;

    const fencingLeaseKey = leaseKey(key);
    const token = await sessionRegistry.acquire(key);
    if (!token) {
      console.warn(`[telegram] unable to acquire distributed session lease for client ${clientId}`);
      return null;
    }

    const apiId = parseInt(process.env.TELEGRAM_API_ID || '0');
    const apiHash = process.env.TELEGRAM_API_HASH || '';

    let client: TelegramClient;
    try {
      if (!sessionString) {
        sessionString = (await redis.get(tgSessionKey(clientId, slot))) || '';
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
        // Phone login asks for 'none': the caller sends the code itself
        // (sendCode) and finishes sign-in on channel.signin.telegram —
        // starting the QR flow here would fight it.
        if (!isAuth && opts?.autoLogin !== 'none' && typeof (client as any).signInUserWithQrCode === 'function') {
          (client as any).signInUserWithQrCode({ apiId, apiHash }, {
            qrCode: async ({ token: qrTok }: any) => {
              try {
                const qrLink = `tg://login?token=${qrTok.toString('base64url')}`;
                const dataUrl = await QRCode.toDataURL(qrLink);
                await redis.set(tgQrKey(clientId, slot), dataUrl, 'EX', QR_TTL_SECONDS);
                await coordinator.publishEvent(tenantEventsChannel(clientId), {
                  type: SSE_EVENT_TYPES.QR,
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
            await redis.del(tgQrKey(clientId, slot)).catch(() => {});
            const savedStr = typeof (client.session as any)?.save === 'function' ? (client.session as any).save() : '';
            if (savedStr) {
              await redis.set(tgSessionKey(clientId, slot), savedStr);
            }
            await publishChannelStatus(clientId, slot, 'connected');
          }).catch((err: any) => {
            console.error('[telegram] QR login failed:', err.message);
          });
        } else if (isAuth) {
          await redis.del(tgQrKey(clientId, slot)).catch(() => {});
          await publishChannelStatus(clientId, slot, 'connected');
        }
      }
    } catch (err) {
      console.error(`[telegram] failed to connect client ${clientId}:`, err);
      await coordinator.releaseLease(fencingLeaseKey, token);
      return null;
    }

    // Set up lease renewal with heartbeat and teardown on loss
    sessionRegistry.track(key, () => ({ client, token }), token, { key, clientId, slot });

    const entry = { client, token };
    sessionRegistry.set(key, entry);
    return entry;
  };

  if (channel) {
    await channel.prefetch(1);

    // Setup durable main, retry (TTL + DLX), and dead-letter topology
    await mq.setupRetryTopology(outgoingQueue('telegram'), outgoingRoutingKey('telegram'), {
      dlxExchange: DLX_EXCHANGE,
      dlqQueue: dlqQueue(outgoingQueue('telegram')),
      retryExchange: RETRY_EXCHANGE,
      retryQueue: retryQueue(outgoingQueue('telegram')),
      retryTtlMs: RETRY_TTL_MS,
    });

    const consumeResult = await channel.consume(outgoingQueue('telegram'), async (msg: any) => {
      if (!msg) return;

      const result = await runOutgoingMessage({
        msg,
        coordinator,
        mq,
        channel: 'telegram',
        validate: (payload) => {
          const parsed = TelegramOutboundWireMessageSchema.safeParse(payload);
          return parsed.success
            ? { ok: true as const, data: parsed.data }
            : { ok: false as const };
        },
        buildIdempotencyKey: (data) =>
          data.idempotencyKey ||
          `tg:${data.clientId}:${data.to}:${Buffer.from(data.text).toString('base64').slice(0, 32)}`,
        send: async (data, stableIdKey) => {
          const entry = await getClientWithFencing(String(data.clientId), data.sessionString);
          if (!entry) {
            throw new Error(`Failed to acquire active lease for Telegram client ${data.clientId}`);
          }

          // Atomically validate fencing token and touch lease at provider boundary.
          // Reproduces the current behaviour exactly: the DEFAULT-slot lease
          // is validated for every slot (known latent bug for non-default
          // slots — deliberately not fixed in Phase 1).
          const isValid = await coordinator.validateAndTouchLease(leaseKey(telegramSessionKey(data.clientId, DEFAULT_SLOT)), entry.token);
          if (!isValid) {
            throw new Error(`Stale fencing token ${entry.token} for Telegram client ${data.clientId}; side-effect aborted`);
          }

          try {
            await entry.client.sendMessage(data.to, { message: data.text });
            await coordinator.recordSendState(stableIdKey, 'sent');
          } catch (err) {
            await coordinator.recordSendState(stableIdKey, 'outcome-unknown');
            throw err;
          }
          return { outcome: 'sent' as const };
        },
      });

      if (shouldAckOutgoing(result)) channel.ack(msg);
      else channel.nack(msg, false, false);
    });
    consumerHolder.tag = consumeResult?.consumerTag || null;

    // channel.connect.telegram consumer
    const connectQueueName = connectQueue('telegram');
    await channel.assertQueue(connectQueueName, { durable: true });
    await channel.bindQueue(connectQueueName, EVENTS_EXCHANGE, connectRoutingKey('telegram'));
    await channel.consume(connectQueueName, async (msg: any) => {
      if (!msg) return;

      let payload: any;
      try {
        payload = JSON.parse(msg.content.toString());
      } catch (err) {
        console.error('[telegram] malformed connect payload, dropping:', err);
        channel.nack(msg, false, false);
        return;
      }

      // Connect commands gate on clientId only (ChannelCommandWireMessageSchema).
      const parsed = ChannelCommandWireMessageSchema.safeParse(payload);
      if (!parsed.success) {
        console.warn('[telegram] connect command without clientId, dropping:', payload);
        channel.nack(msg, false, false);
        return;
      }

      const { clientId, slot, channelRowId, id, label, method, phoneNumber } = parsed.data;

      const effectiveSlot = slot || 'default';
      try {
        if (method === 'phone' && phoneNumber) {
          await requestTelegramLoginCode({
            getClient: getClientWithFencing,
            redis,
            coordinator,
            publishChannelStatus,
            clientId,
            slot: effectiveSlot,
            phoneNumber,
          });
          channel.ack(msg);
          return;
        }

        const entry = await getClientWithFencing(String(clientId), effectiveSlot);
        if (entry) {
          console.log(`[telegram] connect command started session for ${clientId}:${effectiveSlot}`);
          // No 'connected' publish here: the row must flip only when the
          // QR is actually scanned (the .then() in getClientWithFencing)
          // or a saved session is alive (its isAuth branch). Publishing
          // here used to flip the row at Connect-tap time, which closed
          // the QR modal before the user could scan.
        } else {
          console.warn(`[telegram] connect ${clientId}:${effectiveSlot} could not acquire lease`);
        }
        channel.ack(msg);
      } catch (err) {
        console.error('[telegram] connect command failed:', err);
        channel.ack(msg);
      }
    });

    // channel.signin.telegram consumer — step 2 of phone login.
    const signinQueueName = signinQueue('telegram');
    await channel.assertQueue(signinQueueName, { durable: true });
    await channel.bindQueue(signinQueueName, EVENTS_EXCHANGE, signinRoutingKey('telegram'));
    await channel.consume(signinQueueName, async (msg: any) => {
      if (!msg) return;

      let payload: any;
      try {
        payload = JSON.parse(msg.content.toString());
      } catch (err) {
        console.error('[telegram] malformed signin payload, dropping:', err);
        channel.nack(msg, false, false);
        return;
      }

      // Sign-in commands gate on clientId + phoneCode (TelegramSigninWireMessageSchema).
      const parsed = TelegramSigninWireMessageSchema.safeParse(payload);
      if (!parsed.success) {
        console.warn('[telegram] signin command without clientId/code, dropping:', payload);
        channel.nack(msg, false, false);
        return;
      }

      const { clientId, slot, phoneCode, password } = parsed.data;

      const effectiveSlot = slot || 'default';
      try {
        await handleTelegramSignin({
          getClient: getClientWithFencing,
          sessions: sessionRegistry.map,
          redis,
          coordinator,
          publishChannelStatus,
          clientId,
          slot: effectiveSlot,
          phoneCode,
          password,
        });
        channel.ack(msg);
      } catch (err) {
        console.error('[telegram] signin command failed:', err);
        channel.ack(msg);
      }
    });

    // channel.disconnect.telegram consumer
    const disconnectQueueName = disconnectQueue('telegram');
    await channel.assertQueue(disconnectQueueName, { durable: true });
    await channel.bindQueue(disconnectQueueName, EVENTS_EXCHANGE, disconnectRoutingKey('telegram'));
    await channel.consume(disconnectQueueName, async (msg: any) => {
      if (!msg) return;

      let payload: any;
      try {
        payload = JSON.parse(msg.content.toString());
      } catch (err) {
        console.error('[telegram] malformed disconnect payload, dropping:', err);
        channel.nack(msg, false, false);
        return;
      }

      // Disconnect commands gate on clientId only (ChannelCommandWireMessageSchema).
      const parsed = ChannelCommandWireMessageSchema.safeParse(payload);
      if (!parsed.success) {
        console.warn('[telegram] disconnect command without clientId, dropping:', payload);
        channel.nack(msg, false, false);
        return;
      }

      const { clientId, slot } = parsed.data;

      const effectiveSlot = slot || 'default';
      const key = telegramSessionKey(clientId, effectiveSlot);
      const fencingLeaseKey = leaseKey(key);

      try {
        const entry = sessionRegistry.get(key);
        sessionRegistry.remove(key);

        if (entry) {
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
          await coordinator.releaseLease(fencingLeaseKey, entry.token).catch(() => {});
        }

        await redis.del(tgQrKey(clientId, effectiveSlot)).catch(() => {});
        await redis.del(tgSessionKey(clientId, effectiveSlot)).catch(() => {});
        await redis.del(tgCodeHashKey(clientId, effectiveSlot)).catch(() => {});
        await redis.del(tgPhoneKey(clientId, effectiveSlot)).catch(() => {});
        await redis.del(tgCodeSentKey(clientId, effectiveSlot)).catch(() => {});
        await publishChannelStatus(String(clientId), effectiveSlot, 'disconnected');

        channel.ack(msg);
      } catch (err) {
        console.error('[telegram] disconnect command failed:', err);
        channel.ack(msg);
      }
    });
  }

  console.log('[telegram-worker] started');
}
