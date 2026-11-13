import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CourierController } from './courier.controller.js';

describe('CourierController (seg-02)', () => {
  let controller: CourierController;
  let mockPool: any;
  let dbQueries: Array<{ sql: string; params: any[] }>;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'test-secret-key-32-bytes-long!!';
    dbQueries = [];
    mockPool = {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        dbQueries.push({ sql, params });
        return { rows: [] };
      }),
    };
    controller = new CourierController(mockPool);
  });

  describe('GET courier/config', () => {
    it('response contains no secret value', async () => {
      const knownSecret = 'CANARY_SECRET_NEVER_LEAK_ME_12345';
      mockPool.query.mockImplementationOnce(async (sql: string, params: any[]) => {
        dbQueries.push({ sql, params });
        return {
          rows: [
            {
              courier_config_json: JSON.stringify({
                provider: 'steadfast',
                steadfast_api_key: knownSecret,
                steadfast_secret_key: 'SECOND_CANARY_SECRET_9876',
              }),
            },
          ],
        };
      });

      const res = await controller.getCourierConfig(101);
      const str = JSON.stringify(res);

      expect(str).not.toContain(knownSecret);
      expect(str).not.toContain('SECOND_CANARY_SECRET_9876');
      expect(res.steadfast_api_key).toBe('****2345');
      expect(res.steadfast_secret_key).toBe('****9876');
      expect(res.configured.steadfast).toBe(true);
    });
  });

  describe('GET courier/fraud-check (M6)', () => {
    it('scopes local order history queries strictly to the tenant client_id', async () => {
      const tenantId = 88;
      const phone = '01711223344';

      mockPool.query.mockImplementation(async (sql: string, params: any[]) => {
        dbQueries.push({ sql, params });
        if (sql.includes('FROM orders')) {
          return { rows: [{ status: 'delivered', cnt: '2' }] };
        }
        return { rows: [] };
      });

      const res = await controller.checkCustomerFraud(tenantId, phone);
      expect(res.delivered).toBe(2);

      const orderQuery = dbQueries.find((q) => q.sql.includes('FROM orders'));
      expect(orderQuery).toBeDefined();
      expect(orderQuery?.sql).toContain('client_id = $1');
      expect(orderQuery?.params[0]).toBe(tenantId);
    });
  });
});
