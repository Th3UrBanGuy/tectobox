import {
  Controller,
  Get,
  Post,
  Delete,
  Put,
  Param,
  Body,
  Query,
  Req,
  Res,
  UseGuards,
  Inject,
  ParseIntPipe,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import crypto, { randomBytes } from 'crypto';
import pg from 'pg';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { DB_POOL } from '../database/database.module.js';
import { EventsService } from '../events/events.service.js';

const META_GRAPH = 'v21.0';
const META_SCOPES = 'pages_show_list,pages_messaging,pages_manage_metadata,instagram_basic,instagram_manage_messages';
const pendingMetaOAuth = new Map<string, { clientId: number; createdAt: number }>();
const pendingMetaPick = new Map<string, { clientId: number; pages: any[]; createdAt: number }>();

function escHtml(s: any): string {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c
  );
}

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

@Controller('api')
export class ConnectorsController {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    private readonly eventsService: EventsService
  ) {}

  @Get('clients/:clientId/connectors')
  @UseGuards(TenantGuard)
  async getConnectors(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number
  ) {
    const targetClient = tenantId || clientId;
    const sessions = await this.pool.query(
      'SELECT channel, slot, status, label, ai_paused, updated_at FROM channel_sessions WHERE client_id = $1',
      [targetClient]
    );

    const waAccounts = await Promise.all(
      sessions.rows
        .filter((s) => s.channel === 'whatsapp')
        .map(async (s) => {
          const qr = await this.eventsService.getQrCode(targetClient, s.slot);
          return {
            slot: s.slot,
            status: s.status,
            label: s.label,
            aiPaused: s.ai_paused,
            qr: qr || undefined,
          };
        })
    );

    const tgAccounts = sessions.rows
      .filter((s) => s.channel === 'telegram')
      .map((s) => ({ slot: s.slot, status: s.status, label: s.label, aiPaused: s.ai_paused }));

    const metaPages = await this.pool.query(
      'SELECT channel, page_id, page_name, ig_username, status FROM meta_pages WHERE client_id = $1',
      [targetClient]
    );

    const clientRes = await this.pool.query('SELECT widget_key, website_url FROM clients WHERE id = $1', [targetClient]);
    const client = clientRes.rows[0];

    return {
      whatsapp: {
        accounts: waAccounts.length ? waAccounts : [{ slot: 'default', status: 'connected', label: 'Primary WA' }],
      },
      telegram: {
        accounts: tgAccounts.length ? tgAccounts : [{ slot: 'default', status: 'connected', label: 'Primary TG' }],
      },
      messenger: {
        pages: metaPages.rows.filter((p) => p.channel === 'messenger'),
      },
      instagram: {
        pages: metaPages.rows.filter((p) => p.channel === 'instagram'),
      },
      webchat: {
        mode: 'live',
        status: 'connected',
        method: 'One-line embed script',
        widgetKey: client?.widget_key || 'test-widget-key',
        websiteUrl: client?.website_url || null,
        note: 'Paste the snippet on any website — visitor chats land in this inbox and the AI answers from your products + website.',
      },
    };
  }

  @Get('webchat/config')
  @UseGuards(TenantGuard)
  async getWebchatConfig(@CurrentTenant() tenantId: number) {
    const res = await this.pool.query(
      'SELECT id, name, widget_key, website_url, wc_title, wc_greeting, wc_color, wc_position, wc_avatar, wc_subtitle, wc_require_intro FROM clients WHERE id = $1',
      [tenantId]
    );
    if (!res.rows.length) return {};
    const c = res.rows[0];

    let widgetKey = c.widget_key;
    if (!widgetKey) {
      widgetKey = 'wk_' + randomBytes(8).toString('hex');
      await this.pool.query('UPDATE clients SET widget_key = $1 WHERE id = $2', [widgetKey, tenantId]);
    }

    return {
      widget_key: widgetKey,
      website_url: c.website_url,
      imported_pages: 0,
      appearance: {
        title: c.wc_title || c.name || 'Chat with us',
        subtitle: c.wc_subtitle || 'Online — replies instantly',
        greeting: c.wc_greeting || 'Hi there! 👋 How can I help you today?',
        color: c.wc_color || '#7c5cff',
        position: c.wc_position || 'bottom-right',
        avatar: c.wc_avatar || '',
        require_intro: c.wc_require_intro !== false,
      },
    };
  }

  @Post('webchat/config')
  @UseGuards(TenantGuard)
  async saveWebchatConfig(@CurrentTenant() tenantId: number, @Body() body: any) {
    const f: any = {};
    if (body.title !== undefined) f.wc_title = String(body.title).slice(0, 60);
    if (body.greeting !== undefined) f.wc_greeting = String(body.greeting).slice(0, 300);
    if (body.subtitle !== undefined) f.wc_subtitle = String(body.subtitle).slice(0, 80);
    if (body.avatar !== undefined) f.wc_avatar = String(body.avatar).slice(0, 500);
    if (body.color !== undefined) {
      const col = String(body.color).trim();
      if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(col)) f.wc_color = col;
    }
    if (body.position !== undefined && ['bottom-right', 'bottom-left'].includes(body.position)) {
      f.wc_position = body.position;
    }
    if (body.require_intro !== undefined) f.wc_require_intro = !!+body.require_intro;

    const fields = Object.keys(f);
    if (fields.length) {
      const sets = fields.map((k, i) => `${k} = $${i + 2}`).join(', ');
      const vals = fields.map((k) => f[k]);
      await this.pool.query(`UPDATE clients SET ${sets} WHERE id = $1`, [tenantId, ...vals]);
    }

    return { ok: true, appearance: f };
  }

  @Post('clients/:clientId/connectors/:channel/connect')
  @UseGuards(TenantGuard)
  async connectChannel(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number,
    @Param('channel') channel: string,
    @Body() body: any
  ) {
    const targetClient = tenantId || clientId;
    const slot = body.slot || 'default';

    await this.pool.query(
      `INSERT INTO channel_sessions (client_id, channel, slot, status, updated_at)
       VALUES ($1, $2, $3, 'connecting', NOW())
       ON CONFLICT(client_id, channel, slot) DO UPDATE
       SET status = 'connecting', updated_at = NOW()`,
      [targetClient, channel, slot]
    );

    return { ok: true, channel, slot, status: 'connecting' };
  }

  @Post('clients/:clientId/connectors/:channel/disconnect')
  @UseGuards(TenantGuard)
  async disconnectChannel(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number,
    @Param('channel') channel: string,
    @Body() body: any
  ) {
    const targetClient = tenantId || clientId;
    const slot = body.slot || 'default';

    await this.pool.query(
      `UPDATE channel_sessions
       SET status = 'disconnected', updated_at = NOW()
       WHERE client_id = $1 AND channel = $2 AND slot = $3`,
      [targetClient, channel, slot]
    );

    return { ok: true, channel, slot, status: 'disconnected' };
  }

  @Post('clients/:clientId/connectors/:channel/ai-pause')
  @UseGuards(TenantGuard)
  async toggleAiPause(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number,
    @Param('channel') channel: string,
    @Body() body: any
  ) {
    const targetClient = tenantId || clientId;
    const slot = body.slot || 'default';

    const res = await this.pool.query(
      `UPDATE channel_sessions
       SET ai_paused = NOT ai_paused, updated_at = NOW()
       WHERE client_id = $1 AND channel = $2 AND slot = $3
       RETURNING ai_paused`,
      [targetClient, channel, slot]
    );

    return { ok: true, ai_paused: res.rows[0]?.ai_paused ?? false };
  }

  @Delete('clients/:clientId/connectors/:channel/:slot')
  @UseGuards(TenantGuard)
  async deleteAccountSlot(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number,
    @Param('channel') channel: string,
    @Param('slot') slot: string
  ) {
    const targetClient = tenantId || clientId;
    await this.pool.query(
      'DELETE FROM channel_sessions WHERE client_id = $1 AND channel = $2 AND slot = $3',
      [targetClient, channel, slot]
    );
    return { ok: true, success: true };
  }

  // ---------------- Meta OAuth ----------------
  @Get('clients/:clientId/connectors/messenger/oauth/start')
  @UseGuards(TenantGuard)
  startMetaOAuth(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number,
    @Req() req: Request
  ) {
    const targetClient = tenantId || clientId;
    const appId = process.env.META_APP_ID;
    if (!appId) {
      return { error: 'META_APP_ID is not configured on the server' };
    }
    const state = `${targetClient}.${randomBytes(10).toString('hex')}`;
    pendingMetaOAuth.set(state, { clientId: targetClient, createdAt: Date.now() });

    const redirectUri = `${req.protocol}://${req.get('host')}/api/meta/oauth/callback`;
    const url =
      `https://www.facebook.com/${META_GRAPH}/dialog/oauth` +
      `?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent(META_SCOPES)}&state=${state}&response_type=code`;

    return { url };
  }

  @Get('meta/oauth/callback')
  async metaOAuthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: Request,
    @Res() res: Response
  ) {
    const pending = pendingMetaOAuth.get(state);
    if (!code || !pending) {
      return res
        .status(400)
        .send('<h3>Invalid or expired connection session.</h3><p>Please start again from the Connectors tab.</p>');
    }
    pendingMetaOAuth.delete(state);

    const redirectUri = `${req.protocol}://${req.get('host')}/api/meta/oauth/callback`;
    try {
      const tokRes = await fetch(
        `https://graph.facebook.com/${META_GRAPH}/oauth/access_token?` +
          new URLSearchParams({
            client_id: process.env.META_APP_ID || '',
            redirect_uri: redirectUri,
            client_secret: process.env.META_APP_SECRET || '',
            code,
          })
      );
      const tok: any = await tokRes.json().catch(() => ({}));
      if (!tokRes.ok) throw new Error(tok?.error?.message || 'Failed to exchange token');

      const accRes = await fetch(
        `https://graph.facebook.com/${META_GRAPH}/me/accounts?` +
          new URLSearchParams({
            fields: 'id,name,access_token',
            access_token: tok.access_token,
            limit: '50',
          })
      );
      const acc: any = await accRes.json().catch(() => ({}));
      const pages = (acc.data || []).filter((p: any) => p.access_token);

      if (!pages.length) {
        return res.send('<h3>No Facebook Pages found</h3><p>This Facebook account has no Pages.</p>');
      }

      if (pages.length === 1) {
        const r = await this.saveConnectedMetaPage(pending.clientId, pages[0]);
        return res.send(
          `<h3>Connected: ${escHtml(r.page)} ✅</h3>` +
            (r.instagram ? `<p>Instagram @${escHtml(r.instagram)} also connected.</p>` : '') +
            '<p>You can close this tab and return to the app.</p>'
        );
      }

      const pid = randomBytes(10).toString('hex');
      pendingMetaPick.set(pid, { clientId: pending.clientId, pages, createdAt: Date.now() });
      return res.redirect(`/#meta-pick?pid=${pid}`);
    } catch (err: any) {
      console.error('[meta] OAuth failed:', err.message);
      return res.status(500).send(`<h3>Facebook connection failed</h3><p>${escHtml(err.message)}</p>`);
    }
  }

  @Get('meta/oauth/pending/:pid')
  getPendingMetaPick(@Param('pid') pid: string) {
    const p = pendingMetaPick.get(pid);
    if (!p) {
      return { error: 'This connection session expired — please start again.' };
    }
    return { pages: p.pages.map((x: any) => ({ id: x.id, name: x.name })) };
  }

  @Post('meta/oauth/pick')
  async pickMetaPage(@Body() body: { pid: string; pageId: string }) {
    const { pid, pageId } = body || {};
    const p = pendingMetaPick.get(pid);
    if (!p) return { error: 'expired' };

    const page = p.pages.find((x: any) => String(x.id) === String(pageId));
    if (!page) return { error: 'unknown page' };

    pendingMetaPick.delete(pid);
    const r = await this.saveConnectedMetaPage(p.clientId, page);
    return { ok: true, ...r };
  }

  private async saveConnectedMetaPage(clientId: number, page: any) {
    // 1. Subscribe to app webhooks
    try {
      await fetch(
        `https://graph.facebook.com/${META_GRAPH}/${page.id}/subscribed_apps?` +
          new URLSearchParams({
            access_token: page.access_token,
            subscribed_fields: 'messages,messaging_postbacks,feed',
          }),
        { method: 'POST' }
      );
    } catch (e: any) {
      console.warn('[meta] webhook subscribe warning:', e.message);
    }

    // 2. Discover linked Instagram business account
    let ig: any = null;
    try {
      const igRes = await fetch(
        `https://graph.facebook.com/${META_GRAPH}/${page.id}?` +
          new URLSearchParams({
            fields: 'instagram_business_account{id,username}',
            access_token: page.access_token,
          })
      );
      const pData: any = await igRes.json().catch(() => ({}));
      ig = pData.instagram_business_account || null;
    } catch (e: any) {
      console.warn('[meta] IG lookup failed:', e.message);
    }

    // 3. Save to database
    await this.pool.query(
      `INSERT INTO meta_pages (client_id, channel, page_id, page_name, page_access_token, status, updated_at)
       VALUES ($1, 'messenger', $2, $3, $4, 'connected', NOW())
       ON CONFLICT (client_id, channel) DO UPDATE
       SET page_id = EXCLUDED.page_id, page_name = EXCLUDED.page_name, page_access_token = EXCLUDED.page_access_token, status = 'connected', updated_at = NOW()`,
      [clientId, page.id, page.name, page.access_token]
    );

    // Dynamic Redis routing for Go ingress and outbound worker
    await this.eventsService.setRedisKey(`meta:page:${page.id}`, clientId.toString());
    await this.eventsService.setRedisKey(`meta:token:${clientId}:messenger`, page.access_token);

    if (ig) {
      await this.pool.query(
        `INSERT INTO meta_pages (client_id, channel, page_id, page_name, page_access_token, ig_user_id, ig_username, status, updated_at)
         VALUES ($1, 'instagram', $2, $3, $4, $5, $6, 'connected', NOW())
         ON CONFLICT (client_id, channel) DO UPDATE
         SET page_id = EXCLUDED.page_id, page_name = EXCLUDED.page_name, page_access_token = EXCLUDED.page_access_token, ig_user_id = EXCLUDED.ig_user_id, ig_username = EXCLUDED.ig_username, status = 'connected', updated_at = NOW()`,
        [clientId, page.id, page.name, page.access_token, ig.id, ig.username]
      );
      await this.eventsService.setRedisKey(`meta:page:${ig.id}`, clientId.toString());
      await this.eventsService.setRedisKey(`meta:token:${clientId}:instagram`, page.access_token);
    }

    // Broadcast connectors update to frontend
    await this.eventsService.broadcastTenantEvent(clientId, { type: 'connectors', clientId });
    console.log(`[meta] client ${clientId} connected page "${page.name}"${ig ? ` + IG @${ig.username}` : ''}`);

    return { page: page.name, instagram: ig ? ig.username : null };
  }

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
  @UseGuards(TenantGuard)
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

  @Get('clients/:clientId/comment-config')
  @UseGuards(TenantGuard)
  async getCommentConfig(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number
  ) {
    const target = tenantId || clientId;
    const rows = await this.pool.query(
      `SELECT key, value FROM settings WHERE key LIKE $1`,
      [`comment.%.${target}`]
    );
    const cfg: Record<string, string> = {};
    for (const r of rows.rows) cfg[r.key] = r.value;
    let rules: any[] = [];
    try { rules = JSON.parse(cfg[`comment.rules.${target}`] || '[]'); } catch {}
    return {
      autoReply: cfg[`comment.autoreply.${target}`] === '1',
      dmFollowup: cfg[`comment.dm.${target}`] === '1',
      likeComment: cfg[`comment.like.${target}`] === '1',
      rules: Array.isArray(rules) ? rules : [],
    };
  }

  @Put('clients/:clientId/comment-config')
  @UseGuards(TenantGuard)
  async updateCommentConfig(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number,
    @Body() body: any
  ) {
    const target = tenantId || clientId;
    if (body.autoReply !== undefined) {
      await this.pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [`comment.autoreply.${target}`, body.autoReply ? '1' : '0']
      );
    }
    if (body.dmFollowup !== undefined) {
      await this.pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [`comment.dm.${target}`, body.dmFollowup ? '1' : '0']
      );
    }
    if (body.likeComment !== undefined) {
      await this.pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [`comment.like.${target}`, body.likeComment ? '1' : '0']
      );
    }
    if (body.rules !== undefined) {
      await this.pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [`comment.rules.${target}`, JSON.stringify(body.rules)]
      );
    }
    return this.getCommentConfig(tenantId, clientId);
  }

  @Get('clients/:clientId/comments')
  @UseGuards(TenantGuard)
  async getComments(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number
  ) {
    const target = tenantId || clientId;
    const rows = await this.pool.query(
      'SELECT * FROM fb_comment_log WHERE client_id = $1 ORDER BY id DESC LIMIT 30',
      [target]
    );
    return rows.rows;
  }
}
