import { Redis } from 'ioredis';
import { randomUUID } from 'crypto';

export type RedisEventHandler = (payload: any) => void;

export class RedisCoordinator {
  constructor(private redis: Redis) {}

  /**
   * Sliding window rate limiting
   * Evaluates window count before adding member to prevent lockout poisoning
   */
  async rateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
    const now = Date.now();
    const windowStart = now - windowSec * 1000;
    const member = `${now}-${randomUUID()}`;

    const lua = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local windowStart = tonumber(ARGV[2])
      local limit = tonumber(ARGV[3])
      local windowSec = tonumber(ARGV[4])
      local member = ARGV[5]

      redis.call("zremrangebyscore", key, 0, windowStart)
      local currentCount = redis.call("zcard", key)
      if currentCount < limit then
        redis.call("zadd", key, now, member)
        redis.call("expire", key, windowSec)
        return 1
      else
        return 0
      end
    `;

    const result = await this.redis.eval(
      lua,
      1,
      key,
      now.toString(),
      windowStart.toString(),
      limit.toString(),
      windowSec.toString(),
      member
    );

    return result === 1;
  }

  /**
   * Distributed session leases with strictly monotonically increasing fencing tokens
   * Uses atomic INCR on a dedicated counter key to generate monotonic fencing tokens.
   */
  async acquireLease(key: string, ttlSec: number): Promise<number | null> {
    const counterKey = `${key}:seq`;
    const fencingToken = await this.redis.incr(counterKey);

    // Atomically set lease owner and fencing token if not held
    const lua = `
      if redis.call("set", KEYS[1], ARGV[1], "EX", ARGV[2], "NX") then
        return 1
      else
        return 0
      end
    `;

    const acquired = await this.redis.eval(lua, 1, key, fencingToken.toString(), ttlSec);
    return acquired === 1 ? fencingToken : null;
  }

  /**
   * Validate current lease ownership and fencing token immediately before any side-effect
   */
  async validateLease(key: string, fencingToken: number): Promise<boolean> {
    const current = await this.redis.get(key);
    return current === fencingToken.toString();
  }

  /**
   * Atomically validate lease ownership/fencing token and touch (refresh) the lease TTL.
   * Ensures the lease has not expired or been acquired by a newer worker with a higher token,
   * while keeping it active. Returns true if valid and touched, false if stale or expired.
   */
  async validateAndTouchLease(key: string, fencingToken: number, ttlSec: number = 60): Promise<boolean> {
    const lua = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        redis.call("expire", KEYS[1], ARGV[2])
        return 1
      else
        return 0
      end
    `;
    const result = await this.redis.eval(lua, 1, key, fencingToken.toString(), ttlSec.toString());
    return result === 1;
  }

  async renewLease(key: string, fencingToken: number, ttlSec: number): Promise<boolean> {
    const lua = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("expire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    const result = await this.redis.eval(lua, 1, key, fencingToken.toString(), ttlSec);
    return result === 1;
  }

  async releaseLease(key: string, fencingToken: number): Promise<boolean> {
    const lua = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const result = await this.redis.eval(lua, 1, key, fencingToken.toString());
    return result === 1;
  }

  /**
   * Conversation distributed lock
   */
  async acquireLock(key: string, ttlSec: number): Promise<string | null> {
    const token = randomUUID();
    const result = await this.redis.set(key, token, 'EX', ttlSec, 'NX');
    return result === 'OK' ? token : null;
  }

  async releaseLock(key: string, token: string): Promise<boolean> {
    const lua = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const result = await this.redis.eval(lua, 1, key, token);
    return result === 1;
  }

  /**
   * Outbound send attempt idempotency & state tracking
   * Supported states: pending, sending, sent, failed, outcome-unknown
   *
   * Note on provider calls: External provider network calls (WhatsApp/Telegram APIs)
   * can never be strictly atomic with local/Redis distributed state. If a provider
   * receives a request but the connection drops before a response is received,
   * the outcome is inherently ambiguous ('outcome-unknown') and must be routed
   * for manual reconciliation or DLQ, rather than blindly retried.
   */
  async recordSendState(
    idempotencyKey: string,
    state: 'pending' | 'sending' | 'sent' | 'failed' | 'outcome-unknown',
    ttlSec: number = 86400
  ): Promise<void> {
    const key = `send_attempt:${idempotencyKey}`;
    await this.redis.set(key, state, 'EX', ttlSec);
  }

  /**
   * Atomically claim a send attempt.
   * If the current state is already 'sent', 'sending', or 'outcome-unknown',
   * returns { claimed: false, state: string }.
   * If not set or in a retryable state ('pending', 'failed'), atomically sets state to 'sending' with ttlSec
   * and returns { claimed: true, state: 'sending' }.
   */
  async claimSendAttempt(
    idempotencyKey: string,
    ttlSec: number = 86400
  ): Promise<{ claimed: boolean; state: string }> {
    const key = `send_attempt:${idempotencyKey}`;
    const lua = `
      local current = redis.call("get", KEYS[1])
      if current == "sent" or current == "sending" or current == "outcome-unknown" then
        return {0, current}
      end
      redis.call("set", KEYS[1], "sending", "EX", ARGV[1])
      return {1, "sending"}
    `;
    const result = (await this.redis.eval(lua, 1, key, ttlSec.toString())) as [number, string];
    const claimed = result[0] === 1;
    const state = result[1];
    return { claimed, state };
  }

  async getSendState(idempotencyKey: string): Promise<string | null> {
    const key = `send_attempt:${idempotencyKey}`;
    return this.redis.get(key);
  }

  /**
   * Redis Pub/Sub client for real-time SSE event fan-out
   */
  async publishEvent(channel: string, payload: any): Promise<number> {
    return this.redis.publish(channel, JSON.stringify(payload));
  }
}

export class RedisSubscriber {
  private redis: Redis;
  private handlers = new Map<string, Set<RedisEventHandler>>();

  constructor(options: { url?: string; host?: string; port?: number; password?: string }) {
    // Prefer a full URL (ioredis parses host/port/password from it); fall back
    // to discrete host/port/password. Subscriber connections are dedicated:
    // an ioredis connection in subscriber mode cannot run commands.
    this.redis = options.url
      ? new Redis(options.url, {
          retryStrategy: (times: number) => Math.min(times * 1000, 10000),
          maxRetriesPerRequest: 1,
        })
      : new Redis({
          host: options.host ?? 'localhost',
          port: options.port ?? 6379,
          password: options.password,
          retryStrategy: (times: number) => Math.min(times * 1000, 10000),
          maxRetriesPerRequest: 1,
        });
    // Swallow connection errors instead of crashing the process with an
    // "Unhandled error event"; subscribe() still rejects on init failure,
    // which the caller logs.
    this.redis.on('error', () => {});
    
    this.redis.on('message', (channel: string, message: string) => {
      const channelHandlers = this.handlers.get(channel);
      if (channelHandlers && channelHandlers.size > 0) {
        try {
          const parsed = JSON.parse(message);
          for (const handler of channelHandlers) {
            try {
              handler(parsed);
            } catch (err) {
              console.error(`Error in handler for channel ${channel}:`, err);
            }
          }
        } catch (err) {
          console.error(`Error processing message from channel ${channel}:`, err);
        }
      }
    });
  }

  async subscribe(channel: string, handler: RedisEventHandler) {
    let channelHandlers = this.handlers.get(channel);
    if (!channelHandlers) {
      channelHandlers = new Set<RedisEventHandler>();
      this.handlers.set(channel, channelHandlers);
      await this.redis.subscribe(channel);
    }
    channelHandlers.add(handler);
  }

  async unsubscribe(channel: string, handler?: RedisEventHandler) {
    const channelHandlers = this.handlers.get(channel);
    if (!channelHandlers) return;

    if (handler) {
      channelHandlers.delete(handler);
      if (channelHandlers.size === 0) {
        this.handlers.delete(channel);
        await this.redis.unsubscribe(channel);
      }
    } else {
      this.handlers.delete(channel);
      await this.redis.unsubscribe(channel);
    }
  }

  async close() {
    await this.redis.quit();
  }
}
