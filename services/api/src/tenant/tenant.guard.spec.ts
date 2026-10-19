import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { TenantGuard } from './tenant.guard.js';

describe('TenantGuard', () => {
  let guard: TenantGuard;

  beforeEach(() => {
    guard = new TenantGuard();
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

  it('throws UnauthorizedException when user and bearer auth header are not present', () => {
    const ctx = createMockContext(undefined, {});
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('allows client with valid clientId and assigns request.tenantId', () => {
    const ctx = createMockContext({
      id: 1,
      username: 'client_user',
      role: 'client',
      clientId: 42,
    });
    const req = ctx.switchToHttp().getRequest();

    const allowed = guard.canActivate(ctx);
    expect(allowed).toBe(true);
    expect(req.tenantId).toBe(42);
  });

  it('does NOT allow client to override tenant via x-tenant-id header', () => {
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

    const allowed = guard.canActivate(ctx);
    expect(allowed).toBe(true);
    // MUST remain 42, not 999
    expect(req.tenantId).toBe(42);
  });

  it('throws ForbiddenException when client user has no clientId', () => {
    const ctx = createMockContext({
      id: 2,
      username: 'orphan_user',
      role: 'client',
      clientId: null,
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('allows admin and assigns request.tenantId from x-tenant-id header override', () => {
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

    const allowed = guard.canActivate(ctx);
    expect(allowed).toBe(true);
    expect(req.tenantId).toBe(108);
  });

  it('allows admin and sets request.tenantId to null if x-tenant-id header is absent', () => {
    const ctx = createMockContext({
      id: 99,
      username: 'admin_user',
      role: 'admin',
      clientId: null,
    });
    const req = ctx.switchToHttp().getRequest();

    const allowed = guard.canActivate(ctx);
    expect(allowed).toBe(true);
    expect(req.tenantId).toBeNull();
  });
});
