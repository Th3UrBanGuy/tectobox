import {
  Controller,
  Post,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
  Inject,
  ParseIntPipe,
  BadRequestException,
} from '@nestjs/common';
import pg from 'pg';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { DB_POOL } from '../database/database.module.js';
import { EventsService } from '../events/events.service.js';
import { ConversationsController } from '../conversations/conversations.controller.js';

/**
 * Channel connect / sign-in / disconnect, per-channel AI pause,
 * account-slot delete, and conversation delete/restore.
 *
 * Split out of `ConnectorsController` (Phase 3 of the modular
 * restructure). Methods moved verbatim; no behaviour change.
 *
 * NOTE on the conversation delete/restore delegations below: they
 * construct `ConversationsController` by hand because that controller
 * is registered in NO module (its routes are dead as HTTP endpoints).
 * This is the only live path for conversation delete/restore, so the
 * delegations stay exactly as they were. Registering the
 * conversations module naively would create duplicate routes, and
 * deleting the directory would break delete/restore — both are
 * deliberately out of scope for this phase.
 */
@Controller('api')
export class ChannelConnectController {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    private readonly eventsService: EventsService
  ) {}

  @Post('clients/:clientId/connectors/:channel/connect')
  @UseGuards(TenantGuard)
  async connectChannel(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number,
    @Param('channel') channel: string,
    @Body() body: any
  ) {
    const targetClient = tenantId || clientId;
    const slot = body?.slot || 'default';
    const label = body?.label !== undefined ? String(body.label).trim() : null;
    // Phone login: 'qr' (default) or 'phone'. A phone number is digits only,
    // 7-15 long, country code included, no '+' — Baileys/GramJS both want it
    // that way. The number is never stored; it only rides the connect
    // command to the worker.
    const method = body?.method === 'phone' ? 'phone' : 'qr';
    const phoneNumber = String(body?.phoneNumber || '').replace(/[^0-9]/g, '');
    if (method === 'phone' && (channel === 'whatsapp' || channel === 'telegram')) {
      if (!/^[0-9]{7,15}$/.test(phoneNumber)) {
        throw new BadRequestException('Enter a valid phone number with country code (digits only).');
      }
      // A leading 0 means the number was typed in local format (e.g.
      // 0164...). Baileys/GramJS need international format, and WhatsApp
      // answers a bad number by dropping the socket ("Connection Closed").
      if (phoneNumber.startsWith('0')) {
        throw new BadRequestException('Number must start with the country code (e.g. 880 for Bangladesh) — remove the leading 0.');
      }
    }

    const row = await this.pool.query(
      `INSERT INTO channel_sessions (client_id, channel, slot, status, label, updated_at)
       VALUES ($1, $2, $3, 'connecting', $4, NOW())
       ON CONFLICT(client_id, channel, slot) DO UPDATE
       SET status = 'connecting',
           label = COALESCE(EXCLUDED.label, channel_sessions.label),
           updated_at = NOW()
       RETURNING id, client_id, channel, slot, label, status`,
      [targetClient, channel, slot, label]
    );
    const rowId = row?.rows?.[0]?.id;
    const finalLabel = row?.rows?.[0]?.label ?? label;

    // RC5 & RC6: start real channel session in worker.
    if (channel === 'whatsapp') {
      const triggered = await this.eventsService.publishChannelConnect(targetClient, slot, {
        method,
        phoneNumber: method === 'phone' ? phoneNumber : undefined,
      });
      if (!triggered) {
        console.warn(
          `[connectors] WhatsApp connect for client ${targetClient}:${slot} did not reach the worker (broker down?) — row stays 'connecting'; re-tap Connect to retry`
        );
      }
    } else if (channel === 'telegram') {
      // channel.connect.telegram: trigger Telegram worker session & QR flow
      const triggered = await this.eventsService.publishChannelConnectTelegram(
        targetClient,
        slot,
        rowId,
        finalLabel,
        { method, phoneNumber: method === 'phone' ? phoneNumber : undefined }
      );
      if (!triggered) {
        console.warn(
          `[connectors] Telegram connect (channel.connect.telegram) for client ${targetClient}:${slot} did not reach the worker (broker down?) — row stays 'connecting'; re-tap Connect to retry`
        );
      }
    }

    return { ok: true, channel, slot, status: 'connecting', method };
  }

  @Post('clients/:clientId/connectors/:channel/signin')
  @UseGuards(TenantGuard)
  async signinChannel(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number,
    @Param('channel') channel: string,
    @Body() body: any
  ) {
    // Telegram phone login, step 2: the user typed the code Telegram sent.
    // Only Telegram has a code to submit — WhatsApp pairing codes are typed
    // into the phone's own WhatsApp, never here.
    if (channel !== 'telegram') {
      throw new BadRequestException('Phone-code sign-in is only for Telegram.');
    }
    const targetClient = tenantId || clientId;
    const slot = body?.slot || 'default';
    const code = String(body?.code || '').replace(/[^0-9]/g, '');
    if (!/^[0-9]{5}$/.test(code)) {
      throw new BadRequestException('Enter the 5-digit code Telegram sent you.');
    }
    const password = body?.password !== undefined ? String(body.password) : undefined;
    const triggered = await this.eventsService.publishTelegramSignIn(targetClient, slot, code, password);
    if (!triggered) {
      throw new BadRequestException('Could not reach the worker — try again.');
    }
    return { ok: true, channel, slot, status: 'verifying' };
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
    const slot = body?.slot || 'default';

    if (channel === 'whatsapp' || channel === 'telegram') {
      const triggered = await this.eventsService.publishChannelDisconnect(channel, targetClient, slot);
      if (!triggered) {
        console.warn(
          `[connectors] Disconnect for client ${targetClient}:${channel}:${slot} did not reach worker (broker down?)`
        );
      }
      return { ok: true, channel, slot, status: 'disconnecting' };
    }

    await this.pool.query(
      `UPDATE channel_sessions
       SET status = 'disconnected', updated_at = NOW()
       WHERE client_id = $1 AND channel = $2 AND slot = $3`,
      [targetClient, channel, slot]
    );

    return { ok: true, channel, slot, status: 'disconnected' };
  }

  @Delete('clients/:clientId/conversations/:conversationId')
  @UseGuards(TenantGuard)
  async deleteConversation(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number,
    @Param('conversationId', ParseIntPipe) conversationId: number,
    @Req() req: any
  ) {
    const ctrl = new ConversationsController(this.pool);
    return ctrl.deleteConversation(tenantId, clientId, conversationId, req);
  }

  @Post('clients/:clientId/conversations/:conversationId/restore')
  @UseGuards(TenantGuard)
  async restoreConversation(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number,
    @Param('conversationId', ParseIntPipe) conversationId: number,
    @Req() req: any
  ) {
    const ctrl = new ConversationsController(this.pool);
    return ctrl.restoreConversation(tenantId, clientId, conversationId, req);
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
}
