import { RETRY_EXCHANGE, outgoingRoutingKey } from '@tectonic/contracts';

/**
 * Shared outgoing-message consumer skeleton — the claim / retry / DLQ
 * flow copied 3× (WhatsApp worker L200–325, Telegram worker L206–311,
 * meta `handleMetaOutgoingMessage` L1–150).
 *
 * Phase 2 of the modular restructure. Only three things differ per
 * channel and are parameterised: the payload validation (wire schema),
 * the idempotency-key prefix, and the provider call (`send`). Everything
 * else — JSON-parse → DLQ, required-field gate → DLQ, `claimSendAttempt`
 * branches, `validateAndTouchLease` at the provider boundary (done inside
 * each channel's `send`), exponential backoff
 * `min(1000·2^(n-1), 10000)`, MAX_RETRIES = 3, republish to
 * `tectobox.retry` with `x-retry-count`, `recordSendState('failed')` +
 * DLQ on exhaustion — is identical, including the rule that the original
 * message is acked ONLY after a confirmed republish to the retry
 * exchange.
 *
 * The skeleton never acks/nacks: it returns an outcome and the caller
 * (the `channel.consume` callback, or meta's exported handler) maps it
 * to ack/nack / a status object. That keeps the meta handler's
 * `{ status, error? }` return contract intact while sharing the flow.
 *
 * `send` returns `{ outcome: 'sent' }` on success, throws on a failure
 * that goes through the retry/DLQ path (the skeleton re-reads the send
 * state first — an 'outcome-unknown' state routes straight to the DLQ
 * without a blind retry), or returns `{ outcome: 'terminal-failed' }`
 * for a failure that must NOT be retried (meta: no page token
 * configured — the send callback has already recorded 'failed' and the
 * error key, exactly as before).
 *
 * Log lines: unified to the WhatsApp wording with the channel prefix.
 * Four console-only wordings change (no ack/nack/retry/DLQ/state
 * behaviour): Telegram's max-retries line ("for message to X, routing
 * to DLQ" → "for X, sending to DLQ"), meta's send-error line (logs the
 * whole error instead of `err.message`), meta's claim outcome-unknown /
 * in-flight lines (longer forms), and meta's retry-publish-failure line
 * (gains ", routing original to DLQ"). Meta's catch path also gains a
 * warn line on outcome-unknown that it did not log before.
 */
export const MAX_RETRIES = 3;
export const RETRY_BACKOFF_BASE_MS = 1000;
export const RETRY_BACKOFF_MAX_MS = 10000;

export type OutgoingSendOutcome =
  | { outcome: 'sent' }
  | { outcome: 'terminal-failed'; error?: string };

export type OutgoingMessageOutcome =
  | { outcome: 'ignored' }
  | { outcome: 'malformed' }
  | { outcome: 'invalid' }
  | { outcome: 'duplicate-sent' }
  | { outcome: 'outcome-unknown' }
  | { outcome: 'in-flight' }
  | { outcome: 'sent' }
  | { outcome: 'retried'; attempt: number }
  | { outcome: 'failed'; error: string };

/** Outcomes after which the caller must ack (everything else: nack). */
export function shouldAckOutgoing(result: OutgoingMessageOutcome): boolean {
  return (
    result.outcome === 'sent' ||
    result.outcome === 'duplicate-sent' ||
    result.outcome === 'retried'
  );
}

export interface OutgoingConsumerOptions {
  msg: any;
  coordinator: any;
  mq: any;
  /** Log prefix + routing-key channel: 'whatsapp' | 'telegram' | 'meta'. */
  channel: string;
  /**
   * Wire-schema validation; `{ ok: false }` routes to the DLQ. The data
   * is `any` (the zod schemas coerce/validate at runtime — the payloads
   * are `any`-typed across this codebase); the skeleton only reads
   * `attempt` / `to` / `idempotencyKey` off it.
   */
  validate: (payload: unknown) => { ok: true; data: any } | { ok: false };
  /** Deterministic idempotency key; must be stable across redeliveries. */
  buildIdempotencyKey: (data: any) => string;
  /** Provider call (incl. lease validation + send-state recording). */
  send: (data: any, stableIdKey: string) => Promise<OutgoingSendOutcome>;
}

export async function runOutgoingMessage(
  opts: OutgoingConsumerOptions,
): Promise<OutgoingMessageOutcome> {
  const { msg, coordinator, mq, channel } = opts;
  if (!msg) return { outcome: 'ignored' };

  let payload: any;
  try {
    payload = JSON.parse(msg.content.toString());
  } catch (err) {
    console.error(`[${channel}] malformed JSON payload, routing to DLQ:`, err);
    return { outcome: 'malformed' };
  }

  // Payloads are validated by the channel's wire schema, which encodes
  // exactly the old `!clientId || !to || !text` gate (plus the Number()
  // coercion for clientId). A failed message is nacked to the DLQ, as before.
  const parsed = opts.validate(payload);
  if (!parsed.ok) {
    console.warn(`[${channel}] missing required fields, routing to DLQ:`, payload);
    return { outcome: 'invalid' };
  }
  const data = parsed.data;

  // Read retry attempt from message header if present (broker-managed
  // retry) or payload.
  const headerAttempt = msg.properties?.headers?.['x-retry-count'];
  const currentAttempt = Number(headerAttempt ?? data.attempt) || 1;

  // Never generate a different idempotency key for the same logical send
  // on redelivery! If payload already has an idempotencyKey, preserve it
  // deterministically.
  const stableIdKey = opts.buildIdempotencyKey(parsed.data);

  // Atomic send-state claim via Redis Lua script.
  const claimResult = await coordinator.claimSendAttempt(stableIdKey);
  if (!claimResult.claimed) {
    if (claimResult.state === 'sent') {
      console.log(
        `[${channel}] message ${stableIdKey} already sent, acknowledging duplicate`,
      );
      return { outcome: 'duplicate-sent' };
    }
    if (claimResult.state === 'outcome-unknown') {
      console.warn(
        `[${channel}] message ${stableIdKey} has ambiguous outcome from prior attempt; holding for manual reconciliation and routing to DLQ`,
      );
      return { outcome: 'outcome-unknown' };
    }
    if (claimResult.state === 'sending') {
      console.warn(
        `[${channel}] message ${stableIdKey} is currently being sent concurrently; rejecting redelivery`,
      );
      return { outcome: 'in-flight' };
    }
  }

  try {
    const sent = await opts.send(parsed.data, stableIdKey);
    if (sent.outcome === 'terminal-failed') {
      return { outcome: 'failed', error: sent.error || 'terminal_failed' };
    }
    return { outcome: 'sent' };
  } catch (err) {
    console.error(
      `[${channel}] send error (attempt ${currentAttempt}/${MAX_RETRIES}):`,
      err,
    );
    const latestState = await coordinator.getSendState(stableIdKey);
    if (latestState === 'outcome-unknown') {
      console.warn(
        `[${channel}] send encountered ambiguous outcome for ${data.to}, routing to DLQ without blind retry`,
      );
      return { outcome: 'failed', error: 'outcome-unknown' };
    }

    if (currentAttempt < MAX_RETRIES) {
      // Broker-managed durable retry routing: publish to durable retry
      // exchange with TTL and headers.
      const nextAttempt = currentAttempt + 1;
      const nextPayload = {
        ...data,
        attempt: nextAttempt,
        idempotencyKey: stableIdKey,
      };
      const delayMs = Math.min(
        RETRY_BACKOFF_BASE_MS * Math.pow(2, currentAttempt - 1),
        RETRY_BACKOFF_MAX_MS,
      );

      try {
        await mq.publish(outgoingRoutingKey(channel), nextPayload, {
          exchange: RETRY_EXCHANGE,
          expiration: delayMs,
          headers: { 'x-retry-count': nextAttempt },
          mandatory: true,
        });
        // Only ack original message after confirmed republish to retry queue.
        return { outcome: 'retried', attempt: nextAttempt };
      } catch (publishErr) {
        console.error(
          `[${channel}] failed to publish to retry queue, routing original to DLQ:`,
          publishErr,
        );
        return { outcome: 'failed', error: 'publish_retry_failed' };
      }
    } else {
      console.error(
        `[${channel}] max retries reached for ${data.to}, sending to DLQ`,
      );
      await coordinator.recordSendState(stableIdKey, 'failed');
      return { outcome: 'failed', error: 'max_retries' };
    }
  }
}
