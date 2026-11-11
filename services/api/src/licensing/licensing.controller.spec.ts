import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { LicensingController } from './licensing.controller.js';
import { AdminGuard } from '../auth/admin.guard.js';

// NOTE: Nest's GUARDS_METADATA constant ('__guards__') is not re-exported
// from '@nestjs/common', so the literal key is used here.

// C2: admin-only licensing routes must refuse non-admin tenants (403) and
// let admins through. Guards are not executed on direct method calls, so
// the tests below verify (a) the AdminGuard behaviour itself, (b) that the
// guard is actually wired onto every admin route (and NOT onto the
// client-facing routes), and (c) that the handlers succeed for an admin.

const ADMIN_ROUTES = [
  'listPlans',
  'createPlan',
  'updatePlan',
  'deletePlan',
  'listLicenses',
  'issueLicense',
  'pauseLicense',
  'resumeLicense',
  'cancelLicense',
  'topupLicense',
] as const;

const CLIENT_ROUTES = ['getFeatures', 'getClientAccess'] as const;

function mockContext(role: string | undefined) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: role === undefined ? undefined : { role } }),
    }),
  } as any;
}

describe('AdminGuard (licensing)', () => {
  const guard = new AdminGuard();

  it('throws 403 for a non-admin tenant role', () => {
    expect(() => guard.canActivate(mockContext('client'))).toThrow(ForbiddenException);
  });

  it('throws 403 when there is no authenticated user', () => {
    expect(() => guard.canActivate(mockContext(undefined))).toThrow(ForbiddenException);
  });

  it('allows admin and superadmin roles', () => {
    expect(guard.canActivate(mockContext('admin'))).toBe(true);
    expect(guard.canActivate(mockContext('superadmin'))).toBe(true);
  });
});

describe('LicensingController guard wiring (C2)', () => {
  it.each(ADMIN_ROUTES)('%s carries AdminGuard', (method) => {
    const guards = Reflect.getMetadata('__guards__', (LicensingController.prototype as any)[method]) as any[];
    expect(guards).toBeDefined();
    expect(guards).toContain(AdminGuard);
  });

  it.each(CLIENT_ROUTES)('%s does NOT carry AdminGuard', (method) => {
    const guards = Reflect.getMetadata('__guards__', (LicensingController.prototype as any)[method]) as any[];
    expect(guards || []).not.toContain(AdminGuard);
  });
});

describe('LicensingController admin handlers', () => {
  let controller: LicensingController;
  let mockPool: any;

  beforeEach(() => {
    mockPool = { query: vi.fn() };
    controller = new LicensingController(mockPool);
  });

  it('admin creating a plan succeeds (201-style row returned)', async () => {
    const plan = { id: 1, name: 'Pro', kind: 'time', billing_period: 'monthly' };
    mockPool.query.mockResolvedValueOnce({ rows: [plan] });

    const res = await controller.createPlan({ name: 'Pro', kind: 'time' });

    expect(res).toEqual(plan);
    expect(mockPool.query.mock.calls[0][0]).toMatch(/INSERT INTO plans/);
  });

  it('admin issuing a license succeeds', async () => {
    const license = { id: 9, code: 'LIC-TEST', client_id: 42, status: 'active' };
    // issueLicense first cancels the client's existing licenses, then inserts.
    mockPool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [license] });

    const res = await controller.issueLicense({ client_id: 42, days: 30 });

    expect(res).toEqual(license);
    expect(mockPool.query.mock.calls[1][0]).toMatch(/INSERT INTO licenses/);
  });

  it('admin topping up a license succeeds', async () => {
    const license = { id: 9, credits_total: 1500 };
    mockPool.query.mockResolvedValueOnce({ rows: [license] });

    const res = await controller.topupLicense(9, { credits: 500 });

    expect(res).toEqual(license);
    expect(mockPool.query.mock.calls[0][1]).toEqual([500, 9]);
  });

  it('admin listing plans succeeds', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });
    const res = await controller.listPlans();
    expect(res).toHaveLength(2);
  });
});

describe('LicensingController.getClientAccess tenant scoping (C2/C3 rule)', () => {
  let controller: LicensingController;
  let mockPool: any;

  beforeEach(() => {
    // No active license anywhere: first query returns no rows, so the
    // handler falls through to the legacy full-access return.
    mockPool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    controller = new LicensingController(mockPool);
  });

  it('non-admin asking for another workspace id gets their OWN tenant data', async () => {
    await controller.getClientAccess(42, '7', { user: { role: 'client' } });

    const firstCallArgs = mockPool.query.mock.calls[0][1];
    expect(firstCallArgs).toEqual([42]);
  });

  it('admin asking for another workspace id gets that workspace', async () => {
    await controller.getClientAccess(42, '7', { user: { role: 'admin' } });

    const firstCallArgs = mockPool.query.mock.calls[0][1];
    expect(firstCallArgs).toEqual([7]);
  });
});
