import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRateLimitMiddleware } from './rate-limit.middleware.js';

describe('Rate limit and brute force middleware', () => {
  let mockRedis: any;
  let redisStore: Map<string, string>;

  beforeEach(() => {
    redisStore = new Map<string, string>();
    mockRedis = {
      incr: vi.fn(async (key: string) => {
        const val = (parseInt(redisStore.get(key) || '0', 10) + 1).toString();
        redisStore.set(key, val);
        return parseInt(val, 10);
      }),
      expire: vi.fn(async () => 1),
      get: vi.fn(async (key: string) => redisStore.get(key) || null),
      set: vi.fn(async (key: string, val: string) => {
        redisStore.set(key, val);
        return 'OK';
      }),
      del: vi.fn(async (...keys: string[]) => {
        keys.forEach((k) => redisStore.delete(k));
        return 1;
      }),
    };
  });

  const createMockReqRes = (path = '/api/data', ip = '192.168.1.50', method = 'GET') => {
    const req: any = {
      path,
      method,
      headers: { 'x-forwarded-for': ip },
      socket: { remoteAddress: ip },
    };
    let responseStatus: number | null = null;
    let responseBody: any = null;
    const res: any = {
      statusCode: 200,
      status: vi.fn(function (code: number) {
        responseStatus = code;
        res.statusCode = code;
        return res;
      }),
      json: vi.fn(function (body: any) {
        responseBody = body;
        return res;
      }),
      send: vi.fn(function (body: any) {
        responseBody = body;
        return res;
      }),
    };
    const next = vi.fn();
    return { req, res, next, getStatus: () => responseStatus, getBody: () => responseBody };
  };

  it('allows requests 1 through 300 and returns 429 on the 301st request', async () => {
    const middleware = createRateLimitMiddleware({ redis: mockRedis, limit: 300, windowSec: 60 });

    // Requests 1 to 300 should pass
    for (let i = 1; i <= 300; i++) {
      const { req, res, next } = createMockReqRes('/api/items', '10.0.0.1');
      await middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    }

    // 301st request should get 429 Too Many Requests
    const { req, res, next, getStatus, getBody } = createMockReqRes('/api/items', '10.0.0.1');
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(429);
    expect(getBody()).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. System is operating under load shedding.',
    });
  });

  it('exempts /api/health and non-api routes from rate limiting', async () => {
    const middleware = createRateLimitMiddleware({ redis: mockRedis, limit: 1 });

    // Health check
    const health = createMockReqRes('/api/health');
    await middleware(health.req, health.res, health.next);
    expect(health.next).toHaveBeenCalledTimes(1);

    // Static / web route
    const staticRoute = createMockReqRes('/app');
    await middleware(staticRoute.req, staticRoute.res, staticRoute.next);
    expect(staticRoute.next).toHaveBeenCalledTimes(1);

    expect(mockRedis.incr).not.toHaveBeenCalled();
  });

  it('triggers login brute-force guard after 10 failed login attempts', async () => {
    const middleware = createRateLimitMiddleware({ redis: mockRedis, limit: 300 });

    // 10 failed login attempts
    for (let i = 1; i <= 10; i++) {
      const { req, res, next } = createMockReqRes('/api/auth/login', '192.168.1.99', 'POST');
      await middleware(req, res, next);
      expect(next).toHaveBeenCalled();

      // Simulate auth failure
      res.statusCode = 401;
      res.send({ error: 'Unauthorized' });
    }

    // 11th request from this IP should be blocked by the brute-force guard
    const blocked = createMockReqRes('/api/auth/login', '192.168.1.99', 'POST');
    await middleware(blocked.req, blocked.res, blocked.next);

    expect(blocked.next).not.toHaveBeenCalled();
    expect(blocked.getStatus()).toBe(429);
    expect(blocked.getBody()).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Temporarily blocked due to repeated failed attempts. Please retry later.',
    });
  });

  it('resets brute force failure counter on successful login', async () => {
    const middleware = createRateLimitMiddleware({ redis: mockRedis, limit: 300 });

    // 5 failed logins
    for (let i = 1; i <= 5; i++) {
      const { req, res, next } = createMockReqRes('/api/auth/login', '192.168.1.105', 'POST');
      await middleware(req, res, next);
      res.statusCode = 401;
      res.send({ error: 'Unauthorized' });
    }

    // 1 successful login
    const successLogin = createMockReqRes('/api/auth/login', '192.168.1.105', 'POST');
    await middleware(successLogin.req, successLogin.res, successLogin.next);
    successLogin.res.statusCode = 200;
    successLogin.res.send({ ok: true });

    // 5 more failed logins (total 10 non-consecutive, but counter was reset)
    for (let i = 1; i <= 5; i++) {
      const { req, res, next } = createMockReqRes('/api/auth/login', '192.168.1.105', 'POST');
      await middleware(req, res, next);
      res.statusCode = 401;
      res.send({ error: 'Unauthorized' });
    }

    // Request should still pass since counter was reset
    const nextReq = createMockReqRes('/api/auth/login', '192.168.1.105', 'POST');
    await middleware(nextReq.req, nextReq.res, nextReq.next);
    expect(nextReq.next).toHaveBeenCalled();
  });

  it('falls back to in-memory rate limiting if Redis client is not available or throws', async () => {
    const failingRedis = {
      incr: vi.fn().mockRejectedValue(new Error('Redis connection lost')),
      get: vi.fn().mockRejectedValue(new Error('Redis connection lost')),
    };

    const middleware = createRateLimitMiddleware({ redis: failingRedis, limit: 3, windowSec: 60 });

    for (let i = 1; i <= 3; i++) {
      const { req, res, next } = createMockReqRes('/api/items', '172.16.0.1');
      await middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    }

    // 4th request exceeds limit in memory
    const { req, res, next, getStatus } = createMockReqRes('/api/items', '172.16.0.1');
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(getStatus()).toBe(429);
  });
});
