import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DeveloperController } from './developer.controller.js';
import { BadRequestException, NotFoundException } from '@nestjs/common';

/**
 * P7/P19 (2026-11-15): API-key name is required (no 'integration'
 * default, no leaked DB error) and revoke must actually revoke.
 */
describe('DeveloperController — API keys (P7/P19)', () => {
  let controller: DeveloperController;
  let mockPool: any;
  let dbQueries: Array<{ sql: string; params: any[] }>;

  beforeEach(() => {
    dbQueries = [];
    mockPool = {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        dbQueries.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }),
    };
    controller = new DeveloperController(mockPool);
  });

  describe('createApiKey — name required (P7/P19)', () => {
    it('rejects an empty name with a clean message and no DB write', async () => {
      await expect(controller.createApiKey(5, 5, { name: '' })).rejects.toThrow(BadRequestException);
      await expect(controller.createApiKey(5, 5, { name: '' })).rejects.toThrow('Name is required');
      expect(dbQueries).toHaveLength(0);
    });

    it('rejects a whitespace-only name', async () => {
      await expect(controller.createApiKey(5, 5, { name: '   ' })).rejects.toThrow(BadRequestException);
      expect(dbQueries).toHaveLength(0);
    });

    it('rejects a missing name (no "integration" default)', async () => {
      await expect(controller.createApiKey(5, 5, {})).rejects.toThrow(BadRequestException);
      expect(dbQueries).toHaveLength(0);
    });

    it('creates a key with the given name and never stores "integration" by default', async () => {
      mockPool.query.mockImplementationOnce(async (sql: string, params: any[] = []) => {
        dbQueries.push({ sql, params });
        return { rows: [{ id: 1, name: 'My App', key_prefix: 'tk_abc123' }], rowCount: 1 };
      });
      const res = await controller.createApiKey(5, 5, { name: 'My App' });
      expect(res.name).toBe('My App');
      expect(res.api_key).toMatch(/^tk_/);
      const insert = dbQueries.find((q) => q.sql.includes('INSERT INTO api_keys'));
      expect(insert?.params[1]).toBe('My App');
    });
  });

  describe('deleteApiKey — revoke must actually revoke (P19)', () => {
    it('returns ok when a row was revoked', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 3 }], rowCount: 1 });
      const res = await controller.deleteApiKey(5, 5, 3);
      expect(res.ok).toBe(true);
    });

    it('throws 404 when no key matched (never a silent ok)', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await expect(controller.deleteApiKey(5, 5, 999)).rejects.toThrow(NotFoundException);
    });
  });
});
