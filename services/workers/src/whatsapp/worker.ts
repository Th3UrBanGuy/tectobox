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
  OutboundWireMessageSchema,
  connectQueue,
  connectRoutingKey,
  disconnectQueue,
  disconnectRoutingKey,
  dlqQueue,
  incomingRoutingKey,
  leaseKey,
  outgoingQueue,
  outgoingRoutingKey,
  retryQueue,
  tenantEventsChannel,
  waPairingKey,
  waQrKey,
  whatsappSessionKey,
} from '@tectonic/contracts';
import { createChannelStatusPublisher } from '../shared/channel-status.ts';
import { FencedSessionRegistry } from '../shared/session-lease.ts';
import {
  runOutgoingMessage,
  shouldAckOutgoing,
} from '../shared/outgoing-consumer.ts';
import {
  requestWhatsappPairingCode,
  whatsappSessionDir,
} from './pairing.ts';
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { pacedSend, clearPacerQueue } from './pacer.ts';
import * as fs from 'fs';
import QRCode from 'qrcode';

export interface WhatsappWorkerDeps {
  mq?: any;
  redis?: any;
  coordinator?: any;
  initialSockets?: Map<string, { sock: any; token: number }>;
  /** Max ms to wait for the Noise handshake before requesting a pairing code (default 20000). */
  pairingWaitMs?: number;
}

export async function startWhatsappWorker(deps: WhatsappWorkerDeps = {}) {
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
  // teardown) — shared with Telegram via FencedSessionRegistry. The
  // registry wraps the injected map (or a fresh one), so tests that
  // seed `initialSockets` keep driving the same instance.
  const sessionRegistry = new FencedSessionRegistry<{ sock: any; token: number }>(
    {
      coordinator,
      channel: 'whatsapp',
      consumer: consumerHolder,
      onLeaseLoss: async (entry, { key, clientId, slot }) => {
        // 1. Drain & abort queued pacer tasks
        clearPacerQueue(clientId, slot, new Error(`Lease lost for WhatsApp client ${clientId}:${slot}`));

        // 2. Disconnect socket (may be null — the interval is created
        // before makeWASocket returns, exactly as before).
        const sock = entry?.sock;
        if (sock) {
          try {
            sock.end(new Error('Lease expired or fenced'));
          } catch (e) {
            console.error(`[whatsapp] error closing socket on lease loss for ${key}:`, e);
          }
        }
      },
    },
    deps.initialSockets,
  );

  // Paired channel-status flip (SSE channel_status event + MQ
  // channel.status.whatsapp publish) — shared with Telegram.
  const publishChannelStatus = createChannelStatusPublisher({
    mq,
    coordinator,
    channel: 'whatsapp',
  });

  const getSocketWithFencing = async (clientId: string, slot: string) => {
    const key = whatsappSessionKey(clientId, slot);
    const cached = await sessionRegistry.getCached(key);
    if (cached) return cached;

    const fencingLeaseKey = leaseKey(key);
    const token = await sessionRegistry.acquire(key);
    if (!token) {
      console.log(`[whatsapp] could not acquire lease for ${key}`);
      return null;
    }

    let sock: any = null;
    sessionRegistry.track(key, () => (sock ? { sock, token } : null), token, { key, clientId, slot });

    const authDir = whatsappSessionDir(clientId, slot);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      // WhatsApp's server (since Apr 2026) rejects the pairing-code stanza
      // unless companion_platform_display is a canonical label (Baileys
      // #2560 / PR #2559). Baileys builds it as `${browser[1]} (${browser[0]})`,
      // so the default ['Baileys','Chrome',...] sends 'Chrome (Baileys)' and
      // the server answers 400 bad-request — the code looks issued but was
      // never registered server-side. 'Chrome (Mac OS)' is on the allow-list
      // (verified live: server returns the pairing ref in ~0.5s).
      browser: ['Mac OS', 'Chrome', '14.4.1'],
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const dataUrl = await QRCode.toDataURL(qr);
          await redis.set(waQrKey(clientId, slot), dataUrl, 'EX', QR_TTL_SECONDS);
          await coordinator.publishEvent(tenantEventsChannel(clientId), {
            type: SSE_EVENT_TYPES.QR,
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
        sessionRegistry.remove(key);
        clearPacerQueue(clientId, slot, new Error(`Connection closed for WhatsApp client ${clientId}:${slot}`));
        coordinator.releaseLease(fencingLeaseKey, token);
        await redis.del(waQrKey(clientId, slot)).catch(() => {});
        await redis.del(waPairingKey(clientId, slot)).catch(() => {});
        await publishChannelStatus(clientId, slot, 'disconnected');
      } else if (connection === 'open') {
        console.log('[whatsapp] opened connection');
        await redis.del(waQrKey(clientId, slot)).catch(() => {});
        await redis.del(waPairingKey(clientId, slot)).catch(() => {});
        await publishChannelStatus(clientId, slot, 'connected');
      }
    });

    sock.ev.on('messages.upsert', async (m: any) => {
      for (const msg of m.messages) {
        if (!msg.message || msg.key.fromMe) continue;

        await mq.publish(incomingRoutingKey('whatsapp'), {
          clientId,
          slot,
          message: msg
        });
      }
    });

    const entry = { sock, token };
    sessionRegistry.set(key, entry);
    return entry;
  };

  if (channel) {
    await channel.prefetch(1);

    // Setup durable main, retry (TTL + DLX), and dead-letter topology
    await mq.setupRetryTopology(outgoingQueue('whatsapp'), outgoingRoutingKey('whatsapp'), {
      dlxExchange: DLX_EXCHANGE,
      dlqQueue: dlqQueue(outgoingQueue('whatsapp')),
      retryExchange: RETRY_EXCHANGE,
      retryQueue: retryQueue(outgoingQueue('whatsapp')),
      retryTtlMs: RETRY_TTL_MS,
    });

    const consumeResult = await channel.consume(outgoingQueue('whatsapp'), async (msg: any) => {
      if (!msg) return;

      const result = await runOutgoingMessage({
        msg,
        coordinator,
        mq,
        channel: 'whatsapp',
        validate: (payload) => {
          const parsed = OutboundWireMessageSchema.safeParse(payload);
          return parsed.success
            ? { ok: true as const, data: parsed.data }
            : { ok: false as const };
        },
        buildIdempotencyKey: (data) =>
          data.idempotencyKey ||
          `wa:${data.clientId}:${data.slot || 'default'}:${data.to}:${Buffer.from(data.text).toString('base64').slice(0, 32)}`,
        send: async (data, stableIdKey) => {
          await pacedSend(
            String(data.clientId),
            data.slot || 'default',
            data.to,
            data.text,
            async (target, txt) => {
              const entry = await getSocketWithFencing(String(data.clientId), data.slot || 'default');
              if (!entry) {
                throw new Error(`Failed to acquire active lease for WhatsApp ${data.clientId}:${data.slot || 'default'}`);
              }

              // Atomically validate lease and monotonic fencing token at the provider call boundary
              const isValid = await coordinator.validateAndTouchLease(leaseKey(whatsappSessionKey(data.clientId, data.slot || DEFAULT_SLOT)), entry.token);
              if (!isValid) {
                throw new Error(`Stale fencing token ${entry.token} for WhatsApp ${data.clientId}:${data.slot || 'default'}; side-effect aborted`);
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
              const entry = await getSocketWithFencing(String(data.clientId), data.slot || 'default');
              if (entry) {
                await entry.sock.sendPresenceUpdate(isTyping ? 'composing' : 'paused', target);
              }
            }
          );
          return { outcome: 'sent' as const };
        },
      });

      if (shouldAckOutgoing(result)) channel.ack(msg);
      else channel.nack(msg, false, false);
    });
    consumerHolder.tag = consumeResult?.consumerTag || null;

    // RC5: connect commands from the API (POST .../connectors/whatsapp/connect).
    // Starting the socket here is the whole trigger: Baileys emits a QR on
    // connection.update (stored in Redis + SSE, polled by the QR modal), or
    // reconnects the saved pairing silently. Idempotent — if a live socket
    // already exists for the slot, getSocketWithFencing returns it and no
    // duplicate session is created.
    const connectQueueName = connectQueue('whatsapp');
    await channel.assertQueue(connectQueueName, { durable: true });
    await channel.bindQueue(connectQueueName, EVENTS_EXCHANGE, connectRoutingKey('whatsapp'));
    await channel.consume(connectQueueName, async (msg: any) => {
      if (!msg) return;

      let payload: any;
      try {
        payload = JSON.parse(msg.content.toString());
      } catch (err) {
        console.error('[whatsapp] malformed connect payload, dropping:', err);
        channel.nack(msg, false, false);
        return;
      }

      // Connect commands gate on clientId only (ChannelCommandWireMessageSchema).
      const parsed = ChannelCommandWireMessageSchema.safeParse(payload);
      if (!parsed.success) {
        console.warn('[whatsapp] connect command without clientId, dropping:', payload);
        channel.nack(msg, false, false);
        return;
      }

      const { clientId, slot, method, phoneNumber } = parsed.data;

      try {
        const entry = await getSocketWithFencing(String(clientId), slot || 'default');
        if (entry) {
          console.log(`[whatsapp] connect command started session for ${clientId}:${slot || 'default'}`);
          // Phone login: ask Baileys for an 8-char pairing code for this
          // number instead of a QR. The user types it into their phone's
          // WhatsApp (Linked devices -> Link with phone number instead).
          // Same delivery as the QR: Redis (polled by the modal) + SSE.
          if (method === 'phone' && phoneNumber) {
            await requestWhatsappPairingCode({
              entry,
              sockets: sessionRegistry.map,
              redis,
              coordinator,
              clientId,
              slot: slot || 'default',
              phoneNumber,
              pairingWaitMs: deps.pairingWaitMs,
            });
          }
        } else {
          console.warn(`[whatsapp] connect ${clientId}:${slot || 'default'} could not acquire a lease — re-tap Connect to retry`);
        }
        channel.ack(msg);
      } catch (err) {
        // Drop, don't requeue: a connect command is cheap to re-issue by
        // re-tapping Connect, and a persistent failure would poison-loop.
        console.error('[whatsapp] connect command failed:', err);
        channel.ack(msg);
      }
    });

    // Disconnect commands from API (channel.disconnect.whatsapp).
    // Destroys the live socket, wipes session data and publishes status disconnected.
    const disconnectQueueName = disconnectQueue('whatsapp');
    await channel.assertQueue(disconnectQueueName, { durable: true });
    await channel.bindQueue(disconnectQueueName, EVENTS_EXCHANGE, disconnectRoutingKey('whatsapp'));
    await channel.consume(disconnectQueueName, async (msg: any) => {
      if (!msg) return;

      let payload: any;
      try {
        payload = JSON.parse(msg.content.toString());
      } catch (err) {
        console.error('[whatsapp] malformed disconnect payload, dropping:', err);
        channel.nack(msg, false, false);
        return;
      }

      // Disconnect commands gate on clientId only (ChannelCommandWireMessageSchema).
      const parsed = ChannelCommandWireMessageSchema.safeParse(payload);
      if (!parsed.success) {
        console.warn('[whatsapp] disconnect command without clientId, dropping:', payload);
        channel.nack(msg, false, false);
        return;
      }

      const { clientId, slot } = parsed.data;

      const effectiveSlot = slot || 'default';
      const key = whatsappSessionKey(clientId, effectiveSlot);
      const fencingLeaseKey = leaseKey(key);

      try {
        const entry = sessionRegistry.get(key);
        if (entry) {
          sessionRegistry.delete(key);
          clearPacerQueue(String(clientId), effectiveSlot, new Error(`Session disconnected for WhatsApp client ${clientId}:${effectiveSlot}`));
          if (entry.sock) {
            try {
              if (typeof entry.sock.destroy === 'function') {
                await entry.sock.destroy();
              } else if (typeof entry.sock.end === 'function') {
                entry.sock.end(new Error('Disconnected by user'));
              }
            } catch (e: any) {
              console.error(`[whatsapp] error destroying socket for ${key}:`, e);
            }
          }
          await coordinator.releaseLease(fencingLeaseKey, entry.token).catch(() => {});
        }

        // Remove auth/session data on disk and in Redis
        const authDir = whatsappSessionDir(clientId, effectiveSlot);
        try {
          fs.rmSync(authDir, { recursive: true, force: true });
        } catch (e) {}

        await redis.del(waQrKey(clientId, effectiveSlot)).catch(() => {});
        await redis.del(waPairingKey(clientId, effectiveSlot)).catch(() => {});
        await publishChannelStatus(String(clientId), effectiveSlot, 'disconnected');

        channel.ack(msg);
      } catch (err) {
        console.error('[whatsapp] disconnect command failed:', err);
        channel.ack(msg);
      }
    });
  }

  console.log('[whatsapp-worker] started');
}
