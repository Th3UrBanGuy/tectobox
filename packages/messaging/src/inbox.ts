import { Pool, PoolClient } from 'pg';
import amqplib from 'amqplib';
import { randomUUID, createHash } from 'crypto';

export type MessageHandler = (payload: any, client: PoolClient) => Promise<void>;

function toUUID(id?: string | number): string {
  if (!id) return randomUUID();
  const str = String(id).trim();
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(str)) {
    return str;
  }
  const hash = createHash('sha256').update(str).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export class InboxProcessor {
  constructor(private db: Pool) {}

  async handleMessage(
    msg: amqplib.ConsumeMessage,
    channel: amqplib.Channel,
    handler: MessageHandler
  ) {
    let payload: any;
    try {
      payload = JSON.parse(msg.content.toString());
    } catch (err) {
      console.error('Invalid JSON payload in consumer, dead-lettering message:', err);
      channel.nack(msg, false, false);
      return;
    }

    if (!payload || typeof payload !== 'object') {
      console.warn('Consumer received non-object payload, dead-lettering:', payload);
      channel.nack(msg, false, false);
      return;
    }

    const rawId = payload.id || payload.eventId || payload.requestId || payload.messageId;
    const messageId = toUUID(rawId);
    const source = payload.source || payload.platform || 'unknown';
    const eventType = payload.type || payload.eventType || payload.event_type || 'message';

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Try to insert into inbox_events to ensure idempotency
      const result = await client.query(
        `INSERT INTO inbox_events (id, source, event_type, payload, processed_at) 
         VALUES ($1, $2, $3, $4, NOW()) 
         ON CONFLICT (id) DO NOTHING`,
        [messageId, source, eventType, payload]
      );

      if (result.rowCount === 0) {
        // Message already processed
        await client.query('ROLLBACK');
        channel.ack(msg);
        return;
      }

      await handler(payload, client);

      await client.query('COMMIT');
      channel.ack(msg);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Failed to process message:', err);
      // Nack and do not requeue -> send to DLQ
      channel.nack(msg, false, false);
    } finally {
      client.release();
    }
  }
}

