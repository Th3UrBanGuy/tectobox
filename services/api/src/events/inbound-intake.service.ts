import pg from 'pg';
import {
  DEFAULT_SLOT,
  INBOUND_QUEUE,
  INCOMING_ROUTING_KEY_PATTERN,
  EVENTS_EXCHANGE,
  InboundWireMessageSchema,
  SSE_EVENT_TYPES,
  aiRequestRoutingKey,
} from '@tectonic/contracts';
import { LicensingService } from '../licensing/licensing.service.js';
import type { BrokerState } from './broker-state.js';

/** SSE fan-out callback, bound to `SsePublisherService.broadcastTenantEvent`. */
export type BroadcastFn = (tenantId: number, event: any) => Promise<void>;

/**
 * Inbound-message intake: consumes `message.incoming.*`, persists the
 * conversation / message / lead, broadcasts SSE, flags human-handover,
 * and — licence gate permitting — publishes an `ai.request.*` job for
 * the AI worker.
 *
 * Moved verbatim out of `EventsService.startInboundConsumer` — Phase 3
 * of the modular restructure. No behaviour change: the wire-schema
 * validation (Phase 1), the upsert SQL (kept as-is, not deduped with
 * the widget's copy), the AI gate, and the always-ack poison policy
 * are untouched.
 */
export class InboundIntakeService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly licensing: LicensingService,
    private readonly state: BrokerState,
    private readonly broadcast: BroadcastFn
  ) {}

  /**
   * Inbound consumer listening to message.incoming.*
   * The payload is validated by InboundWireMessageSchema, which encodes
   * exactly the coercions this consumer used to do inline (Number() for
   * clientId, 'whatsapp' platform default, platformUserId || from,
   * trimmed text). A message that fails the schema is acked and dropped,
   * exactly as the old `if (!clientId || !platformUserId || !text)` did.
   */
  async startInboundConsumer(): Promise<void> {
    if (!this.state.mq) return;
    const channel = this.state.mq.getChannel();
    if (!channel) return;

    const queueName = INBOUND_QUEUE;
    await channel.assertQueue(queueName, { durable: true });
    await channel.bindQueue(queueName, EVENTS_EXCHANGE, INCOMING_ROUTING_KEY_PATTERN);

    await channel.consume(queueName, async (msg) => {
      if (!msg) return;

      try {
        const rawContent = msg.content.toString();
        const parsed = InboundWireMessageSchema.safeParse(JSON.parse(rawContent));
        if (!parsed.success) {
          channel.ack(msg);
          return;
        }
        const payload = parsed.data;

        const clientId = payload.clientId;
        const platform = payload.platform;
        const platformUserId = payload.platformUserId;
        const text = payload.text;
        const customerName = payload.customerName ?? null;
        const customerPhone = payload.customerPhone ?? null;
        const externalId = payload.externalId ?? null;

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
        await this.broadcast(clientId, {
          type: SSE_EVENT_TYPES.MESSAGE,
          conversation: conv,
          inbound: msgRow,
        });

        // 4b. Check if customer is asking for a human agent
        const humanRegex = /(human|agent|person|representative|support team|manager|talk to someone|call me|মানুষ|এজেন্ট|প্রতিনিধি|কল দেন|কথা বলব|অপারেটর|manush|kotha bolbo|call den|kew asen|operator)/i;
        if (humanRegex.test(text)) {
          await this.pool.query('UPDATE conversations SET needs_human = true WHERE id = $1', [conv.id]);
          conv.needs_human = true;
          await this.broadcast(clientId, {
            type: SSE_EVENT_TYPES.CONVERSATION_FLAG,
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

          if (this.state.mq && client && !client.ai_paused && !conv.needs_human && isGlobalAutoReply && platform !== 'webchat' && licenseOk) {
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

            await this.state.mq.publish(aiRequestRoutingKey(platform), {
              platform,
              clientId,
              slot: conv.slot || DEFAULT_SLOT,
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
}
