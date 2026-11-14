import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Req,
  Res,
  UseGuards,
  Inject,
  ParseIntPipe,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import pg from 'pg';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { DB_POOL } from '../database/database.module.js';
import { EventsService } from '../events/events.service.js';
import { SSE_EVENT_TYPES, metaPageKey, metaTokenKey } from '@tectonic/contracts';
import { metaOAuthState } from './meta.controller.js';

const META_GRAPH = 'v21.0';
const META_SCOPES = 'pages_show_list,pages_messaging,pages_manage_metadata,instagram_basic,instagram_manage_messages';
const pendingMetaPick = new Map<string, { clientId: number; pages: any[]; createdAt: number }>();

function escHtml(s: any): string {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c
  );
}

/**
 * Facebook / Instagram OAuth: start, callback, page pick, and the
 * connected-page save (Messenger + linked Instagram business account).
 *
 * Split out of `ConnectorsController` (Phase 3 of the modular
 * restructure) into `meta/`, where the OAuth state manager already
 * lives. Methods moved verbatim; no behaviour change. The
 * `pendingMetaPick` map moves with them, still module-level with no
 * TTL/pruning, exactly as before.
 */
@Controller('api')
export class MetaOAuthController {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    private readonly eventsService: EventsService
  ) {}

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
    metaOAuthState.setState(state, targetClient);

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
    const pending = metaOAuthState.consumeState(state);
    if (!code || !pending) {
      return res
        .status(400)
        .send('<h3>Invalid or expired connection session.</h3><p>Please start again from the Connectors tab.</p>');
    }

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
    await this.eventsService.setRedisKey(metaPageKey(page.id), clientId.toString());
    await this.eventsService.setRedisKey(metaTokenKey(clientId, 'messenger'), page.access_token);

    if (ig) {
      await this.pool.query(
        `INSERT INTO meta_pages (client_id, channel, page_id, page_name, page_access_token, ig_user_id, ig_username, status, updated_at)
         VALUES ($1, 'instagram', $2, $3, $4, $5, $6, 'connected', NOW())
         ON CONFLICT (client_id, channel) DO UPDATE
         SET page_id = EXCLUDED.page_id, page_name = EXCLUDED.page_name, page_access_token = EXCLUDED.page_access_token, ig_user_id = EXCLUDED.ig_user_id, ig_username = EXCLUDED.ig_username, status = 'connected', updated_at = NOW()`,
        [clientId, page.id, page.name, page.access_token, ig.id, ig.username]
      );
      await this.eventsService.setRedisKey(metaPageKey(ig.id), clientId.toString());
      await this.eventsService.setRedisKey(metaTokenKey(clientId, 'instagram'), page.access_token);
    }

    // Broadcast connectors update to frontend
    await this.eventsService.broadcastTenantEvent(clientId, { type: SSE_EVENT_TYPES.CONNECTORS, clientId });
    console.log(`[meta] client ${clientId} connected page "${page.name}"${ig ? ` + IG @${ig.username}` : ''}`);

    return { page: page.name, instagram: ig ? ig.username : null };
  }
}
