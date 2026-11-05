import { Controller, Post, Get, Body, Req, Res, HttpCode, HttpStatus, UnauthorizedException, Inject, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import crypto from 'crypto';
import { DB_POOL } from '../database/database.module.js';
import { verifyPassword } from './password.util.js';
import { TenantGuard } from '../tenant/tenant.guard.js';

const LoginDto = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

@Controller('api')
export class AuthController {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  @Post('auth/login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: any,
    @Res({ passthrough: true }) res?: Response
  ) {
    const parsed = LoginDto.safeParse(body);
    if (!parsed.success) {
      throw new UnauthorizedException('Invalid login credentials format');
    }

    const { username, password } = parsed.data;
    const jwtSecret =
      process.env.JWT_SECRET ||
      (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test'
        ? 'tectobox_jwt_dev_secret_key_2026'
        : undefined);
    if (!jwtSecret) {
      throw new Error('JWT_SECRET is required but not configured');
    }

    // Query user in PostgreSQL
    const userResult = await this.pool.query(
      'SELECT id, username, role, client_id, password_hash FROM users WHERE username = $1 LIMIT 1',
      [username]
    );

    if (userResult.rows.length === 0) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const dbUser = userResult.rows[0];
    const passwordValid = await verifyPassword(password, dbUser.password_hash);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid username or password');
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
      const isProd = process.env.NODE_ENV === 'production';
      res.setHeader(
        'Set-Cookie',
        `tb_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${isProd ? '; Secure' : ''}`
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
    return {
      user: {
        id: req.user?.id,
        username: req.user?.username,
        role: req.user?.role,
        clientId: req.user?.clientId,
        tenantId: req.user?.clientId,
      },
    };
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

