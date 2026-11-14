import pg from 'pg';
import { DEFAULT_SLOT, outgoingRoutingKey } from '@tectonic/contracts';
import type { BrokerState } from './broker-state.js';

export interface OutboundPayload {
  conversationId: number;
  clientId: number;
  platform: string;
  platformUserId: string;
  slot?: string;
  text: string;
  timestamp: string;
}

/**
 * Outbound outbox: durable `outbox_events` rows + immediate direct
 * publish, with a 3s polling loop that republishes anything the direct
 * publish missed.
 *
 * Moved verbatim out of `EventsService` (`enqueueOutboundMessage`,
 * `startOutboxPolling`) — Phase 3 of the modular restructure.
 * No behaviour change.
 */
export class OutboxService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly state: BrokerState
  ) {}

  /**
   * Publish an outbound message directly to RabbitMQ & outbox
   */
  async enqueueOutboundMessage(payload: OutboundPayload): Promise<void> {
    const routingKey = outgoingRoutingKey(payload.platform);

    // 1. Persist to outbox_events inside transactional database
    await this.pool.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, created_at)
       VALUES ('message', $1, 'outgoing', $2, NOW())`,
      [payload.conversationId.toString(), JSON.stringify(payload)]
    );

    // 2. Immediate direct publish if broker connected
    if (this.state.isConnected && this.state.mq) {
      try {
        await this.state.mq.publish(routingKey, {
          clientId: payload.clientId,
          slot: payload.slot || DEFAULT_SLOT,
          to: payload.platformUserId,
          text: payload.text,
        });
      } catch (err: any) {
        console.warn(`[events] Direct publish to ${routingKey} deferred to outbox worker:`, err.message);
      }
    }
  }

  /**
   * Outbox background processor polling unprocessed outbox_events
   */
  startOutboxPolling(): void {
    this.state.outboxTimer = setInterval(async () => {
      if (this.state.isProcessingOutbox || !this.state.isConnected || !this.state.mq) return;
      this.state.isProcessingOutbox = true;

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
          const routingKey = outgoingRoutingKey(payload.platform || 'whatsapp');

          await this.state.mq.publish(routingKey, {
            clientId: payload.clientId,
            slot: payload.slot || DEFAULT_SLOT,
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
        this.state.isProcessingOutbox = false;
      }
    }, 3000);
  }

  /** Stops the polling loop (called on module destroy). */
  stopOutboxPolling(): void {
    if (this.state.outboxTimer) {
      clearInterval(this.state.outboxTimer);
      this.state.outboxTimer = null;
    }
  }
}
