/**
 * Outbound send attempt idempotency & state tracking — @tectonic/coordination
 * (Phase 6). Moved verbatim from RedisCoordinator; behaviour unchanged.
 *
 * Note on provider calls: External provider network calls (WhatsApp/Telegram APIs)
 * can never be strictly atomic with local/Redis distributed state. If a provider
 * receives a request but the connection drops before a response is received,
 * the outcome is inherently ambiguous ('outcome-unknown') and must be routed
 * for manual reconciliation or DLQ, rather than blindly retried.
 */

import { Redis } from 'ioredis';
import { CLAIM_SEND_ATTEMPT_SCRIPT } from './lua.js';

/**
 * Outbound send attempt idempotency & state tracking
 * Supported states: pending, sending, sent, failed, outcome-unknown
 */
export async function recordSendState(
  redis: Redis,
  idempotencyKey: string,
  state: 'pending' | 'sending' | 'sent' | 'failed' | 'outcome-unknown',
  ttlSec: number = 86400,
): Promise<void> {
  const key = `send_attempt:${idempotencyKey}`;
  await redis.set(key, state, 'EX', ttlSec);
}

/**
 * Atomically claim a send attempt.
 * If the current state is already 'sent', 'sending', or 'outcome-unknown',
 * returns { claimed: false, state: string }.
 * If not set or in a retryable state ('pending', 'failed'), atomically sets state to 'sending' with ttlSec
 * and returns { claimed: true, state: 'sending' }.
 */
export async function claimSendAttempt(
  redis: Redis,
  idempotencyKey: string,
  ttlSec: number = 86400,
): Promise<{ claimed: boolean; state: string }> {
  const key = `send_attempt:${idempotencyKey}`;
  const result = (await redis.eval(
    CLAIM_SEND_ATTEMPT_SCRIPT,
    1,
    key,
    ttlSec.toString(),
  )) as [number, string];
  const claimed = result[0] === 1;
  const state = result[1];
  return { claimed, state };
}

export async function getSendState(
  redis: Redis,
  idempotencyKey: string,
): Promise<string | null> {
  const key = `send_attempt:${idempotencyKey}`;
  return redis.get(key);
}
