import { Redis } from 'ioredis';
import { RedisCoordinator } from '@tectonic/coordination';
import { RabbitMQClient } from '@tectonic/messaging';
import { EVENTS_EXCHANGE } from '@tectonic/contracts';
import type { BrokerState } from './broker-state.js';

export interface BrokerConnectionHooks {
  /**
   * Called after a (re)connect, once the lifecycle handlers are
   * attached: (re)starts the RabbitMQ consumers (inbound intake +
   * channel status). `EventsService` wires this to the two consumer
   * services so the broker layer never imports them.
   */
  onReconnected: () => Promise<void>;
}

/**
 * RabbitMQ + Redis connection lifecycle: initial connect with bounded
 * retry, disconnect detection, exponential-backoff reconnect, and
 * teardown.
 *
 * Moved verbatim out of `EventsService` (`getMqClient`, `setMqClient`,
 * `getIsConnected`, `setIsConnected`, `attachConnectionLifecycle`,
 * `triggerReconnect`, and the broker half of `onModuleInit`) — Phase 3
 * of the modular restructure. No behaviour change: same env vars, same
 * backoff, same fatal `process.exit(1)` when the broker is unreachable
 * past the startup timeout.
 */
export class BrokerConnectionService {
  constructor(
    private readonly state: BrokerState,
    private readonly hooks: BrokerConnectionHooks
  ) {}

  getMqClient(): RabbitMQClient | null {
    return this.state.mq;
  }

  setMqClient(mq: any) {
    this.state.mq = mq;
  }

  getIsConnected(): boolean {
    return this.state.isConnected;
  }

  setIsConnected(connected: boolean) {
    this.state.isConnected = connected;
  }

  /** Creates the Redis client + coordinator (warns, never throws). */
  initializeRedis(): void {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    try {
      this.state.redis = new Redis(redisUrl, {
        retryStrategy: (times: number) => Math.min(times * 1000, 10000),
        maxRetriesPerRequest: 1,
      });
      this.state.redis.on('error', (err: any) => {
        console.warn('[events] Redis connection warning:', err?.message || err);
      });
      this.state.coordinator = new RedisCoordinator(this.state.redis);
    } catch (err: any) {
      console.warn('[events] Redis init warning:', err?.message || err);
    }
  }

  attachConnectionLifecycle() {
    const mqAny = this.state.mq as any;
    const conn = mqAny?.conn;
    const channel = this.state.mq?.getChannel();

    const handleDisconnect = (reason: string) => {
      if (this.state.isClosing) return;
      if (!this.state.isConnected && this.state.isReconnecting) return;
      console.warn(`[events] RabbitMQ disconnected (${reason}), initiating reconnect...`);
      this.state.isConnected = false;
      this.triggerReconnect().catch((err) => {
        console.error('[events] Reconnect loop error:', err);
      });
    };

    if (conn && typeof conn.on === 'function') {
      conn.on('close', () => handleDisconnect('connection closed'));
      conn.on('error', (err: any) => handleDisconnect(`connection error: ${err?.message || err}`));
    }
    if (channel && typeof (channel as any).on === 'function') {
      (channel as any).on('close', () => handleDisconnect('channel closed'));
      (channel as any).on('error', (err: any) => handleDisconnect(`channel error: ${err?.message || err}`));
    }
  }

  async triggerReconnect(): Promise<void> {
    if (this.state.isClosing || this.state.isReconnecting) return;
    this.state.isReconnecting = true;

    let delay = Number(process.env.RABBITMQ_RECONNECT_INITIAL_MS) || 1000;
    const maxDelay = Number(process.env.RABBITMQ_RECONNECT_MAX_MS) || 30000;

    while (!this.state.isConnected && !this.state.isClosing) {
      console.log(`[events] Attempting broker reconnect in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
      if (this.state.isClosing) break;

      try {
        const rabbitUrl = process.env.RABBITMQ_URL || 'amqp://tectobox:tectobox_dev@localhost:5672/';
        if (this.state.mq) {
          try { await this.state.mq.close(); } catch {}
        }
        this.state.mq = new RabbitMQClient({
          url: rabbitUrl,
          exchange: EVENTS_EXCHANGE,
        });
        await this.state.mq.connect();
        this.state.isConnected = true;
        this.state.isReconnecting = false;
        console.log('[events] Reconnected to RabbitMQ broker successfully');
        this.attachConnectionLifecycle();
        await this.hooks.onReconnected();
        return;
      } catch (err: any) {
        console.warn(`[events] Reconnect attempt failed: ${err?.message || err}`);
        delay = Math.min(delay * 2, maxDelay);
      }
    }
    this.state.isReconnecting = false;
  }

  /**
   * Connects to the broker with a bounded retry loop. On success the
   * lifecycle handlers are attached and `onConnected` runs (consumers +
   * outbox polling). On fatal timeout logs and exits non-zero, exactly
   * as the old `onModuleInit` did.
   */
  async connectWithRetry(onConnected: () => Promise<void>): Promise<void> {
    const rabbitUrl = process.env.RABBITMQ_URL || 'amqp://tectobox:tectobox_dev@localhost:5672/';
    const startupTimeoutMs = Number(process.env.RABBITMQ_STARTUP_TIMEOUT_MS ?? process.env.BROKER_STARTUP_TIMEOUT_MS) || 60000;
    const startTime = Date.now();
    let attempt = 0;

    while (!this.state.isConnected && !this.state.isClosing) {
      attempt++;
      try {
        this.state.mq = new RabbitMQClient({
          url: rabbitUrl,
          exchange: EVENTS_EXCHANGE,
        });
        await this.state.mq.connect();
        this.state.isConnected = true;
        console.log('[events] Connected to RabbitMQ & Redis');
        this.attachConnectionLifecycle();
        await onConnected();
        return;
      } catch (err: any) {
        const elapsed = Date.now() - startTime;
        if (elapsed >= startupTimeoutMs) {
          console.error(
            `[events] Fatal: RabbitMQ broker unreachable after ${elapsed}ms (${attempt} attempts, limit ${startupTimeoutMs}ms): ${err.message}. Exiting non-zero.`
          );
          process.exit(1);
          return;
        }
        const backoff = Math.min(500 * Math.pow(1.5, attempt - 1), 3000);
        const remaining = startupTimeoutMs - elapsed;
        const waitTime = Math.min(backoff, remaining);
        console.warn(
          `[events] RabbitMQ broker connection attempt ${attempt} failed (${err.message}), retrying in ${waitTime}ms (elapsed: ${elapsed}ms, limit: ${startupTimeoutMs}ms)...`
        );
        await new Promise((r) => setTimeout(r, waitTime));
      }
    }
  }

  /** Closes the broker client and the Redis client (both best-effort). */
  async close(): Promise<void> {
    if (this.state.mq) {
      await this.state.mq.close().catch(() => {});
    }
    if (this.state.redis) {
      await this.state.redis.quit().catch(() => {});
    }
  }
}
