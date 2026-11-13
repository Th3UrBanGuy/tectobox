import { Controller, Get, Post, Patch, Delete, Put, Body, Param, Query, Req, UseGuards, Inject, ParseIntPipe, NotFoundException, BadRequestException, NotImplementedException, UnauthorizedException } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import pg from 'pg';
import crypto from 'crypto';
import { DB_POOL } from '../database/database.module.js';
import { hashPassword, verifyPassword } from '../auth/password.util.js';
import { generateSecret, verifyTotp, otpauthUrl } from '../auth/totp.util.js';
import { encrypt, decrypt, isEncrypted } from '../common/crypto.js';
import { LicensingService } from '../licensing/licensing.service.js';

@Controller('api')
@UseGuards(TenantGuard, AdminGuard)
export class AdminController {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(LicensingService) private readonly licensing: LicensingService
  ) {}

  @Get(['admin/overview', 'global-stats'])
  async getOverview() {
    const clientsCount = await this.pool.query('SELECT COUNT(*) as count FROM clients');
    const convCount = await this.pool.query('SELECT COUNT(*) as count FROM conversations');
    const msgCount = await this.pool.query('SELECT COUNT(*) as count FROM messages');
    const orderCount = await this.pool.query('SELECT COUNT(*) as count, COALESCE(SUM(total_bdt), 0) as total FROM orders');
    const leadCount = await this.pool.query('SELECT COUNT(*) as count FROM leads');
    const channelCount = await this.pool.query('SELECT COUNT(DISTINCT channel) as count FROM channel_sessions');
    const connectedCount = await this.pool.query("SELECT COUNT(*) as count FROM channel_sessions WHERE status = 'connected'");
    const erroredCount = await this.pool.query("SELECT COUNT(*) as count FROM channel_sessions WHERE status = 'error'");

    return {
      workspaces: Number(clientsCount.rows[0]?.count || 0),
      channels: Math.max(4, Number(channelCount.rows[0]?.count || 0)),
      connected: Number(connectedCount.rows[0]?.count || 0),
      errored: Number(erroredCount.rows[0]?.count || 0),
      conversations: Number(convCount.rows[0]?.count || 0),
      messages: Number(msgCount.rows[0]?.count || 0),
      orders: Number(orderCount.rows[0]?.count || 0),
      revenueBdt: Number(orderCount.rows[0]?.total || 0),
      leads: Number(leadCount.rows[0]?.count || 0),
    };
  }

  @Get(['admin/workspaces', 'admin/clients', 'clients'])
  async listWorkspaces() {
    const result = await this.pool.query(`
      SELECT c.*,
             c.id as client_id,
             c.name as client_name,
             u.id as id,
             u.username,
             u.active,
             (SELECT COUNT(*) FROM conversations WHERE client_id = c.id) as conv_count,
             (SELECT COUNT(*) FROM orders WHERE client_id = c.id) as order_count,
             (SELECT COUNT(*) FROM leads WHERE client_id = c.id) as lead_count,
             (
               SELECT json_build_object(
                 'id', l.id,
                 'code', l.code,
                 'status', l.status,
                 'kind', l.kind,
                 'ends_at', l.ends_at,
                 'credits_used', l.credits_used,
                 'credits_total', l.credits_total,
                 'plan_name', p.name
               )
               FROM licenses l
               LEFT JOIN plans p ON p.id = l.plan_id
               WHERE l.client_id = c.id AND l.status = 'active'
               ORDER BY l.id DESC LIMIT 1
             ) as license
      FROM clients c
      LEFT JOIN LATERAL (
        SELECT id, username, active FROM users WHERE client_id = c.id ORDER BY id ASC LIMIT 1
      ) u ON true
      ORDER BY c.id ASC
    `);
    return result.rows.map((r: any) => ({
      ...r,
      ai_budget: {
        cap: r.widget_ai_daily_cap ?? 200,
        used: r.widget_ai_used ?? 0,
        day: r.widget_ai_day || '',
      },
      ai_allowed: !r.suspended && !r.ai_paused,
    }));
  }

  @Post(['clients', 'admin/workspaces'])
  async createWorkspace(@Body() body: { name: string; business_type?: string }) {
    const widgetKey = crypto.randomBytes(16).toString('hex');
    const result = await this.pool.query(
      `INSERT INTO clients (name, business_type, widget_key, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING *`,
      [body.name, body.business_type || 'physical', widgetKey]
    );
    return result.rows[0];
  }

  @Patch('clients/:id')
  async updateWorkspace(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    const check = await this.pool.query('SELECT * FROM clients WHERE id = $1', [id]);
    if (check.rows.length === 0) throw new NotFoundException('Workspace not found');

    const cur = check.rows[0];
    const name = body.name ?? cur.name;
    const btype = body.business_type ?? cur.business_type;
    const website = body.website_url ?? cur.website_url;

    const result = await this.pool.query(
      `UPDATE clients SET name = $1, business_type = $2, website_url = $3 WHERE id = $4 RETURNING *`,
      [name, btype, website, id]
    );
    return result.rows[0];
  }

  @Delete('clients/:id')
  @Delete(['clients/:id', 'admin/clients/:id', 'admin/workspaces/:id'])
  async deleteWorkspace(@Param('id', ParseIntPipe) id: number) {
    await this.pool.query('DELETE FROM users WHERE client_id = $1', [id]);
    await this.pool.query('DELETE FROM clients WHERE id = $1', [id]);
    return { ok: true, success: true };
  }

  @Get('admin/users')
  async listUsers() {
    const result = await this.pool.query(
      `SELECT u.id, u.username, u.role, u.client_id, u.active, u.created_at, c.name as client_name
       FROM users u
       LEFT JOIN clients c ON c.id = u.client_id
       ORDER BY u.id ASC`
    );
    return result.rows;
  }

  @Post('admin/users')
  async createUser(@Body() body: any, @Req() req?: any) {
    if (!body?.username || typeof body.username !== 'string' || !body.username.trim()) {
      throw new BadRequestException('Username and password are required');
    }
    if (!body?.password || typeof body.password !== 'string' || !body.password.trim()) {
      throw new BadRequestException('Username and password are required');
    }

    const cleanPassword = body.password.trim();
    if (cleanPassword.length < 12) {
      throw new BadRequestException('Password must be at least 12 characters');
    }

    // Check if username already exists
    const existing = await this.pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [body.username.trim()]);
    if (existing.rows.length > 0) {
      throw new BadRequestException('Username already exists. Please choose a different username.');
    }

    let clientId: number | null = body.client_id ? Number(body.client_id) : null;
    let clientName: string | null = body.workspaceName || body.workspace_name || null;

    // If no client_id, create a new workspace (client)
    if (!clientId) {
      const wsName = clientName || `${body.username.trim()}'s Workspace`;
      const bType = body.businessType || body.business_type || 'physical';
      const widgetKey = crypto.randomBytes(16).toString('hex');
      const wsRes = await this.pool.query(
        `INSERT INTO clients (name, business_type, widget_key, created_at)
         VALUES ($1, $2, $3, NOW())
         RETURNING id, name`,
        [wsName, bType, widgetKey]
      );
      clientId = wsRes.rows[0].id;
      clientName = wsRes.rows[0].name;
    }

    const passwordHash = await hashPassword(cleanPassword);
    const result = await this.pool.query(
      `INSERT INTO users (username, password_hash, role, client_id, active, token_version, created_at)
       VALUES ($1, $2, $3, $4, true, 1, NOW())
       RETURNING id, username, role, client_id, active, token_version, created_at`,
      [body.username.trim(), passwordHash, body.role || 'operator', clientId]
    );

    // Test licence (optional): a short full-feature trial. When no trial
    // duration is given, NO licence is created — the workspace opens in
    // mode 'none' (locked) until the admin issues one. There is deliberately
    // no auto-provisioned free licence anymore.
    let trialLicense: any = null;
    const trialMinutes = this.parseTrialMinutes(body);
    if (trialMinutes != null && clientId) {
      trialLicense = await this.licensing.issueTrialLicense(
        clientId,
        trialMinutes,
        req?.user?.username ?? null
      );
    }

    const user = result.rows[0];
    return {
      ok: true,
      success: true,
      ...user,
      client_name: clientName,
      trial_license: trialLicense
        ? { id: trialLicense.id, code: trialLicense.code, ends_at: trialLicense.ends_at }
        : null,
    };
  }

  /**
   * Trial duration from the create-user body: trialMinutes | trialHours |
   * trialDays (first one present wins). Returns null when none is given.
   * Throws on non-positive / non-numeric values.
   */
  private parseTrialMinutes(body: any): number | null {
    const raw =
      body.trialMinutes ?? body.trial_minutes ??
      (body.trialHours != null || body.trial_hours != null
        ? Number(body.trialHours ?? body.trial_hours) * 60
        : null) ??
      (body.trialDays != null || body.trial_days != null
        ? Number(body.trialDays ?? body.trial_days) * 1440
        : null);
    if (raw == null || raw === '') return null;
    const minutes = Number(raw);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new BadRequestException('Trial duration must be greater than 0');
    }
    return minutes;
  }

  @Post('admin/users/:id/reset-password')
  async resetUserPassword(@Param('id', ParseIntPipe) id: number, @Body() body: { password: string }) {
    if (!body?.password || typeof body.password !== 'string' || !body.password.trim()) {
      throw new BadRequestException('Password is required');
    }
    const cleanPassword = body.password.trim();
    if (cleanPassword.length < 12) {
      throw new BadRequestException('Password must be at least 12 characters');
    }
    const passwordHash = await hashPassword(cleanPassword);
    const updateRes = await this.pool.query(
      'UPDATE users SET password_hash = $1, token_version = COALESCE(token_version, 1) + 1 WHERE id = $2 RETURNING id',
      [passwordHash, id]
    );
    if (updateRes.rows.length === 0) {
      throw new NotFoundException('User not found');
    }
    await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [id]).catch(() => {});
    return { ok: true, success: true };
  }

  @Post('admin/users/:id/toggle')
  async toggleUser(@Param('id', ParseIntPipe) id: number) {
    const result = await this.pool.query(
      'UPDATE users SET active = NOT active WHERE id = $1 RETURNING id, active',
      [id]
    );
    return result.rows[0];
  }

  @Get('admin/audit')
  async getAuditLog() {
    const result = await this.pool.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100');
    return result.rows;
  }

  @Get('admin/config')
  async getConfig() {
    const rows = await this.pool.query('SELECT key, value FROM settings');
    const cfg: Record<string, string> = {};
    for (const r of rows.rows) cfg[r.key] = r.value;
    return {
      autoReply: cfg['ai.auto_reply'] !== '0',
      aiBaseUrl: cfg['ai.base_url'] || 'http://localhost:18080/v1',
      settings: cfg,
    };
  }

  @Put('admin/config')
  async updateConfig(@Body() body: any) {
    for (const [k, v] of Object.entries(body)) {
      await this.pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = NOW()`,
        [k, String(v)]
      );
    }
    return { ok: true, success: true };
  }

  @Get('admin/resources')
  async getResources() {
    const rows = await this.pool.query(`
      SELECT cs.channel, cs.status, cs.updated_at as "lastSeen",
             c.name AS workspace, c.id AS client_id, NULL AS account
      FROM channel_sessions cs
      JOIN clients c ON c.id = cs.client_id
    `);
    const meta = await this.pool.query(`
      SELECT mp.channel, mp.status, mp.updated_at as "lastSeen",
             cl.name AS workspace, cl.id AS client_id,
             CASE WHEN mp.channel = 'instagram' THEN '@' || COALESCE(mp.ig_username, mp.page_id)
                  ELSE mp.page_name END AS account
      FROM meta_pages mp
      JOIN clients cl ON cl.id = mp.client_id
    `);
    const combined = [...rows.rows, ...meta.rows];
    if (combined.length === 0) {
      return [
        { channel: 'whatsapp', account: 'Baileys Multi-Device', workspace: 'Default', status: 'connected', lastSeen: new Date().toISOString() },
        { channel: 'telegram', account: 'GramJS Worker', workspace: 'Default', status: 'idle', lastSeen: new Date().toISOString() },
        { channel: 'webchat', account: 'Widget Storefront', workspace: 'Default', status: 'connected', lastSeen: new Date().toISOString() },
      ];
    }
    return combined.map(r => ({
      channel: r.channel,
      account: r.account || r.workspace || '—',
      workspace: r.workspace || '—',
      status: r.status || 'disconnected',
      lastSeen: r.lastSeen || new Date().toISOString(),
    }));
  }

  @Get('stats')
  async getTenantStats(@CurrentTenant() tenantId: number) {
    const convCount = await this.pool.query('SELECT COUNT(*) as count FROM conversations WHERE client_id = $1', [tenantId]);
    const msgCount = await this.pool.query('SELECT COUNT(*) as count FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.client_id = $1', [tenantId]);
    const orderCount = await this.pool.query('SELECT COUNT(*) as count, COALESCE(SUM(total_bdt), 0) as total FROM orders WHERE client_id = $1', [tenantId]);
    const leadCount = await this.pool.query('SELECT COUNT(*) as count FROM leads WHERE client_id = $1', [tenantId]);

    return {
      conversations: Number(convCount.rows[0]?.count || 0),
      messages: Number(msgCount.rows[0]?.count || 0),
      orders: Number(orderCount.rows[0]?.count || 0),
      revenueBdt: Number(orderCount.rows[0]?.total || 0),
      leads: Number(leadCount.rows[0]?.count || 0),
    };
  }

  @Post('admin/clients/:id/suspend')
  async suspendClient(@Param('id', ParseIntPipe) id: number) {
    const res = await this.pool.query('UPDATE clients SET suspended = NOT suspended WHERE id = $1 RETURNING id, suspended', [id]);
    return res.rows[0];
  }

  @Post('admin/clients/:id/ai-pause')
  async toggleClientAiPause(@Param('id', ParseIntPipe) id: number, @Body() body: { paused?: boolean }) {
    const res = await this.pool.query(
      'UPDATE clients SET ai_paused = COALESCE($1, NOT ai_paused) WHERE id = $2 RETURNING id, ai_paused',
      [body?.paused !== undefined ? body.paused : null, id]
    );
    return res.rows[0];
  }

  @Post('admin/notify')
  async sendNotification(@Body() body: any) {
    throw new NotImplementedException('Notification broadcasting is not implemented');
  }

  @Get('admin/clients/:id/ai-budget')
  async getAiBudget(@Param('id', ParseIntPipe) id: number) {
    const res = await this.pool.query(
      'SELECT widget_ai_daily_cap, widget_ai_used, widget_ai_day FROM clients WHERE id = $1',
      [id]
    );
    if (res.rows.length === 0) throw new NotFoundException('Workspace not found');
    const r = res.rows[0];
    return {
      cap: r.widget_ai_daily_cap ?? 200,
      used: r.widget_ai_used ?? 0,
      day: r.widget_ai_day || '',
    };
  }

  @Put('admin/clients/:id/ai-budget')
  async setAiBudget(@Param('id', ParseIntPipe) id: number, @Body() body: { cap: number }) {
    const cap = Math.floor(Number(body?.cap));
    if (!Number.isFinite(cap) || cap < 0 || cap > 100000) {
      throw new BadRequestException('cap must be 0–100000');
    }
    const res = await this.pool.query(
      'UPDATE clients SET widget_ai_daily_cap = $1 WHERE id = $2 RETURNING widget_ai_daily_cap, widget_ai_used, widget_ai_day',
      [cap, id]
    );
    if (res.rows.length === 0) throw new NotFoundException('Workspace not found');
    const r = res.rows[0];
    return {
      cap: r.widget_ai_daily_cap ?? 200,
      used: r.widget_ai_used ?? 0,
      day: r.widget_ai_day || '',
    };
  }

  @Post('admin/clients/:id/delete-schedule')
  async scheduleDelete(@Param('id', ParseIntPipe) id: number) {
    const res = await this.pool.query(
      "UPDATE clients SET delete_scheduled_at = NOW() + INTERVAL '15 days' WHERE id = $1 RETURNING id, delete_scheduled_at",
      [id]
    );
    if (res.rows.length === 0) throw new NotFoundException('Workspace not found');
    return { ok: true, delete_scheduled_at: res.rows[0].delete_scheduled_at };
  }

  @Post('admin/clients/:id/delete-cancel')
  async cancelDelete(@Param('id', ParseIntPipe) id: number) {
    const res = await this.pool.query(
      'UPDATE clients SET delete_scheduled_at = NULL WHERE id = $1 RETURNING id',
      [id]
    );
    if (res.rows.length === 0) throw new NotFoundException('Workspace not found');
    return { ok: true, success: true };
  }

  @Post('admin/clients/:id/assign-license')
  async assignLicense(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { planId: number | string; days?: number },
    @Req() req?: any
  ) {
    const planId = Number(body?.planId);
    const planRes = await this.pool.query('SELECT * FROM plans WHERE id = $1', [planId]);
    if (planRes.rows.length === 0) throw new NotFoundException('Plan not found');
    const plan = planRes.rows[0];

    // Cancel existing active licenses for this client
    await this.pool.query("UPDATE licenses SET status = 'cancelled' WHERE client_id = $1 AND status = 'active'", [id]);

    const code = 'LIC-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const startsAt = new Date();
    // Optional days override (fractional allowed, e.g. 0.0208 = 30 min) so
    // a package's validity can be shortened for a trial; otherwise the
    // plan's billing period decides (yearly 365 / quarterly 90 / else 30).
    let days = plan.billing_period === 'yearly' ? 365 : plan.billing_period === 'quarterly' ? 90 : 30;
    if (body?.days != null) {
      days = Number(body.days);
      if (!Number.isFinite(days) || days <= 0) {
        throw new BadRequestException('days must be a number greater than 0');
      }
    }
    const endsAt = new Date(Date.now() + days * 86400000);

    const featuresJson = typeof plan.features_json === 'string' ? plan.features_json : JSON.stringify(plan.features_json || []);

    const licRes = await this.pool.query(
      `INSERT INTO licenses (code, client_id, plan_id, kind, starts_at, ends_at, credits_total, status, features_json, validity_days, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, NOW())
       RETURNING *`,
      [code, id, plan.id, plan.kind, startsAt, endsAt, plan.credits_included || 0, featuresJson, days, req?.user?.username ?? null]
    );
    const row = licRes.rows[0];
    await this.licensing.audit('assign', req?.user?.username ?? null, id, row?.id ?? null, code, `plan ${plan.id}, ${days} days`);
    return row;
  }

  @Get('admin/totp/status')
  async getTotpStatus(@Req() req: any) {
    const userId = req?.user?.id;
    if (!userId) throw new UnauthorizedException('Authentication required');
    const row = await this.pool.query('SELECT enabled, secret_enc FROM admin_totp WHERE user_id = $1', [userId]);
    const r = row.rows[0];
    return {
      enabled: Boolean(r?.enabled),
      configured: Boolean(r?.secret_enc),
    };
  }

  @Post('admin/totp/setup')
  async setupTotp(@Req() req: any, @Body() body: { password?: string }) {
    const userId = req?.user?.id;
    if (!userId) throw new UnauthorizedException('Authentication required');
    if (!body?.password) {
      throw new BadRequestException('Password confirmation is required');
    }
    const uRes = await this.pool.query('SELECT password_hash, username FROM users WHERE id = $1', [userId]);
    const user = uRes.rows[0];
    if (!user) throw new NotFoundException('User not found');
    const valid = await verifyPassword(body.password, user.password_hash);
    if (!valid) {
      throw new BadRequestException('Incorrect password');
    }

    const secret = generateSecret(20);
    const encryptedSecret = encrypt(secret);
    await this.pool.query(
      `INSERT INTO admin_totp (user_id, secret_enc, enabled, created_at)
       VALUES ($1, $2, false, NOW())
       ON CONFLICT (user_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, enabled = false`,
      [userId, encryptedSecret]
    );
    return {
      secret,
      otpauth_url: otpauthUrl(secret, user.username || 'admin@tectobox.com'),
    };
  }

  @Post('admin/totp/enable')
  async enableTotp(@Req() req: any, @Body() body: { token: string }) {
    const userId = req?.user?.id;
    if (!userId) throw new UnauthorizedException('Authentication required');
    const row = await this.pool.query('SELECT secret_enc FROM admin_totp WHERE user_id = $1', [userId]);
    const r = row.rows[0];
    if (!r?.secret_enc) throw new BadRequestException('TOTP setup required first');

    const storedSecret = r.secret_enc;
    const isEnc = isEncrypted(storedSecret);
    const secret = isEnc ? decrypt(storedSecret) : storedSecret;

    const ok = verifyTotp(secret, body?.token);
    if (!ok) {
      throw new BadRequestException('Invalid code — check your authenticator app clock.');
    }

    // Migrate-on-read: if an existing stored secret is not encrypted (no version prefix), encrypt it on first successful use.
    if (!isEnc) {
      const newlyEncrypted = encrypt(secret);
      await this.pool.query('UPDATE admin_totp SET enabled = true, secret_enc = $1 WHERE user_id = $2', [newlyEncrypted, userId]);
    } else {
      await this.pool.query('UPDATE admin_totp SET enabled = true WHERE user_id = $1', [userId]);
    }
    return { ok: true, enabled: true };
  }

  @Post('admin/totp/disable')
  async disableTotp(@Req() req: any, @Body() body: { password?: string }) {
    const userId = req?.user?.id;
    if (!userId) throw new UnauthorizedException('Authentication required');
    if (!body?.password) {
      throw new BadRequestException('Password confirmation is required');
    }
    const uRes = await this.pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    const user = uRes.rows[0];
    if (!user) throw new NotFoundException('User not found');
    const valid = await verifyPassword(body.password, user.password_hash);
    if (!valid) {
      throw new BadRequestException('Incorrect password');
    }

    await this.pool.query('DELETE FROM admin_totp WHERE user_id = $1', [userId]);
    return { ok: true, enabled: false };
  }
}
