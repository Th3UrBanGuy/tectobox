/**
 * Redis Pub/Sub for real-time SSE event fan-out — @tectonic/coordination
 * (Phase 6). Moved verbatim from RedisCoordinator.publishEvent and the
 * RedisSubscriber class; behaviour unchanged.
 */

import { Redis } from 'ioredis';

export type RedisEventHandler = (payload: any) => void;

/**
 * Redis Pub/Sub client for real-time SSE event fan-out
 */
export async function publishEvent(
  redis: Redis,
  channel: string,
  payload: any,
): Promise<number> {
  return redis.publish(channel, JSON.stringify(payload));
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
