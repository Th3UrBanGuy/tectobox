import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Inject,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import pg from 'pg';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { DB_POOL } from '../database/database.module.js';

/**
 * Webchat appearance settings (title, greeting, colour, position…).
 *
 * Split out of `ConnectorsController` (Phase 3 of the modular
 * restructure). Methods moved verbatim; no behaviour change.
 */
@Controller('api')
export class WebchatConfigController {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool
  ) {}

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
}
