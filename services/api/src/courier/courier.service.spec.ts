import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CourierService, maskSecret } from './courier.service.js';
import { isEncrypted, decrypt } from '../common/crypto.js';

describe('CourierService (seg-02 secrets handling & masking)', () => {
  let service: CourierService;
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
    service = new CourierService(mockPool);
  });

  describe('maskSecret', () => {
    it('masks long secrets keeping only last 4 chars', () => {
      expect(maskSecret('sf_live_key_99887766')).toBe('****7766');
      expect(maskSecret('secret1234')).toBe('****1234');
    });

    it('masks short secrets with ****', () => {
      expect(maskSecret('1234')).toBe('****');
      expect(maskSecret('ab')).toBe('****');
      expect(maskSecret('')).toBe('');
      expect(maskSecret(null)).toBe('');
    });
  });

  describe('getMaskedConfig', () => {
    it('returns masked secrets and configured booleans, never returning plaintext secrets', async () => {
      const knownSecret = 'SUPER_SECRET_STEADFAST_KEY_XYZ99';
      const knownSecret2 = 'SUPER_SECRET_STEADFAST_PASS_5544';

      mockPool.query.mockImplementationOnce(async (sql: string, params: any[]) => {
        dbQueries.push({ sql, params });
        return {
          rows: [
            {
              courier_config_json: JSON.stringify({
                provider: 'steadfast',
                steadfast_api_key: knownSecret,
                steadfast_secret_key: knownSecret2,
                pathao_client_id: '12345',
                pathao_client_secret: '',
              }),
            },
          ],
        };
      });

      const res = await service.getMaskedConfig(15);

      // Verify known plaintext secrets do not appear anywhere in the returned JSON or values
      const jsonOutput = JSON.stringify(res);
      expect(jsonOutput).not.toContain(knownSecret);
      expect(jsonOutput).not.toContain(knownSecret2);

      expect(res.steadfast_api_key).toBe('****YZ99');
      expect(res.steadfast_secret_key).toBe('****5544');
      expect(res.configured.steadfast).toBe(true);
      expect(res.configured.pathao).toBe(false);
      expect(res.steadfast_configured).toBe(true);
      expect(res.pathao_configured).toBe(false);
    });

    it('performs migrate-on-read for unencrypted legacy config rows', async () => {
      const rawKey = 'plaintext_key_123456';
      const rawSecret = 'plaintext_secret_654321';

      mockPool.query.mockImplementationOnce(async (sql: string, params: any[]) => {
        dbQueries.push({ sql, params });
        return {
          rows: [
            {
              courier_config_json: JSON.stringify({
                provider: 'steadfast',
                steadfast_api_key: rawKey,
                steadfast_secret_key: rawSecret,
              }),
            },
          ],
        };
      });

      await service.getMaskedConfig(22);

      // Verify migration update query was dispatched
      const updateQ = dbQueries.find((q) => q.sql.includes('UPDATE clients SET courier_config_json = $1 WHERE id = $2'));
      expect(updateQ).toBeDefined();
      expect(updateQ?.params[1]).toBe(22);

      const savedJson = JSON.parse(updateQ?.params[0]);
      expect(savedJson.steadfast_api_key).not.toBe(rawKey);
      expect(isEncrypted(savedJson.steadfast_api_key)).toBe(true);
      expect(decrypt(savedJson.steadfast_api_key)).toBe(rawKey);
      expect(isEncrypted(savedJson.steadfast_secret_key)).toBe(true);
      expect(decrypt(savedJson.steadfast_secret_key)).toBe(rawSecret);
    });
  });

  describe('saveConfig', () => {
    it('encrypts secrets at rest and preserves unchanged masked secrets', async () => {
      const existingKey = 'original_secret_key_1111';
      const existingSecret = 'original_secret_pass_2222';

      let storedJson = JSON.stringify({
        provider: 'steadfast',
        steadfast_api_key: existingKey,
        steadfast_secret_key: existingSecret,
      });

      mockPool.query.mockImplementation(async (sql: string, params: any[]) => {
        dbQueries.push({ sql, params });
        if (sql.includes('SELECT courier_config_json')) {
          return { rows: [{ courier_config_json: storedJson }] };
        }
        if (sql.includes('UPDATE clients SET courier_config_json')) {
          storedJson = params[0];
          return { rows: [] };
        }
        return { rows: [] };
      });

      // Submit with steadfast_api_key masked (unchanged) but new steadfast_secret_key
      const newSecret = 'brand_new_secret_3333';
      const body = {
        provider: 'steadfast',
        steadfast_api_key: '****1111',
        steadfast_secret_key: newSecret,
      };

      await service.saveConfig(42, body);

      const updateQueries = dbQueries.filter((q) => q.sql.includes('UPDATE clients SET courier_config_json = $1 WHERE id = $2'));
      const lastUpdateQ = updateQueries[updateQueries.length - 1];
      expect(lastUpdateQ).toBeDefined();

      const stored = JSON.parse(lastUpdateQ?.params[0]);
      // Key was preserved from existing and encrypted
      expect(decrypt(stored.steadfast_api_key)).toBe(existingKey);
      // Secret was updated and encrypted
      expect(decrypt(stored.steadfast_secret_key)).toBe(newSecret);
    });
  });
});
