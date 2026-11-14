import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, Inject, ParseIntPipe, NotFoundException } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import pg from 'pg';
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

/**
 * Plans + feature catalogue (admin).
 *
 * Split out of `LicensingController` (Phase 3 of the modular
 * restructure). Methods moved verbatim; no behaviour change. The
 * class-level TenantGuard and the method-level AdminGuard on the plan
 * routes are preserved; `getFeatures` stays open to tenants.
 */
@Controller('api')
@UseGuards(TenantGuard)
export class PlansController {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool
  ) {}

  @Get('admin/features')
  getFeatures() {
    return SYSTEM_FEATURES;
  }

  // C2: admin-only routes carry a method-level AdminGuard (on top of the
  // class-level TenantGuard). getFeatures stays open to tenants.
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
}
