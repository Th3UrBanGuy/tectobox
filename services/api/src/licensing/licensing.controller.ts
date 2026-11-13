import { Controller, Get, Post, Patch, Delete, Body, Param, Req, UseGuards, Inject, ParseIntPipe, NotFoundException, BadRequestException, GoneException, ConflictException, Optional } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import pg from 'pg';
import crypto from 'crypto';
import { DB_POOL } from '../database/database.module.js';
import { LicensingService } from './licensing.service.js';
import { EventsService } from '../events/events.service.js';
import { IssueLicenseDto, ActivateLicenseDto } from './dto/licensing.dto.js';

export const SYSTEM_FEATURES = [
  { key: 'combined_inbox', id: 'combined_inbox', label: 'Combined inbox', name: 'Combined inbox', desc: 'All platforms in one unified inbox view' },
  { key: 'ai_response', id: 'ai_response', label: 'AI auto-replies', name: 'AI auto-replies', desc: 'AI answers customers on every connected channel' },
  { key: 'webchat', id: 'webchat', label: 'Webchat widget', name: 'Webchat widget', desc: 'Embeddable chat bubble for the client website' },
  { key: 'broadcast', id: 'broadcast', label: 'Broadcast', name: 'Broadcast', desc: 'Bulk campaign messaging' },
  { key: 'lead_intel', id: 'lead_intel', label: 'Lead intelligence', name: 'Lead intelligence', desc: 'AI lead scoring (Hot/Warm/Cold)' },
  { key: 'knowledge', id: 'knowledge', label: 'AI knowledge base', name: 'AI knowledge base', desc: 'Teach the AI from docs + website imports' },
  { key: 'api_access', id: 'api_access', label: 'API keys & webhooks', name: 'API keys & webhooks', desc: 'Public API v1 + outbound webhooks' },
];

// A key that was generated but never activated stops being redeemable
// after this many days (lazy check at activation time — no cron).
const KEY_ACTIVATION_TTL_DAYS = 30;

@Controller('api')
@UseGuards(TenantGuard)
export class LicensingController {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(LicensingService) private readonly licensing: LicensingService,
    @Optional() private readonly eventsService?: EventsService
  ) {}

  private getEvents(): EventsService {
    return this.eventsService || new EventsService(this.pool, this.licensing);
  }

  @Get('admin/features')
  getFeatures() {
    return SYSTEM_FEATURES;
  }

  // C2: admin-only routes carry a method-level AdminGuard (on top of the
  // class-level TenantGuard). getFeatures/getClientAccess stay open to
  // tenants — see getClientAccess for its own tenant scoping.
  @Get('admin/plans')
  @UseGuards(AdminGuard)
  async listPlans() {
    const result = await this.pool.query('SELECT * FROM plans ORDER BY id ASC');
    return result.rows;
  }

  @Post('admin/plans')
  @UseGuards(AdminGuard)
  async createPlan(@Body() body: any) {
    const result = await this.pool.query(
      `INSERT INTO plans (name, kind, billing_period, features_json, credits_included, price_bdt, active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
       RETURNING *`,
      [
        body.name,
        body.kind || 'time',
        body.billing_period || 'monthly',
        JSON.stringify(body.features || body.features_json || []),
        body.credits_included || 0,
        body.price_bdt || 0,
      ]
    );
    return result.rows[0];
  }

  @Patch('admin/plans/:id')
  @UseGuards(AdminGuard)
  async updatePlan(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    const check = await this.pool.query('SELECT * FROM plans WHERE id = $1', [id]);
    if (check.rows.length === 0) throw new NotFoundException('Plan not found');
    const cur = check.rows[0];

    const result = await this.pool.query(
      `UPDATE plans
       SET name = $1, features_json = $2, price_bdt = $3, credits_included = $4
       WHERE id = $5
       RETURNING *`,
      [
        body.name ?? cur.name,
        body.features_json ? JSON.stringify(body.features_json) : cur.features_json,
        body.price_bdt ?? cur.price_bdt,
        body.credits_included ?? cur.credits_included,
        id,
      ]
    );
    return result.rows[0];
  }

  @Delete('admin/plans/:id')
  @UseGuards(AdminGuard)
  async deletePlan(@Param('id', ParseIntPipe) id: number) {
    await this.pool.query('DELETE FROM plans WHERE id = $1', [id]);
    return { ok: true, success: true };
  }

  @Get('admin/licenses')
  @UseGuards(AdminGuard)
  async listLicenses() {
    const result = await this.pool.query(
      `SELECT l.*, c.name as client_name, p.name as plan_name
       FROM licenses l
       LEFT JOIN clients c ON c.id = l.client_id
       LEFT JOIN plans p ON p.id = l.plan_id
       ORDER BY l.id DESC LIMIT 100`
    );
    return result.rows;
  }

  /**
   * Issue a licence. Two delivery modes:
   * - 'apply' (default): active immediately, cancels the client's current
   *   active licence (newer-wins). Used for test licences and direct
   *   assignment by the admin.
   * - 'key-only': creates a `pending_activation` row with starts_at/ends_at
   *   NULL. The admin copies the returned code and hands it to the client
   *   after payment; the client activates it themselves via
   *   POST /api/client/licenses/activate. The key is inert until then.
   * `days` accepts fractions (0.0208 = 30 min) and must be > 0.
   */
  @Post('admin/licenses')
  @UseGuards(AdminGuard)
  async issueLicense(@Body() body: IssueLicenseDto, @Req() req?: any) {
    const createdBy = req?.user?.username ?? null;
    const clientId = body.client_id ? Number(body.client_id) : null;
    if (!clientId) {
      throw new BadRequestException('client_id is required');
    }
    const deliver = body.deliver || body.mode || 'apply';
    if (deliver !== 'apply' && deliver !== 'key-only') {
      throw new BadRequestException("deliver must be 'apply' or 'key-only'");
    }

    const code = 'LIC-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    let days = body.days != null ? Number(body.days) : 30;
    let kind = body.kind || 'time';
    let featuresJson = JSON.stringify(body.features || []);
    let credits = Number(body.credits || body.credits_total || 0);
    let billingPeriod: string | null = body.billing_period || null;
    const planId = body.plan_id || body.planId || null;

    if (planId) {
      const pRes = await this.pool.query('SELECT * FROM plans WHERE id = $1', [planId]);
      if (pRes.rows.length > 0) {
        const p = pRes.rows[0];
        kind = p.kind;
        featuresJson = typeof p.features_json === 'string' ? p.features_json : JSON.stringify(p.features_json || []);
        credits = Number(p.credits_included || 0);
        billingPeriod = p.billing_period;
        days = p.billing_period === 'yearly' ? 365 : p.billing_period === 'quarterly' ? 90 : 30;
      }
    }

    if (!Number.isFinite(days) || days <= 0) {
      throw new BadRequestException('days must be a number greater than 0');
    }

    if (deliver === 'key-only') {
      // The clock starts at activation: starts_at/ends_at stay NULL and the
      // intended duration is remembered in validity_days.
      const result = await this.pool.query(
        `INSERT INTO licenses (code, client_id, plan_id, kind, billing_period, starts_at, ends_at,
           credits_total, credits_used, status, features_json, validity_days, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, 0, 'pending_activation', $7, $8, $9, NOW())
         RETURNING *`,
        [code, clientId, planId, kind, billingPeriod, credits, featuresJson, days, createdBy]
      );
      const row = result.rows[0];
      await this.licensing.audit('key_issue', createdBy, clientId, row?.id ?? null, code, `key-only, ${days} days`);
      await this.getEvents().writeAudit(createdBy, clientId, 'license:issue', { code, days, deliver: 'key-only', licenseId: row?.id, ip: req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || null });
      return { code, license: row };
    }

    const startsAt = new Date();
    const endsAt = new Date(Date.now() + days * 86400000);

    // Cancel existing active licenses for this client if any
    await this.pool.query("UPDATE licenses SET status = 'cancelled' WHERE client_id = $1 AND status = 'active'", [clientId]);

    const result = await this.pool.query(
      `INSERT INTO licenses (code, client_id, plan_id, kind, billing_period, starts_at, ends_at,
         credits_total, credits_used, status, features_json, validity_days, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 'active', $9, $10, $11, NOW())
       RETURNING *`,
      [
        code,
        clientId,
        planId,
        kind,
        billingPeriod,
        startsAt,
        endsAt,
        credits,
        featuresJson,
        days,
        createdBy,
      ]
    );
    const row = result.rows[0];
    await this.licensing.audit('issue', createdBy, clientId, row?.id ?? null, code, `applied, ${days} days`);
    await this.getEvents().writeAudit(createdBy, clientId, 'license:issue', { code, days, deliver: 'apply', licenseId: row?.id, ip: req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || null });
    return row;
  }

  /**
   * Client self-service licence activation. Tenant-guarded, NOT admin-only.
   * The code is looked up tenant-blind: an unknown code and a code that
   * belongs to another workspace both return 404, so keys cannot be
   * enumerated. A key older than KEY_ACTIVATION_TTL_DAYS is cancelled
   * lazily and returns 410 Gone. On success the current active licence is
   * cancelled and this one starts now (ends_at = NOW() + validity_days).
   */
  @Post('client/licenses/activate')
  async activateLicense(
    @CurrentTenant() tenantId: number,
    @Body() body: ActivateLicenseDto,
    @Req() req?: any
  ) {
    const rawCode = String(body?.code || '').trim();
    if (!rawCode) {
      throw new BadRequestException('code is required');
    }
    const code = rawCode.toUpperCase();

    const found = await this.pool.query(
      'SELECT * FROM licenses WHERE UPPER(code) = $1 LIMIT 1',
      [code]
    );
    // Unknown code and foreign-workspace code are indistinguishable (404)
    // so that keys cannot be enumerated.
    if (found.rows.length === 0 || Number(found.rows[0].client_id) !== Number(tenantId)) {
      throw new NotFoundException('License key not found');
    }
    const lic = found.rows[0];
    if (lic.status !== 'pending_activation') {
      throw new ConflictException('This license key has already been used or revoked');
    }
    const createdAt = new Date(lic.created_at).getTime();
    if (Date.now() - createdAt > KEY_ACTIVATION_TTL_DAYS * 86400000) {
      await this.pool.query(
        "UPDATE licenses SET status = 'cancelled' WHERE id = $1 AND status = 'pending_activation'",
        [lic.id]
      );
      throw new GoneException('This license key has expired (never activated within 30 days)');
    }

    const validityDays =
      lic.validity_days != null && Number(lic.validity_days) > 0
        ? Number(lic.validity_days)
        : lic.billing_period === 'yearly'
          ? 365
          : lic.billing_period === 'quarterly'
            ? 90
            : 30;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "UPDATE licenses SET status = 'cancelled' WHERE client_id = $1 AND status = 'active'",
        [tenantId]
      );
      const activated = await client.query(
        `UPDATE licenses
         SET status = 'active', starts_at = NOW(), ends_at = NOW() + ($1 * INTERVAL '1 day')
         WHERE id = $2 AND status = 'pending_activation'
         RETURNING *`,
        [validityDays, lic.id]
      );
      if (activated.rows.length === 0) {
        throw new ConflictException('This license key has already been used or revoked');
      }
      await client.query('COMMIT');
      const row = activated.rows[0];
      await this.licensing.audit(
        'activate',
        req?.user?.username ?? null,
        tenantId,
        row.id,
        row.code,
        `activated, ${validityDays} days`
      );
      // Fresh access payload so the UI unlocks without a reload.
      const access = await this.licensing.resolveAccess(tenantId);
      return { ...this.toAccessResponse(access), license: access.license };
    } catch (err: any) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      if (
        err instanceof NotFoundException ||
        err instanceof ConflictException ||
        err instanceof GoneException ||
        err instanceof BadRequestException
      ) {
        throw err;
      }
      throw err;
    } finally {
      client.release();
    }
  }

  @Post('admin/licenses/:id/pause')
  @UseGuards(AdminGuard)
  async pauseLicense(@Param('id', ParseIntPipe) id: number, @Req() req?: any) {
    const res = await this.pool.query(
      "UPDATE licenses SET status = 'paused' WHERE id = $1 RETURNING *",
      [id]
    );
    const row = res.rows[0];
    if (row) {
      await this.licensing.audit('pause', req?.user?.username ?? null, row.client_id, row.id, row.code, null);
    }
    return row;
  }

  @Post('admin/licenses/:id/resume')
  @UseGuards(AdminGuard)
  async resumeLicense(@Param('id', ParseIntPipe) id: number, @Req() req?: any) {
    const res = await this.pool.query(
      "UPDATE licenses SET status = 'active' WHERE id = $1 RETURNING *",
      [id]
    );
    const row = res.rows[0];
    if (row) {
      await this.licensing.audit('resume', req?.user?.username ?? null, row.client_id, row.id, row.code, null);
    }
    return row;
  }

  @Post('admin/licenses/:id/cancel')
  @UseGuards(AdminGuard)
  async cancelLicense(@Param('id', ParseIntPipe) id: number, @Req() req?: any) {
    const res = await this.pool.query(
      "UPDATE licenses SET status = 'cancelled' WHERE id = $1 RETURNING *",
      [id]
    );
    const row = res.rows[0];
    if (row) {
      await this.licensing.audit('cancel', req?.user?.username ?? null, row.client_id, row.id, row.code, null);
    }
    return row;
  }

  @Post(['admin/licenses/:id/topup', 'admin/licenses/:id/topup-feature'])
  @UseGuards(AdminGuard)
  async topupLicense(@Param('id', ParseIntPipe) id: number, @Body() body: { credits: number }, @Req() req?: any) {
    const res = await this.pool.query(
      'UPDATE licenses SET credits_total = credits_total + $1 WHERE id = $2 RETURNING *',
      [body.credits || 0, id]
    );
    const row = res.rows[0];
    if (row) {
      await this.licensing.audit(
        'topup',
        req?.user?.username ?? null,
        row.client_id,
        row.id,
        row.code,
        `+${body.credits || 0} credits`
      );
    }
    return row;
  }

  /**
   * The single licence read path. Delegates to LicensingService: no
   * auto-provision, no legacy full-access fallbacks. A workspace without
   * an active licence gets mode 'none' (features []), a suspended one
   * gets mode 'suspended'. Expiry is flipped inline by the service.
   */
  @Get(['client/access', 'admin/clients/:id/access'])
  async getClientAccess(@CurrentTenant() tenantId: number, @Param('id') paramId?: string, @Req() req?: any) {
    // C2/C3 rule: only an admin may address another workspace via :id.
    // A non-admin's :id is ignored and their own tenant is used instead.
    const isAdmin = req?.user?.role === 'admin' || req?.user?.role === 'superadmin';
    const targetTenantId = isAdmin && paramId ? Number(paramId) : tenantId;
    if (!targetTenantId) {
      return {
        active: false,
        mode: 'none',
        licenseId: null,
        code: null,
        features: [],
        creditsTotal: 0,
        creditsUsed: 0,
        license: null,
        aiAllowed: false,
        aiReason: 'no_active_license',
        suspended: false,
        aiPaused: false,
      };
    }
    const access = await this.licensing.resolveAccess(targetTenantId);
    return this.toAccessResponse(access);
  }

  /**
   * Shapes the service payload into the access object the frontend already
   * consumes (active / mode / features / credits / license) plus the
   * enforcement fields (aiAllowed / aiReason / suspended / aiPaused).
   */
  private toAccessResponse(access: {
    mode: string;
    features: string[];
    aiAllowed: boolean;
    aiReason: any;
    license: any | null;
    suspended: boolean;
    aiPaused: boolean;
  }) {
    const lic = access.license;
    return {
      active: access.mode === 'licensed',
      mode: access.mode,
      licenseId: lic?.id ?? null,
      code: lic?.code ?? null,
      features: access.features,
      creditsTotal: lic?.credits_total ?? 0,
      creditsUsed: lic?.credits_used ?? 0,
      license: lic
        ? {
            id: lic.id,
            code: lic.code,
            status: lic.status,
            kind: lic.kind,
            plan_id: lic.plan_id ?? null,
            plan_name: lic.plan_name || null,
            starts_at: lic.starts_at,
            ends_at: lic.ends_at,
            credits_total: lic.credits_total,
            credits_used: lic.credits_used,
            validity_days: lic.validity_days ?? null,
            features: lic.features,
          }
        : null,
      aiAllowed: access.aiAllowed,
      aiReason: access.aiReason,
      suspended: access.suspended,
      aiPaused: access.aiPaused,
    };
  }
}
