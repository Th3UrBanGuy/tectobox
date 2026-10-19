import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, Inject, ParseIntPipe, NotFoundException } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import pg from 'pg';
import crypto from 'crypto';
import { DB_POOL } from '../database/database.module.js';

export const SYSTEM_FEATURES = [
  { key: 'combined_inbox', id: 'combined_inbox', label: 'Combined inbox', name: 'Combined inbox', desc: 'All platforms in one unified inbox view' },
  { key: 'ai_response', id: 'ai_response', label: 'AI auto-replies', name: 'AI auto-replies', desc: 'AI answers customers on every connected channel' },
  { key: 'webchat', id: 'webchat', label: 'Webchat widget', name: 'Webchat widget', desc: 'Embeddable chat bubble for the client website' },
  { key: 'broadcast', id: 'broadcast', label: 'Broadcast', name: 'Broadcast', desc: 'Bulk campaign messaging' },
  { key: 'lead_intel', id: 'lead_intel', label: 'Lead intelligence', name: 'Lead intelligence', desc: 'AI lead scoring (Hot/Warm/Cold)' },
  { key: 'knowledge', id: 'knowledge', label: 'AI knowledge base', name: 'AI knowledge base', desc: 'Teach the AI from docs + website imports' },
  { key: 'api_access', id: 'api_access', label: 'API keys & webhooks', name: 'API keys & webhooks', desc: 'Public API v1 + outbound webhooks' },
];

@Controller('api')
@UseGuards(TenantGuard)
export class LicensingController {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  @Get('admin/features')
  getFeatures() {
    return SYSTEM_FEATURES;
  }

  @Get('admin/plans')
  async listPlans() {
    const result = await this.pool.query('SELECT * FROM plans ORDER BY id ASC');
    return result.rows;
  }

  @Post('admin/plans')
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
  async deletePlan(@Param('id', ParseIntPipe) id: number) {
    await this.pool.query('DELETE FROM plans WHERE id = $1', [id]);
    return { ok: true, success: true };
  }

  @Get('admin/licenses')
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

  @Post('admin/licenses')
  async issueLicense(@Body() body: any) {
    const code = 'LIC-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const startsAt = new Date();
    const endsAt = body.days
      ? new Date(Date.now() + Number(body.days) * 86400000)
      : new Date(Date.now() + 30 * 86400000);

    const result = await this.pool.query(
      `INSERT INTO licenses (code, client_id, plan_id, kind, starts_at, ends_at, credits_total, status, features_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, NOW())
       RETURNING *`,
      [
        code,
        body.client_id,
        body.plan_id || null,
        body.kind || 'time',
        startsAt,
        endsAt,
        body.credits || 0,
        JSON.stringify(body.features || []),
      ]
    );
    return result.rows[0];
  }

  @Post('admin/licenses/:id/pause')
  async pauseLicense(@Param('id', ParseIntPipe) id: number) {
    const res = await this.pool.query(
      "UPDATE licenses SET status = 'paused' WHERE id = $1 RETURNING *",
      [id]
    );
    return res.rows[0];
  }

  @Post('admin/licenses/:id/resume')
  async resumeLicense(@Param('id', ParseIntPipe) id: number) {
    const res = await this.pool.query(
      "UPDATE licenses SET status = 'active' WHERE id = $1 RETURNING *",
      [id]
    );
    return res.rows[0];
  }

  @Post('admin/licenses/:id/cancel')
  async cancelLicense(@Param('id', ParseIntPipe) id: number) {
    const res = await this.pool.query(
      "UPDATE licenses SET status = 'cancelled' WHERE id = $1 RETURNING *",
      [id]
    );
    return res.rows[0];
  }

  @Post(['admin/licenses/:id/topup', 'admin/licenses/:id/topup-feature'])
  async topupLicense(@Param('id', ParseIntPipe) id: number, @Body() body: { credits: number }) {
    const res = await this.pool.query(
      'UPDATE licenses SET credits_total = credits_total + $1 WHERE id = $2 RETURNING *',
      [body.credits || 0, id]
    );
    return res.rows[0];
  }

  @Get(['client/access', 'admin/clients/:id/access'])
  async getClientAccess(@CurrentTenant() tenantId: number) {
    if (!tenantId) {
      return {
        active: true,
        features: SYSTEM_FEATURES.map((f) => f.id),
        credits: 999999,
      };
    }

    const licRes = await this.pool.query(
      "SELECT * FROM licenses WHERE client_id = $1 AND status = 'active' ORDER BY id DESC LIMIT 1",
      [tenantId]
    );

    if (licRes.rows.length === 0) {
      // Default standard active features if no strict license is assigned
      return {
        active: true,
        features: SYSTEM_FEATURES.map((f) => f.id),
        credits: 1000,
      };
    }

    const lic = licRes.rows[0];
    const rawFeatures = typeof lic.features_json === 'string'
      ? JSON.parse(lic.features_json)
      : (lic.features_json || []);
    const features = Array.isArray(rawFeatures) && rawFeatures.length > 0
      ? rawFeatures
      : SYSTEM_FEATURES.map((f) => f.id);

    return {
      active: lic.status === 'active',
      licenseId: lic.id,
      code: lic.code,
      features,
      creditsTotal: lic.credits_total,
      creditsUsed: lic.credits_used,
    };
  }
}
