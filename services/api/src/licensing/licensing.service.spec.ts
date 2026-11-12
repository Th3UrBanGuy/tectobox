import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LicensingService, SYSTEM_FEATURE_KEYS } from './licensing.service.js';

// Mock pool: routes each query by SQL substring. First matching route wins;
// unmatched queries return empty rows. Lets each test declare exactly the
// rows its code path reads, and assert on the SQL that was issued.
type Route = [string, any];
function mockPoolWith(routes: Route[]) {
  const calls: any[] = [];
  const query = vi.fn(async (sql: string, params?: any[]) => {
    calls.push([sql, params]);
    for (const [needle, result] of routes) {
      if (sql.includes(needle)) {
        return typeof result === 'function' ? result(sql, params) : result;
      }
    }
    return { rows: [] };
  });
  return { query, calls };
}

const ALL_FEATURES = [...SYSTEM_FEATURE_KEYS];

function clientRow(overrides: any = {}) {
  return { id: 42, suspended: false, ai_paused: false, ...overrides };
}

function licenseRow(overrides: any = {}) {
  return {
    id: 5,
    code: 'LIC-TEST',
    status: 'active',
    kind: 'time',
    plan_id: null,
    plan_name: null,
    billing_period: null,
    starts_at: new Date(Date.now() - 86400000).toISOString(),
    ends_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    credits_total: 0,
    credits_used: 0,
    features_json: JSON.stringify(ALL_FEATURES),
    validity_days: 30,
    ...overrides,
  };
}

describe('LicensingService.parseFeatures (fail-closed)', () => {
  let svc: LicensingService;
  beforeEach(() => {
    svc = new LicensingService({ query: vi.fn() } as any);
  });

  it('NULL features_json parses to []', () => {
    expect(svc.parseFeatures(null)).toEqual([]);
    expect(svc.parseFeatures(undefined)).toEqual([]);
  });

  it('invalid JSON parses to []', () => {
    expect(svc.parseFeatures('{not json')).toEqual([]);
  });

  it('a JSON string parses to its array', () => {
    expect(svc.parseFeatures('["webchat","knowledge"]')).toEqual(['webchat', 'knowledge']);
  });

  it('a non-array value parses to []', () => {
    expect(svc.parseFeatures({ webchat: true })).toEqual([]);
    expect(svc.parseFeatures('webchat')).toEqual([]);
  });

  it('non-string entries are dropped', () => {
    expect(svc.parseFeatures(['webchat', 7, null])).toEqual(['webchat']);
  });
});

describe('LicensingService.resolveAccess (§E)', () => {
  it('no client row → mode none, no_active_license', async () => {
    const pool = mockPoolWith([]);
    const svc = new LicensingService(pool as any);

    const res = await svc.resolveAccess(42);

    expect(res.mode).toBe('none');
    expect(res.features).toEqual([]);
    expect(res.aiAllowed).toBe(false);
    expect(res.aiReason).toBe('no_active_license');
    expect(res.license).toBeNull();
  });

  it('suspended workspace → mode suspended, no licence lookup', async () => {
    const pool = mockPoolWith([
      ['FROM clients', { rows: [clientRow({ suspended: true })] }],
    ]);
    const svc = new LicensingService(pool as any);

    const res = await svc.resolveAccess(42);

    expect(res.mode).toBe('suspended');
    expect(res.aiReason).toBe('workspace_suspended');
    expect(res.suspended).toBe(true);
    expect(res.features).toEqual([]);
    // The licence table is never consulted for a suspended workspace.
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('no active licence → mode none (never auto-provisioned)', async () => {
    const pool = mockPoolWith([
      ['FROM clients', { rows: [clientRow()] }],
      ['FROM licenses', { rows: [] }],
    ]);
    const svc = new LicensingService(pool as any);

    const res = await svc.resolveAccess(42);

    expect(res.mode).toBe('none');
    expect(res.aiReason).toBe('no_active_license');
    expect(res.features).toEqual([]);
    // No INSERT anywhere: resolution never creates a licence.
    expect(pool.calls.every(([sql]: any[]) => !/INSERT INTO licenses/.test(sql))).toBe(true);
  });

  it('valid time licence → mode licensed, all features, AI allowed', async () => {
    const pool = mockPoolWith([
      ['FROM clients', { rows: [clientRow()] }],
      ['FROM licenses', { rows: [licenseRow()] }],
    ]);
    const svc = new LicensingService(pool as any);

    const res = await svc.resolveAccess(42);

    expect(res.mode).toBe('licensed');
    expect(res.features).toEqual(ALL_FEATURES);
    expect(res.aiAllowed).toBe(true);
    expect(res.aiReason).toBeNull();
    expect(res.license?.code).toBe('LIC-TEST');
  });

  it('expired time licence → row flipped to expired inline, mode none', async () => {
    const pool = mockPoolWith([
      ['FROM clients', { rows: [clientRow()] }],
      ['FROM licenses', { rows: [licenseRow({ ends_at: new Date(Date.now() - 1000).toISOString() })] }],
      ["SET status = 'expired'", { rows: [] }],
    ]);
    const svc = new LicensingService(pool as any);

    const res = await svc.resolveAccess(42);

    expect(res.mode).toBe('none');
    expect(res.aiReason).toBe('license_expired');
    expect(res.license?.status).toBe('expired');
    expect(pool.calls.some(([sql]: any[]) => /SET status = 'expired'/.test(sql))).toBe(true);
  });

  it('licence without ai_response → aiAllowed false, feature_not_in_plan', async () => {
    const pool = mockPoolWith([
      ['FROM clients', { rows: [clientRow()] }],
      ['FROM licenses', { rows: [licenseRow({ features_json: JSON.stringify(['webchat', 'knowledge']) })] }],
    ]);
    const svc = new LicensingService(pool as any);

    const res = await svc.resolveAccess(42);

    expect(res.mode).toBe('licensed');
    expect(res.features).toEqual(['webchat', 'knowledge']);
    expect(res.aiAllowed).toBe(false);
    expect(res.aiReason).toBe('feature_not_in_plan');
  });

  it('ai_paused client → aiAllowed false, reason paused (features still listed)', async () => {
    const pool = mockPoolWith([
      ['FROM clients', { rows: [clientRow({ ai_paused: true })] }],
      ['FROM licenses', { rows: [licenseRow()] }],
    ]);
    const svc = new LicensingService(pool as any);

    const res = await svc.resolveAccess(42);

    expect(res.aiAllowed).toBe(false);
    expect(res.aiReason).toBe('paused');
    expect(res.features).toEqual(ALL_FEATURES);
  });

  it('exhausted credit licence → mode licensed, features listed, AI denied', async () => {
    const pool = mockPoolWith([
      ['FROM clients', { rows: [clientRow()] }],
      ['FROM licenses', { rows: [licenseRow({ kind: 'credit', credits_total: 100, credits_used: 100 })] }],
    ]);
    const svc = new LicensingService(pool as any);

    const res = await svc.resolveAccess(42);

    expect(res.mode).toBe('licensed');
    expect(res.features).toEqual(ALL_FEATURES);
    expect(res.aiAllowed).toBe(false);
    expect(res.aiReason).toBe('credits_exhausted');
  });

  it('credit licence with credit left → AI allowed', async () => {
    const pool = mockPoolWith([
      ['FROM clients', { rows: [clientRow()] }],
      ['FROM licenses', { rows: [licenseRow({ kind: 'credit', credits_total: 100, credits_used: 99 })] }],
    ]);
    const svc = new LicensingService(pool as any);

    const res = await svc.resolveAccess(42);

    expect(res.aiAllowed).toBe(true);
    expect(res.aiReason).toBeNull();
  });

  it('feature-kind licence → only granted features, per-feature AI', async () => {
    const pool = mockPoolWith([
      ['FROM clients', { rows: [clientRow()] }],
      ['FROM licenses', { rows: [licenseRow({ kind: 'feature', features_json: null })] }],
      ['FROM license_feature_credits', { rows: [
        { feature: 'webchat', mode: 'unlimited', credits_total: 0, credits_used: 0 },
        { feature: 'ai_response', mode: 'credit', credits_total: 10, credits_used: 10 },
      ] }],
    ]);
    const svc = new LicensingService(pool as any);

    const res = await svc.resolveAccess(42);

    expect(res.mode).toBe('licensed');
    expect(res.features).toEqual(['webchat']);
    expect(res.aiAllowed).toBe(false);
    expect(res.aiReason).toBe('ai_not_granted');
  });
});

describe('LicensingService.consumeAiCredit — atomicity (§E)', () => {
  it('no licence → false', async () => {
    const pool = mockPoolWith([
      ['FROM licenses', { rows: [] }],
    ]);
    const svc = new LicensingService(pool as any);

    expect(await svc.consumeAiCredit(42)).toBe(false);
  });

  it('time licence → true without touching credits', async () => {
    const pool = mockPoolWith([
      ['FROM licenses', { rows: [licenseRow({ kind: 'time' })] }],
    ]);
    const svc = new LicensingService(pool as any);

    expect(await svc.consumeAiCredit(42)).toBe(true);
    expect(pool.calls.every(([sql]: any[]) => !/UPDATE/.test(sql))).toBe(true);
  });

  it('credit licence → single guarded UPDATE; rowCount decides', async () => {
    const pool = mockPoolWith([
      ['FROM licenses', { rows: [licenseRow({ kind: 'credit', credits_total: 10, credits_used: 9 })] }],
      ['UPDATE licenses SET credits_used', { rowCount: 1 }],
    ]);
    const svc = new LicensingService(pool as any);

    expect(await svc.consumeAiCredit(42)).toBe(true);
    const update = pool.calls.find(([sql]: any[]) => sql.includes('UPDATE licenses'));
    // The atomicity guard: two concurrent replies cannot both take the
    // last credit because the UPDATE itself checks credits_used < total.
    expect(update[0]).toMatch(/credits_used < credits_total/);
  });

  it('credit licence with the last credit already taken → false', async () => {
    const pool = mockPoolWith([
      ['FROM licenses', { rows: [licenseRow({ kind: 'credit', credits_total: 10, credits_used: 10 })] }],
      ['UPDATE licenses SET credits_used', { rowCount: 0 }],
    ]);
    const svc = new LicensingService(pool as any);

    expect(await svc.consumeAiCredit(42)).toBe(false);
  });

  it('feature-kind unlimited ai_response → true', async () => {
    const pool = mockPoolWith([
      ['FROM licenses', { rows: [licenseRow({ kind: 'feature' })] }],
      ['FROM license_feature_credits', { rows: [{ mode: 'unlimited', credits_total: 0, credits_used: 0 }] }],
    ]);
    const svc = new LicensingService(pool as any);

    expect(await svc.consumeAiCredit(42)).toBe(true);
  });

  it('feature-kind ai_response with no grant → false', async () => {
    const pool = mockPoolWith([
      ['FROM licenses', { rows: [licenseRow({ kind: 'feature' })] }],
      ['FROM license_feature_credits', { rows: [] }],
    ]);
    const svc = new LicensingService(pool as any);

    expect(await svc.consumeAiCredit(42)).toBe(false);
  });

  it('feature-kind credit ai_response, last credit taken → false', async () => {
    const pool = mockPoolWith([
      ['FROM licenses', { rows: [licenseRow({ kind: 'feature' })] }],
      ['FROM license_feature_credits', { rows: [{ mode: 'credit', credits_total: 5, credits_used: 5 }] }],
      ['UPDATE license_feature_credits', { rowCount: 0 }],
    ]);
    const svc = new LicensingService(pool as any);

    expect(await svc.consumeAiCredit(42)).toBe(false);
  });
});

describe('LicensingService.issueTrialLicense', () => {
  it('issues a short time licence with all 7 features and cancels the old one', async () => {
    const pool = mockPoolWith([
      ["SET status = 'cancelled'", { rows: [] }],
      ['INSERT INTO licenses', { rows: [{ id: 30, code: 'LIC-TRIAL', status: 'active' }] }],
      ['INSERT INTO license_audit', { rows: [] }],
    ]);
    const svc = new LicensingService(pool as any);

    const row = await svc.issueTrialLicense(42, 60, 'mrash');

    expect(row.code).toBe('LIC-TRIAL');
    const insert = pool.calls.find(([sql]: any[]) => sql.includes('INSERT INTO licenses'));
    expect(insert).toBeDefined();
    const params = insert[1];
    // features_json = all 7 system features; validity_days = 60/1440.
    expect(JSON.parse(params[3])).toEqual(ALL_FEATURES);
    expect(params[4]).toBeCloseTo(60 / 1440, 6);
    expect(params[5]).toBe('mrash');
    // ends_at ≈ NOW() + 60 min.
    const endsAt = new Date(params[2]).getTime();
    expect(endsAt - Date.now()).toBeGreaterThan(55 * 60000);
    expect(endsAt - Date.now()).toBeLessThan(65 * 60000);
    // Old active licence cancelled first (newer-wins).
    expect(pool.calls[0][0]).toMatch(/SET status = 'cancelled'/);
  });
});

describe('LicensingService.audit (best-effort)', () => {
  it('a failed audit write never throws', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('table missing')) };
    const svc = new LicensingService(pool as any);

    await expect(
      svc.audit('issue', 'mrash', 42, 5, 'LIC-X', 'note')
    ).resolves.toBeUndefined();
  });

  it('a successful audit write inserts the row', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const svc = new LicensingService(pool as any);

    await svc.audit('activate', 'mrash', 42, 5, 'LIC-X', 'activated');

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toMatch(/INSERT INTO license_audit/);
    expect(pool.query.mock.calls[0][1]).toEqual(['mrash', 'activate', 42, 5, 'LIC-X', 'activated']);
  });
});
