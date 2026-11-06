import pg from 'pg';
import { RabbitMQClient } from '@tectonic/messaging';
import { RedisCoordinator } from '@tectonic/coordination';
import { Redis } from 'ioredis';

export interface BroadcastJob {
  broadcastId: number;
  recipientId: number;
  clientId: number;
  platform: string;
  platformUserId: string;
  customerName?: string | null;
  text: string;
}

type DeliveryOutcome = { status: 'sent' | 'failed'; error?: string };

// How long to wait for a channel worker to report the send state of a
// published outbound message before marking the recipient failed as
// "unconfirmed" (the channel worker may still retry after that; the error
// text says so). Channel workers retry up to 3 times with backoff, so 30s
// covers the normal path.
const SEND_STATE_TIMEOUT_MS = 30000;
const SEND_STATE_POLL_MS = 1000;

/**
 * Extract a Telegram StringSession from a channel_sessions.session_json
 * value. Nothing in the codebase writes session_json today (the connect
 * flow only stores the status), so this accepts the plausible shapes a
 * future connect flow may store: a bare string, or an object holding the
 * session under sessionString / session / string / data.
 */
function extractTelegramSession(sessionJson: any): string | null {
  if (!sessionJson) return null;
  if (typeof sessionJson === 'string') return sessionJson.trim() || null;
  if (typeof sessionJson === 'object') {
    for (const key of ['sessionString', 'session', 'string', 'data']) {
      const v = sessionJson[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

export async function startBroadcastWorker() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('[broadcast] DATABASE_URL not set, broadcast worker disabled');
    return;
  }
  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });

  const mq = new RabbitMQClient({
    url: process.env.RABBITMQ_URL || 'amqp://tectobox:tectobox_dev@localhost:5672/',
    exchange: 'tectobox.events',
  });
  await mq.connect();

  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  const coordinator = new RedisCoordinator(redis);

  const channel = mq.getChannel();
  if (!channel) {
    console.error('[broadcast] no RabbitMQ channel, broadcast worker disabled');
    return;
  }

  await channel.prefetch(1);

  // Queue + retry topology. The queue and its 'broadcast.job.#' binding
  // already exist (infra/rabbitmq/definitions.json); setupRetryTopology
  // re-asserts them idempotently and adds the 'broadcast.job.send' binding
  // the api publishes with, plus retry/DLQ queues.
  await mq.setupRetryTopology('broadcast.jobs', 'broadcast.job.send', {
    dlxExchange: 'tectobox.dlx',
    dlqQueue: 'broadcast.jobs.dlq',
    // MUST match infra/rabbitmq/definitions.json exactly: the queue already
    // exists with x-dead-letter-routing-key 'broadcast.jobs.dlq'. The
    // helper's default (routingKey + '.dlq' = 'broadcast.job.send.dlq')
    // mismatches and the broker rejects the declare with 406.
    dlqRoutingKey: 'broadcast.jobs.dlq',
    retryExchange: 'tectobox.retry',
    retryQueue: 'broadcast.jobs.retry',
    retryTtlMs: 5000,
  });

  const markRecipient = async (
    recipientId: number,
    status: 'sent' | 'failed',
    error?: string | null,
  ): Promise<void> => {
    await pool.query(
      `UPDATE broadcast_recipients
       SET status = $2, error = $3,
           sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END
       WHERE id = $1`,
      [recipientId, status, error ?? null],
    );
  };

  /**
   * Flip the broadcast to its terminal state ('done' — the status the
   * frontend renders) once no recipient is pending anymore. Guarded on
   * status='sending' so a user-cancelled campaign is never overwritten.
   */
  const finalizeIfComplete = async (broadcastId: number): Promise<void> => {
    const { rows } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'pending') AS pending,
              COUNT(*) FILTER (WHERE status = 'sent') AS sent,
              COUNT(*) FILTER (WHERE status = 'failed') AS failed
       FROM broadcast_recipients WHERE broadcast_id = $1`,
      [broadcastId],
    );
    const counts = rows[0];
    if (Number(counts.pending) === 0) {
      await pool.query(
        `UPDATE broadcasts
         SET status = 'done', finished_at = NOW(), sent = $2, failed = $3
         WHERE id = $1 AND status = 'sending'`,
        [broadcastId, Number(counts.sent), Number(counts.failed)],
      );
      console.log(
        `[broadcast] broadcast ${broadcastId} done: ${counts.sent} sent, ${counts.failed} failed`,
      );
    }
  };

  /**
   * Wait for a channel worker to record the outcome of an outbound send
   * under the idempotency key we published with. Channel workers claim the
   * key, then record 'sent' / 'failed' / 'outcome-unknown'. Returns the
   * terminal state, or the last observed state ('sending' / 'pending' /
   * null) when the timeout expires.
   */
  const waitForSendState = async (idempotencyKey: string): Promise<string | null> => {
    const deadline = Date.now() + SEND_STATE_TIMEOUT_MS;
    let state: string | null = null;
    while (Date.now() < deadline) {
      try {
        state = await coordinator.getSendState(idempotencyKey);
      } catch {
        state = null;
      }
      if (state === 'sent' || state === 'failed' || state === 'outcome-unknown') return state;
      await new Promise((res) => setTimeout(res, SEND_STATE_POLL_MS));
    }
    return state;
  };

  /**
   * Webchat has no external provider: delivery IS the message landing in
   * the conversation (same as a manual reply) plus the live SSE event so
   * the widget shows it immediately. Nothing is published to
   * message.outgoing.webchat — no worker consumes it.
   */
  const deliverWebchat = async (job: BroadcastJob): Promise<DeliveryOutcome> => {
    const convRes = await pool.query(
      `SELECT id, client_id, platform, platform_user_id, slot, customer_name,
              customer_phone, last_message_at, unread_count, status
       FROM conversations
       WHERE client_id = $1 AND platform = 'webchat' AND platform_user_id = $2
       ORDER BY id DESC LIMIT 1`,
      [job.clientId, job.platformUserId],
    );
    if (convRes.rows.length === 0) {
      return { status: 'failed', error: 'No webchat conversation found for recipient' };
    }
    const conv = convRes.rows[0];
    const msgRes = await pool.query(
      `INSERT INTO messages (conversation_id, direction, text, created_at)
       VALUES ($1, 'out', $2, NOW())
       RETURNING id, conversation_id, direction, text, created_at`,
      [conv.id, job.text],
    );
    await pool.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conv.id]);
    try {
      await coordinator.publishEvent(`tenant:${job.clientId}:events`, {
        type: 'message',
        conversation: conv,
        outbound: msgRes.rows[0],
      });
    } catch (err: any) {
      console.warn('[broadcast] SSE publish failed:', err?.message || err);
    }
    return { status: 'sent' };
  };

  /**
   * WhatsApp / Telegram / Messenger / Instagram: first check the channel is
   * actually connected for this workspace; if not, fail honestly. If it is,
   * hand the message to the existing channel worker via its outbound queue
   * and wait for its send-state verdict instead of assuming success.
   */
  const deliverViaChannel = async (job: BroadcastJob): Promise<DeliveryOutcome> => {
    const platform = job.platform;
    let sessionString: string | null = null;

    if (platform === 'whatsapp' || platform === 'telegram') {
      const sRes = await pool.query(
        `SELECT session_json FROM channel_sessions
         WHERE client_id = $1 AND channel = $2 AND status = 'connected'
         ORDER BY updated_at DESC LIMIT 1`,
        [job.clientId, platform],
      );
      if (sRes.rows.length === 0) {
        return {
          status: 'failed',
          error: `No connected ${platform} session for this workspace (channel not connected)`,
        };
      }
      if (platform === 'telegram') {
        sessionString = extractTelegramSession(sRes.rows[0].session_json);
        if (!sessionString) {
          return {
            status: 'failed',
            error:
              'Telegram session is connected but has no stored session string (reconnect the channel)',
          };
        }
      }
    } else {
      // messenger / instagram
      const pRes = await pool.query(
        `SELECT id FROM meta_pages
         WHERE client_id = $1 AND channel = $2 AND status = 'connected' LIMIT 1`,
        [job.clientId, platform],
      );
      if (pRes.rows.length === 0) {
        return {
          status: 'failed',
          error: `No connected ${platform} page for this workspace (channel not connected)`,
        };
      }
    }

    const idempotencyKey = `bc:${job.broadcastId}:${job.recipientId}`;
    const routingKey = `message.outgoing.${platform}`;
    const payload: any = {
      clientId: job.clientId,
      slot: 'default',
      to: job.platformUserId,
      text: job.text,
      idempotencyKey,
      broadcastId: job.broadcastId,
      recipientId: job.recipientId,
    };
    if (platform === 'messenger' || platform === 'instagram') payload.platform = platform;
    if (platform === 'telegram') payload.sessionString = sessionString;

    try {
      await mq.publish(routingKey, payload);
    } catch (err: any) {
      return { status: 'failed', error: `Failed to publish to ${routingKey}: ${err?.message || err}` };
    }

    const state = await waitForSendState(idempotencyKey);
    if (state === 'sent') return { status: 'sent' };
    if (state === 'failed') {
      return { status: 'failed', error: 'Channel delivery failed (see message DLQ)' };
    }
    if (state === 'outcome-unknown') {
      return {
        status: 'failed',
        error: 'Channel delivery outcome unknown after provider error (check DLQ)',
      };
    }
    return {
      status: 'failed',
      error:
        'Channel delivery not confirmed within 30s (channel worker may still be retrying; check DLQ)',
    };
  };

  const deliver = async (job: BroadcastJob): Promise<DeliveryOutcome> => {
    switch (job.platform) {
      case 'webchat':
        return deliverWebchat(job);
      case 'whatsapp':
      case 'telegram':
      case 'messenger':
      case 'instagram':
        return deliverViaChannel(job);
      default:
        return { status: 'failed', error: `Unsupported platform '${job.platform}'` };
    }
  };

  await channel.consume('broadcast.jobs', async (msg: any) => {
    if (!msg) return;

    let job: BroadcastJob;
    try {
      job = JSON.parse(msg.content.toString());
    } catch (err) {
      console.error('[broadcast] malformed job JSON, routing to DLQ:', err);
      channel.nack(msg, false, false);
      return;
    }
    if (
      !job ||
      !job.broadcastId ||
      !job.recipientId ||
      !job.clientId ||
      !job.platform ||
      !job.platformUserId ||
      !job.text
    ) {
      console.warn('[broadcast] job missing required fields, routing to DLQ:', job);
      channel.nack(msg, false, false);
      return;
    }

    try {
      // Idempotency: a redelivered job for an already-sent recipient is a no-op.
      const recRes = await pool.query(
        'SELECT broadcast_id, status FROM broadcast_recipients WHERE id = $1',
        [job.recipientId],
      );
      if (recRes.rows.length === 0) {
        console.warn(`[broadcast] recipient ${job.recipientId} not found, ack`);
        channel.ack(msg);
        return;
      }
      if (recRes.rows[0].status === 'sent') {
        channel.ack(msg);
        return;
      }

      // A cancelled campaign stops here: remaining recipients stay pending
      // so a later re-send can still reach them.
      const bcRes = await pool.query('SELECT status FROM broadcasts WHERE id = $1', [job.broadcastId]);
      if (bcRes.rows.length === 0) {
        channel.ack(msg);
        return;
      }
      if (bcRes.rows[0].status === 'cancelled') {
        console.log(
          `[broadcast] broadcast ${job.broadcastId} cancelled, skipping recipient ${job.recipientId}`,
        );
        channel.ack(msg);
        return;
      }

      const outcome = await deliver(job);
      await markRecipient(job.recipientId, outcome.status, outcome.error ?? null);
      console.log(
        `[broadcast] broadcast ${job.broadcastId} recipient ${job.recipientId} (${job.platform} ${job.platformUserId}): ${outcome.status}${outcome.error ? ` — ${outcome.error}` : ''}`,
      );
      await finalizeIfComplete(job.broadcastId);
      channel.ack(msg);
    } catch (err: any) {
      // Never requeue broadcast jobs blindly: record the failure on the
      // recipient so the campaign still reaches a terminal state.
      console.error(
        `[broadcast] error processing job for recipient ${job.recipientId}:`,
        err?.message || err,
      );
      try {
        await markRecipient(
          job.recipientId,
          'failed',
          `Worker error: ${String(err?.message || err).slice(0, 500)}`,
        );
        await finalizeIfComplete(job.broadcastId);
      } catch {
        // Best effort only; the job is acked below regardless.
      }
      channel.ack(msg);
    }
  });

  console.log('[broadcast-worker] started');
}
