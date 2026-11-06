import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthController } from './auth.controller.js';
import { hashPassword } from './password.util.js';
import { UnauthorizedException } from '@nestjs/common';

describe('AuthController', () => {
  let controller: AuthController;
  let mockPool: any;

  beforeEach(() => {
    process.env.JWT_SECRET = 'test_jwt_secret_12345';
    mockPool = {
      // Default: every query returns a rows-shaped result. login() issues
      // three queries (user lookup, admin_totp, session insert); tests
      // override the first call with mockResolvedValueOnce for the user row.
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
    controller = new AuthController(mockPool);
  });

  it('authenticates user with correct scrypt password and returns valid token', async () => {
    const rawPw = 'SuperSecret123!';
    const hashed = await hashPassword(rawPw);

    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 10,
          username: 'merchant_bob',
          role: 'client',
          client_id: 42,
          password_hash: hashed,
        },
      ],
    });

    const res = await controller.login({
      username: 'merchant_bob',
      password: rawPw,
    });

    expect(res.success).toBe(true);
    expect(res.user.username).toBe('merchant_bob');
    expect(res.user.tenantId).toBe(42);
    expect(typeof res.token).toBe('string');
  });

  it('rejects login with incorrect password', async () => {
    const hashed = await hashPassword('CorrectPassword123');
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 10,
          username: 'merchant_bob',
          role: 'client',
          client_id: 42,
          password_hash: hashed,
        },
      ],
    });

    await expect(
      controller.login({
        username: 'merchant_bob',
        password: 'WrongPassword456',
      })
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects login for unknown user', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [],
    });

    await expect(
      controller.login({
        username: 'non_existent_user',
        password: 'AnyPassword',
      })
    ).rejects.toThrow(UnauthorizedException);
  });

  it('fails closed when JWT_SECRET is unset in environment', async () => {
    delete process.env.JWT_SECRET;

    await expect(
      controller.login({
        username: 'any_user',
        password: 'AnyPassword',
      })
    ).rejects.toThrow('JWT_SECRET is required but not configured');
  });
});
