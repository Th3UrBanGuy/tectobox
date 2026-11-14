import {
  Controller,
  Get,
  Param,
  UseGuards,
  Inject,
  ParseIntPipe,
} from '@nestjs/common';
import pg from 'pg';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { DB_POOL } from '../database/database.module.js';
import { EventsService } from '../events/events.service.js';

/**
 * Channel account list (WhatsApp / Telegram / Messenger / Instagram /
 * webchat) with honest statuses.
 *
 * Split out of `ConnectorsController` (Phase 3 of the modular
 * restructure). Method moved verbatim; no behaviour change.
 */
@Controller('api')
export class ChannelsController {
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
          const pairingCode = await this.eventsService.getPairingCode(targetClient, s.slot);
          return {
            slot: s.slot,
            status: s.status,
            label: s.label,
            aiPaused: s.ai_paused,
            qr: qr || undefined,
            pairingCode: pairingCode || undefined,
          };
        })
    );

    const tgAccounts = await Promise.all(
      sessions.rows
        .filter((s) => s.channel === 'telegram')
        .map(async (s) => {
          const qr = await this.eventsService.getQrCode(targetClient, s.slot, 'telegram');
          const phoneCodeSent = await this.eventsService.getPhoneCodeSent(targetClient, s.slot);
          return {
            slot: s.slot,
            status: s.status,
            label: s.label,
            aiPaused: s.ai_paused,
            qr: qr || undefined,
            phoneCodeSent: phoneCodeSent || undefined,
          };
        })
    );

    const metaPages = await this.pool.query(
      'SELECT channel, page_id, page_name, ig_username, status FROM meta_pages WHERE client_id = $1',
      [targetClient]
    );

    const clientRes = await this.pool.query('SELECT widget_key, website_url FROM clients WHERE id = $1', [targetClient]);
    const client = clientRes.rows[0];

    // Honest statuses only: a channel with no real session/page is
    // 'disconnected' with an empty list — never invent a "Primary" account.
    // (2026-11-12: the old fallbacks fabricated a connected "Primary WA" /
    // "Primary TG" for every fresh workspace; removed — no demo data in prod.)
    const messengerPages = metaPages.rows.filter((p) => p.channel === 'messenger');
    const instagramPages = metaPages.rows.filter((p) => p.channel === 'instagram');
    return {
      whatsapp: {
        method: 'QR code scan or phone number (Baileys Linked devices)',
        status: waAccounts.some((a) => a.status === 'connected') ? 'connected' : 'disconnected',
        accounts: waAccounts,
      },
      telegram: {
        method: 'QR code scan or phone number login (Linked devices)',
        status: tgAccounts.some((a) => a.status === 'connected') ? 'connected' : 'disconnected',
        accounts: tgAccounts,
      },
      messenger: {
        method: 'Facebook Page OAuth',
        status: messengerPages.some((p) => p.status === 'connected') ? 'connected' : 'disconnected',
        pages: messengerPages,
      },
      instagram: {
        method: 'Facebook Page OAuth (linked business account)',
        status: instagramPages.some((p) => p.status === 'connected') ? 'connected' : 'disconnected',
        pages: instagramPages,
      },
      webchat: {
        mode: 'live',
        status: client?.widget_key ? 'ready' : 'disconnected',
        method: 'One-line embed script',
        widgetKey: client?.widget_key || null,
        websiteUrl: client?.website_url || null,
        note: 'Paste the snippet on any website — visitor chats land in this inbox and the AI answers from your products + website.',
      },
    };
  }
}
