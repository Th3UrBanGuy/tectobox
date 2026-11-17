import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AiKeysController, fingerprintKey } from './ai-keys.controller.js';
import { decrypt } from '../common/crypto.js';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('AiKeysController (Gemini key pool, 2026-11-17)', () => {
  let controller: AiKeysController;
  let mockPool: any;
  let dbQueries: Array<{ sql: string; params: any[] }>;
  let fetchCalls: Array<{ url: string; body?: string; method?: string }>;
  let probeStatus = 200;

  const GOOD_KEY = 'AIzaSyGoodKey0123456789abcdefghij';
  const BAD_KEY = 'AQAb8DeadKey0123456789abcdefghij';

  function stubFetch() {
    fetchCalls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: any = {}) => {
        fetchCalls.push({ url, body: init.body, method: init.method });
        if (url.includes('generativelanguage.googleapis.com')) {
          return { ok: probeStatus === 200, status: probeStatus, json: async () => ({}) } as any;
        }
        if (url.includes('/internal/pool') && init.method === 'POST') {
          return { ok: true, status: 200, json: async () => ({ fingerprint: fingerprintKey(GOOD_KEY) }) } as any;
        }
        if (url.includes('/internal/pool') && (!init.method || init.method === 'GET')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              total: 3,
              keys: [
                { fingerprint: fingerprintKey(GOOD_KEY), source: 'env', label: '', uses: 10, successes: 9, failures: 1, healthy: true },
              ],
            }),
          } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }),
    );
  }

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'test-secret-key-32-bytes-long!!';
    dbQueries = [];
    probeStatus = 200;
    mockPool = {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        dbQueries.push({ sql, params });
        return { rows: [] };
      }),
    };
    stubFetch();
    controller = new AiKeysController(mockPool);
  });

  afterEach(() => {
    controller.onModuleDestroy();
    vi.unstubAllGlobals();
  });

  it('fingerprints are stable, 12 chars, and never equal the key', () => {
    const fp = fingerprintKey(GOOD_KEY);
    expect(fp).toHaveLength(12);
    expect(fp).toBe(fingerprintKey(GOOD_KEY));
    expect(fp).not.toBe(GOOD_KEY);
    expect(fingerprintKey(BAD_KEY)).not.toBe(fp);
  });

  it('add rejects a short key without touching the DB or the network', async () => {
    await expect(controller.add({ key: 'short' })).rejects.toThrow(BadRequestException);
    expect(dbQueries).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });

  it('add rejects a key whose project has no free tier (403) without storing it', async () => {
    probeStatus = 403;
    await expect(controller.add({ key: GOOD_KEY, label: 'main' })).rejects.toThrow(/no Gemini free tier/);
    expect(dbQueries.some((q) => q.sql.includes('INSERT INTO ai_api_keys'))).toBe(false);
  });

  it('add live-probes, encrypts, stores, and pushes to the pool', async () => {
    mockPool.query.mockImplementation(async (sql: string, params: any[] = []) => {
      dbQueries.push({ sql, params });
      if (sql.includes('SELECT id FROM ai_api_keys')) return { rows: [] };
      if (sql.includes('INSERT INTO ai_api_keys')) return { rows: [{ id: 7 }] };
      return { rows: [] };
    });
    const res = await controller.add({ key: GOOD_KEY, label: 'main' });
    expect(res.fingerprint).toBe(fingerprintKey(GOOD_KEY));
    expect(res.poolSynced).toBe(true);
    // The stored value decrypts back to the key — and is NOT the key.
    const insert = dbQueries.find((q) => q.sql.includes('INSERT INTO ai_api_keys'));
    expect(insert).toBeDefined();
    expect(insert!.params[0]).not.toBe(GOOD_KEY);
    expect(decrypt(insert!.params[0])).toBe(GOOD_KEY);
    // The pool push carried the key over the internal network only.
    const push = fetchCalls.find((c) => c.url.includes('/internal/pool/keys'));
    expect(push).toBeDefined();
    expect(JSON.parse(push!.body!).key).toBe(GOOD_KEY);
    // The Google probe went out with the key as a header, never in a URL.
    const probe = fetchCalls.find((c) => c.url.includes('generativelanguage'));
    expect(probe).toBeDefined();
    expect(probe!.url).not.toContain(GOOD_KEY);
  });

  it('add reports poolSynced=false when the pool push fails, but keeps the stored row', async () => {
    mockPool.query.mockImplementation(async (sql: string, params: any[] = []) => {
      dbQueries.push({ sql, params });
      if (sql.includes('SELECT id FROM ai_api_keys')) return { rows: [] };
      if (sql.includes('INSERT INTO ai_api_keys')) return { rows: [{ id: 8 }] };
      return { rows: [] };
    });
    (global.fetch as any).mockImplementation(async (url: string) => {
      if (url.includes('generativelanguage')) return { ok: true, status: 200, json: async () => ({}) };
      throw new Error('ai unreachable');
    });
    const res = await controller.add({ key: GOOD_KEY, label: 'main' });
    expect(res.poolSynced).toBe(false);
    expect(res.note).toMatch(/5-minute sync/);
  });

  it('list merges pool stats with stored rows and never exposes a key value', async () => {
    mockPool.query.mockImplementation(async (sql: string, params: any[] = []) => {
      dbQueries.push({ sql, params });
      if (sql.includes('FROM ai_api_keys')) {
        return {
          rows: [
            { id: 7, key_fp: fingerprintKey(GOOD_KEY), label: 'main', is_active: true, uses: 0, fails: 0, last_used_at: null, last_tested_at: new Date(), last_test_error: null, created_at: new Date() },
          ],
        };
      }
      return { rows: [] };
    });
    const res = await controller.list();
    expect(res.poolTotal).toBe(3);
    expect(res.stored).toHaveLength(1);
    expect(res.stored[0].inPool).toBe(true);
    expect(JSON.stringify(res)).not.toContain(GOOD_KEY);
  });

  it('remove deletes the row and drops the key from the live pool', async () => {
    mockPool.query.mockImplementation(async (sql: string, params: any[] = []) => {
      dbQueries.push({ sql, params });
      if (sql.includes('SELECT key_fp')) return { rows: [{ key_fp: fingerprintKey(GOOD_KEY) }] };
      return { rows: [] };
    });
    const res = await controller.remove('7');
    expect(res.removed).toBe(fingerprintKey(GOOD_KEY));
    expect(dbQueries.some((q) => q.sql.includes('DELETE FROM ai_api_keys'))).toBe(true);
    const del = fetchCalls.find((c) => c.method === 'DELETE');
    expect(del?.url).toContain(`fp=${fingerprintKey(GOOD_KEY)}`);
  });

  it('remove 404s for an unknown id', async () => {
    await expect(controller.remove('99')).rejects.toThrow(NotFoundException);
  });

  it('test live-probes a stored key and records the result', async () => {
    const { encrypt } = await import('../common/crypto.js');
    mockPool.query.mockImplementation(async (sql: string, params: any[] = []) => {
      dbQueries.push({ sql, params });
      if (sql.includes('SELECT key_enc')) {
        return { rows: [{ key_enc: encrypt(GOOD_KEY), key_fp: fingerprintKey(GOOD_KEY) }] };
      }
      return { rows: [] };
    });
    const res = await controller.test('7');
    expect(res.ok).toBe(true);
    expect(res.fingerprint).toBe(fingerprintKey(GOOD_KEY));
    expect(JSON.stringify(res)).not.toContain(GOOD_KEY);
    expect(dbQueries.some((q) => q.sql.includes('UPDATE ai_api_keys SET last_tested_at'))).toBe(true);
  });
});
