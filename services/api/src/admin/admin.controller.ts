import { Controller, Get, Post, Patch, Delete, Put, Body, Param, Query, Req, UseGuards, Inject, ParseIntPipe, NotFoundException, BadRequestException, UnauthorizedException, Optional, OnModuleInit } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import pg from 'pg';
import crypto from 'crypto';
import { DB_POOL } from '../database/database.module.js';
import { hashPassword, verifyPassword } from '../auth/password.util.js';
import { TotpService, totpErrorToHttp } from '../auth/totp.service.js';
import { LicensingService } from '../licensing/licensing.service.js';
import { EventsService } from '../events/events.service.js';
import { CreateUserDto, ResetPasswordDto } from './dto/admin.dto.js';
import { CF_MODEL_POOL } from '@tectonic/ai-router';
import { SSE_EVENT_TYPES } from '@tectonic/contracts';

/** P10 (2026-11-15): the correct internal AI-server URL. The old code
 * default was http://localhost:18080/v1, which is what the live admin
 * panel displayed — localhost inside a container is never the AI
 * server. The runtime AI path uses GEMINI_WEB2API_URL /
 * http://ai:8081/v1 (compose + app.config.ts); the admin config must
 * show the same address. */
const DEFAULT_AI_BASE_URL = 'http://ai:8081/v1';
/** First Tier-1 model in providers.ts — the default when no model is configured. */
const DEFAULT_AI_MODEL = 'gemini-3.6-flash';

@Controller('api')
@UseGuards(TenantGuard, AdminGuard)
export class AdminController implements OnModuleInit {
  private readonly totp: TotpService;

  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(LicensingService) private readonly licensing: LicensingService,
    @Optional() private readonly eventsService?: EventsService
  ) {
    this.totp = new TotpService(pool);
  }

  /**
   * P12: ensure the notifications history table exists (same
   * CREATE-TABLE-IF-NOT-EXISTS pattern as PaymentsController) — the
   * numbered migration 005 covers fresh/apply-on-deploy DBs, this
   * covers a live DB where the migration has not been applied yet.
   */
  async onModuleInit() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS admin_notifications (
          id SERIAL PRIMARY KEY,
          client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
          title TEXT NOT NULL DEFAULT 'Admin notice',
          message TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_admin_notifications_client ON admin_notifications(client_id, created_at DESC);
      `);
    } catch (err: any) {
      console.warn('[admin] Failed to ensure admin_notifications table:', err.message);
    }
  }

  private getEvents(): EventsService {
    return this.eventsService || new EventsService(this.pool, this.licensing);
  }

  /**
   * P1 (2026-11-15): the ONE channel truth. Overview stats and the
   * resources table are computed from this single query — the old code
   * counted channels from channel_sessions only (with a hardcoded
   * floor of 4) while the table merged channel_sessions + meta_pages
   * and fabricated 3 rows when the DB was empty, so the numbers could
   * never agree. Status 'ready' (webchat with a widget key) is
   * normalised to 'connected' here — it means the same thing.
   */
  private async getChannelResources() {
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
    return [...rows.rows, ...meta.rows].map((r: any) => ({
      channel: r.channel,
      account: r.account || r.workspace || '—',
      workspace: r.workspace || '—',
      // 'ready' is the webchat status for "widget key exists" — it IS connected.
      status: r.status === 'ready' ? 'connected' : (r.status || 'disconnected'),
      clientId: r.client_id ?? null,
      // No last-seen in the DB means never seen — show '—', never a
      // fabricated timestamp (the old fallback stamped "now" on all rows).
      lastSeen: r.lastSeen ? new Date(r.lastSeen).toISOString() : null,
    }));
  }

  @Get(['admin/overview', 'global-stats'])
  async getOverview() {
    const clientsCount = await this.pool.query('SELECT COUNT(*) as count FROM clients');
    const convCount = await this.pool.query('SELECT COUNT(*) as count FROM conversations');
    const msgCount = await this.pool.query('SELECT COUNT(*) as count FROM messages');
    const orderCount = await this.pool.query('SELECT COUNT(*) as count, COALESCE(SUM(total_bdt), 0) as total FROM orders');
    const leadCount = await this.pool.query('SELECT COUNT(*) as count FROM leads');
    const resources = await this.getChannelResources();

    return {
      workspaces: Number(clientsCount.rows[0]?.count || 0),
      channels: resources.length,
      connected: resources.filter((r) => r.status === 'connected').length,
      errored: resources.filter((r) => r.status === 'error').length,
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
             c.id as id,
             c.id as client_id,
             c.name as client_name,
             u.id as user_id,
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
                 AND (l.kind <> 'time' OR l.ends_at IS NULL OR l.ends_at > NOW())
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

  @Delete(['clients/:id', 'admin/clients/:id', 'admin/workspaces/:id'])
  async deleteWorkspace(@Param('id', ParseIntPipe) id: number, @Req() req?: any) {
    await this.pool.query('DELETE FROM users WHERE client_id = $1', [id]);
    await this.pool.query('DELETE FROM clients WHERE id = $1', [id]);
    const actorId = req?.user?.username || req?.user?.id || 'admin';
    const ip = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || null;
    await this.getEvents().writeAudit(actorId, id, 'workspace:delete', { ip });
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
  async createUser(@Body() body: CreateUserDto, @Req() req?: any) {
    if (!body.username || !body.password) {
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
    const actorId = req?.user?.username || req?.user?.id || 'admin';
    const ip = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || null;
    await this.getEvents().writeAudit(actorId, clientId, 'user:create', { newUserId: user.id, username: user.username, role: user.role, ip });

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
  async resetUserPassword(@Param('id', ParseIntPipe) id: number, @Body() body: ResetPasswordDto, @Req() req?: any) {
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
    const actorId = req?.user?.username || req?.user?.id || 'admin';
    const ip = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || null;
    await this.getEvents().writeAudit(actorId, null, 'password:reset', { targetUserId: id, ip });
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
  async getAuditLog(
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string
  ) {
    const limit = Math.min(200, Math.max(1, parseInt(limitStr || '', 10) || 50));
    const offset = Math.max(0, parseInt(offsetStr || '', 10) || 0);

    const countRes = await this.pool.query('SELECT COUNT(*) AS total FROM audit_log');
    const total = parseInt(countRes.rows[0]?.total || '0', 10);

    const result = await this.pool.query(
      'SELECT * FROM audit_log ORDER BY id DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    const res: any = result.rows;
    res.total = total;
    res.limit = limit;
    res.offset = offset;
    return res;
  }

  @Get('admin/config')
  async getConfig() {
    const rows = await this.pool.query('SELECT key, value FROM settings');
    const cfg: Record<string, string> = {};
    for (const r of rows.rows) cfg[r.key] = r.value;
    // P10 (2026-11-15): the old code returned ONLY autoReply /
    // aiBaseUrl / settings — the frontend reads c.aiModel and
    // c.aiModelPool, so the model fields were always empty, and the
    // aiBaseUrl default was a localhost address that must never be
    // served on the live site. Defaults now point at the real internal
    // AI server (http://ai:8081/v1) and the Tier-1 model + CF pool.
    const pool = cfg['ai.model_pool']
      ? cfg['ai.model_pool'].split(',').map((s) => s.trim()).filter(Boolean)
      : CF_MODEL_POOL;
    return {
      autoReply: cfg['ai.auto_reply'] !== '0',
      aiBaseUrl: cfg['ai.base_url'] || DEFAULT_AI_BASE_URL,
      aiModel: cfg['ai.model'] || DEFAULT_AI_MODEL,
      aiModelPool: pool,
      settings: cfg,
    };
  }

  @Put('admin/config')
  async updateConfig(@Body() body: any) {
    // P10: the old code stored body keys verbatim ('aiModel',
    // 'aiBaseUrl', 'autoReply') while getConfig reads the canonical
    // keys ('ai.model', 'ai.base_url', 'ai.auto_reply') — so a save
    // NEVER round-tripped (the auto-reply toggle silently did nothing).
    // Map the frontend's camelCase keys to the canonical settings keys.
    const keyMap: Record<string, string> = {
      autoReply: 'ai.auto_reply',
      aiModel: 'ai.model',
      aiModelPool: 'ai.model_pool',
      aiBaseUrl: 'ai.base_url',
    };
    for (const [k, v] of Object.entries(body)) {
      const key = keyMap[k] || k;
      let value = v;
      if (key === 'ai.auto_reply') value = v === true || v === '1' || v === 'true' ? '1' : '0';
      if (key === 'ai.model_pool' && Array.isArray(v)) value = (v as string[]).join(',');
      await this.pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = NOW()`,
        [key, String(value)]
      );
    }
    return { ok: true, success: true };
  }

  @Get('admin/resources')
  async getResources() {
    // P1: real rows only, from the same query as the overview. When
    // nothing is connected the table is EMPTY — the old code fabricated
    // whatsapp/telegram/webchat rows stamped "now", which is why the
    // admin panel claimed "connected" while the real sessions were empty.
    return this.getChannelResources();
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

  /**
   * P12 (2026-11-15): notifications that actually send. The old code
   * threw NotImplementedException while the UI offered a send form.
   * Each send is recorded in `admin_notifications` (migration
   * 005-admin-notifications.sql) so the Notifications tab can show a
   * real history — never invented — and is broadcast over SSE to each
   * target workspace, where the dashboard shows it as a toast.
   * Body: { message, title?, clientIds?: number[] } — no clientIds
   * means every workspace. A target workspace id that does not exist
   * is skipped (recorded as skipped, not sent).
   */
  @Post('admin/notify')
  async sendNotification(@Body() body: any) {
    const message = String(body?.message || '').trim().slice(0, 2000);
    if (!message) throw new BadRequestException('Message is required');
    const title = String(body?.title || 'Admin notice').trim().slice(0, 120);
    let targets: number[];
    if (Array.isArray(body?.clientIds) && body.clientIds.length) {
      targets = body.clientIds.map((n: any) => parseInt(String(n), 10)).filter((n: number) => !Number.isNaN(n));
    } else {
      const all = await this.pool.query('SELECT id FROM clients ORDER BY id');
      targets = all.rows.map((r: any) => r.id);
    }
    if (targets.length === 0) return { ok: true, sent: 0, skipped: 0 };
    const existing = await this.pool.query(
      `SELECT id FROM clients WHERE id = ANY($1::int[])`, [targets]
    );
    const existingIds = new Set(existing.rows.map((r: any) => r.id));
    const sent: number[] = [];
    const skipped: number[] = [];
    for (const id of targets) {
      if (!existingIds.has(id)) { skipped.push(id); continue; }
      await this.pool.query(
        `INSERT INTO admin_notifications (client_id, title, message, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [id, title, message]
      );
      sent.push(id);
    }
    const events = this.getEvents();
    for (const id of sent) {
      await events.broadcastTenantEvent(id, {
        type: SSE_EVENT_TYPES.ADMIN_NOTIFICATION,
        title,
        message,
      }).catch(() => {});
    }
    return { ok: true, sent: sent.length, skipped: skipped.length };
  }

  /** P12: the real sent-notifications history for the Notifications tab. */
  @Get('admin/notifications')
  async getNotifications(
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string
  ) {
    const limit = Math.min(200, Math.max(1, parseInt(limitStr || '', 10) || 50));
    const offset = Math.max(0, parseInt(offsetStr || '', 10) || 0);
    const result = await this.pool.query(
      `SELECT n.id, n.client_id, c.name AS workspace, n.title, n.message, n.created_at
       FROM admin_notifications n
       LEFT JOIN clients c ON c.id = n.client_id
       ORDER BY n.id DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return result.rows;
  }

  /**
   * P13/P20 (2026-11-15): admin "View chat" — read a conversation that
   * belongs to ANOTHER workspace. The admin has no tenant of their own,
   * so the normal inbox endpoints (tenant-scoped) can never serve it.
   * These AdminGuard endpoints return the conversation + its client +
   * orders, and its messages, so the inbox can render the real
   * conversation read-only instead of the admin's empty inbox.
   */
  @Get('admin/conversations/:id')
  async getAdminConversation(@Param('id', ParseIntPipe) id: number) {
    const conv = await this.pool.query(
      `SELECT c.*, cl.name AS workspace, cl.id AS client_id
       FROM conversations c JOIN clients cl ON cl.id = c.client_id
       WHERE c.id = $1`,
      [id]
    );
    if (conv.rows.length === 0) throw new NotFoundException('Conversation not found');
    const orders = await this.pool.query(
      'SELECT id, total_bdt, status, created_at FROM orders WHERE conversation_id = $1 ORDER BY id DESC LIMIT 20',
      [id]
    );
    return { ...conv.rows[0], orders: orders.rows };
  }

  @Get('admin/conversations/:id/messages')
  async getAdminConversationMessages(@Param('id', ParseIntPipe) id: number) {
    const conv = await this.pool.query('SELECT id FROM conversations WHERE id = $1', [id]);
    if (conv.rows.length === 0) throw new NotFoundException('Conversation not found');
    const result = await this.pool.query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC LIMIT 500',
      [id]
    );
    return result.rows;
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
    try {
      return await this.totp.getStatus(req?.user?.id);
    } catch (err) {
      throw totpErrorToHttp(err);
    }
  }

  @Post('admin/totp/setup')
  async setupTotp(@Req() req: any, @Body() body: { password?: string }) {
    const userId = req?.user?.id;
    if (!userId) throw new UnauthorizedException('Authentication required');
    if (!body?.password) {
      throw new BadRequestException('Password confirmation is required');
    }
    try {
      return await this.totp.setup(userId, body.password);
    } catch (err) {
      throw totpErrorToHttp(err);
    }
  }

  @Post('admin/totp/enable')
  async enableTotp(@Req() req: any, @Body() body: { token: string }) {
    try {
      return await this.totp.enable(req?.user?.id, body?.token);
    } catch (err) {
      throw totpErrorToHttp(err);
    }
  }

  @Post('admin/totp/disable')
  async disableTotp(@Req() req: any, @Body() body: { password?: string }) {
    const userId = req?.user?.id;
    if (!userId) throw new UnauthorizedException('Authentication required');
    if (!body?.password) {
      throw new BadRequestException('Password confirmation is required');
    }
    try {
      return await this.totp.disable(userId, body.password);
    } catch (err) {
      throw totpErrorToHttp(err);
    }
  }
}
