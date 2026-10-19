import { Pool } from 'pg';
import { RabbitMQClient, withRetry } from './rabbitmq.js';

export interface OutboxEvent {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: any;
  created_at: Date;
}

export class OutboxProcessor {
  private isProcessing: boolean = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped: boolean = false;

  constructor(
    private db: Pool,
    private rabbitmq: RabbitMQClient,
    private batchSize: number = 50
  ) {}

  async processPendingEvents(): Promise<number> {
    let processed = 0;

    for (let i = 0; i < this.batchSize; i++) {
      const client = await this.db.connect();
      try {
        await client.query('BEGIN');

        const { rows } = await client.query<OutboxEvent>(
          `SELECT * FROM outbox_events 
           WHERE processed_at IS NULL 
           ORDER BY created_at ASC 
           FOR UPDATE SKIP LOCKED 
           LIMIT 1`
        );

        if (rows.length === 0) {
          await client.query('COMMIT');
          break;
        }

        const event = rows[0];
        // Derive routing key from event type or aggregate
        const routingKey = `${event.aggregate_type}.${event.event_type}`;

        await withRetry(() =>
          this.rabbitmq.publish(routingKey, {
            id: event.id,
            type: event.event_type,
            aggregateId: event.aggregate_id,
            payload: event.payload,
            timestamp: event.created_at,
          })
        );

        await client.query(
          `UPDATE outbox_events SET processed_at = NOW() WHERE id = $1`,
          [event.id]
        );

        await client.query('COMMIT');
        processed++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('Outbox event processing failed:', err);
        throw err;
      } finally {
        client.release();
      }
    }

    return processed;
  }

  startPolling(intervalMs: number = 5000) {
    this.stopped = false;
    const poll = async () => {
      if (this.stopped) return;
      if (this.isProcessing) {
        this.pollTimer = setTimeout(poll, intervalMs);
        return;
      }

      this.isProcessing = true;
      try {
        await this.processPendingEvents();
      } catch (err) {
        console.error('Outbox processing failed:', err);
      } finally {
        this.isProcessing = false;
        if (!this.stopped) {
          this.pollTimer = setTimeout(poll, intervalMs);
        }
      }
    };

    this.pollTimer = setTimeout(poll, intervalMs);
  }

  stopPolling() {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

