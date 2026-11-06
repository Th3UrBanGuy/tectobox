import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { TenantGuard } from './tenant.guard.js';

describe('TenantGuard', () => {
  let guard: TenantGuard;
  let mockPool: any;

  beforeEach(() => {
    // Mock pg pool: the auto-heal path INSERTs a workspace and returns its id.
    mockPool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO clients')) {
          return { rows: [{ id: 77 }] };
        }
        return { rows: [] };
      }),
    };
    guard = new TenantGuard(mockPool);
  });

  const createMockContext = (user?: any, headers: Record<string, string> = {}): ExecutionContext => {
    const request: any = {
      user,
      headers,
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  };

  it('throws UnauthorizedException when user and bearer token header are not present', () => {
    const ctx = createMockContext(undefined, {});
    // canActivate throws synchronously here (no user, no auth header, no session cookie)
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('allows client with valid clientId and assigns request.tenantId', async () => {
    const ctx = createMockContext({
      id: 1,
      username: 'client_user',
      role: 'client',
      clientId: 42,
    });
    const req = ctx.switchToHttp().getRequest();

    const allowed = await guard.canActivate(ctx);
    expect(allowed).toBe(true);
    expect(req.tenantId).toBe(42);
  });

  it('does NOT allow client to override tenant via x-tenant-id header', async () => {
    const ctx = createMockContext(
      {
        id: 1,
        username: 'client_user',
        role: 'client',
        clientId: 42,
      },
      { 'x-tenant-id': '999' }
    );
    const req = ctx.switchToHttp().getRequest();

    const allowed = await guard.canActivate(ctx);
    expect(allowed).toBe(true);
    // MUST remain 42, not 999
    expect(req.tenantId).toBe(42);
  });

  it('auto-heals a client user with no clientId by creating a workspace', async () => {
    const user: any = {
      id: 2,
      username: 'orphan_user',
      role: 'client',
      clientId: null,
    };
    const ctx = createMockContext(user);
    const req = ctx.switchToHttp().getRequest();

    const allowed = await guard.canActivate(ctx);
    expect(allowed).toBe(true);
    expect(req.tenantId).toBe(77);
    expect(user.clientId).toBe(77);
    expect(mockPool.query).toHaveBeenCalled();
  });

  it('throws ForbiddenException when client user has no clientId and no pool is available', async () => {
    const noPoolGuard = new TenantGuard();
    const ctx = createMockContext({
      id: 2,
      username: 'orphan_user',
      role: 'client',
      clientId: null,
    });
    // assignTenant is async, so the ForbiddenException surfaces as a rejected promise
    await expect(noPoolGuard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('allows admin and assigns request.tenantId from x-tenant-id header override', async () => {
    const ctx = createMockContext(
      {
        id: 99,
        username: 'admin_user',
        role: 'admin',
        clientId: null,
      },
      { 'x-tenant-id': '108' }
    );
    const req = ctx.switchToHttp().getRequest();

    const allowed = await guard.canActivate(ctx);
    expect(allowed).toBe(true);
    expect(req.tenantId).toBe(108);
  });

  it('allows admin and sets request.tenantId to null if x-tenant-id header is absent', async () => {
    const ctx = createMockContext({
      id: 99,
      username: 'admin_user',
      role: 'admin',
      clientId: null,
    });
    const req = ctx.switchToHttp().getRequest();

    const allowed = await guard.canActivate(ctx);
    expect(allowed).toBe(true);
    expect(req.tenantId).toBeNull();
  });
});
