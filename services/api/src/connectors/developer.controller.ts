import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  Inject,
  ParseIntPipe,
  BadRequestException,
} from '@nestjs/common';
import type { Request } from 'express';
import crypto, { randomBytes } from 'crypto';
import pg from 'pg';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { RequireFeature } from '../licensing/feature.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { DB_POOL } from '../database/database.module.js';

/**
 * Public base URL for inbound webhook URLs shown in the UI.
 * Priority: BASE_URL env -> PUBLIC_URL env -> DOMAIN env (the public
 * hostname Caddy serves, e.g. box.tect0nic.com) -> the incoming request's
 * Host + X-Forwarded-Proto (Caddy forwards both) -> localhost fallback
 * for local dev. No production host is hardcoded here.
 */
function resolvePublicBaseUrl(req: Request): string {
  const fromEnv = normalizeBaseUrl(process.env.BASE_URL || process.env.PUBLIC_URL || '');
  if (fromEnv) return fromEnv;
  const domain = normalizeBaseUrl(process.env.DOMAIN || '');
  if (domain) return domain;
  const host = req.get?.('host');
  if (host) {
    const forwarded = String(req.headers?.['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim();
    const proto = forwarded || (req.secure ? 'https' : 'http');
    return `${proto}://${host}`;
  }
  return 'http://localhost:3000';
}

function normalizeBaseUrl(raw: string): string {
  // Blank values (incl. a bare '/' from a build tool's default base) mean
  // "not configured" — never turn them into a bare 'https://'.
  let url = String(raw).trim().replace(/\/+$/, '');
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

/**
 * Developer surface: public webhook URLs, API keys, outbound webhooks.
 *
 * Split out of `ConnectorsController` (Phase 3 of the modular
 * restructure). Methods moved verbatim; no behaviour change.
 * `getWebhookUrls` stays unguarded, exactly as before.
 */
@Controller('api')
export class DeveloperController {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool
  ) {}

  @Get('webhook-urls')
  getWebhookUrls(@Req() req: Request) {
    const host = resolvePublicBaseUrl(req);
    return {
      meta: `${host}/webhooks/meta`,
      telegram: `${host}/webhooks/telegram`,
    };
  }

  @Get('clients/:clientId/api-keys')
  @UseGuards(TenantGuard)
  async getApiKeys(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number
  ) {
    const target = tenantId || clientId;
    const rows = await this.pool.query(
      'SELECT id, name, key_prefix, revoked, last_used_at, created_at FROM api_keys WHERE client_id = $1 AND NOT revoked ORDER BY id DESC',
      [target]
    );
    return rows.rows;
  }

  @Post('clients/:clientId/api-keys')
  @UseGuards(TenantGuard, RequireFeature('api_access'))
  async createApiKey(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number,
    @Body() body: { name?: string }
  ) {
    const target = tenantId || clientId;
    const name = String(body?.name || 'integration').trim().slice(0, 60);
    const raw = 'tk_' + randomBytes(24).toString('hex');
    const prefix = raw.slice(0, 8);
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const result = await this.pool.query(
      `INSERT INTO api_keys (client_id, name, key_hash, key_prefix, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, name, key_prefix`,
      [target, name, hash, prefix]
    );
    return { ...result.rows[0], api_key: raw };
  }

  @Delete('clients/:clientId/api-keys/:id')
  @UseGuards(TenantGuard)
  async deleteApiKey(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number,
    @Param('id', ParseIntPipe) id: number
  ) {
    const target = tenantId || clientId;
    await this.pool.query(
      'UPDATE api_keys SET revoked = true WHERE id = $1 AND client_id = $2',
      [id, target]
    );
    return { ok: true, success: true };
  }

  @Get('clients/:clientId/webhooks')
  @UseGuards(TenantGuard)
  async getWebhooks(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number
  ) {
    const target = tenantId || clientId;
    const rows = await this.pool.query(
      'SELECT id, url, events, active, created_at FROM client_webhooks WHERE client_id = $1 ORDER BY id DESC',
      [target]
    );
    return rows.rows;
  }

  @Post('clients/:clientId/webhooks')
  @UseGuards(TenantGuard)
  async createWebhook(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number,
    @Body() body: { url: string; events?: string }
  ) {
    const target = tenantId || clientId;
    const url = String(body?.url || '').trim();
    if (!url) throw new BadRequestException('url is required');
    const events = String(body?.events || 'message.received,lead.created,order.created');
    const secret = randomBytes(24).toString('hex');
    const result = await this.pool.query(
      `INSERT INTO client_webhooks (client_id, url, events, secret, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, url, events, secret as signing_secret`,
      [target, url, events, secret]
    );
    return result.rows[0];
  }

  @Delete('clients/:clientId/webhooks/:id')
  @UseGuards(TenantGuard)
  async deleteWebhook(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number,
    @Param('id', ParseIntPipe) id: number
  ) {
    const target = tenantId || clientId;
    await this.pool.query(
      'DELETE FROM client_webhooks WHERE id = $1 AND client_id = $2',
      [id, target]
    );
    return { ok: true, success: true };
  }
}
