import pg from 'pg';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { verifyPassword } from './password.util.js';
import { generateSecret, verifyTotp, otpauthUrl } from './totp.util.js';
import { encrypt, decrypt, isEncrypted } from '../common/crypto.js';

export type TotpErrorCode =
  | 'user_not_found'
  | 'wrong_password'
  | 'not_configured'
  | 'invalid_code'
  | 'auth_required';

/**
 * Thrown by `TotpService` when a TOTP operation cannot proceed. The
 * `code` lets each endpoint keep its exact user-facing message:
 * the admin endpoints use the canonical (English) message carried
 * here, the auth endpoints map the codes to their Bengali messages.
 */
export class TotpError extends Error {
  constructor(
    public readonly code: TotpErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'TotpError';
  }
}

/**
 * Converts a `TotpError` into the Nest HTTP exception the admin
 * endpoints raise (their messages are the canonical ones carried by
 * the error). Non-TotpError values pass through unchanged.
 */
export function totpErrorToHttp(err: unknown): unknown {
  if (!(err instanceof TotpError)) return err;
  switch (err.code) {
    case 'user_not_found':
      return new NotFoundException(err.message);
    case 'auth_required':
      return new UnauthorizedException(err.message);
    default:
      return new BadRequestException(err.message);
  }
}

/**
 * The ONE TOTP implementation (Phase 3 of the modular restructure).
 * Merges the auth endpoints' TOTP (which stored secrets raw and
 * verified them raw) with the admin endpoints' TOTP (encrypted
 * storage, decrypt-aware verify, migrate-on-read, fuller status).
 * The union wins on every difference:
 *
 * - encrypted storage everywhere (`encrypt(secret)`),
 * - decrypt-aware verify + migrate-on-read (legacy raw secrets are
 *   encrypted on first successful use),
 * - status returns `{enabled, configured}`,
 * - user-existence `NotFoundException` check,
 * - userId `UnauthorizedException` check.
 *
 * Login's TOTP check uses `verifyCode` (decrypt-aware): the old raw
 * `verifyTotp(secret_enc, code)` in login failed on any secret set
 * up via the admin endpoint, locking those users out.
 */
export class TotpService {
  constructor(private readonly pool: pg.Pool) {}

  private requireUserId(userId: any): number {
    if (!userId) throw new TotpError('auth_required', 'Authentication required');
    return userId;
  }

  async getStatus(userId: any): Promise<{ enabled: boolean; configured: boolean }> {
    const uid = this.requireUserId(userId);
    const row = await this.pool.query('SELECT enabled, secret_enc FROM admin_totp WHERE user_id = $1', [uid]);
    const r = row.rows[0];
    return {
      enabled: Boolean(r?.enabled),
      configured: Boolean(r?.secret_enc),
    };
  }

  async setup(userId: any, password: string): Promise<{ secret: string; otpauth_url: string }> {
    const uid = this.requireUserId(userId);
    const uRes = await this.pool.query('SELECT password_hash, username FROM users WHERE id = $1', [uid]);
    const user = uRes.rows[0];
    if (!user) throw new TotpError('user_not_found', 'User not found');
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      throw new TotpError('wrong_password', 'Incorrect password');
    }

    const secret = generateSecret(20);
    const encryptedSecret = encrypt(secret);
    await this.pool.query(
      `INSERT INTO admin_totp (user_id, secret_enc, enabled, created_at)
       VALUES ($1, $2, false, NOW())
       ON CONFLICT (user_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, enabled = false`,
      [uid, encryptedSecret]
    );
    return {
      secret,
      otpauth_url: otpauthUrl(secret, user.username || 'admin@tectobox.com'),
    };
  }

  async enable(userId: any, token: string): Promise<{ ok: true; enabled: true }> {
    const uid = this.requireUserId(userId);
    const row = await this.pool.query('SELECT secret_enc FROM admin_totp WHERE user_id = $1', [uid]);
    const r = row.rows[0];
    if (!r?.secret_enc) throw new TotpError('not_configured', 'TOTP setup required first');

    const storedSecret = r.secret_enc;
    const isEnc = isEncrypted(storedSecret);
    const secret = isEnc ? decrypt(storedSecret) : storedSecret;

    const ok = verifyTotp(secret, token);
    if (!ok) {
      throw new TotpError('invalid_code', 'Invalid code — check your authenticator app clock.');
    }

    // Migrate-on-read: if an existing stored secret is not encrypted (no version prefix), encrypt it on first successful use.
    if (!isEnc) {
      const newlyEncrypted = encrypt(secret);
      await this.pool.query('UPDATE admin_totp SET enabled = true, secret_enc = $1 WHERE user_id = $2', [newlyEncrypted, uid]);
    } else {
      await this.pool.query('UPDATE admin_totp SET enabled = true WHERE user_id = $1', [uid]);
    }
    return { ok: true, enabled: true };
  }

  async disable(userId: any, password: string): Promise<{ ok: true; enabled: false }> {
    const uid = this.requireUserId(userId);
    const uRes = await this.pool.query('SELECT password_hash FROM users WHERE id = $1', [uid]);
    const user = uRes.rows[0];
    if (!user) throw new TotpError('user_not_found', 'User not found');
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      throw new TotpError('wrong_password', 'Incorrect password');
    }

    await this.pool.query('DELETE FROM admin_totp WHERE user_id = $1', [uid]);
    return { ok: true, enabled: false };
  }

  /**
   * Decrypt-aware TOTP verification for the login flow: decrypts the
   * stored secret when it carries the encryption prefix, otherwise
   * verifies the raw secret (legacy rows, migrated on next enable).
   */
  verifyCode(storedSecret: string, code: string): boolean {
    const secret = isEncrypted(storedSecret) ? decrypt(storedSecret) : storedSecret;
    return verifyTotp(secret, code);
  }
}
