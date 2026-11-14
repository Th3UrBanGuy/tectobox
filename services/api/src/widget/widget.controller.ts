import { Controller, Get, Post, Body, Param, Query, Inject, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import pg from 'pg';
import { DB_POOL } from '../database/database.module.js';
import { EventsService } from '../events/events.service.js';
import { LicensingService } from '../licensing/licensing.service.js';
import { WidgetIntakeService } from './intake.service.js';
import { AiReplyService } from './ai-reply.service.js';
import { PaymentClaimService } from './payment-claim.service.js';

/**
 * Public webchat widget controller (Phase 3 of the modular
 * restructure). `handleWidgetMessage` is now orchestration only:
 * intake (lookup, licence gate, persistence, inbound broadcast) →
 * AI reply (handover, guardrails, knowledge-grounded reply chain,
 * outbound insert + broadcast). The constructor signature and the
 * response shape are unchanged.
 */
@Controller('api/widget')
export class WidgetController {
  private readonly intake: WidgetIntakeService;
  private readonly aiReply: AiReplyService;

  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Optional() private readonly eventsService?: EventsService,
    // Optional on purpose: this is a public route — a DI misconfiguration
    // must never 500 the intake. In production the module always wires it
    // (WidgetModule imports LicensingModule). When absent, the webchat
    // check is skipped but AI replies are denied (fail-closed for AI).
    @Optional() @Inject(LicensingService) private readonly licensing?: LicensingService
  ) {
    this.intake = new WidgetIntakeService(pool, eventsService, licensing);
    const paymentClaim = new PaymentClaimService(pool, eventsService);
    this.aiReply = new AiReplyService(pool, eventsService, licensing, paymentClaim);
  }

  @Post(':widgetKey/message')
  async handleWidgetMessage(
    @Param('widgetKey') widgetKey: string,
    @Body() body: any
  ) {
    const ctx = await this.intake.intake(widgetKey, body);
    const { replyText, replyId } = await this.aiReply.generateReply(ctx);

    return {
      reply: replyText,
      reply_id: replyId,
      conversation_id: ctx.conv.id,
      message_id: ctx.msg.id,
      needs_human: ctx.conv.needs_human || false,
    };
  }

  @Post(':widgetKey/identify')
  async identifyWidget(
    @Param('widgetKey') widgetKey: string,
    @Body() body: any
  ) {
    const clientRes = await this.pool.query(
      'SELECT id FROM clients WHERE widget_key = $1 LIMIT 1',
      [widgetKey]
    );
    if (clientRes.rows.length === 0) throw new NotFoundException('Widget not found');
    const client = clientRes.rows[0];

    const visitorId = String(body.visitor_id || '').slice(0, 128);
    if (!visitorId) throw new BadRequestException('visitor_id required');

    const name = body.name ? String(body.name).slice(0, 120) : null;
    const contact = body.contact ? String(body.contact).slice(0, 120) : null;
    const digits = contact ? contact.replace(/\D/g, '') : '';
    const phone = digits.length >= 7 && digits.length <= 15 ? digits : null;

    const res = await this.pool.query(
      `UPDATE conversations
       SET customer_name = COALESCE($1, customer_name),
           customer_phone = COALESCE($2, customer_phone),
           customer_contact = COALESCE($3, customer_contact)
       WHERE client_id = $4 AND platform = 'webchat' AND platform_user_id = $5 AND slot = 'default'
       RETURNING id`,
      [name, phone, contact, client.id, visitorId]
    );

    return { ok: true, conversation_id: res.rows[0]?.id || null };
  }

  @Get(':widgetKey/config')
  async getWidgetConfig(@Param('widgetKey') widgetKey: string) {
    const clientRes = await this.pool.query(
      'SELECT * FROM clients WHERE widget_key = $1 LIMIT 1',
      [widgetKey]
    );
    if (clientRes.rows.length === 0) throw new NotFoundException('Widget not found');
    const c = clientRes.rows[0];

    return {
      title: c.wc_title || c.name || 'Chat with us',
      subtitle: c.wc_subtitle || 'Typically replies within a few minutes',
      greeting: c.wc_greeting || 'Hi! How can we help you today?',
      color: c.wc_color || '#7c5cff',
      position: c.wc_position || 'bottom-right',
      avatar: c.wc_avatar || '',
      requireIntro: c.wc_require_intro !== false,
    };
  }

  @Get(':widgetKey/messages')
  async getWidgetMessages(
    @Param('widgetKey') widgetKey: string,
    @Query('visitor_id') visitorId: string,
    @Query('since_id') sinceId?: string
  ) {
    const clientRes = await this.pool.query(
      'SELECT id FROM clients WHERE widget_key = $1 LIMIT 1',
      [widgetKey]
    );
    if (clientRes.rows.length === 0) throw new NotFoundException('Widget not found');
    const client = clientRes.rows[0];

    if (!visitorId) throw new BadRequestException('visitor_id required');

    const convRes = await this.pool.query(
      "SELECT id FROM conversations WHERE client_id = $1 AND platform = 'webchat' AND platform_user_id = $2 LIMIT 1",
      [client.id, visitorId]
    );
    if (convRes.rows.length === 0) return { messages: [] };

    const convId = convRes.rows[0].id;
    const since = Number(sinceId || 0);

    const msgs = await this.pool.query(
      `SELECT id, direction, text, created_at
       FROM messages
       WHERE conversation_id = $1 AND id > $2
       ORDER BY id ASC LIMIT 50`,
      [convId, since]
    );

    return { messages: msgs.rows };
  }
}
