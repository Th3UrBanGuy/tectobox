import { CanActivate, ExecutionContext, Injectable, ForbiddenException, UnauthorizedException, Optional, Inject } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import pg from 'pg';
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
        const jwtSecret = process.env.JWT_SECRET || 'tectobox_jwt_dev_secret_key_2026';

        let decoded: any;
        try {
          decoded = jwt.verify(token, jwtSecret);
        } catch {
          throw new UnauthorizedException('Invalid or expired authentication token');
        }

        user = {
          id: decoded.sub || decoded.id,
          username: decoded.username,
          role: decoded.role,
          clientId: decoded.clientId ?? null,
        };
        request.user = user;
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

  private assignTenant(user: AuthenticatedUser, request: any): boolean {
    // Role-based tenant assignment: only genuine admins can perform cross-tenant access via header/query
    if (user.role === 'admin' || (user.role as any) === 'superadmin') {
      const headerVal = request.headers?.['x-tenant-id'];
      const queryVal = request.query?.client_id || request.query?.clientId;
      const overrideVal = headerVal || queryVal;
      const overrideTenantId = overrideVal ? Number(overrideVal) : null;
      request.tenantId = (overrideTenantId && !isNaN(overrideTenantId)) ? overrideTenantId : (user.clientId || 1);
      return true;
    }

    // Standard client role: NEVER allow x-tenant-id header override
    if (!user.clientId) {
      throw new ForbiddenException('No tenant workspace associated with this user');
    }

    request.tenantId = user.clientId;
    return true;
  }
}

