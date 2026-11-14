import { RabbitMQClient } from '@tectonic/messaging';
import { connectBroker } from '../broker/reconnect.ts';
import { RedisCoordinator } from '@tectonic/coordination';
import { Redis } from 'ioredis';
import {
  DEFAULT_SLOT,
  DLX_EXCHANGE,
  EVENTS_EXCHANGE,
  LEASE_TTL_SECONDS,
  PAIRING_TTL_SECONDS,
  QR_TTL_SECONDS,
  RETRY_EXCHANGE,
  RETRY_TTL_MS,
  SSE_EVENT_TYPES,
  ChannelCommandWireMessageSchema,
  OutboundWireMessageSchema,
  channelStatusRoutingKey,
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
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { pacedSend, clearPacerQueue } from './pacer.ts';
import * as path from 'path';
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

  const sockets = deps.initialSockets || new Map<string, { sock: any; token: number }>();
  let consumerTag: string | null = null;
  const channel = mq.getChannel();

  // Best-effort channel status sync (worker -> API -> DB). Never throws:
  // a missing API consumer (or a broker restart) must not break the
  // socket's connection lifecycle.
  const publishChannelStatus = async (clientId: string, slot: string, status: string) => {
    try {
      await mq.publish(channelStatusRoutingKey('whatsapp'), {
        clientId: Number(clientId),
        channel: 'whatsapp',
        slot,
        status,
      });
    } catch (e: any) {
      console.warn('[whatsapp] channel status publish failed:', e.message);
    }
  };

  const getSocketWithFencing = async (clientId: string, slot: string) => {
    const key = whatsappSessionKey(clientId, slot);
    const cached = sockets.get(key);
    if (cached) {
      // Validate lease ownership immediately before use
      const valid = await coordinator.validateLease(leaseKey(key), cached.token);
      if (valid) return cached;
      sockets.delete(key);
    }

    const fencingLeaseKey = leaseKey(key);
    const token = await coordinator.acquireLease(fencingLeaseKey, LEASE_TTL_SECONDS);
    if (!token) {
      console.log(`[whatsapp] could not acquire lease for ${key}`);
      return null;
    }
    
    let sock: any = null;
    let isLeaseValid = true;
    const renewInterval = setInterval(async () => {
      const ok = await coordinator.renewLease(fencingLeaseKey, token, LEASE_TTL_SECONDS);
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
        clearInterval(renewInterval);
        sockets.delete(key);
        clearPacerQueue(clientId, slot, new Error(`Connection closed for WhatsApp client ${clientId}:${slot}`));
        coordinator.releaseLease(fencingLeaseKey, token);
        await redis.del(waQrKey(clientId, slot)).catch(() => {});
        await redis.del(waPairingKey(clientId, slot)).catch(() => {});
        await coordinator.publishEvent(tenantEventsChannel(clientId), {
          type: SSE_EVENT_TYPES.CHANNEL_STATUS,
          clientId: Number(clientId),
          channel: 'whatsapp',
          slot,
          status: 'disconnected',
        });
        await publishChannelStatus(clientId, slot, 'disconnected');
      } else if (connection === 'open') {
        console.log('[whatsapp] opened connection');
        await redis.del(waQrKey(clientId, slot)).catch(() => {});
        await redis.del(waPairingKey(clientId, slot)).catch(() => {});
        await coordinator.publishEvent(tenantEventsChannel(clientId), {
          type: SSE_EVENT_TYPES.CHANNEL_STATUS,
          clientId: Number(clientId),
          channel: 'whatsapp',
          slot,
          status: 'connected',
        });
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
    sockets.set(key, entry);
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

      let payload: any;
      try {
        payload = JSON.parse(msg.content.toString());
      } catch (err) {
        console.error('[whatsapp] malformed JSON payload, routing to DLQ:', err);
        channel.nack(msg, false, false);
        return;
      }

      // Outbound payloads are validated by OutboundWireMessageSchema,
      // which encodes exactly the old `!clientId || !to || !text` gate
      // (plus the Number() coercion for clientId). A failed message is
      // nacked to the DLQ, as before.
      const parsed = OutboundWireMessageSchema.safeParse(payload);
      if (!parsed.success) {
        console.warn('[whatsapp] missing required fields, routing to DLQ:', payload);
        channel.nack(msg, false, false);
        return;
      }
      const { clientId, slot, to, text, attempt } = parsed.data;

      // Read retry attempt from message header if present (broker-managed retry) or payload
      const headerAttempt = msg.properties?.headers?.['x-retry-count'];
      const currentAttempt = Number(headerAttempt ?? attempt) || 1;
      const MAX_RETRIES = 3;

      // Never generate a different idempotency key for the same logical send on redelivery!
      // If payload already has an idempotencyKey, preserve it deterministically.
      // If not, derive deterministic key from clientId, slot, to, and message text hash/content.
      const stableIdKey = parsed.data.idempotencyKey || `wa:${clientId}:${slot || 'default'}:${to}:${Buffer.from(text).toString('base64').slice(0, 32)}`;

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
          String(clientId),
          slot || 'default',
          to,
          text,
          async (target, txt) => {
            const entry = await getSocketWithFencing(String(clientId), slot || 'default');
            if (!entry) {
              throw new Error(`Failed to acquire active lease for WhatsApp ${clientId}:${slot || 'default'}`);
            }

            // Atomically validate lease and monotonic fencing token at the provider call boundary
            const isValid = await coordinator.validateAndTouchLease(leaseKey(whatsappSessionKey(clientId, slot || DEFAULT_SLOT)), entry.token);
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
            const entry = await getSocketWithFencing(String(clientId), slot || 'default');
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
          const nextPayload = { ...parsed.data, attempt: nextAttempt, idempotencyKey: stableIdKey };
          const delayMs = Math.min(1000 * Math.pow(2, currentAttempt - 1), 10000);

          try {
            await mq.publish(
              outgoingRoutingKey('whatsapp'),
              nextPayload,
              {
                exchange: RETRY_EXCHANGE,
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
            const effSlot = slot || 'default';
            try {
              if (typeof entry.sock.requestPairingCode !== 'function') {
                throw new Error('This WhatsApp version does not support pairing codes');
              }
              // Baileys requestPairingCode sends the pairing stanza
              // immediately — it does NOT wait for the Noise handshake.
              // Called right after makeWASocket, it corrupts the handshake
              // and the server drops the connection ("Connection Failure"
              // at noise-handler decodeFrame). The handshake is done once
              // the server emits the QR, so wait for the wa:qr key (the
              // same key the QR modal polls) before asking for the code.
              // If the socket dies mid-wait, stop at once instead of
              // burning the whole window on a dead connection.
              const waitMs = deps.pairingWaitMs ?? 20000;
              const startedAt = Date.now();
              const sockKey = whatsappSessionKey(clientId, effSlot);
              let qrSeen = !!(await redis.get(waQrKey(clientId, effSlot)).catch(() => null));
              let sockDead = false;
              while (!qrSeen && Date.now() - startedAt < waitMs) {
                await new Promise((r) => setTimeout(r, 500));
                if (!sockets.has(sockKey)) { sockDead = true; break; }
                qrSeen = !!(await redis.get(waQrKey(clientId, effSlot)).catch(() => null));
              }
              if (sockDead) {
                throw new Error('WhatsApp closed the connection — tap "Request a new code" to try again.');
              }
              if (!qrSeen) {
                throw new Error('WhatsApp did not answer in time — tap "Request a new code" to try again.');
              }
              const raw = String(await entry.sock.requestPairingCode(String(phoneNumber).replace(/[^0-9]/g, '')));
              const code = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
              const shown = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
              await redis.set(waPairingKey(clientId, effSlot), shown, 'EX', PAIRING_TTL_SECONDS);
              await coordinator.publishEvent(tenantEventsChannel(clientId), {
                type: SSE_EVENT_TYPES.PAIRING_CODE,
                clientId: Number(clientId),
                channel: 'whatsapp',
                slot: effSlot,
                code: shown,
              });
              console.log(`[whatsapp] pairing code issued for ${clientId}:${effSlot}`);
            } catch (e: any) {
              const raw = e.message || 'Could not request a pairing code';
              // Baileys drops the socket ("Connection Closed") when the
              // number is not on WhatsApp or not in international format.
              // The raw text tells the user nothing, so translate it.
              const friendly = /connection closed/i.test(raw)
                ? 'WhatsApp closed the connection — this number may not be on WhatsApp, or the country code is wrong. Check the number and try again.'
                : raw;
              console.warn(`[whatsapp] pairing code failed for ${clientId}:${effSlot}:`, raw);
              await coordinator.publishEvent(tenantEventsChannel(clientId), {
                type: SSE_EVENT_TYPES.PAIRING_ERROR,
                clientId: Number(clientId),
                channel: 'whatsapp',
                slot: effSlot,
                error: friendly,
              });
              // The failed request poisoned the saved session: Baileys
              // stores the half-registered identity (creds.me +
              // pairingCode) before sending, so the next socket load
              // skips the QR flow and the server rejects it as logged
              // out — no QR ever arrives and every retry times out.
              // End the socket and wipe the slot's session dir so the
              // next tap starts clean. Nothing was paired, so nothing
              // is lost.
              try { entry.sock.end?.(new Error('pairing failed, resetting session')); } catch {}
              try {
                const baseDir = process.env.SESSION_DIR || path.join(process.cwd(), 'wa-auth');
                await fs.promises.rm(path.join(baseDir, whatsappSessionKey(clientId, effSlot)), { recursive: true, force: true });
              } catch {}
            }
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
        const entry = sockets.get(key);
        if (entry) {
          sockets.delete(key);
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
        const baseSessionDir = process.env.SESSION_DIR || path.join(process.cwd(), 'wa-auth');
        const authDir = path.join(baseSessionDir, key);
        try {
          fs.rmSync(authDir, { recursive: true, force: true });
        } catch (e) {}

        await redis.del(waQrKey(clientId, effectiveSlot)).catch(() => {});
        await redis.del(waPairingKey(clientId, effectiveSlot)).catch(() => {});
        await publishChannelStatus(String(clientId), effectiveSlot, 'disconnected');
        await coordinator.publishEvent(tenantEventsChannel(clientId), {
          type: SSE_EVENT_TYPES.CHANNEL_STATUS,
          clientId: Number(clientId),
          channel: 'whatsapp',
          slot: effectiveSlot,
          status: 'disconnected',
        });

        channel.ack(msg);
      } catch (err) {
        console.error('[whatsapp] disconnect command failed:', err);
        channel.ack(msg);
      }
    });
  }

  console.log('[whatsapp-worker] started');
}
