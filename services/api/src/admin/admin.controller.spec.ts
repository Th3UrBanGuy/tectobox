import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { AdminController } from './admin.controller.js';
import { hashPassword } from '../auth/password.util.js';
import { encrypt, decrypt, isEncrypted } from '../common/crypto.js';
import { generateSecret, verifyTotp } from '../auth/totp.util.js';
import { NotImplementedException, BadRequestException, UnauthorizedException } from '@nestjs/common';

describe('AdminController (seg-02 secrets & honest responses)', () => {
  const originalEnv = process.env.ENCRYPTION_KEY;
  let controller: AdminController;
  let mockPool: any;
  let mockLicensing: any;
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
    controller = new AdminController(mockPool, mockLicensing);
  });

  describe('POST admin/notify', () => {
    it('returns honest 501 NotImplementedException instead of fake success', async () => {
      await expect(controller.sendNotification({ message: 'Hello' })).rejects.toThrow(
        NotImplementedException
      );
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
});
