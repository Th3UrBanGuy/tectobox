import { HttpStatus, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import crypto from 'crypto';
import { verifyPassword } from './password.util.js';
import { EventsService } from '../events/events.service.js';
import { TotpService } from './totp.service.js';

const LoginDto = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  totp: z.string().optional(),
});

/**
 * Session handling: login + logout.
 *
 * Split out of `AuthController` (Phase 3 of the modular restructure).
 * Code moved verbatim; no behaviour change. The 7-day session cookie,
 * the JWT claims, the response shapes, and the query order are all
 * preserved. The one deliberate fix: the TOTP check now goes through
 * `TotpService.verifyCode` (decrypt-aware) instead of raw
 * `verifyTotp(secret_enc, code)` — the raw check failed on any secret
 * set up via the admin endpoint (which stores it encrypted), locking
 * those users out of login.
 *
 * The brute-force guard (≥10 failed logins → 15-min 429 per IP) is
 * NOT here — it lives in `rate-limit.middleware.ts`, wired in
 * `main.ts`, and is untouched by this split.
 */
export class SessionService {
  private readonly totp: TotpService;

  constructor(
    private readonly pool: pg.Pool,
    private readonly eventsService?: EventsService
  ) {
    this.totp = new TotpService(pool);
  }

  private getEvents(): EventsService {
    return this.eventsService || new EventsService(this.pool, undefined as any);
  }

  async login(
    body: any,
    req?: Request,
    res?: Response
  ) {
    const ip = (req?.headers?.['x-forwarded-for'] as string) || req?.socket?.remoteAddress || '127.0.0.1';
    const parsed = LoginDto.safeParse(body);
    if (!parsed.success) {
      await this.getEvents().writeAudit(null, null, 'login:failure', { reason: 'invalid_format', ip });
      throw new UnauthorizedException('Invalid login credentials format');
    }

    const { username, password, totp } = parsed.data;
    // C4: JWT secret comes from the environment only — no fallback. If it is
    // missing the login fails closed instead of signing with a known value.
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new Error('JWT_SECRET is required but not configured');
    }

    // Query user in PostgreSQL case-insensitively
    const userResult = await this.pool.query(
      'SELECT id, username, role, client_id, password_hash, active, token_version FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1',
      [username.trim()]
    );

    if (userResult.rows.length === 0) {
      await this.getEvents().writeAudit(null, null, 'login:failure', { username, reason: 'user_not_found', ip });
      throw new UnauthorizedException('Invalid username or password');
    }

    const dbUser = userResult.rows[0];
    if (dbUser.active === false) {
      await this.getEvents().writeAudit(dbUser.id, dbUser.client_id, 'login:failure', { username, reason: 'account_deactivated', ip });
      throw new UnauthorizedException('Account has been deactivated. Please contact administrator.');
    }

    // C1: password is verified ONLY against the stored scrypt hash. The
    // old literal fallback checks for operator/admin/xyz were removed —
    // anyone reading the public repo could log in with them.
    const passwordValid = await verifyPassword(password, dbUser.password_hash);

    if (!passwordValid) {
      await this.getEvents().writeAudit(dbUser.id, dbUser.client_id, 'login:failure', { username, reason: 'invalid_password', ip });
      throw new UnauthorizedException('ইউজারনেম অথবা পাসওয়ার্ড সঠিক নয়। দয়া করে পুনরায় চেক করুন। (Invalid username or password)');
    }

    // Suspended workspace: no login, even with a valid password. Platform
    // admins have no workspace (client_id NULL) and are never blocked here.
    if (dbUser.client_id != null) {
      const wsRes = await this.pool.query(
        'SELECT suspended FROM clients WHERE id = $1 LIMIT 1',
        [dbUser.client_id]
      );
      if (wsRes.rows[0]?.suspended) {
        await this.getEvents().writeAudit(dbUser.id, dbUser.client_id, 'login:failure', { username, reason: 'workspace_suspended', ip });
        throw new UnauthorizedException('This workspace has been suspended. Please contact the platform admin.');
      }
    }

    // Check if Two-Factor Authentication (2FA) is enabled for this user
    const totpRes = await this.pool.query(
      'SELECT enabled, secret_enc FROM admin_totp WHERE user_id = $1 LIMIT 1',
      [dbUser.id]
    );
    const totpRow = totpRes.rows[0];
    if (totpRow && totpRow.enabled) {
      const code = String(totp || '').trim();
      if (!code) {
        await this.getEvents().writeAudit(dbUser.id, dbUser.client_id, 'login:failure', { username, reason: 'totp_required', ip });
        if (res && typeof res.status === 'function') {
          return res.status(HttpStatus.UNAUTHORIZED).json({
            ok: false,
            totp_required: true,
            error: 'Enter your 6-digit two-factor authentication code.',
          });
        }
        throw new UnauthorizedException({
          totp_required: true,
          error: 'Enter your 6-digit two-factor authentication code.',
        });
      }

      const isTotpValid = this.totp.verifyCode(totpRow.secret_enc, code);
      if (!isTotpValid) {
        await this.getEvents().writeAudit(dbUser.id, dbUser.client_id, 'login:failure', { username, reason: 'totp_invalid', ip });
        if (res && typeof res.status === 'function') {
          return res.status(HttpStatus.UNAUTHORIZED).json({
            ok: false,
            totp_required: true,
            error: 'Invalid two-factor authentication code. Please check your authenticator app.',
          });
        }
        throw new UnauthorizedException({
          totp_required: true,
          error: 'Invalid two-factor authentication code. Please check your authenticator app.',
        });
      }
    }

    // Generate session ID for cookie-based authentication
    const sid = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000); // 7 days

    try {
      await this.pool.query(
        `INSERT INTO sessions (id, user_id, expires_at, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [sid, dbUser.id, expiresAt]
      );
    } catch (err) {
      console.error('[auth] Failed to persist session:', err);
    }

    // Set cookie if response object is available (passthrough)
    if (res && typeof res.setHeader === 'function') {
      const isHttps = Boolean(
        req?.secure ||
        req?.headers?.['x-forwarded-proto'] === 'https' ||
        (process.env.COOKIE_SECURE === 'true')
      );
      res.setHeader(
        'Set-Cookie',
        `tb_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${isHttps ? '; Secure' : ''}`
      );
    }

    // Include strictly necessary claims with explicit expiration and pinned algorithm
    const token = jwt.sign(
      {
        sub: dbUser.id,
        username: dbUser.username,
        role: dbUser.role,
        clientId: dbUser.client_id,
        token_version: dbUser.token_version ?? 1,
        tokenVersion: dbUser.token_version ?? 1,
      },
      jwtSecret,
      { expiresIn: '24h', algorithm: 'HS256' }
    );

    await this.getEvents().writeAudit(dbUser.id, dbUser.client_id, 'login', { username: dbUser.username, ip });

    return {
      ok: true,
      success: true,
      user: {
        id: dbUser.id,
        username: dbUser.username,
        role: dbUser.role,
        tenantId: dbUser.client_id,
        clientId: dbUser.client_id,
      },
      token,
    };
  }

  async logout(
    req: Request,
    res?: Response
  ) {
    const sid = req.cookies?.tb_session || req.headers?.cookie?.match(/tb_session=([^;]+)/)?.[1];
    if (sid) {
      await this.pool.query('DELETE FROM sessions WHERE id = $1', [sid]).catch(() => {});
    }

    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Set-Cookie', 'tb_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    }

    return { ok: true, success: true };
  }
}
