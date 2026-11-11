import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  Inject,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import crypto from 'crypto';
import { DB_POOL } from '../database/database.module.js';
import { verifyPassword, hashPassword } from './password.util.js';
import { generateSecret, verifyTotp, otpauthUrl } from './totp.util.js';
import { TenantGuard } from '../tenant/tenant.guard.js';

const LoginDto = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  totp: z.string().optional(),
});

const UpdateCredentialsDto = z.object({
  current_password: z.string().min(1, 'Current password is required'),
  new_username: z.string().optional(),
  new_password: z.string().optional(),
});

@Controller('api')
export class AuthController {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  @Post('auth/login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: any,
    @Req() req?: Request,
    @Res({ passthrough: true }) res?: Response
  ) {
    const parsed = LoginDto.safeParse(body);
    if (!parsed.success) {
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
      'SELECT id, username, role, client_id, password_hash, active FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1',
      [username.trim()]
    );

    if (userResult.rows.length === 0) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const dbUser = userResult.rows[0];
    if (dbUser.active === false) {
      throw new UnauthorizedException('Account has been deactivated. Please contact administrator.');
    }

    // C1: password is verified ONLY against the stored scrypt hash. The
    // old literal fallback checks for operator/admin/xyz were removed —
    // anyone reading the public repo could log in with them.
    const passwordValid = await verifyPassword(password, dbUser.password_hash);

    if (!passwordValid) {
      throw new UnauthorizedException('ইউজারনেম অথবা পাসওয়ার্ড সঠিক নয়। দয়া করে পুনরায় চেক করুন। (Invalid username or password)');
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

      const isTotpValid = verifyTotp(totpRow.secret_enc, code);
      if (!isTotpValid) {
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

    // Include strictly necessary claims with explicit expiration
    const token = jwt.sign(
      {
        sub: dbUser.id,
        username: dbUser.username,
        role: dbUser.role,
        clientId: dbUser.client_id,
      },
      jwtSecret,
      { expiresIn: '24h' }
    );

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

  @Get('auth/me')
  @UseGuards(TenantGuard)
  async me(@Req() req: any) {
    const userId = req.user?.id;
    const totpRes = await this.pool.query(
      'SELECT enabled FROM admin_totp WHERE user_id = $1 LIMIT 1',
      [userId]
    );
    const totpEnabled = totpRes.rows[0]?.enabled || false;

    return {
      user: {
        id: req.user?.id,
        username: req.user?.username,
        role: req.user?.role,
        clientId: req.user?.clientId,
        tenantId: req.user?.clientId,
        totp_enabled: totpEnabled,
      },
    };
  }

  @Get('auth/profile')
  @UseGuards(TenantGuard)
  async getProfile(@Req() req: any) {
    const userId = req.user?.id;
    const userRes = await this.pool.query(
      'SELECT id, username, role, client_id, active, created_at FROM users WHERE id = $1 LIMIT 1',
      [userId]
    );
    if (userRes.rows.length === 0) throw new UnauthorizedException('User not found');
    const u = userRes.rows[0];

    const totpRes = await this.pool.query(
      'SELECT enabled FROM admin_totp WHERE user_id = $1 LIMIT 1',
      [userId]
    );
    const totpEnabled = totpRes.rows[0]?.enabled || false;

    return {
      id: u.id,
      username: u.username,
      role: u.role,
      clientId: u.client_id,
      tenantId: u.client_id,
      active: u.active,
      created_at: u.created_at,
      totp_enabled: totpEnabled,
      user: {
        id: u.id,
        username: u.username,
        role: u.role,
        clientId: u.client_id,
        tenantId: u.client_id,
        active: u.active,
        created_at: u.created_at,
        totp_enabled: totpEnabled,
      },
    };
  }

  /**
   * Update Credentials:
   * - Admin can update their OWN username and password.
   * - Operators / Regular Users CANNOT change their username, but CAN update their own password.
   */
  @Post('auth/profile/credentials')
  @UseGuards(TenantGuard)
  async updateCredentials(@Req() req: any, @Body() body: any) {
    const parsed = UpdateCredentialsDto.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message || 'Invalid input');
    }

    const { current_password, new_username, new_password } = parsed.data;
    const userId = req.user?.id;

    const userRes = await this.pool.query(
      'SELECT id, username, role, password_hash, client_id FROM users WHERE id = $1 LIMIT 1',
      [userId]
    );
    if (userRes.rows.length === 0) throw new UnauthorizedException('User not found');
    const dbUser = userRes.rows[0];

    // 1. Verify current password (hash only — see C1 note in login()).
    const isCurrentValid = await verifyPassword(current_password, dbUser.password_hash);
    if (!isCurrentValid) {
      throw new BadRequestException('বর্তমান পাসওয়ার্ডটি সঠিক নয়। অনুগ্রহ করে সঠিক পাসওয়ার্ড দিন। (Current password incorrect)');
    }

    let updatedUsername = dbUser.username;

    // 2. Handle username change
    if (new_username && new_username.trim() !== dbUser.username) {
      const cleanUsername = new_username.trim();
      if (dbUser.role !== 'admin') {
        throw new ForbiddenException(
          'অপারেটর বা সাধারণ ইউজারদের ইউজারনেম পরিবর্তনের অনুমতি নেই। শুধুমাত্র পাসওয়ার্ড পরিবর্তন করা যাবে। (Operators cannot change username)'
        );
      }

      if (cleanUsername.length < 3) {
        throw new BadRequestException('Username must be at least 3 characters long');
      }

      // Check username collision
      const conflictRes = await this.pool.query(
        'SELECT id FROM users WHERE username = $1 AND id != $2 LIMIT 1',
        [cleanUsername, userId]
      );
      if (conflictRes.rows.length > 0) {
        throw new BadRequestException('এই ইউজারনেমটি ইতিমধ্যে ব্যবহৃত। অন্য একটি ইউজারনেম নির্বাচন করুন। (Username already in use)');
      }

      updatedUsername = cleanUsername;
    }

    // 3. Handle password change
    let updatedHash = dbUser.password_hash;
    if (new_password) {
      const cleanPassword = String(new_password).trim();
      if (cleanPassword.length < 6) {
        throw new BadRequestException('নতুন পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে। (Password must be at least 6 characters)');
      }
      updatedHash = await hashPassword(cleanPassword);
    }

    // 4. Save updates to database
    await this.pool.query(
      'UPDATE users SET username = $1, password_hash = $2 WHERE id = $3',
      [updatedUsername, updatedHash, userId]
    );

    // Issue refreshed token (C4: env-only JWT secret, fail closed).
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new Error('JWT_SECRET is required but not configured');
    }
    const newToken = jwt.sign(
      {
        sub: dbUser.id,
        username: updatedUsername,
        role: dbUser.role,
        clientId: dbUser.client_id,
      },
      jwtSecret,
      { expiresIn: '24h' }
    );

    return {
      ok: true,
      success: true,
      message: 'ক্রেডেনশিয়ালস সফলভাবে আপডেট করা হয়েছে। (Credentials updated successfully)',
      user: {
        id: dbUser.id,
        username: updatedUsername,
        role: dbUser.role,
        clientId: dbUser.client_id,
      },
      token: newToken,
    };
  }

  // ================= 2FA (TOTP) MANAGEMENT =================

  @Get('auth/profile/2fa/status')
  @UseGuards(TenantGuard)
  async getTotpStatus(@Req() req: any) {
    const userId = req.user?.id;
    const row = await this.pool.query(
      'SELECT enabled FROM admin_totp WHERE user_id = $1 LIMIT 1',
      [userId]
    );
    return { enabled: row.rows[0]?.enabled || false };
  }

  @Post('auth/profile/2fa/setup')
  @UseGuards(TenantGuard)
  async setupTotp(@Req() req: any, @Body() body: { password?: string }) {
    const userId = req.user?.id;
    if (!body.password) {
      throw new BadRequestException('পাসওয়ার্ড প্রদান করা আবশ্যক। (Password required to set up 2FA)');
    }

    const uRes = await this.pool.query('SELECT password_hash, username FROM users WHERE id = $1', [userId]);
    const u = uRes.rows[0];
    const ok = await verifyPassword(body.password, u.password_hash);
    if (!ok) {
      throw new BadRequestException('পাসওয়ার্ড সঠিক নয়। (Incorrect password)');
    }

    const secret = generateSecret();
    await this.pool.query(
      `INSERT INTO admin_totp (user_id, secret_enc, enabled, created_at)
       VALUES ($1, $2, false, NOW())
       ON CONFLICT (user_id) DO UPDATE SET secret_enc = excluded.secret_enc, enabled = false`,
      [userId, secret]
    );

    const uri = otpauthUrl(secret, u.username, 'Tectobox');
    return {
      ok: true,
      secret,
      otpauth_url: uri,
    };
  }

  @Post('auth/profile/2fa/verify-enable')
  @UseGuards(TenantGuard)
  async enableTotp(@Req() req: any, @Body() body: { token?: string; code?: string }) {
    const userId = req.user?.id;
    const token = String(body.token || body.code || '').trim();
    if (!/^\d{6}$/.test(token)) {
      throw new BadRequestException('সঠিক ৬-সংখ্যার কোডটি দিন। (Invalid 6-digit code format)');
    }

    const row = await this.pool.query('SELECT secret_enc FROM admin_totp WHERE user_id = $1 LIMIT 1', [userId]);
    if (row.rows.length === 0) {
      throw new BadRequestException('2FA সেটআপ প্রক্রিয়া পুনরায় শুরু করুন। (2FA setup not initiated)');
    }

    const valid = verifyTotp(row.rows[0].secret_enc, token);
    if (!valid) {
      throw new BadRequestException('কোডটি মেলেনি। অনুগ্রহ করে আপনার প্রমাণীকরণ অ্যাপটি পরীক্ষা করুন। (Invalid 2FA code)');
    }

    await this.pool.query('UPDATE admin_totp SET enabled = true WHERE user_id = $1', [userId]);
    return { ok: true, success: true, message: 'টু-ফ্যাক্টর অথেন্টিকেশন সফলভাবে সক্রিয় করা হয়েছে। (2FA enabled)' };
  }

  @Post('auth/profile/2fa/disable')
  @UseGuards(TenantGuard)
  async disableTotp(@Req() req: any, @Body() body: { password?: string }) {
    const userId = req.user?.id;
    if (!body.password) {
      throw new BadRequestException('2FA নিষ্ক্রিয় করতে বর্তমান পাসওয়ার্ড দিন। (Password required)');
    }

    const uRes = await this.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    const ok = await verifyPassword(body.password, uRes.rows[0].password_hash);
    if (!ok) {
      throw new BadRequestException('পাসওয়ার্ড সঠিক নয়। (Incorrect password)');
    }

    await this.pool.query('DELETE FROM admin_totp WHERE user_id = $1', [userId]);
    return { ok: true, success: true, message: 'টু-ফ্যাক্টর অথেন্টিকেশন নিষ্ক্রিয় করা হয়েছে। (2FA disabled)' };
  }

  @Post('auth/logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res?: Response
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

  @Get('captcha')
  getCaptcha() {
    return { token: 'bypass', svg: '<svg></svg>' };
  }
}


