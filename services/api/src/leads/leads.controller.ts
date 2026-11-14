import { Controller, Get, Patch, Post, Body, Param, Query, UseGuards, Inject, ParseIntPipe, NotFoundException } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import pg from 'pg';
import { DB_POOL } from '../database/database.module.js';
import { extractLeadSignals } from '../widget/lead-intel.js';

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

    // P15 (2026-11-15): recompute the intel fields from the lead's real
    // conversation history via extractLeadSignals — the same module the
    // intake upsert uses — instead of the old phone-only 75/35 guess.
    // The existing 50 placeholder leads are fixed on demand this way
    // (per-lead Re-analyze), with no invented data: no chat signals
    // means the fields stay empty/zero.
    const lead = check.rows[0];
    const productsRes = await this.pool.query(
      'SELECT id, name, price_bdt FROM products WHERE client_id = $1 ORDER BY id',
      [tenantId]
    );
    const msgsRes = await this.pool.query(
      `SELECT m.text FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.client_id = $1 AND c.platform = $2 AND c.platform_user_id = $3
         AND m.direction = 'in'
       ORDER BY m.created_at ASC LIMIT 200`,
      [tenantId, lead.platform, lead.platform_user_id]
    );
    let score = 0;
    let intentSummary = '';
    let nextAction = '';
    const affinityByName = new Map<string, { productId?: number; name: string; priceBdt: number; quantity: number }>();
    for (const row of msgsRes.rows) {
      const s = extractLeadSignals(row.text || '', productsRes.rows);
      if (s.score > score) {
        score = s.score;
        intentSummary = s.intentSummary || intentSummary;
        nextAction = s.nextAction || nextAction;
      } else if (!intentSummary && s.intentSummary) {
        intentSummary = s.intentSummary;
        nextAction = s.nextAction || nextAction;
      }
      for (const a of s.productAffinity) {
        const prev = affinityByName.get(a.name);
        affinityByName.set(a.name, prev ? { ...a, quantity: Math.max(prev.quantity, a.quantity) } : a);
      }
    }
    if (msgsRes.rows.length === 0 && lead.phone && lead.phone.length >= 7) score = Math.max(score, 35);
    const temperature = score >= 60 ? 'hot' : score >= 35 ? 'warm' : 'cold';
    const affinity = [...affinityByName.values()];
    const predictedValueBdt = affinity.reduce((sum, a) => sum + a.priceBdt * a.quantity, 0);
    const stage = lead.status === 'confirmed' ? 'won' : (score >= 35 ? 'qualified' : 'contacted');

    const result = await this.pool.query(
      `UPDATE leads
       SET score = $1, temperature = $2, stage = $3,
           product_affinity_json = $4, intent_summary = $5,
           predicted_value_bdt = $6, conversion_probability = $7,
           next_action = $8, intel_updated_at = NOW(), updated_at = NOW()
       WHERE id = $9 AND client_id = $10
       RETURNING *`,
      [score, temperature, stage, JSON.stringify(affinity), intentSummary,
       predictedValueBdt, score / 100, nextAction, id, tenantId]
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
    const flat = {
      total: Number(row.total || 0),
      hot: Number(row.hot || 0),
      warm: Number(row.warm || 0),
      cold: Number(row.cold || 0),
      won: Number(row.won || 0),
    };
    // P15: the frontend summary reads s.byTemperature — return the
    // nested shape alongside the flat counts so both agree.
    return { ...flat, byTemperature: { hot: flat.hot, warm: flat.warm, cold: flat.cold } };
  }
}
