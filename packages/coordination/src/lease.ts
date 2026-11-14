/**
 * Distributed session leases with fencing tokens — @tectonic/coordination
 * (Phase 6). Moved verbatim from RedisCoordinator; behaviour unchanged.
 * Fencing tokens are strictly monotonically increasing (atomic INCR on a
 * dedicated counter key), so a newer worker's lease always beats a stale
 * holder's token.
 */

import { Redis } from 'ioredis';
import {
  LEASE_SET_NX_SCRIPT,
  LEASE_TOUCH_SCRIPT,
  LEASE_RENEW_SCRIPT,
  COMPARE_AND_DELETE_SCRIPT,
} from './lua.js';

/**
 * Distributed session leases with strictly monotonically increasing fencing tokens
 * Uses atomic INCR on a dedicated counter key to generate monotonic fencing tokens.
 */
export async function acquireLease(
  redis: Redis,
  key: string,
  ttlSec: number,
): Promise<number | null> {
  const counterKey = `${key}:seq`;
  const fencingToken = await redis.incr(counterKey);

  // Atomically set lease owner and fencing token if not held
  const acquired = await redis.eval(
    LEASE_SET_NX_SCRIPT,
    1,
    key,
    fencingToken.toString(),
    ttlSec,
  );
  return acquired === 1 ? fencingToken : null;
}

/**
 * Validate current lease ownership and fencing token immediately before any side-effect
 */
export async function validateLease(
  redis: Redis,
  key: string,
  fencingToken: number,
): Promise<boolean> {
  const current = await redis.get(key);
  return current === fencingToken.toString();
}

/**
 * Atomically validate lease ownership/fencing token and touch (refresh) the lease TTL.
 * Ensures the lease has not expired or been acquired by a newer worker with a higher token,
 * while keeping it active. Returns true if valid and touched, false if stale or expired.
 */
export async function validateAndTouchLease(
  redis: Redis,
  key: string,
  fencingToken: number,
  ttlSec: number = 60,
): Promise<boolean> {
  const result = await redis.eval(
    LEASE_TOUCH_SCRIPT,
    1,
    key,
    fencingToken.toString(),
    ttlSec.toString(),
  );
  return result === 1;
}

export async function renewLease(
  redis: Redis,
  key: string,
  fencingToken: number,
  ttlSec: number,
): Promise<boolean> {
  const result = await redis.eval(
    LEASE_RENEW_SCRIPT,
    1,
    key,
    fencingToken.toString(),
    ttlSec,
  );
  return result === 1;
}

export async function releaseLease(
  redis: Redis,
  key: string,
  fencingToken: number,
): Promise<boolean> {
  const result = await redis.eval(
    COMPARE_AND_DELETE_SCRIPT,
    1,
    key,
    fencingToken.toString(),
  );
  return result === 1;
}
