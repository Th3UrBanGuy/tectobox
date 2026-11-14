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
  NotFoundException,
  Inject,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { DB_POOL } from '../database/database.module.js';
import { verifyPassword, hashPassword } from './password.util.js';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { EventsService } from '../events/events.service.js';
import { Optional } from '@nestjs/common';
import { SessionService } from './session.service.js';
import { TotpService, TotpError, totpErrorToHttp } from './totp.service.js';

const UpdateCredentialsDto = z.object({
  current_password: z.string().min(1, 'Current password is required'),
  new_username: z.string().optional(),
  new_password: z.string().optional(),
});

/**
 * Auth controller (Phase 3 of the modular restructure). `login` and
 * `logout` now delegate to `SessionService`; the 2FA endpoints
 * delegate to the shared `TotpService` (the same implementation the
 * admin endpoints use). `me`, `getProfile`, and `updateCredentials`
 * stay inline, moved verbatim. The constructor signature is unchanged.
 *
 * TOTP messages stay the auth endpoints' own Bengali ones: the
 * controller checks password presence / code format itself, then
 * maps the service's `TotpError` codes to those messages.
 */
@Controller('api')
export class AuthController {
  private readonly session: SessionService;
  private readonly totp: TotpService;

  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Optional() private readonly eventsService?: EventsService
  ) {
    this.session = new SessionService(pool, eventsService);
    this.totp = new TotpService(pool);
  }

  @Post('auth/login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: any,
    @Req() req?: Request,
    @Res({ passthrough: true }) res?: Response
  ) {
    return this.session.login(body, req, res);
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
      'SELECT id, username, role, password_hash, client_id, token_version FROM users WHERE id = $1 LIMIT 1',
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
    let passwordChanged = false;
    if (new_password) {
      const cleanPassword = String(new_password).trim();
      if (cleanPassword.length < 12) {
        throw new BadRequestException('নতুন পাসওয়ার্ড কমপক্ষে ১২ অক্ষরের হতে হবে। (Password must be at least 12 characters)');
      }
      updatedHash = await hashPassword(cleanPassword);
      passwordChanged = true;
    }

    let newTokenVersion = dbUser.token_version ?? 1;

    // 4. Save updates to database
    if (passwordChanged) {
      newTokenVersion = (dbUser.token_version ?? 1) + 1;
      await this.pool.query(
        'UPDATE users SET username = $1, password_hash = $2, token_version = $3 WHERE id = $4',
        [updatedUsername, updatedHash, newTokenVersion, userId]
      );
      // Invalidate existing cookie sessions
      await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]).catch(() => {});
    } else {
      await this.pool.query(
        'UPDATE users SET username = $1, password_hash = $2 WHERE id = $3',
        [updatedUsername, updatedHash, userId]
      );
    }

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
        token_version: newTokenVersion,
        tokenVersion: newTokenVersion,
      },
      jwtSecret,
      { expiresIn: '24h', algorithm: 'HS256' }
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
  // Delegates to the shared TotpService (one implementation for the
  // auth and admin endpoints). This controller keeps its own Bengali
  // messages: password-presence / code-format checks happen here,
  // then TotpError codes map to the messages below. The status
  // endpoint returns only `{enabled: ...}` (the service's fuller
  // `{enabled, configured}` shape is the admin endpoint's).

  @Get('auth/profile/2fa/status')
  @UseGuards(TenantGuard)
  async getTotpStatus(@Req() req: any) {
    try {
      const { enabled } = await this.totp.getStatus(req.user?.id);
      return { enabled };
    } catch (err) {
      throw totpErrorToHttp(err);
    }
  }

  @Post('auth/profile/2fa/setup')
  @UseGuards(TenantGuard)
  async setupTotp(@Req() req: any, @Body() body: { password?: string }) {
    if (!body.password) {
      throw new BadRequestException('পাসওয়ার্ড প্রদান করা আবশ্যক। (Password required to set up 2FA)');
    }
    try {
      const { secret, otpauth_url } = await this.totp.setup(req.user?.id, body.password);
      return {
        ok: true,
        secret,
        otpauth_url,
      };
    } catch (err) {
      if (err instanceof TotpError && err.code === 'wrong_password') {
        throw new BadRequestException('পাসওয়ার্ড সঠিক নয়। (Incorrect password)');
      }
      throw totpErrorToHttp(err);
    }
  }

  @Post('auth/profile/2fa/verify-enable')
  @UseGuards(TenantGuard)
  async enableTotp(@Req() req: any, @Body() body: { token?: string; code?: string }) {
    const token = String(body.token || body.code || '').trim();
    if (!/^\d{6}$/.test(token)) {
      throw new BadRequestException('সঠিক ৬-সংখ্যার কোডটি দিন। (Invalid 6-digit code format)');
    }
    try {
      await this.totp.enable(req.user?.id, token);
    } catch (err) {
      if (err instanceof TotpError && err.code === 'not_configured') {
        throw new BadRequestException('2FA সেটআপ প্রক্রিয়া পুনরায় শুরু করুন। (2FA setup not initiated)');
      }
      if (err instanceof TotpError && err.code === 'invalid_code') {
        throw new BadRequestException('কোডটি মেলেনি। অনুগ্রহ করে আপনার প্রমাণীকরণ অ্যাপটি পরীক্ষা করুন। (Invalid 2FA code)');
      }
      throw totpErrorToHttp(err);
    }
    return { ok: true, success: true, message: 'টু-ফ্যাক্টর অথেন্টিকেশন সফলভাবে সক্রিয় করা হয়েছে। (2FA enabled)' };
  }

  @Post('auth/profile/2fa/disable')
  @UseGuards(TenantGuard)
  async disableTotp(@Req() req: any, @Body() body: { password?: string }) {
    if (!body.password) {
      throw new BadRequestException('2FA নিষ্ক্রিয় করতে বর্তমান পাসওয়ার্ড দিন। (Password required)');
    }
    try {
      await this.totp.disable(req.user?.id, body.password);
    } catch (err) {
      if (err instanceof TotpError && err.code === 'wrong_password') {
        throw new BadRequestException('পাসওয়ার্ড সঠিক নয়। (Incorrect password)');
      }
      throw totpErrorToHttp(err);
    }
    return { ok: true, success: true, message: 'টু-ফ্যাক্টর অথেন্টিকেশন নিষ্ক্রিয় করা হয়েছে। (2FA disabled)' };
  }

  @Post('auth/logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res?: Response
  ) {
    return this.session.logout(req, res);
  }
}
