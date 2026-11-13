import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, NotFoundException, BadRequestException, ConflictException, GoneException } from '@nestjs/common';
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

// activateLicense is tenant-guarded but NOT admin-only (client self-service).
const CLIENT_ROUTES = ['getFeatures', 'getClientAccess', 'activateLicense'] as const;

function mockContext(role: string | undefined) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: role === undefined ? undefined : { role } }),
    }),
  } as any;
}

function mockLicensing(overrides: any = {}) {
  return {
    resolveAccess: vi.fn(),
    audit: vi.fn().mockResolvedValue(undefined),
    issueTrialLicense: vi.fn(),
    ...overrides,
  };
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
  let licensing: any;

  beforeEach(() => {
    mockPool = { query: vi.fn() };
    licensing = mockLicensing();
    controller = new LicensingController(mockPool, licensing);
  });

  it('admin creating a plan succeeds (201-style row returned)', async () => {
    const plan = { id: 1, name: 'Pro', kind: 'time', billing_period: 'monthly' };
    mockPool.query.mockResolvedValueOnce({ rows: [plan] });

    const res = await controller.createPlan({ name: 'Pro', kind: 'time' });

    expect(res).toEqual(plan);
    expect(mockPool.query.mock.calls[0][0]).toMatch(/INSERT INTO plans/);
  });

  it('admin issuing a license (apply) succeeds and cancels the old one', async () => {
    const license = { id: 9, code: 'LIC-TEST', client_id: 42, status: 'active' };
    // issueLicense first cancels the client's existing licenses, then inserts.
    mockPool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [license] });

    const res = await controller.issueLicense({ client_id: 42, days: 30 });

    expect(res).toEqual(license);
    expect(mockPool.query.mock.calls[0][0]).toMatch(/UPDATE licenses SET status = 'cancelled'/);
    expect(mockPool.query.mock.calls[1][0]).toMatch(/INSERT INTO licenses/);
    expect(licensing.audit).toHaveBeenCalledWith(
      'issue', null, 42, 9, expect.stringMatching(/^LIC-/), expect.stringContaining('30 days')
    );
  });

  it('admin issuing a key-only license returns the code and stays pending', async () => {
    const license = { id: 10, code: 'LIC-KEYONLY', client_id: 42, status: 'pending_activation', starts_at: null, ends_at: null };
    mockPool.query.mockResolvedValueOnce({ rows: [license] });

    const res = await controller.issueLicense({ client_id: 42, days: 30, deliver: 'key-only' });

    expect(res.code).toMatch(/^LIC-/);
    expect(res.license.status).toBe('pending_activation');
    // Key-only must NOT cancel the client's current active licence.
    expect(mockPool.query).toHaveBeenCalledTimes(2);
    expect(mockPool.query.mock.calls[0][0]).toMatch(/'pending_activation'/);
    expect(mockPool.query.mock.calls[0][0]).toMatch(/NULL, NULL/); // starts_at/ends_at NULL
    expect(mockPool.query.mock.calls[1][0]).toMatch(/INSERT INTO audit_log/);
    expect(licensing.audit).toHaveBeenCalledWith(
      'key_issue', null, 42, 10, expect.stringMatching(/^LIC-/), expect.stringContaining('30 days')
    );
  });

  it('issueLicense rejects a missing client_id', async () => {
    await expect(controller.issueLicense({ days: 30 })).rejects.toThrow(BadRequestException);
  });

  it('issueLicense rejects an unknown deliver mode', async () => {
    await expect(
      controller.issueLicense({ client_id: 42, deliver: 'smoke-signal' })
    ).rejects.toThrow(BadRequestException);
  });

  it('issueLicense rejects non-positive fractional days', async () => {
    await expect(
      controller.issueLicense({ client_id: 42, days: 0 })
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.issueLicense({ client_id: 42, days: -1 })
    ).rejects.toThrow(BadRequestException);
  });

  it('issueLicense accepts fractional days (30 min = 0.0208)', async () => {
    const license = { id: 11, code: 'LIC-FRAC', client_id: 42, status: 'active' };
    mockPool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [license] });

    const res = await controller.issueLicense({ client_id: 42, days: 0.0208 });

    expect(res).toEqual(license);
    // validity_days is the fractional value, passed through to the INSERT.
    const insertParams = mockPool.query.mock.calls[1][1];
    expect(insertParams).toContain(0.0208);
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

describe('LicensingController.getClientAccess — delegation, no auto-provision (§E)', () => {
  let controller: LicensingController;
  let mockPool: any;
  let licensing: any;

  const accessPayload = {
    mode: 'licensed',
    features: ['combined_inbox', 'ai_response', 'webchat'],
    aiAllowed: true,
    aiReason: null,
    license: {
      id: 5, code: 'LIC-ABC', status: 'active', kind: 'time',
      plan_id: null, plan_name: null, billing_period: null,
      starts_at: '2026-11-12T00:00:00.000Z', ends_at: '2026-12-12T00:00:00.000Z',
      credits_total: 0, credits_used: 0, validity_days: 30,
      features: ['combined_inbox', 'ai_response', 'webchat'],
    },
    suspended: false,
    aiPaused: false,
  };

  beforeEach(() => {
    mockPool = { query: vi.fn() };
    licensing = mockLicensing({
      resolveAccess: vi.fn().mockResolvedValue(accessPayload),
    });
    controller = new LicensingController(mockPool, licensing);
  });

  it('delegates to LicensingService and returns the shaped access payload', async () => {
    const res = await controller.getClientAccess(42, undefined, { user: { role: 'client' } });

    expect(licensing.resolveAccess).toHaveBeenCalledWith(42);
    expect(res.active).toBe(true);
    expect(res.mode).toBe('licensed');
    expect(res.features).toEqual(['combined_inbox', 'ai_response', 'webchat']);
    expect(res.aiAllowed).toBe(true);
    expect(res.licenseId).toBe(5);
    expect(res.code).toBe('LIC-ABC');
    // No licence is ever created by a read: the pool sees no INSERT.
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('no-license workspace returns mode none (never auto-provisioned)', async () => {
    licensing.resolveAccess.mockResolvedValueOnce({
      mode: 'none', features: [], aiAllowed: false, aiReason: 'no_active_license',
      license: null, suspended: false, aiPaused: false,
    });

    const res = await controller.getClientAccess(42, undefined, { user: { role: 'client' } });

    expect(res.active).toBe(false);
    expect(res.mode).toBe('none');
    expect(res.features).toEqual([]);
    expect(res.aiReason).toBe('no_active_license');
    expect(res.license).toBeNull();
  });

  it('non-admin asking for another workspace id gets their OWN tenant data', async () => {
    await controller.getClientAccess(42, '7', { user: { role: 'client' } });

    expect(licensing.resolveAccess).toHaveBeenCalledWith(42);
  });

  it('admin asking for another workspace id gets that workspace', async () => {
    await controller.getClientAccess(42, '7', { user: { role: 'admin' } });

    expect(licensing.resolveAccess).toHaveBeenCalledWith(7);
  });

  it('no tenant at all returns mode none without touching the service', async () => {
    const res = await controller.getClientAccess(undefined as any, undefined, { user: { role: 'client' } });

    expect(res.mode).toBe('none');
    expect(res.aiReason).toBe('no_active_license');
    expect(licensing.resolveAccess).not.toHaveBeenCalled();
  });
});

describe('LicensingController.activateLicense — client self-service (§E)', () => {
  let controller: LicensingController;
  let mockPool: any;
  let licensing: any;
  let fakeClient: any;

  const pendingRow = {
    id: 20, code: 'LIC-ACTIVATE', client_id: 42, status: 'pending_activation',
    kind: 'time', billing_period: null, validity_days: 30,
    created_at: new Date().toISOString(),
  };

  beforeEach(() => {
    mockPool = { query: vi.fn(), connect: vi.fn() };
    licensing = mockLicensing({
      resolveAccess: vi.fn().mockResolvedValue({
        mode: 'licensed', features: ['combined_inbox', 'ai_response', 'webchat'],
        aiAllowed: true, aiReason: null,
        license: {
          id: 20, code: 'LIC-ACTIVATE', status: 'active', kind: 'time',
          plan_id: null, plan_name: null, billing_period: null,
          starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
          credits_total: 0, credits_used: 0, validity_days: 30,
          features: ['combined_inbox', 'ai_response', 'webchat'],
        },
        suspended: false, aiPaused: false,
      }),
    });
    fakeClient = { query: vi.fn(), release: vi.fn() };
    mockPool.connect.mockResolvedValue(fakeClient);
    controller = new LicensingController(mockPool, licensing);
  });

  function mockLookup(row: any | null) {
    mockPool.query.mockResolvedValueOnce({ rows: row ? [row] : [] });
  }

  it('unknown code returns 404', async () => {
    mockLookup(null);
    await expect(controller.activateLicense(42, { code: 'LIC-NOPE' })).rejects.toThrow(NotFoundException);
  });

  it('a code belonging to another workspace returns 404 (no enumeration)', async () => {
    mockLookup({ ...pendingRow, client_id: 99 });
    await expect(controller.activateLicense(42, { code: 'LIC-ACTIVATE' })).rejects.toThrow(NotFoundException);
    // The foreign code is never touched: no UPDATE ran.
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('an already-active code returns 409', async () => {
    mockLookup({ ...pendingRow, status: 'active' });
    await expect(controller.activateLicense(42, { code: 'LIC-ACTIVATE' })).rejects.toThrow(ConflictException);
  });

  it('a key older than 30 days is cancelled and returns 410 Gone', async () => {
    const stale = {
      ...pendingRow,
      created_at: new Date(Date.now() - 40 * 86400000).toISOString(),
    };
    mockLookup(stale);
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // the cancel UPDATE

    await expect(controller.activateLicense(42, { code: 'LIC-ACTIVATE' })).rejects.toThrow(GoneException);
    const cancelCall = mockPool.query.mock.calls[1];
    expect(cancelCall[0]).toMatch(/SET status = 'cancelled'/);
    expect(cancelCall[1]).toEqual([20]);
  });

  it('success cancels the old licence, activates this one, returns fresh access', async () => {
    mockLookup(pendingRow);
    const activatedRow = { ...pendingRow, status: 'active', starts_at: new Date().toISOString() };
    fakeClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SET status = 'active'")) return { rows: [activatedRow] };
      return { rows: [] };
    });

    const res = await controller.activateLicense(42, { code: 'lic-activate' });

    // Code lookup is case-insensitive (upper-cased before the query).
    expect(mockPool.query.mock.calls[0][1]).toEqual(['LIC-ACTIVATE']);
    // Transaction: BEGIN, cancel old active, activate, COMMIT.
    const txSql = fakeClient.query.mock.calls.map((c: any[]) => c[0]);
    expect(txSql[0]).toBe('BEGIN');
    expect(txSql[1]).toMatch(/SET status = 'cancelled'/);
    expect(txSql[2]).toMatch(/SET status = 'active'/);
    expect(txSql[2]).toMatch(/validity_days|INTERVAL '1 day'/);
    expect(txSql[3]).toBe('COMMIT');
    expect(fakeClient.release).toHaveBeenCalled();
    // Fresh access payload: the UI unlocks without a reload.
    expect(res.mode).toBe('licensed');
    expect(res.active).toBe(true);
    expect(res.license?.code).toBe('LIC-ACTIVATE');
    expect(licensing.audit).toHaveBeenCalledWith(
      'activate', null, 42, 20, 'LIC-ACTIVATE', expect.stringContaining('30 days')
    );
  });

  it('a lost activation race rolls back and returns 409', async () => {
    mockLookup(pendingRow);
    fakeClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SET status = 'active'")) return { rows: [] }; // already taken
      return { rows: [] };
    });

    await expect(controller.activateLicense(42, { code: 'LIC-ACTIVATE' })).rejects.toThrow(ConflictException);
    const txSql = fakeClient.query.mock.calls.map((c: any[]) => c[0]);
    expect(txSql).toContain('ROLLBACK');
    expect(fakeClient.release).toHaveBeenCalled();
  });

  it('missing code returns 400', async () => {
    await expect(controller.activateLicense(42, {})).rejects.toThrow(BadRequestException);
  });
});
