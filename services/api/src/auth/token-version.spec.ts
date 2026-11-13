import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { UnauthorizedException, BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { AuthController } from './auth.controller.js';
import { AdminController } from '../admin/admin.controller.js';
import { hashPassword } from './password.util.js';

describe('Token version, revocation, algorithm pinning, password hardening, captcha', () => {
  const JWT_SECRET = 'super_secure_test_jwt_secret_67890!';

  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
  });

  const createMockContext = (headers: Record<string, string> = {}): any => {
    const request: any = {
      headers,
    };
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    };
  };

  describe('Session revocation via token_version', () => {
    it('accepts token matching user token_version, and rejects when token_version is bumped', async () => {
      let currentDbVersion = 1;

      const mockPool: any = {
        query: vi.fn(async (sql: string, params: any[]) => {
          if (sql.includes('FROM users WHERE id = $1')) {
            return {
              rows: [
                {
                  id: 10,
                  username: 'test_user',
                  role: 'client',
                  client_id: 42,
                  active: true,
                  token_version: currentDbVersion,
                },
              ],
            };
          }
          return { rows: [] };
        }),
      };

      const guard = new TenantGuard(mockPool);

      // 1. Issue a token with version 1
      const tokenV1 = jwt.sign(
        {
          sub: 10,
          username: 'test_user',
          role: 'client',
          clientId: 42,
          token_version: 1,
          tokenVersion: 1,
        },
        JWT_SECRET,
        { expiresIn: '24h', algorithm: 'HS256' }
      );

      // Validate with version 1 in DB -> should succeed
      const ctx1 = createMockContext({ authorization: `Bearer ${tokenV1}` });
      const allowed1 = await guard.canActivate(ctx1);
      expect(allowed1).toBe(true);
      expect(ctx1.switchToHttp().getRequest().user.id).toBe(10);

      // 2. Bump user token_version in DB (e.g., password change or password reset)
      currentDbVersion = 2;

      // Validate tokenV1 with version 2 in DB -> should be rejected as revoked
      const ctx2 = createMockContext({ authorization: `Bearer ${tokenV1}` });
      await expect(guard.canActivate(ctx2)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(ctx2)).rejects.toThrow('Token revoked');

      // 3. Newly issued token with version 2 should succeed
      const tokenV2 = jwt.sign(
        {
          sub: 10,
          username: 'test_user',
          role: 'client',
          clientId: 42,
          token_version: 2,
          tokenVersion: 2,
        },
        JWT_SECRET,
        { expiresIn: '24h', algorithm: 'HS256' }
      );

      const ctx3 = createMockContext({ authorization: `Bearer ${tokenV2}` });
      const allowed3 = await guard.canActivate(ctx3);
      expect(allowed3).toBe(true);
    });
  });

  describe('JWT algorithm pinning (L8)', () => {
    it('rejects tokens signed with alg: "none"', async () => {
      const mockPool: any = { query: vi.fn().mockResolvedValue({ rows: [] }) };
      const guard = new TenantGuard(mockPool);

      // An unsigned / alg: none token (header: {"alg":"none","typ":"JWT"})
      const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const nonePayload = Buffer.from(JSON.stringify({ sub: 10, username: 'attacker', role: 'admin' })).toString('base64url');
      const noneToken = `${noneHeader}.${nonePayload}.`;

      const ctx = createMockContext({ authorization: `Bearer ${noneToken}` });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects tokens signed with an unlisted algorithm', async () => {
      const mockPool: any = { query: vi.fn().mockResolvedValue({ rows: [] }) };
      const guard = new TenantGuard(mockPool);

      // Token signed with HS512 instead of HS256
      const hs512Token = jwt.sign(
        { sub: 10, username: 'test_user', role: 'client', token_version: 1 },
        JWT_SECRET,
        { algorithm: 'HS512', expiresIn: '1h' }
      );

      const ctx = createMockContext({ authorization: `Bearer ${hs512Token}` });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('Password hardening (H7, L3)', () => {
    it('updateCredentials rejects new password < 12 characters', async () => {
      const currentPwHash = await hashPassword('CurrentValidPassword123');
      const mockPool: any = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('FROM users WHERE id = $1')) {
            return {
              rows: [
                {
                  id: 5,
                  username: 'regular_user',
                  role: 'operator',
                  password_hash: currentPwHash,
                  client_id: 1,
                  token_version: 1,
                },
              ],
            };
          }
          return { rows: [] };
        }),
      };

      const authController = new AuthController(mockPool);

      // Attempt to change password to something with length < 12
      await expect(
        authController.updateCredentials(
          { user: { id: 5 } },
          {
            current_password: 'CurrentValidPassword123',
            new_password: 'short',
          }
        )
      ).rejects.toThrow(BadRequestException);
    });

    it('updateCredentials succeeds with password >= 12 characters and bumps token_version', async () => {
      const currentPwHash = await hashPassword('CurrentValidPassword123');
      let updatedTokenVersion: number | null = null;

      const mockPool: any = {
        query: vi.fn(async (sql: string, params: any[]) => {
          if (sql.includes('FROM users WHERE id = $1')) {
            return {
              rows: [
                {
                  id: 5,
                  username: 'regular_user',
                  role: 'operator',
                  password_hash: currentPwHash,
                  client_id: 1,
                  token_version: 1,
                },
              ],
            };
          }
          if (sql.includes('UPDATE users SET username = $1, password_hash = $2, token_version = $3')) {
            updatedTokenVersion = params[2];
            return { rows: [] };
          }
          return { rows: [] };
        }),
      };

      const authController = new AuthController(mockPool);
      const res = await authController.updateCredentials(
        { user: { id: 5 } },
        {
          current_password: 'CurrentValidPassword123',
          new_password: 'NewStrongPassword2026!',
        }
      );

      expect(res.ok).toBe(true);
      expect(updatedTokenVersion).toBe(2);
      expect(typeof res.token).toBe('string');
    });

    it('createUser rejects missing password and password < 12 characters', async () => {
      const mockPool: any = { query: vi.fn().mockResolvedValue({ rows: [] }) };
      const adminController = new AdminController(mockPool, {} as any);

      // Missing password
      await expect(
        adminController.createUser({ username: 'newuser1', password: '' })
      ).rejects.toThrow(BadRequestException);

      // Password < 12 characters
      await expect(
        adminController.createUser({ username: 'newuser1', password: 'password123' })
      ).rejects.toThrow('Password must be at least 12 characters');
    });

    it('resetUserPassword rejects missing password and password < 12 characters without default', async () => {
      const mockPool: any = { query: vi.fn().mockResolvedValue({ rows: [] }) };
      const adminController = new AdminController(mockPool, {} as any);

      // Missing password
      await expect(
        adminController.resetUserPassword(10, { password: '' })
      ).rejects.toThrow(BadRequestException);

      // Password < 12 characters (rejects password123 default)
      await expect(
        adminController.resetUserPassword(10, { password: 'password123' })
      ).rejects.toThrow('Password must be at least 12 characters');
    });

    it('resetUserPassword updates password and bumps token_version for valid password >= 12 chars', async () => {
      const executedSqls: string[] = [];
      const mockPool: any = {
        query: vi.fn(async (sql: string) => {
          executedSqls.push(sql);
          if (sql.includes('UPDATE users SET password_hash = $1')) {
            return { rows: [{ id: 10 }] };
          }
          return { rows: [] };
        }),
      };
      const adminController = new AdminController(mockPool, {} as any);

      const res = await adminController.resetUserPassword(10, { password: 'StrongNewResetPassword123!' });
      expect(res.ok).toBe(true);
      const updateQuery = executedSqls.find((s) => s.includes('UPDATE users SET password_hash'));
      expect(updateQuery).toContain('token_version = COALESCE(token_version, 1) + 1');
      expect(executedSqls.some((s) => s.includes('DELETE FROM sessions'))).toBe(true);
    });
  });

  describe('Captcha endpoint removed (M1)', () => {
    it('verifies getCaptcha endpoint no longer exists on AuthController', () => {
      const mockPool: any = { query: vi.fn() };
      const authController = new AuthController(mockPool);
      expect((authController as any).getCaptcha).toBeUndefined();
    });
  });
});
