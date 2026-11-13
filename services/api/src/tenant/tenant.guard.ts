import { CanActivate, ExecutionContext, Injectable, ForbiddenException, UnauthorizedException, Optional, Inject } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import crypto from 'crypto';
import { DB_POOL } from '../database/database.module.js';

export interface AuthenticatedUser {
  id: number;
  username: string;
  role: 'admin' | 'client';
  clientId: number | null;
}

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(@Optional() @Inject(DB_POOL) private readonly pool?: pg.Pool) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // If request.user was already set by upstream middleware/test fixture, use it
    let user: AuthenticatedUser | undefined = request.user;

    if (!user) {
      const authHeader = request.headers?.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        return this.validateBearerToken(token, request);
      } else {
        const sid = request.cookies?.tb_session || request.headers?.cookie?.match(/tb_session=([^;]+)/)?.[1];
        if (sid && this.pool) {
          return this.validateSessionCookie(sid, request);
        }
      }
    }

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    return this.assignTenant(user, request);
  }

  private async validateBearerToken(token: string, request: any): Promise<boolean> {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new UnauthorizedException('Authentication secret not configured');
    }

    let decoded: any;
    try {
      // Pin algorithm explicitly to HS256 (L8)
      decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException('Invalid or expired authentication token');
    }

    const userId = decoded.sub || decoded.id;
    if (!userId) {
      throw new UnauthorizedException('Invalid or expired authentication token');
    }

    // Session revocation check (H3): verify token_version matches DB row
    if (this.pool) {
      const userRes = await this.pool.query(
        'SELECT id, username, role, client_id, active, token_version FROM users WHERE id = $1 LIMIT 1',
        [userId]
      );
      if (userRes.rows.length === 0 || userRes.rows[0].active === false) {
        throw new UnauthorizedException('Invalid or expired authentication token');
      }
      const dbVersion = userRes.rows[0].token_version ?? 1;
      const tokenVersion = decoded.token_version ?? decoded.tokenVersion;
      if (tokenVersion === undefined || tokenVersion !== dbVersion) {
        throw new UnauthorizedException('Token revoked');
      }
    }

    const user: AuthenticatedUser = {
      id: userId,
      username: decoded.username,
      role: decoded.role,
      clientId: decoded.clientId ?? null,
    };
    request.user = user;

    return this.assignTenant(user, request);
  }

  private async validateSessionCookie(sid: string, request: any): Promise<boolean> {
    if (!this.pool) throw new UnauthorizedException('Authentication required');
    try {
      const res = await this.pool.query(
        `SELECT u.id, u.username, u.role, u.client_id, u.active
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.id = $1 AND s.expires_at > NOW() AND u.active = true
         LIMIT 1`,
        [sid]
      );

      if (res.rows.length === 0) {
        throw new UnauthorizedException('Invalid or expired session');
      }

      const row = res.rows[0];
      const user: AuthenticatedUser = {
        id: row.id,
        username: row.username,
        role: row.role,
        clientId: row.client_id ?? null,
      };
      request.user = user;
      return this.assignTenant(user, request);
    } catch (err: any) {
      if (err instanceof UnauthorizedException || err instanceof ForbiddenException) throw err;
      throw new UnauthorizedException('Authentication verification failed');
    }
  }

  private async assignTenant(user: AuthenticatedUser, request: any): Promise<boolean> {
    // Role-based tenant assignment: only genuine admins can perform cross-tenant access via header/query
    if (user.role === 'admin' || (user.role as any) === 'superadmin') {
      const headerVal = request.headers?.['x-tenant-id'];
      const queryVal = request.query?.client_id || request.query?.clientId;
      const overrideVal = headerVal || queryVal;
      const overrideTenantId = overrideVal ? Number(overrideVal) : null;
      request.tenantId = (overrideTenantId && !isNaN(overrideTenantId)) ? overrideTenantId : (user.clientId ?? null);
      // Admins are never blocked by suspension: they must be able to open
      // a suspended workspace to unsuspend it.
      return true;
    }

    // Standard client / operator role: auto-heal if no clientId
    if (!user.clientId) {
      if (this.pool) {
        try {
          const wsRes = await this.pool.query(
            `INSERT INTO clients (name, business_type, widget_key, created_at)
             VALUES ($1, 'physical', $2, NOW())
             RETURNING id`,
            [`${user.username}'s Workspace`, crypto.randomBytes(16).toString('hex')]
          );
          const newCid = wsRes.rows[0].id;
          await this.pool.query('UPDATE users SET client_id = $1 WHERE id = $2', [newCid, user.id]);
          user.clientId = newCid;
          request.tenantId = newCid;
          // Freshly created workspaces are never suspended (column default).
          return true;
        } catch {
          // fall through to exception
        }
      }
      throw new ForbiddenException('No tenant workspace associated with this user');
    }

    request.tenantId = user.clientId;
    await this.assertTenantNotSuspended(user.clientId);
    return true;
  }

  /**
   * Suspended workspaces get 403 on every tenant API. Admins bypass this
   * (see assignTenant). No pool (unit-constructed guard) means the check
   * cannot run — it is skipped, matching the guard's Optional pool pattern.
   */
  private async assertTenantNotSuspended(tenantId: number): Promise<void> {
    if (!this.pool) return;
    const res = await this.pool.query(
      'SELECT suspended FROM clients WHERE id = $1 LIMIT 1',
      [tenantId]
    );
    if (res.rows[0]?.suspended) {
      throw new ForbiddenException('This workspace has been suspended. Please contact the platform admin.');
    }
  }
}

