import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { AdminController } from './admin.controller.js';
import { hashPassword } from '../auth/password.util.js';
import { encrypt, decrypt, isEncrypted } from '../common/crypto.js';
import { generateSecret, verifyTotp } from '../auth/totp.util.js';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';

describe('AdminController (seg-02 secrets & honest responses)', () => {
  const originalEnv = process.env.ENCRYPTION_KEY;
  let controller: AdminController;
  let mockPool: any;
  let mockLicensing: any;
  let mockEvents: any;
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
    mockLicensing = {
      audit: vi.fn(),
    };
    mockEvents = {
      broadcastTenantEvent: vi.fn(async () => {}),
      writeAudit: vi.fn(async () => {}),
    };
    controller = new AdminController(mockPool, mockLicensing, mockEvents);
  });

  describe('POST admin/notify (P12 — real send + history)', () => {
    it('rejects an empty message with a clean validation error', async () => {
      await expect(controller.sendNotification({ message: '   ' })).rejects.toThrow(BadRequestException);
      await expect(controller.sendNotification({})).rejects.toThrow(BadRequestException);
      expect(dbQueries).toHaveLength(0);
    });

    it('records the notification and broadcasts it to every workspace', async () => {
      mockPool.query.mockImplementation(async (sql: string, params: any[] = []) => {
        dbQueries.push({ sql, params });
        if (sql.includes('SELECT id FROM clients') && !sql.includes('WHERE id = ANY')) return { rows: [{ id: 5 }, { id: 7 }] };
        if (sql.includes('WHERE id = ANY')) return { rows: [{ id: 5 }, { id: 7 }] };
        return { rows: [], rowCount: 1 };
      });
      const res = await controller.sendNotification({ message: 'Hello', title: 'Hi' });
      expect(res).toEqual({ ok: true, sent: 2, skipped: 0 });
      expect(dbQueries.some((q) => q.sql.includes('INSERT INTO admin_notifications'))).toBe(true);
      expect(mockEvents.broadcastTenantEvent).toHaveBeenCalledTimes(2);
    });

    it('skips unknown workspace ids instead of sending to them', async () => {
      mockPool.query.mockImplementation(async (sql: string, params: any[] = []) => {
        dbQueries.push({ sql, params });
        if (sql.includes('WHERE id = ANY')) return { rows: [{ id: 5 }] };
        return { rows: [], rowCount: 1 };
      });
      const res = await controller.sendNotification({ message: 'Hi', clientIds: [5, 999] });
      expect(res).toEqual({ ok: true, sent: 1, skipped: 1 });
      expect(mockEvents.broadcastTenantEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET admin/overview (P1)', () => {
    it('derives channel counts from the real resources, with no hardcoded floor', async () => {
      const ov = await controller.getOverview();
      expect(ov.channels).toBe(0);
      expect(ov.connected).toBe(0);
      expect(ov.errored).toBe(0);
    });

    it('counts a ready webchat as connected (one truth with the resources table)', async () => {
      mockPool.query.mockImplementation(async (sql: string, params: any[] = []) => {
        dbQueries.push({ sql, params });
        if (sql.includes('FROM channel_sessions')) {
          return { rows: [{ channel: 'webchat', status: 'ready', lastSeen: null, workspace: 'Xyz', client_id: 5, account: null }] };
        }
        if (sql.includes('FROM meta_pages')) return { rows: [] };
        if (sql.includes('FROM clients')) return { rows: [{ count: '1' }] };
        if (sql.includes('FROM conversations')) return { rows: [{ count: '0' }] };
        if (sql.includes('FROM messages')) return { rows: [{ count: '0' }] };
        if (sql.includes('FROM orders')) return { rows: [{ count: '0', total: '0' }] };
        if (sql.includes('FROM leads')) return { rows: [{ count: '0' }] };
        return { rows: [] };
      });
      const ov = await controller.getOverview();
      expect(ov.channels).toBe(1);
      expect(ov.connected).toBe(1);
    });
  });

  describe('GET admin/config (P10)', () => {
    it('returns the real internal AI URL and model defaults, never localhost', async () => {
      const cfg = await controller.getConfig();
      expect(cfg.aiBaseUrl).toBe('http://ai:8081/v1');
      expect(cfg.aiModel).toBe('gemini-3.6-flash');
      expect(cfg.aiModelPool).toContain('@cf/zai-org/glm-4.7-flash');
      expect(cfg.aiBaseUrl).not.toContain('localhost');
    });

    it('maps camelCase saves to canonical keys so they round-trip', async () => {
      await controller.updateConfig({ autoReply: false, aiModel: 'gemini-3.6-flash', aiBaseUrl: 'http://ai:8081/v1' });
      const keys = dbQueries.map((q) => q.params?.[0]);
      expect(keys).toContain('ai.auto_reply');
      expect(keys).toContain('ai.model');
      expect(keys).toContain('ai.base_url');
      expect(keys).not.toContain('autoReply');
      expect(keys).not.toContain('aiModel');
      const autoReply = dbQueries.find((q) => q.params?.[0] === 'ai.auto_reply');
      expect(autoReply?.params?.[1]).toBe('0');
    });
  });

  describe('TOTP management (H4)', () => {
    it('getTotpStatus scopes query to session user_id, not hardcoded 1', async () => {
      mockPool.query.mockImplementationOnce(async (sql: string, params: any[]) => {
        dbQueries.push({ sql, params });
        return { rows: [{ enabled: true, secret_enc: 'v1:dummy' }] };
      });
      const req = { user: { id: 42, username: 'admin42' } };

      const res = await controller.getTotpStatus(req);
      expect(res).toEqual({ enabled: true, configured: true });

      const totpQuery = dbQueries.find((q) => q.sql.includes('FROM admin_totp WHERE user_id = $1'));
      expect(totpQuery).toBeDefined();
      expect(totpQuery?.params).toEqual([42]);
      expect(totpQuery?.params).not.toContain(1);
    });

    it('setupTotp requires password confirmation and stores secret encrypted at rest', async () => {
      const password = 'CorrectHorseBatteryStaple123!';
      const passwordHash = await hashPassword(password);
      const req = { user: { id: 7, username: 'manager7' } };

      // 1. Rejects if password is not supplied
      await expect(controller.setupTotp(req, {} as any)).rejects.toThrow(BadRequestException);

      // 2. Rejects if password is wrong
      mockPool.query.mockImplementationOnce(async (sql: string, params: any[]) => {
        dbQueries.push({ sql, params });
        return { rows: [{ id: 7, username: 'manager7', password_hash: passwordHash }] };
      });
      await expect(controller.setupTotp(req, { password: 'wrong' })).rejects.toThrow(
        /Incorrect password/
      );

      // 3. Succeeds with correct password, stores secret encrypted (not plaintext)
      mockPool.query.mockImplementationOnce(async (sql: string, params: any[]) => {
        dbQueries.push({ sql, params });
        return { rows: [{ id: 7, username: 'manager7', password_hash: passwordHash }] };
      });
      mockPool.query.mockImplementationOnce(async (sql: string, params: any[]) => {
        dbQueries.push({ sql, params });
        return { rows: [] };
      });

      const result = await controller.setupTotp(req, { password });
      expect(result.secret).toBeDefined();
      expect(result.otpauth_url).toContain(result.secret);

      const insertQuery = dbQueries.find((q) => q.sql.includes('INSERT INTO admin_totp'));
      expect(insertQuery).toBeDefined();
      expect(insertQuery?.params[0]).toBe(7); // user_id = 7, not 1!
      const storedVal = insertQuery?.params[1];

      // Stored secret must be encrypted and must NOT contain the plaintext secret
      expect(isEncrypted(storedVal)).toBe(true);
      expect(storedVal).not.toContain(result.secret);
      expect(decrypt(storedVal)).toBe(result.secret);
    });

    it('enableTotp verifies code and decrypts stored secret', async () => {
      const req = { user: { id: 88 } };
      const rawSecret = generateSecret(20);
      const encryptedSecret = encrypt(rawSecret);

      mockPool.query.mockImplementationOnce(async (sql: string, params: any[]) => {
        dbQueries.push({ sql, params });
        return { rows: [{ secret_enc: encryptedSecret }] };
      });

      // Let's compute a valid TOTP token or test invalid code rejection
      await expect(controller.enableTotp(req, { token: '000000' })).rejects.toThrow(
        /Invalid code/
      );

      const query = dbQueries.find((q) => q.sql.includes('SELECT secret_enc FROM admin_totp WHERE user_id = $1'));
      expect(query?.params).toEqual([88]);
    });

    it('enableTotp performs migrate-on-read for unencrypted legacy secrets on successful verification', async () => {
      const req = { user: { id: 10 } };
      // Simulate existing plaintext unencrypted secret in database
      const rawSecret = 'JBSWY3DPEHPK3PXP';

      // Helper to compute valid TOTP for rawSecret
      const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      const clean = String(rawSecret).toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
      let bits = 0, value = 0;
      const bytes: number[] = [];
      for (const ch of clean) {
        value = (value << 5) | ALPHABET.indexOf(ch);
        bits += 5;
        if (bits >= 8) {
          bytes.push((value >>> (bits - 8)) & 255);
          bits -= 8;
        }
      }
      const key = Buffer.from(bytes);
      const counter = Math.floor(Date.now() / 30000);
      const msg = Buffer.alloc(8);
      msg.writeBigUInt64BE(BigInt(counter));
      const h = crypto.createHmac('sha1', key).update(msg).digest();
      const o = h[h.length - 1] & 0x0f;
      const code = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000;
      const validToken = String(code).padStart(6, '0');

      mockPool.query.mockImplementation(async (sql: string, params: any[]) => {
        dbQueries.push({ sql, params });
        if (sql.includes('SELECT secret_enc FROM admin_totp')) {
          return { rows: [{ secret_enc: rawSecret }] };
        }
        return { rows: [] };
      });

      const res = await controller.enableTotp(req, { token: validToken });
      expect(res).toEqual({ ok: true, enabled: true });

      const updateQ = dbQueries.find((q) => q.sql.includes('UPDATE admin_totp SET enabled = true, secret_enc = $1 WHERE user_id = $2'));
      expect(updateQ).toBeDefined();
      expect(updateQ?.params[1]).toBe(10);

      const newlyEnc = updateQ?.params[0];
      expect(isEncrypted(newlyEnc)).toBe(true);
      expect(decrypt(newlyEnc)).toBe(rawSecret);
    });

    it('disableTotp requires password confirmation and deletes for session user_id', async () => {
      const password = 'SecurePassword123!';
      const passwordHash = await hashPassword(password);
      const req = { user: { id: 99, username: 'admin99' } };

      // Rejects without password
      await expect(controller.disableTotp(req, {} as any)).rejects.toThrow(BadRequestException);

      // Rejects with wrong password
      mockPool.query.mockImplementationOnce(async (sql: string, params: any[]) => {
        dbQueries.push({ sql, params });
        return { rows: [{ id: 99, password_hash: passwordHash }] };
      });
      await expect(controller.disableTotp(req, { password: 'wrong' })).rejects.toThrow(
        /Incorrect password/
      );

      // Succeeds with correct password
      mockPool.query.mockImplementationOnce(async (sql: string, params: any[]) => {
        dbQueries.push({ sql, params });
        return { rows: [{ id: 99, password_hash: passwordHash }] };
      });
      mockPool.query.mockImplementationOnce(async (sql: string, params: any[]) => {
        dbQueries.push({ sql, params });
        return { rows: [] };
      });

      const res = await controller.disableTotp(req, { password });
      expect(res).toEqual({ ok: true, enabled: false });

      const delQuery = dbQueries.find((q) => q.sql.includes('DELETE FROM admin_totp WHERE user_id = $1'));
      expect(delQuery).toBeDefined();
      expect(delQuery?.params).toEqual([99]);
      expect(delQuery?.params).not.toContain(1);
    });

    it('rejects unauthenticated requests lacking session user_id', async () => {
      const emptyReq = {};
      await expect(controller.getTotpStatus(emptyReq)).rejects.toThrow(UnauthorizedException);
      await expect(controller.setupTotp(emptyReq, { password: 'pass' })).rejects.toThrow(
        UnauthorizedException
      );
      await expect(controller.enableTotp(emptyReq, { token: '123456' })).rejects.toThrow(
        UnauthorizedException
      );
      await expect(controller.disableTotp(emptyReq, { password: 'pass' })).rejects.toThrow(
        UnauthorizedException
      );
    });
  });

  describe('GET admin/audit (M14 Pagination)', () => {
    it('paginates audit log with default limit 50, offset 0, and total count', async () => {
      mockPool.query.mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes('COUNT(*)')) return { rows: [{ total: '40' }] };
        return { rows: [{ id: 1, event: 'user:login' }] };
      });

      const res: any = await controller.getAuditLog();
      expect(res.total).toBe(40);
      expect(res.limit).toBe(50);
      expect(res.offset).toBe(0);
      expect(res.length).toBe(1);
    });

    it('respects custom limit (capped at 200) and offset', async () => {
      mockPool.query.mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes('COUNT(*)')) return { rows: [{ total: '100' }] };
        return { rows: [] };
      });

      const res: any = await controller.getAuditLog('300', '15');
      expect(res.limit).toBe(200);
      expect(res.offset).toBe(15);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT $1 OFFSET $2'),
        [200, 15]
      );
    });
  });

  describe('listWorkspaces (F5 wrong id regression)', () => {
    it('returns client id as id, client_id as client id, and user id under distinct user_id alias', async () => {
      mockPool.query.mockImplementationOnce(async (sql: string) => {
        expect(sql).not.toContain('u.id as id');
        expect(sql).toContain('c.id as id');
        expect(sql).toContain('u.id as user_id');
        return {
          rows: [
            {
              id: 14,
              client_id: 14,
              client_name: 'Alpha Electronics',
              user_id: 15,
              username: 'alpha_operator',
              active: true,
              conv_count: 10,
              order_count: 4,
              lead_count: 2,
              license: null,
            },
          ],
        };
      });

      const res = await controller.listWorkspaces();
      expect(res).toHaveLength(1);
      const ws = res[0];
      // Assert returned id equals client id, not user id
      expect(ws.id).toBe(14);
      expect(ws.client_id).toBe(14);
      expect(ws.user_id).toBe(15);
      expect(ws.id).not.toBe(ws.user_id);
      expect(ws.ai_budget).toBeDefined();
    });
  });
});
