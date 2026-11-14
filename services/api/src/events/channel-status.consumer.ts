import pg from 'pg';
import {
  CHANNEL_STATUS_QUEUE,
  CHANNEL_STATUS_ROUTING_KEY_PATTERN,
  ChannelStatusEventSchema,
  EVENTS_EXCHANGE,
  SSE_EVENT_TYPES,
} from '@tectonic/contracts';
import type { BrokerState } from './broker-state.js';
import type { BroadcastFn } from './inbound-intake.service.js';

/**
 * Channel-status consumer: syncs worker-published `channel.status.*`
 * events into `channel_sessions` and nudges open frontends.
 *
 * Moved verbatim out of `EventsService.startChannelStatusConsumer` —
 * Phase 3 of the modular restructure. No behaviour change: always
 * acks (a bad status payload must never poison-loop), and the payload
 * is validated by ChannelStatusEventSchema (Phase 1).
 *
 * RC5: consume channel status events published by the workers
 * (routing key `channel.status.<platform>`) and sync them into
 * channel_sessions. Nothing else flips a session to 'connected':
 * without this the row stays 'connecting' forever after a scan, the
 * Channels tab never shows the account as connected, and a silent
 * reconnect (saved pairing) looks like a 90s timeout to the frontend.
 */
export class ChannelStatusConsumer {
  constructor(
    private readonly pool: pg.Pool,
    private readonly state: BrokerState,
    private readonly broadcast: BroadcastFn
  ) {}

  async startChannelStatusConsumer(): Promise<void> {
    if (!this.state.mq) return;
    const channel = this.state.mq.getChannel();
    if (!channel) return;

    const queueName = CHANNEL_STATUS_QUEUE;
    await channel.assertQueue(queueName, { durable: true });
    await channel.bindQueue(queueName, EVENTS_EXCHANGE, CHANNEL_STATUS_ROUTING_KEY_PATTERN);

    await channel.consume(queueName, async (msg) => {
      if (!msg) return;
      try {
        const parsed = ChannelStatusEventSchema.safeParse(JSON.parse(msg.content.toString()));
        if (!parsed.success) {
          return;
        }
        const { clientId, channel: ch, slot, status } = parsed.data;
        await this.pool.query(
          `UPDATE channel_sessions SET status = $1, updated_at = NOW()
           WHERE client_id = $2 AND channel = $3 AND slot = $4`,
          [status, clientId, ch, slot]
        );
        // Nudge open frontends to re-read /connectors.
        await this.broadcast(clientId, { type: SSE_EVENT_TYPES.CONNECTORS, clientId });
      } catch (err: any) {
        console.error('[events] channel status consumer error:', err.message);
      } finally {
        channel.ack(msg);
      }
    });
  }
}
