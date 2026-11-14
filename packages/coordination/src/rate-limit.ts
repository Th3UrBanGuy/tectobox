/**
 * Sliding-window rate limiting — @tectonic/coordination (Phase 6).
 * Moved verbatim from RedisCoordinator.rateLimit; behaviour unchanged.
 */

import { Redis } from 'ioredis';
import { randomUUID } from 'crypto';
import { RATE_LIMIT_SCRIPT } from './lua.js';

/**
 * Sliding window rate limiting
 * Evaluates window count before adding member to prevent lockout poisoning
 */
export async function rateLimit(
  redis: Redis,
  key: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  const now = Date.now();
  const windowStart = now - windowSec * 1000;
  const member = `${now}-${randomUUID()}`;

  const result = await redis.eval(
    RATE_LIMIT_SCRIPT,
    1,
    key,
    now.toString(),
    windowStart.toString(),
    limit.toString(),
    windowSec.toString(),
    member,
  );

  return result === 1;
}
