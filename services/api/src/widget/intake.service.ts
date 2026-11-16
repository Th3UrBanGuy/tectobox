import pg from 'pg';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventsService } from '../events/events.service.js';
import { SSE_EVENT_TYPES } from '@tectonic/contracts';
import { LicensingService } from '../licensing/licensing.service.js';
import { extractLeadSignals } from './lead-intel.js';

export interface WidgetIntakeContext {
  client: any;
  conv: any;
  msg: any;
  text: string;
  visitorId: string;
  name: string | null;
  phone: string | null;
  access: any | null;
  /** Per-stage timings in ms (Seg-D instrumentation, logged by the controller). */
  timings?: { licenceMs: number; dbMs: number; totalMs: number };
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
 * (2026-11-16: the lookup now also selects business_type and the
 * payment-config columns (migration 007) so the reply chain can
 * quote the shop's real payment methods. ai_paused is still NOT
 * selected — loading it would newly enforce pauses; that needs a
 * live-DB check first, see the order/payment audit notes.)
 */
export class WidgetIntakeService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly eventsService?: EventsService,
    private readonly licensing?: LicensingService
  ) {}

  async intake(widgetKey: string, body: any): Promise<WidgetIntakeContext> {
    const started = Date.now();
    const clientRes = await this.pool.query(
      'SELECT id, name, suspended, business_type, payment_modes, advance_required_bdt, bkash_number, nagad_number, rocket_number FROM clients WHERE widget_key = $1 LIMIT 1',
      [widgetKey]
    );
    if (clientRes.rows.length === 0) throw new NotFoundException('Widget not found');
    const client = clientRes.rows[0];
    if (client.suspended) throw new ForbiddenException('This workspace has been suspended. Please contact the platform admin.');

    // Licence gate for the widget itself (the webchat feature): the widget
    // is public-by-key, so the owner's licence is resolved here, not from
    // a caller. Without webchat the intake is refused outright.
    const licenceStarted = Date.now();
    const access = this.licensing
      ? await this.licensing.resolveAccess(client.id)
      : null;
    const licenceMs = Date.now() - licenceStarted;
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
    const dbStarted = Date.now();
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

    // 3. Upsert lead — P15 (2026-11-15): fill the intel fields from the
    // real chat via extractLeadSignals instead of the old hardcoded
    // score 20 / 'warm' placeholder. Signals are MERGED, never
    // overwritten with empties: a later "hello" must not erase a
    // product affinity a previous message established. On conflict the
    // stored values win when the new message adds nothing (score takes
    // the max, temperature follows the max score).
    const signals = await this.pool
      .query('SELECT id, name, price_bdt FROM products WHERE client_id = $1 ORDER BY id', [client.id])
      .then((r) => extractLeadSignals(text, r.rows))
      .catch(() => extractLeadSignals(text, []));
    await this.pool.query(
      `INSERT INTO leads (client_id, platform, platform_user_id, name, phone, status, stage, score, temperature,
                          product_affinity_json, intent_summary, predicted_value_bdt, conversion_probability, next_action, intel_updated_at, created_at, updated_at)
       VALUES ($1, 'webchat', $2, $3, $4, 'lead', 'new', $5, $6, $7, $8, $9, $10, $11, NOW(), NOW(), NOW())
       ON CONFLICT(client_id, platform, platform_user_id) DO UPDATE
       SET name = COALESCE(excluded.name, leads.name),
           phone = COALESCE(excluded.phone, leads.phone),
           score = GREATEST(leads.score, excluded.score),
           temperature = CASE WHEN GREATEST(leads.score, excluded.score) >= 60 THEN 'hot'
                              WHEN GREATEST(leads.score, excluded.score) >= 35 THEN 'warm'
                              ELSE leads.temperature END,
           product_affinity_json = CASE WHEN jsonb_array_length(excluded.product_affinity_json) > 0 THEN excluded.product_affinity_json ELSE leads.product_affinity_json END,
           intent_summary = CASE WHEN excluded.intent_summary <> '' THEN excluded.intent_summary ELSE leads.intent_summary END,
           predicted_value_bdt = CASE WHEN excluded.predicted_value_bdt > 0 THEN excluded.predicted_value_bdt ELSE leads.predicted_value_bdt END,
           conversion_probability = CASE WHEN excluded.conversion_probability > 0 THEN excluded.conversion_probability ELSE leads.conversion_probability END,
           next_action = CASE WHEN excluded.next_action <> '' THEN excluded.next_action ELSE leads.next_action END,
           intel_updated_at = NOW(),
           updated_at = NOW()`,
      [
        client.id, visitorId, name, phone,
        signals.score, signals.temperature,
        JSON.stringify(signals.productAffinity), signals.intentSummary,
        signals.predictedValueBdt, signals.conversionProbability, signals.nextAction,
      ]
    ).catch(() => {});

    // 4. Broadcast inbound SSE — fire-and-forget (Seg-D): the admin
    // SSE fan-out over Redis must never stall the customer's reply if
    // Redis is slow or reconnecting. broadcastTenantEvent already
    // swallows publish errors internally.
    if (this.eventsService) {
      this.eventsService.broadcastTenantEvent(client.id, {
        type: SSE_EVENT_TYPES.MESSAGE,
        conversation: conv,
        inbound: msg,
      }).catch(() => {});
    }

    return { client, conv, msg, text, visitorId, name, phone, access, timings: { licenceMs, dbMs: Date.now() - dbStarted, totalMs: Date.now() - started } };
  }
}
