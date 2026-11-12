import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForbiddenException, Controller, Get, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RequireFeature } from './feature.guard.js';
import { LicensingModule } from './licensing.module.js';
import { DB_POOL } from '../database/database.module.js';
import { DatabaseModule } from '../database/database.module.js';

// RequireFeature is a mixin guard factory. Two things must hold:
//  (a) the guard logic itself (deny/allow/admin-bypass/fail-closed), and
//  (b) the mixin DI wiring — Nest must actually inject LicensingService
//      into the mixin class, or every guarded write would 403. (a) is
//      tested by direct instantiation; (b) by a real Nest test app below.

function mockContext(opts: { role?: string; tenantId?: number; access?: any }) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        user: opts.role ? { role: opts.role } : undefined,
        tenantId: opts.tenantId,
        access: opts.access,
      }),
    }),
  } as any;
}

describe('RequireFeature — unit (guard logic)', () => {
  const Guard = RequireFeature('knowledge');

  it('admin bypasses without touching the licence service', async () => {
    const licensing = { resolveAccess: vi.fn() };
    const guard = new Guard(licensing as any);

    expect(await guard.canActivate(mockContext({ role: 'admin', tenantId: 42 }))).toBe(true);
    expect(licensing.resolveAccess).not.toHaveBeenCalled();
  });

  it('superadmin bypasses too', async () => {
    const guard = new Guard({ resolveAccess: vi.fn() } as any);
    expect(await guard.canActivate(mockContext({ role: 'superadmin', tenantId: 42 }))).toBe(true);
  });

  it('allows a tenant whose licence includes the feature', async () => {
    const licensing = {
      resolveAccess: vi.fn().mockResolvedValue({ features: ['webchat', 'knowledge'] }),
    };
    const guard = new Guard(licensing as any);

    expect(await guard.canActivate(mockContext({ role: 'client', tenantId: 42 }))).toBe(true);
    expect(licensing.resolveAccess).toHaveBeenCalledWith(42);
  });

  it('denies (403) a tenant whose licence lacks the feature', async () => {
    const licensing = {
      resolveAccess: vi.fn().mockResolvedValue({ features: ['webchat'] }),
    };
    const guard = new Guard(licensing as any);

    await expect(
      guard.canActivate(mockContext({ role: 'client', tenantId: 42 }))
    ).rejects.toThrow(ForbiddenException);
  });

  it('denies a tenant with no licence at all (mode none)', async () => {
    const licensing = {
      resolveAccess: vi.fn().mockResolvedValue({ features: [] }),
    };
    const guard = new Guard(licensing as any);

    await expect(
      guard.canActivate(mockContext({ role: 'client', tenantId: 42 }))
    ).rejects.toThrow(ForbiddenException);
  });

  it('denies when there is no tenant on the request', async () => {
    const guard = new Guard({ resolveAccess: vi.fn() } as any);

    await expect(
      guard.canActivate(mockContext({ role: 'client' }))
    ).rejects.toThrow(ForbiddenException);
  });

  it('fail-closed: no licensing service and no request.access → 403', async () => {
    const guard = new Guard(undefined as any);

    await expect(
      guard.canActivate(mockContext({ role: 'client', tenantId: 42 }))
    ).rejects.toThrow(ForbiddenException);
  });

  it('honours interceptor-populated request.access without a service call', async () => {
    const licensing = { resolveAccess: vi.fn() };
    const guard = new Guard(licensing as any);

    const ok = await guard.canActivate(
      mockContext({ role: 'client', tenantId: 42, access: { features: ['knowledge'] } })
    );

    expect(ok).toBe(true);
    expect(licensing.resolveAccess).not.toHaveBeenCalled();
  });
});

describe('RequireFeature — Nest integration (mixin DI wiring)', () => {
  @Controller('test-guard')
  class TestController {
    @Get('knowledge')
    @UseGuards(RequireFeature('knowledge'))
    knowledge() {
      return { ok: true };
    }

    @Get('open')
    open() {
      return { ok: true };
    }
  }

  let app: any;
  let url: string;
  // Scenario knobs, set per test before the request.
  let currentRole = 'client';
  let currentTenantId = 42;
  let licensedFeatures: string[] = ['webchat'];

  beforeEach(async () => {
    const mockPool = {
      // end() so DatabaseModule.onModuleDestroy does not warn on teardown.
      end: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM clients')) {
          return { rows: [{ id: currentTenantId, suspended: false, ai_paused: false }] };
        }
        if (sql.includes('FROM licenses')) {
          return {
            rows: [{
              id: 5, code: 'LIC-T', status: 'active', kind: 'time',
              plan_id: null, plan_name: null, billing_period: null,
              starts_at: new Date().toISOString(),
              ends_at: new Date(Date.now() + 86400000).toISOString(),
              credits_total: 0, credits_used: 0,
              features_json: JSON.stringify(licensedFeatures),
              validity_days: 30,
            }],
          };
        }
        return { rows: [] };
      }),
    };

    const moduleRef = await Test.createTestingModule({
      // DatabaseModule is @Global and provides DB_POOL in the real app;
      // import it so the override below has a provider to replace (a
      // root-level provider alone is NOT visible inside LicensingModule).
      // Its factory only constructs a lazy pg.Pool — it never connects,
      // and the override means the factory never runs at all.
      imports: [DatabaseModule, LicensingModule],
      controllers: [TestController],
    })
      .overrideProvider(DB_POOL)
      .useValue(mockPool)
      .compile();

    app = moduleRef.createNestApplication();
    // Stand-in for TenantGuard: stamp the tenant + user the guard reads.
    app.use((req: any, _res: any, next: any) => {
      req.tenantId = currentTenantId;
      req.user = { role: currentRole, username: 'tester' };
      next();
    });
    await app.init();
    await app.listen(0);
    url = await app.getUrl();
  });

  afterEach(async () => {
    if (app) await app.close();
    currentRole = 'client';
    currentTenantId = 42;
    licensedFeatures = ['webchat'];
  });

  it('returns 403 when the licence lacks the feature (guard + DI wired)', async () => {
    licensedFeatures = ['webchat'];
    const res = await fetch(`${url}/test-guard/knowledge`);
    expect(res.status).toBe(403);
  });

  it('returns 200 when the licence includes the feature', async () => {
    licensedFeatures = ['webchat', 'knowledge'];
    const res = await fetch(`${url}/test-guard/knowledge`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('admin bypasses the gate even without the feature', async () => {
    licensedFeatures = ['webchat'];
    currentRole = 'admin';
    const res = await fetch(`${url}/test-guard/knowledge`);
    expect(res.status).toBe(200);
  });

  it('an ungated route stays open', async () => {
    const res = await fetch(`${url}/test-guard/open`);
    expect(res.status).toBe(200);
  });
});
