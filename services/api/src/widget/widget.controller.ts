import { Controller, Get, Post, Body, Param, Query, Inject, NotFoundException, BadRequestException, HttpException, ServiceUnavailableException, Optional } from '@nestjs/common';
import pg from 'pg';
import { DB_POOL } from '../database/database.module.js';
import { EventsService } from '../events/events.service.js';
import { LicensingService } from '../licensing/licensing.service.js';
import { WidgetIntakeService } from './intake.service.js';
import { AiReplyService } from './ai-reply.service.js';
import { PaymentClaimService } from './payment-claim.service.js';

/**
 * Overall widget-request budget (Seg-D, W1). The Go-engine fetch is
 * bounded at 25s (GO_AI_TIMEOUT_MS) and the widget comment in
 * providers.ts promises a 30s abort — this race is that abort: no
 * widget request may hang past 30s. Below Cloudflare's 100s origin
 * timeout, so a slow request surfaces here as a structured 503 with a
 * graceful reply instead of a dropped connection at the edge.
 */
export const WIDGET_REQUEST_TIMEOUT_MS = 30_000;

/** Graceful reply returned with the 503 when the widget path fails outright. */
export const WIDGET_UNAVAILABLE_REPLY =
  "Sorry, we're having trouble replying right now. Please try again in a moment — your message has been received.";

function withTimeout<T>(promise: Promise<T>, ms: number, stage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`widget request timed out at ${stage} after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
    // Seg-D (W1): the widget endpoint must NEVER fail silently. Client
    // errors (unknown widget / suspended / no webchat licence / bad
    // input) propagate with their own status; anything else — a DB
    // failure, a hung AI call, an unexpected throw — becomes a
    // structured 503 carrying a graceful reply, never a dropped
    // connection or a bare 500 with no reply.
    const started = Date.now();
    try {
      const result = await withTimeout(
        this.handleWidgetMessageInner(widgetKey, body),
        WIDGET_REQUEST_TIMEOUT_MS,
        'widget-message',
      );
      const intakeTimings = result.intakeTimings;
      const aiTimings = result.aiTimings;
      console.log(
        `[widget] client=${result.clientId} intake_ms=${intakeTimings?.totalMs ?? -1} ` +
          `(licence_ms=${intakeTimings?.licenceMs ?? -1} db_ms=${intakeTimings?.dbMs ?? -1}) ` +
          `ai_ms=${aiTimings ? aiTimings.dbMs + aiTimings.goMs + aiTimings.fallbackMs + aiTimings.outDbMs : -1} ` +
          `(go_ms=${aiTimings?.goMs ?? -1} fallback_ms=${aiTimings?.fallbackMs ?? -1} out_db_ms=${aiTimings?.outDbMs ?? -1}) ` +
          `model=${result.modelUsed} total_ms=${Date.now() - started}`,
      );
      return result.response;
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      console.warn('[widget] handleWidgetMessage failed:', err?.message || err);
      throw new ServiceUnavailableException({
        error: 'widget_temporarily_unavailable',
        reply: WIDGET_UNAVAILABLE_REPLY,
        reply_id: null,
        conversation_id: null,
        message_id: null,
        needs_human: false,
      });
    }
  }

  private async handleWidgetMessageInner(
    widgetKey: string,
    body: any
  ) {
    const ctx = await this.intake.intake(widgetKey, body);
    const { replyText, replyId, modelUsed, timings } = await this.aiReply.generateReply(ctx);

    return {
      clientId: ctx.client.id,
      intakeTimings: ctx.timings,
      aiTimings: timings,
      modelUsed,
      response: {
        reply: replyText,
        reply_id: replyId,
        conversation_id: ctx.conv.id,
        message_id: ctx.msg.id,
        needs_human: ctx.conv.needs_human || false,
      },
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
