import pg from 'pg';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventsService } from '../events/events.service.js';
import { SSE_EVENT_TYPES } from '@tectonic/contracts';
import { LicensingService } from '../licensing/licensing.service.js';

export interface WidgetIntakeContext {
  client: any;
  conv: any;
  msg: any;
  text: string;
  visitorId: string;
  name: string | null;
  phone: string | null;
  access: any | null;
}

/**
 * Webchat intake (steps 1–4 of `handleWidgetMessage`): widget lookup,
 * licence gate, input validation, conversation / message / lead
 * persistence, and the inbound SSE broadcast.
 *
 * Split out of `WidgetController` (Phase 3 of the modular
 * restructure). Code moved verbatim; no behaviour change. In
 * particular the client lookup still selects only `id, name,
 * suspended` — `client.ai_paused` is therefore undefined downstream,
 * exactly as before (the AI block reads it as "not paused").
 */
export class WidgetIntakeService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly eventsService?: EventsService,
    private readonly licensing?: LicensingService
  ) {}

  async intake(widgetKey: string, body: any): Promise<WidgetIntakeContext> {
    const clientRes = await this.pool.query(
      'SELECT id, name, suspended FROM clients WHERE widget_key = $1 LIMIT 1',
      [widgetKey]
    );
    if (clientRes.rows.length === 0) throw new NotFoundException('Widget not found');
    const client = clientRes.rows[0];
    if (client.suspended) throw new ForbiddenException('This workspace has been suspended. Please contact the platform admin.');

    // Licence gate for the widget itself (the webchat feature): the widget
    // is public-by-key, so the owner's licence is resolved here, not from
    // a caller. Without webchat the intake is refused outright.
    const access = this.licensing
      ? await this.licensing.resolveAccess(client.id)
      : null;
    if (access && !access.features.includes('webchat')) {
      throw new ForbiddenException('Webchat is not included in this workspace licence.');
    }

    const visitorId = String(body.visitor_id || body.sessionId || body.visitorId || '').slice(0, 128);
    const text = String(body.text || body.message || '').trim().slice(0, 2000);
    if (!visitorId || !text) throw new BadRequestException('visitor_id (or sessionId) and text required');

    const name = body.name ? String(body.name).slice(0, 120) : null;
    const contact = body.contact ? String(body.contact).slice(0, 120) : null;
    const digits = contact ? contact.replace(/\D/g, '') : '';
    const phone = digits.length >= 7 && digits.length <= 15 ? digits : null;

    // 1. Upsert conversation
    const convRes = await this.pool.query(
      `INSERT INTO conversations (client_id, platform, platform_user_id, slot, customer_name, customer_phone, customer_contact, last_message_at, unread_count, status)
       VALUES ($1, 'webchat', $2, 'default', $3, $4, $5, NOW(), 1, 'open')
       ON CONFLICT(client_id, platform, platform_user_id, slot) DO UPDATE
       SET last_message_at = NOW(),
           unread_count = conversations.unread_count + 1,
           customer_name = COALESCE(excluded.customer_name, conversations.customer_name),
           customer_phone = COALESCE(excluded.customer_phone, conversations.customer_phone),
           customer_contact = COALESCE(excluded.customer_contact, conversations.customer_contact)
       RETURNING *`,
      [client.id, visitorId, name, phone, contact]
    );
    const conv = convRes.rows[0];

    // 2. Insert inbound message
    const rawJson = JSON.stringify({
      page_url: body.page_url || null,
      page_title: body.page_title || null,
      via: 'widget',
    });
    const insertMsg = await this.pool.query(
      `INSERT INTO messages (conversation_id, direction, text, raw_json, external_id, created_at)
       VALUES ($1, 'in', $2, $3, $4, NOW())
       ON CONFLICT (conversation_id, external_id) DO UPDATE SET text = excluded.text
       RETURNING *`,
      [conv.id, text, rawJson, body.message_id || null]
    );
    const msg = insertMsg.rows[0];

    // 3. Upsert lead
    await this.pool.query(
      `INSERT INTO leads (client_id, platform, platform_user_id, name, phone, status, stage, score, temperature, created_at, updated_at)
       VALUES ($1, 'webchat', $2, $3, $4, 'lead', 'new', 20, 'warm', NOW(), NOW())
       ON CONFLICT(client_id, platform, platform_user_id) DO UPDATE
       SET name = COALESCE(excluded.name, leads.name),
           phone = COALESCE(excluded.phone, leads.phone),
           updated_at = NOW()`,
      [client.id, visitorId, name, phone]
    ).catch(() => {});

    // 4. Broadcast inbound SSE
    if (this.eventsService) {
      await this.eventsService.broadcastTenantEvent(client.id, {
        type: SSE_EVENT_TYPES.MESSAGE,
        conversation: conv,
        inbound: msg,
      });
    }

    return { client, conv, msg, text, visitorId, name, phone, access };
  }
}
