/**
 * Redis distributed coordination — @tectonic/coordination (Phase 6 of the
 * modular restructure). The implementation now lives in focused modules
 * (lua.ts, rate-limit.ts, lease.ts, lock.ts, send-state.ts, pubsub.ts);
 * this file is a thin barrel that keeps the public API identical:
 * RedisCoordinator (same methods, same signatures), RedisSubscriber, and
 * RedisEventHandler. Every method below delegates to its module function
 * with this.redis — no behaviour lives here.
 */

import { Redis } from 'ioredis';
import { rateLimit } from './rate-limit.js';
import {
  acquireLease,
  validateLease,
  validateAndTouchLease,
  renewLease,
  releaseLease,
} from './lease.js';
import { acquireLock, releaseLock } from './lock.js';
import {
  recordSendState,
  claimSendAttempt,
  getSendState,
} from './send-state.js';
import { publishEvent, RedisSubscriber } from './pubsub.js';

export { RedisSubscriber } from './pubsub.js';
export type { RedisEventHandler } from './pubsub.js';

export class RedisCoordinator {
  constructor(private redis: Redis) {}

  async rateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
    return rateLimit(this.redis, key, limit, windowSec);
  }

  async acquireLease(key: string, ttlSec: number): Promise<number | null> {
    return acquireLease(this.redis, key, ttlSec);
  }

  async validateLease(key: string, fencingToken: number): Promise<boolean> {
    return validateLease(this.redis, key, fencingToken);
  }

  async validateAndTouchLease(
    key: string,
    fencingToken: number,
    ttlSec: number = 60,
  ): Promise<boolean> {
    return validateAndTouchLease(this.redis, key, fencingToken, ttlSec);
  }

  async renewLease(key: string, fencingToken: number, ttlSec: number): Promise<boolean> {
    return renewLease(this.redis, key, fencingToken, ttlSec);
  }

  async releaseLease(key: string, fencingToken: number): Promise<boolean> {
    return releaseLease(this.redis, key, fencingToken);
  }

  async acquireLock(key: string, ttlSec: number): Promise<string | null> {
    return acquireLock(this.redis, key, ttlSec);
  }

  async releaseLock(key: string, token: string): Promise<boolean> {
    return releaseLock(this.redis, key, token);
  }

  async recordSendState(
    idempotencyKey: string,
    state: 'pending' | 'sending' | 'sent' | 'failed' | 'outcome-unknown',
    ttlSec: number = 86400,
  ): Promise<void> {
    return recordSendState(this.redis, idempotencyKey, state, ttlSec);
  }

  async claimSendAttempt(
    idempotencyKey: string,
    ttlSec: number = 86400,
  ): Promise<{ claimed: boolean; state: string }> {
    return claimSendAttempt(this.redis, idempotencyKey, ttlSec);
  }

  async getSendState(idempotencyKey: string): Promise<string | null> {
    return getSendState(this.redis, idempotencyKey);
  }

  async publishEvent(channel: string, payload: any): Promise<number> {
    return publishEvent(this.redis, channel, payload);
  }
}
