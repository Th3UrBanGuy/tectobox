import { Controller, Get, Patch, Post, Body, Param, Query, UseGuards, Inject, ParseIntPipe, NotFoundException } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import pg from 'pg';
import { DB_POOL } from '../database/database.module.js';

@Controller('api')
@UseGuards(TenantGuard)
export class LeadsController {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  @Get('leads')
  async getLeads(
    @CurrentTenant() tenantId: number,
    @Query('status') status?: string,
    @Query('stage') stage?: string,
    @Query('temp') temperature?: string,
    @Query('platform') platform?: string,
    @Query('q') query?: string,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string
  ) {
    const limit = Math.min(200, Math.max(1, parseInt(limitStr || '', 10) || 50));
    const offset = Math.max(0, parseInt(offsetStr || '', 10) || 0);

    let whereSql = `WHERE client_id = $1`;
    const params: any[] = [tenantId];

    if (status && status !== 'all') {
      params.push(status);
      whereSql += ` AND status = $${params.length}`;
    }
    if (stage && stage !== 'all') {
      params.push(stage);
      whereSql += ` AND stage = $${params.length}`;
    }
    if (temperature && temperature !== 'all') {
      params.push(temperature);
      whereSql += ` AND temperature = $${params.length}`;
    }
    if (platform && platform !== 'all') {
      params.push(platform);
      whereSql += ` AND platform = $${params.length}`;
    }
    if (query && query.trim()) {
      params.push(`%${query.trim()}%`);
      whereSql += ` AND (name ILIKE $${params.length} OR phone ILIKE $${params.length} OR email ILIKE $${params.length})`;
    }

    const countRes = await this.pool.query(`SELECT COUNT(*) AS total FROM leads ${whereSql}`, params);
    const total = parseInt(countRes.rows[0]?.total || '0', 10);

    const queryParams = [...params, limit, offset];
    const dataSql = `SELECT id, client_id, platform, platform_user_id, name, phone, email, whatsapp_id,
                            location, status, stage, score, temperature, product_affinity_json,
                            intent_summary, predicted_value_bdt, conversion_probability, next_action,
                            notes, last_intent_at, followup_due_at, created_at, updated_at
                     FROM leads
                     ${whereSql}
                     ORDER BY updated_at DESC
                     LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`;
    const result = await this.pool.query(dataSql, queryParams);

    const res: any = result.rows;
    res.success = true;
    res.tenantId = tenantId;
    res.leads = result.rows;
    res.total = total;
    res.limit = limit;
    res.offset = offset;
    return res;
  }

  @Patch('leads/:id')
  async updateLead(
    @CurrentTenant() tenantId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any
  ) {
    const check = await this.pool.query(
      'SELECT * FROM leads WHERE id = $1 AND client_id = $2',
      [id, tenantId]
    );
    if (check.rows.length === 0) {
      throw new NotFoundException('Lead not found');
    }

    const current = check.rows[0];
    const status = body.status ?? current.status;
    const stage = body.stage ?? current.stage;
    const name = body.name ?? current.name;
    const phone = body.phone ?? current.phone;
    const email = body.email ?? current.email;
    const notes = body.notes ?? current.notes;
    const temp = body.temperature ?? body.temp ?? current.temperature;

    const result = await this.pool.query(
      `UPDATE leads
       SET status = $1, stage = $2, name = $3, phone = $4, email = $5, notes = $6, temperature = $7, updated_at = NOW()
       WHERE id = $8 AND client_id = $9
       RETURNING *`,
      [status, stage, name, phone, email, notes, temp, id, tenantId]
    );

    return { success: true, lead: result.rows[0] };
  }

  @Post('leads/:id/analyze')
  async analyzeLead(
    @CurrentTenant() tenantId: number,
    @Param('id', ParseIntPipe) id: number
  ) {
    const check = await this.pool.query(
      'SELECT * FROM leads WHERE id = $1 AND client_id = $2',
      [id, tenantId]
    );
    if (check.rows.length === 0) {
      throw new NotFoundException('Lead not found');
    }

    // Deterministic lead scoring based on phone/order existence
    const lead = check.rows[0];
    const hasPhone = Boolean(lead.phone && lead.phone.length >= 7);
    const score = hasPhone ? 75 : 35;
    const temp = hasPhone ? 'warm' : 'cold';
    const stage = lead.status === 'confirmed' ? 'won' : (hasPhone ? 'qualified' : 'contacted');

    const result = await this.pool.query(
      `UPDATE leads
       SET score = $1, temperature = $2, stage = $3, intel_updated_at = NOW(), updated_at = NOW()
       WHERE id = $4 AND client_id = $5
       RETURNING *`,
      [score, temp, stage, id, tenantId]
    );

    return { ok: true, success: true, lead: result.rows[0] };
  }

  @Get('leads/intel-stats')
  async getIntelStats(@CurrentTenant() tenantId: number) {
    const statsResult = await this.pool.query(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE temperature = 'hot') as hot,
         COUNT(*) FILTER (WHERE temperature = 'warm') as warm,
         COUNT(*) FILTER (WHERE temperature = 'cold') as cold,
         COUNT(*) FILTER (WHERE status = 'confirmed' OR stage = 'won') as won
       FROM leads
       WHERE client_id = $1`,
      [tenantId]
    );

    const row = statsResult.rows[0];
    return {
      total: Number(row.total || 0),
      hot: Number(row.hot || 0),
      warm: Number(row.warm || 0),
      cold: Number(row.cold || 0),
      won: Number(row.won || 0),
    };
  }
}
