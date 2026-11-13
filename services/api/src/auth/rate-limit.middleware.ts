import type { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';

export interface RateLimitOptions {
  redis?: Redis | any;
  limit?: number; // default 300
  windowSec?: number; // default 60
}

export function getClientIp(req: Request | any): string {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (forwarded) {
    const first = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : Array.isArray(forwarded) ? forwarded[0].trim() : '';
    if (first) return first;
  }
  return req.socket?.remoteAddress || req.ip || '127.0.0.1';
}

export function createRateLimitMiddleware(options?: RateLimitOptions) {
  const limit = options?.limit ?? 300;
  const windowSec = options?.windowSec ?? 60;

  let redis: Redis | any = options?.redis;

  if (redis === undefined) {
    try {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      redis = new Redis(redisUrl, {
        retryStrategy: (times: number) => Math.min(times * 1000, 10000),
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: true,
      });
      redis.on('error', (err: any) => {
        // Log gracefully without crashing
      });
    } catch {
      redis = null;
    }
  }

  // In-memory buckets for fallback and dual-tracking brute force
  const inMemoryIpBuckets = new Map<
    string,
    { count: number; windowStart: number; failedAuth: number; blockedUntil?: number }
  >();

  return async (req: Request | any, res: Response | any, next: NextFunction) => {
    // Only rate-limit /api/ endpoints; exempt static assets, UI routes, and health check
    if (!req.path || !req.path.startsWith('/api/') || req.path === '/api/health') {
      return next();
    }

    const ip = getClientIp(req);
    const now = Date.now();

    let memEntry = inMemoryIpBuckets.get(ip);
    if (!memEntry) {
      memEntry = { count: 0, windowStart: now, failedAuth: 0 };
      inMemoryIpBuckets.set(ip, memEntry);
    }

    // 1. Check brute force block (in-memory or Redis)
    if (memEntry.blockedUntil && now < memEntry.blockedUntil) {
      return res.status(429).json({
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Temporarily blocked due to repeated failed attempts. Please retry later.',
      });
    }

    if (redis && typeof redis.get === 'function') {
      try {
        const isBfBlocked = await redis.get(`bf:blocked:${ip}`);
        if (isBfBlocked) {
          return res.status(429).json({
            statusCode: 429,
            error: 'Too Many Requests',
            message: 'Temporarily blocked due to repeated failed attempts. Please retry later.',
          });
        }
      } catch {
        // Fall back to memory check
      }
    }

    // 2. Check rate limit
    let requestCount = 0;
    let redisSuccess = false;

    if (redis && typeof redis.incr === 'function') {
      try {
        const currentWindow = Math.floor(now / (windowSec * 1000));
        const rateLimitKey = `rl:${ip}:${currentWindow}`;
        requestCount = await redis.incr(rateLimitKey);
        if (requestCount === 1 && typeof redis.expire === 'function') {
          await redis.expire(rateLimitKey, windowSec + 5);
        }
        redisSuccess = true;
      } catch {
        redisSuccess = false;
      }
    }

    if (!redisSuccess) {
      if (now - memEntry.windowStart >= windowSec * 1000) {
        memEntry.count = 0;
        memEntry.windowStart = now;
      }
      memEntry.count++;
      requestCount = memEntry.count;
    }

    if (requestCount > limit) {
      return res.status(429).json({
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. System is operating under load shedding.',
      });
    }

    // 3. Track auth failures for brute force prevention on POST /api/auth/login
    if (req.path === '/api/auth/login' && req.method === 'POST') {
      const origSend = res.send;
      res.send = function (body: any) {
        if (res.statusCode === 401 || res.statusCode === 400) {
          memEntry!.failedAuth++;
          if (memEntry!.failedAuth >= 10) {
            memEntry!.blockedUntil = Date.now() + 15 * 60 * 1000; // 15 min block
          }
          if (redis && typeof redis.incr === 'function') {
            redis.incr(`bf:failed:${ip}`).then((fails: number) => {
              if (fails === 1 && typeof redis.expire === 'function') {
                redis.expire(`bf:failed:${ip}`, 15 * 60).catch(() => {});
              }
              if (fails >= 10 && typeof redis.set === 'function') {
                redis.set(`bf:blocked:${ip}`, '1', 'EX', 15 * 60).catch(() => {});
              }
            }).catch(() => {});
          }
        } else if (res.statusCode === 200) {
          memEntry!.failedAuth = 0;
          memEntry!.blockedUntil = undefined;
          if (redis && typeof redis.del === 'function') {
            redis.del(`bf:failed:${ip}`, `bf:blocked:${ip}`).catch(() => {});
          }
        }
        return origSend.apply(this, arguments as any);
      };
    }

    return next();
  };
}
