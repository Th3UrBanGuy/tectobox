import { Injectable, OnModuleInit, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
import pg from 'pg';
import { Redis } from 'ioredis';
import { DB_POOL } from '../database/database.module.js';
import { RedisCoordinator } from '@tectonic/coordination';
import { RabbitMQClient } from '@tectonic/messaging';
import { LicensingService } from '../licensing/licensing.service.js';

export interface OutboundPayload {
  conversationId: number;
  clientId: number;
  platform: string;
  platformUserId: string;
  slot?: string;
  text: string;
  timestamp: string;
}

export interface BroadcastJobPayload {
  broadcastId: number;
  recipientId: number;
  clientId: number;
  platform: string;
  platformUserId: string;
  customerName?: string | null;
  text: string;
}

@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private redis: Redis | null = null;
  private coordinator: RedisCoordinator | null = null;
  private mq: RabbitMQClient | null = null;
  private outboxTimer: NodeJS.Timeout | null = null;
  private isProcessingOutbox = false;
  private isConnected = false;

  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(LicensingService) private readonly licensing: LicensingService
  ) {}

  async onModuleInit() {
    try {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      this.redis = new Redis(redisUrl, {
        retryStrategy: (times: number) => Math.min(times * 1000, 10000),
        maxRetriesPerRequest: 1,
      });
      this.redis.on('error', (err: any) => {
        // Log gracefully without crashing process
        console.warn('[events] Redis connection warning:', err?.message || err);
      });
      this.coordinator = new RedisCoordinator(this.redis);

      const rabbitUrl = process.env.RABBITMQ_URL || 'amqp://tectobox:tectobox_dev@localhost:5672/';
      this.mq = new RabbitMQClient({
        url: rabbitUrl,
        exchange: 'tectobox.events',
      });

      await this.mq.connect();
      this.isConnected = true;
      console.log('[events] Connected to RabbitMQ & Redis');

      // Start inbound consumer
      await this.startInboundConsumer();

      // Start channel-status consumer (worker -> DB status sync for
      // channel_sessions, e.g. WhatsApp connected/disconnected)
      await this.startChannelStatusConsumer();

      // Start outbox polling
      this.startOutboxPolling();
    } catch (err: any) {
      console.warn('[events] Initialization warning (offline infrastructure mode):', err.message);
    }
  }

  async onModuleDestroy() {
    if (this.outboxTimer) {
      clearInterval(this.outboxTimer);
      this.outboxTimer = null;
    }
    if (this.mq) {
      await this.mq.close().catch(() => {});
    }
    if (this.redis) {
      await this.redis.quit().catch(() => {});
    }
  }

  /**
   * Broadcast real-time SSE event to a tenant workspace via Redis Pub/Sub
   */
  async broadcastTenantEvent(tenantId: number, event: any): Promise<void> {
    const channel = `tenant:${tenantId}:events`;
    if (this.coordinator) {
      try {
        await this.coordinator.publishEvent(channel, event);
      } catch (err: any) {
        console.warn(`[events] Failed to publish SSE event to ${channel}:`, err.message);
      }
    }
  }

  async getQrCode(clientId: number, slot: string, channel: string = 'whatsapp'): Promise<string | null> {
    if (this.redis) {
      try {
        const prefix = channel === 'telegram' ? 'tg:qr' : 'wa:qr';
        return await this.redis.get(`${prefix}:${clientId}:${slot}`);
      } catch {
        return null;
      }
    }
    return null;
  }

  async setRedisKey(key: string, val: string, ttlSec?: number): Promise<void> {
    if (this.redis) {
      try {
        if (ttlSec) {
          await this.redis.set(key, val, 'EX', ttlSec);
        } else {
          await this.redis.set(key, val);
        }
      } catch (err: any) {
        console.warn(`[events] Redis set error for ${key}:`, err.message);
      }
    }
  }

  async getRedisKey(key: string): Promise<string | null> {
    if (this.redis) {
      try {
        return await this.redis.get(key);
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Publish one broadcast job to the broadcast.jobs queue.
   * Routing key 'broadcast.job.send' matches the pre-declared binding
   * 'broadcast.job.#' in infra/rabbitmq/definitions.json.
   * Returns false when the broker is not connected (caller records the
   * failure on the recipient instead of silently dropping the job).
   */
  async publishBroadcastJob(job: BroadcastJobPayload): Promise<boolean> {
    if (!this.isConnected || !this.mq) {
      console.warn('[events] RabbitMQ not connected, cannot publish broadcast job');
      return false;
    }
    try {
      await this.mq.publish('broadcast.job.send', job);
      return true;
    } catch (err: any) {
      console.warn('[events] Failed to publish broadcast job:', err.message);
      return false;
    }
  }

  /**
   * RC5: ask the WhatsApp worker to start a Baileys session for this
   * client/slot. The worker emits the QR (or reconnects the saved pairing
   * silently). The queue is asserted here so a connect issued while the
   * worker is restarting is durably queued instead of unroutable.
   * Returns false when the broker is not connected (caller keeps the
   * 'connecting' row; re-tapping Connect retries).
   */
  async publishChannelConnect(clientId: number, slot: string): Promise<boolean> {
    if (!this.isConnected || !this.mq) {
      console.warn('[events] RabbitMQ not connected, cannot publish WhatsApp connect command');
      return false;
    }
    try {
      const channel = this.mq.getChannel();
      if (channel) {
        await channel.assertQueue('channel.connect.whatsapp', { durable: true });
        await channel.bindQueue('channel.connect.whatsapp', 'tectobox.events', 'channel.connect.whatsapp');
      }
      await this.mq.publish('channel.connect.whatsapp', { clientId, slot });
      return true;
    } catch (err: any) {
      console.warn('[events] Failed to publish WhatsApp connect command:', err.message);
      return false;
    }
  }

  /**
   * Telegram connect trigger (channel.connect.telegram).
   * Durable routing key carrying clientId, slot, channel row id, and label.
   */
  async publishChannelConnectTelegram(
    clientId: number,
    slot: string,
    channelRowId?: number,
    label?: string
  ): Promise<boolean> {
    if (!this.isConnected || !this.mq) {
      console.warn('[events] RabbitMQ not connected, cannot publish Telegram connect command');
      return false;
    }
    try {
      const channel = this.mq.getChannel();
      if (channel) {
        await channel.assertQueue('channel.connect.telegram', { durable: true });
        await channel.bindQueue('channel.connect.telegram', 'tectobox.events', 'channel.connect.telegram');
      }
      await this.mq.publish('channel.connect.telegram', {
        clientId,
        slot,
        channelRowId,
        id: channelRowId,
        label,
      });
      return true;
    } catch (err: any) {
      console.warn('[events] Failed to publish Telegram connect command:', err.message);
      return false;
    }
  }

  /**
   * Disconnect command (channel.disconnect.<channel>).
   * Tells worker to destroy live session/socket and wipe auth credentials.
   */
  async publishChannelDisconnect(
    channelName: string,
    clientId: number,
    slot: string
  ): Promise<boolean> {
    if (!this.isConnected || !this.mq) {
      console.warn(`[events] RabbitMQ not connected, cannot publish disconnect for ${channelName}`);
      return false;
    }
    try {
      const routingKey = `channel.disconnect.${channelName}`;
      const channel = this.mq.getChannel();
      if (channel) {
        await channel.assertQueue(routingKey, { durable: true });
        await channel.bindQueue(routingKey, 'tectobox.events', routingKey);
      }
      await this.mq.publish(routingKey, {
        clientId,
        channel: channelName,
        slot,
      });
      return true;
    } catch (err: any) {
      console.warn(`[events] Failed to publish disconnect for ${channelName}:`, err.message);
      return false;
    }
  }

  /**
   * Publish an outbound message directly to RabbitMQ & outbox
   */
  async enqueueOutboundMessage(payload: OutboundPayload): Promise<void> {
    const routingKey = `message.outgoing.${payload.platform}`;

    // 1. Persist to outbox_events inside transactional database
    await this.pool.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, created_at)
       VALUES ('message', $1, 'outgoing', $2, NOW())`,
      [payload.conversationId.toString(), JSON.stringify(payload)]
    );

    // 2. Immediate direct publish if broker connected
    if (this.isConnected && this.mq) {
      try {
        await this.mq.publish(routingKey, {
          clientId: payload.clientId,
          slot: payload.slot || 'default',
          to: payload.platformUserId,
          text: payload.text,
        });
      } catch (err: any) {
        console.warn(`[events] Direct publish to ${routingKey} deferred to outbox worker:`, err.message);
      }
    }
  }

  /**
   * Inbound consumer listening to message.incoming.*
   */
  private async startInboundConsumer(): Promise<void> {
    if (!this.mq) return;
    const channel = this.mq.getChannel();
    if (!channel) return;

    const queueName = 'tectobox.inbound.messages';
    await channel.assertQueue(queueName, { durable: true });
    await channel.bindQueue(queueName, 'tectobox.events', 'message.incoming.#');

    await channel.consume(queueName, async (msg) => {
      if (!msg) return;

      try {
        const rawContent = msg.content.toString();
        const payload = JSON.parse(rawContent);

        const clientId = Number(payload.clientId);
        const platform = String(payload.platform || 'whatsapp');
        const platformUserId = String(payload.platformUserId || payload.from || '');
        const text = String(payload.text || '').trim();
        const customerName = payload.customerName || null;
        const customerPhone = payload.customerPhone || null;
        const externalId = payload.externalId || null;

        if (!clientId || !platformUserId || !text) {
          channel.ack(msg);
          return;
        }

        // 1. Find or create conversation
        const convRes = await this.pool.query(
          `INSERT INTO conversations (client_id, platform, platform_user_id, slot, customer_name, customer_phone, last_message_at, unread_count, status)
           VALUES ($1, $2, $3, 'default', $4, $5, NOW(), 1, 'open')
           ON CONFLICT(client_id, platform, platform_user_id, slot) DO UPDATE
           SET last_message_at = NOW(),
               unread_count = conversations.unread_count + 1,
               customer_name = COALESCE(excluded.customer_name, conversations.customer_name),
               customer_phone = COALESCE(excluded.customer_phone, conversations.customer_phone)
           RETURNING id, client_id, platform, platform_user_id, slot, customer_name, customer_phone, last_message_at, unread_count, status`,
          [clientId, platform, platformUserId, customerName, customerPhone]
        );

        const conv = convRes.rows[0];

        // 2. Deduplicate message by external_id if present
        let msgRow = null;
        if (externalId) {
          const dupCheck = await this.pool.query(
            'SELECT id, conversation_id, direction, text, created_at FROM messages WHERE conversation_id = $1 AND external_id = $2 LIMIT 1',
            [conv.id, externalId]
          );
          if (dupCheck.rows.length > 0) {
            msgRow = dupCheck.rows[0];
          }
        }

        if (!msgRow) {
          const insertMsg = await this.pool.query(
            `INSERT INTO messages (conversation_id, direction, text, raw_json, external_id, created_at)
             VALUES ($1, 'in', $2, $3, $4, NOW())
             RETURNING id, conversation_id, direction, text, created_at`,
            [conv.id, text, payload.rawJson ? JSON.stringify(payload.rawJson) : null, externalId]
          );
          msgRow = insertMsg.rows[0];
        }

        // 3. Upsert into leads
        await this.pool.query(
          `INSERT INTO leads (client_id, platform, platform_user_id, name, phone, status, stage, score, temperature, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'lead', 'new', 10, 'warm', NOW(), NOW())
           ON CONFLICT(client_id, platform, platform_user_id) DO UPDATE
           SET name = COALESCE(excluded.name, leads.name),
               phone = COALESCE(excluded.phone, leads.phone),
               updated_at = NOW()`,
          [clientId, platform, platformUserId, customerName, customerPhone]
        ).catch(() => {});

        // 4. Broadcast via Redis Pub/Sub for SSE
        await this.broadcastTenantEvent(clientId, {
          type: 'message',
          conversation: conv,
          inbound: msgRow,
        });

        // 4b. Check if customer is asking for a human agent
        const humanRegex = /(human|agent|person|representative|support team|manager|talk to someone|call me|মানুষ|এজেন্ট|প্রতিনিধি|কল দেন|কথা বলব|অপারেটর|manush|kotha bolbo|call den|kew asen|operator)/i;
        if (humanRegex.test(text)) {
          await this.pool.query('UPDATE conversations SET needs_human = true WHERE id = $1', [conv.id]);
          conv.needs_human = true;
          await this.broadcastTenantEvent(clientId, {
            type: 'conversation:flag',
            conversationId: conv.id,
            needsHuman: true,
          });
        }

        // 5. Trigger AI auto-reply if enabled and not paused
        try {
          const clientRow = await this.pool.query(
            'SELECT name, business_type, ai_paused FROM clients WHERE id = $1 LIMIT 1',
            [clientId]
          );
          const client = clientRow.rows[0];

          const autoReplyRow = await this.pool.query(
            "SELECT value FROM settings WHERE key = 'ai.auto_reply' LIMIT 1"
          );
          const isGlobalAutoReply = !autoReplyRow.rows[0] || autoReplyRow.rows[0].value !== '0';

          // Licence gate: the workspace must hold the ai_response feature
          // with credits left (or an unlimited time licence). Without it
          // the inbound message is already stored above and a human can
          // still reply manually — the AI simply stays silent.
          // consumeAiCredit is the atomic reserve-a-credit step: it returns
          // false when the last credit was taken by a concurrent reply, in
          // which case nothing is published. Time licences always pass.
          let licenseOk = false;
          if (client && !client.ai_paused && !conv.needs_human) {
            const access = await this.licensing.resolveAccess(clientId);
            licenseOk =
              access.aiAllowed && (await this.licensing.consumeAiCredit(clientId));
          }

          if (this.mq && client && !client.ai_paused && !conv.needs_human && isGlobalAutoReply && platform !== 'webchat' && licenseOk) {
            const prodsRes = await this.pool.query(
              'SELECT name, sku, price_bdt, stock FROM products WHERE client_id = $1 ORDER BY id ASC',
              [clientId]
            );
            const kbRes = await this.pool.query(
              'SELECT title, content, category FROM knowledge WHERE client_id = $1 ORDER BY id ASC',
              [clientId]
            );

            // Fetch past messages for conversational memory
            const recentHistoryRes = await this.pool.query(
              `SELECT direction, text FROM messages
               WHERE conversation_id = $1 AND id < $2
               ORDER BY id DESC LIMIT 8`,
              [conv.id, msgRow.id]
            );
            const history = recentHistoryRes.rows.reverse().map(r => ({
              role: r.direction === 'in' ? 'user' : 'assistant',
              content: r.text,
            }));

            await this.mq.publish(`ai.request.${platform}`, {
              platform,
              clientId,
              slot: conv.slot || 'default',
              to: platformUserId,
              conversationId: conv.id,
              text,
              history,
              clientName: client.name,
              businessType: client.business_type,
              products: prodsRes.rows,
              knowledge: kbRes.rows,
            });
          }
        } catch (aiErr: any) {
          console.warn('[events] Error triggering AI response for inbound:', aiErr.message);
        }

        channel.ack(msg);
      } catch (err: any) {
        console.error('[events] Error handling inbound message event:', err);
        channel.ack(msg); // Avoid unhandled poison loop
      }
    });
  }

  /**
   * RC5: consume channel status events published by the workers
   * (routing key `channel.status.<platform>`) and sync them into
   * channel_sessions. Nothing else flips a session to 'connected':
   * without this the row stays 'connecting' forever after a scan, the
   * Channels tab never shows the account as connected, and a silent
   * reconnect (saved pairing) looks like a 90s timeout to the frontend.
   * Always acks — a bad status payload must never poison-loop.
   */
  private async startChannelStatusConsumer(): Promise<void> {
    if (!this.mq) return;
    const channel = this.mq.getChannel();
    if (!channel) return;

    const queueName = 'tectobox.channel.status';
    await channel.assertQueue(queueName, { durable: true });
    await channel.bindQueue(queueName, 'tectobox.events', 'channel.status.#');

    await channel.consume(queueName, async (msg) => {
      if (!msg) return;
      try {
        const payload = JSON.parse(msg.content.toString());
        const clientId = Number(payload.clientId);
        const ch = String(payload.channel || 'whatsapp');
        const slot = String(payload.slot || 'default');
        const status = String(payload.status || '');
        if (!clientId || !['connected', 'disconnected', 'connecting', 'error'].includes(status)) {
          return;
        }
        await this.pool.query(
          `UPDATE channel_sessions SET status = $1, updated_at = NOW()
           WHERE client_id = $2 AND channel = $3 AND slot = $4`,
          [status, clientId, ch, slot]
        );
        // Nudge open frontends to re-read /connectors.
        await this.broadcastTenantEvent(clientId, { type: 'connectors', clientId });
      } catch (err: any) {
        console.error('[events] channel status consumer error:', err.message);
      } finally {
        channel.ack(msg);
      }
    });
  }

  /**
   * Outbox background processor polling unprocessed outbox_events
   */
  private startOutboxPolling(): void {
    this.outboxTimer = setInterval(async () => {
      if (this.isProcessingOutbox || !this.isConnected || !this.mq) return;
      this.isProcessingOutbox = true;

      try {
        const { rows } = await this.pool.query(
          `SELECT id, aggregate_type, aggregate_id, event_type, payload
           FROM outbox_events
           WHERE processed_at IS NULL
           ORDER BY created_at ASC
           LIMIT 25`
        );

        for (const event of rows) {
          const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
          const routingKey = `message.outgoing.${payload.platform || 'whatsapp'}`;

          await this.mq.publish(routingKey, {
            clientId: payload.clientId,
            slot: payload.slot || 'default',
            to: payload.platformUserId,
            text: payload.text,
          });

          await this.pool.query(
            'UPDATE outbox_events SET processed_at = NOW() WHERE id = $1',
            [event.id]
          );
        }
      } catch (err: any) {
        console.warn('[events] Outbox processing tick warning:', err.message);
      } finally {
        this.isProcessingOutbox = false;
      }
    }, 3000);
  }
}
