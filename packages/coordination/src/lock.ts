/**
 * Conversation distributed lock — @tectonic/coordination (Phase 6).
 * Moved verbatim from RedisCoordinator; behaviour unchanged.
 */

import { Redis } from 'ioredis';
import { randomUUID } from 'crypto';
import { COMPARE_AND_DELETE_SCRIPT } from './lua.js';

/**
 * Conversation distributed lock
 */
export async function acquireLock(
  redis: Redis,
  key: string,
  ttlSec: number,
): Promise<string | null> {
  const token = randomUUID();
  const result = await redis.set(key, token, 'EX', ttlSec, 'NX');
  return result === 'OK' ? token : null;
}

export async function releaseLock(
  redis: Redis,
  key: string,
  token: string,
): Promise<boolean> {
  const result = await redis.eval(COMPARE_AND_DELETE_SCRIPT, 1, key, token);
  return result === 1;
}
