import { Controller, Get, Post, Body, Param, Query, Inject, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import pg from 'pg';
import { DB_POOL } from '../database/database.module.js';
import { EventsService } from '../events/events.service.js';
import { SSE_EVENT_TYPES } from '@tectonic/contracts';
import { LicensingService } from '../licensing/licensing.service.js';
import { getAIResponse, demoResponder, detectCustomerLanguage, languageDirective, buildSystemPrompt, queryGoAIEngine, parsePaymentClaim } from '../ai/router.js';
import { evaluatePromptSafety } from '../ai/guardrails.js';

@Controller('api/widget')
export class WidgetController {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Optional() private readonly eventsService?: EventsService,
    // Optional on purpose: this is a public route — a DI misconfiguration
    // must never 500 the intake. In production the module always wires it
    // (WidgetModule imports LicensingModule). When absent, the webchat
    // check is skipped but AI replies are denied (fail-closed for AI).
    @Optional() @Inject(LicensingService) private readonly licensing?: LicensingService
  ) {}

  @Post(':widgetKey/message')
  async handleWidgetMessage(
    @Param('widgetKey') widgetKey: string,
    @Body() body: any
  ) {
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

    // 5. Check if customer is asking for a human agent
    const humanRegex = /(human|agent|person|representative|support team|manager|talk to someone|call me|মানুষ|এজেন্ট|প্রতিনিধি|কল দেন|কথা বলব|অপারেটর|manush|kotha bolbo|call den|kew asen|operator)/i;
    const isAskingForHuman = humanRegex.test(text);

    let replyText: string | null = null;
    let replyId: number | null = null;
    let modelUsed = 'gemini-3.6-flash';

    // 5. Evaluate Prompt Safety & Prompt Injection Guardrails
    const safetyCheck = evaluatePromptSafety(text);

    if (!safetyCheck.isSafe) {
      replyText = safetyCheck.safeDefusalReply || 'Unauthorized input pattern detected.';
      modelUsed = `guardrail:${safetyCheck.threatType}`;
    } else if (isAskingForHuman) {
      await this.pool.query(
        'UPDATE conversations SET needs_human = true WHERE id = $1',
        [conv.id]
      );
      conv.needs_human = true;

      const lang = detectCustomerLanguage(text);
      if (lang === 'bn') {
        replyText = 'আমরা আমাদের একজন সাপোর্ট টিম মেম্বারকে জানাচ্ছি। অনুগ্রহ করে কিছুক্ষণ অপেক্ষা করুন, তিনি দ্রুতই আপনার সাথে কথা বলবেন।';
      } else if (lang === 'banglish') {
        replyText = 'Amra amader human support agent-ke notify korchi. Ektu opekkha korun, tini shighroi apnar sathe contact korben.';
      } else {
        replyText = 'I have alerted a human support representative for you. Please hold on a moment, someone will be with you shortly.';
      }
      modelUsed = 'human-handover';

      if (this.eventsService) {
        await this.eventsService.broadcastTenantEvent(client.id, {
          type: SSE_EVENT_TYPES.CONVERSATION_FLAG,
          conversationId: conv.id,
          needsHuman: true,
        });
      }
    } else {
      // 6. Generate AI auto-reply if enabled and not paused/needs_human.
      // The licence gate (aiAllowed) was resolved at the top of this
      // handler: without the ai_response feature (or with an expired /
      // exhausted licence) the inbound stays stored and a human replies.
      const autoReplyRow = await this.pool.query("SELECT value FROM settings WHERE key = 'ai.auto_reply' LIMIT 1");
      const isGlobalAutoReply = !autoReplyRow.rows[0] || autoReplyRow.rows[0].value !== '0';

      if (isGlobalAutoReply && !client.ai_paused && !conv.needs_human && (access?.aiAllowed ?? false)) {
        // Enforce daily AI budget cap
        const todayStr = new Date().toISOString().slice(0, 10);
        const budRes = await this.pool.query(
          'SELECT widget_ai_daily_cap, widget_ai_used, widget_ai_day FROM clients WHERE id = $1',
          [client.id]
        );
        const bRow = budRes.rows[0] || {};
        const cap = bRow.widget_ai_daily_cap ?? 200;
        let used = bRow.widget_ai_used ?? 0;
        if (bRow.widget_ai_day !== todayStr) {
          used = 0;
        }

        const budgetExceeded = cap > 0 && used >= cap;

        const prodsRes = await this.pool.query('SELECT name, sku, price_bdt, stock FROM products WHERE client_id = $1 ORDER BY id ASC', [client.id]);
        const kbRes = await this.pool.query('SELECT title, content, category FROM knowledge WHERE client_id = $1 ORDER BY id ASC', [client.id]);

        // Retrieve past messages for conversational memory & multi-turn dialog context
        const recentHistoryRes = await this.pool.query(
          `SELECT direction, text FROM messages
           WHERE conversation_id = $1 AND id < $2
           ORDER BY id DESC LIMIT 8`,
          [conv.id, msg.id]
        );
        const history = recentHistoryRes.rows.reverse().map(r => ({
          role: r.direction === 'in' ? 'user' : 'assistant',
          content: r.text,
        }));

        // 6.1 Check if message contains a payment claim (TrxID / bKash / Nagad confirmation)
        const paymentClaim = parsePaymentClaim(text, prodsRes.rows, history);
        if (paymentClaim) {
          // Check for duplicate TrxID
          const dupCheck = await this.pool.query(
            `SELECT id FROM payments
             WHERE client_id = $1 AND UPPER(transaction_id) = UPPER($2) AND status != 'rejected'
             LIMIT 1`,
            [client.id, paymentClaim.trxId]
          );
          const isDuplicate = dupCheck.rows.length > 0;

          // Find or link active order
          let orderId: number | null = null;
          const existOrder = await this.pool.query(
            `SELECT id, total_bdt FROM orders
             WHERE client_id = $1 AND conversation_id = $2
             ORDER BY created_at DESC LIMIT 1`,
            [client.id, conv.id]
          );
          if (existOrder.rows.length > 0) {
            orderId = existOrder.rows[0].id;
            if (!paymentClaim.amount) {
              paymentClaim.amount = Number(existOrder.rows[0].total_bdt);
            }
            await this.pool.query(
              `UPDATE orders
               SET transaction_id = $1, payment_status = 'verification_pending'
               WHERE id = $2`,
              [paymentClaim.trxId, orderId]
            );
          }

          const payRes = await this.pool.query(
            `INSERT INTO payments (
               client_id, order_id, conversation_id, customer_name, customer_phone,
               channel, amount, method, transaction_id, status, duplicate_flag, evidence_text, created_at
             ) VALUES ($1, $2, $3, $4, $5, 'webchat', $6, $7, $8, 'pending', $9, $10, NOW())
             RETURNING *`,
            [
              client.id,
              orderId,
              conv.id,
              name || 'Web Visitor',
              phone || paymentClaim.senderPhone || null,
              paymentClaim.amount,
              paymentClaim.method,
              paymentClaim.trxId,
              isDuplicate,
              text,
            ]
          );

          // Real-time broadcast to dashboard!
          if (this.eventsService) {
            await this.eventsService.broadcastTenantEvent(client.id, {
              type: SSE_EVENT_TYPES.PAYMENT_RECEIVED,
              payment: payRes.rows[0],
            });
          }

          const lang = detectCustomerLanguage(text);
          const amtStr = paymentClaim.amount > 0 ? `৳${paymentClaim.amount}` : '';
          const dupWarnText = isDuplicate ? ' (দ্রষ্টব্য: এই TrxID পূর্বে অন্য অর্ডারে ব্যবহৃত হয়েছে)' : '';

          if (lang === 'bn') {
            replyText = `ধন্যবাদ! আপনার ${paymentClaim.method.toUpperCase()} পেমেন্ট তথ্য (TrxID: ${paymentClaim.trxId}${amtStr ? ', ' + amtStr : ''}) গ্রহণ করা হয়েছে${dupWarnText}। আমাদের টিম অবিলম্বে পেমেন্টটি যাচাই করে আপনার অর্ডার নিশ্চিত করছে।`;
          } else if (lang === 'banglish') {
            replyText = `Dhonnobad! Apnar ${paymentClaim.method.toUpperCase()} payment info (TrxID: ${paymentClaim.trxId}${amtStr ? ', ' + amtStr : ''}) amra peyechi. Amader verification team ekhoni payment check kore order confirm korche.`;
          } else {
            replyText = `Thank you! We received your ${paymentClaim.method.toUpperCase()} payment claim (TrxID: ${paymentClaim.trxId}${amtStr ? ', ' + amtStr : ''}). Our verification team is confirming the transaction now.`;
          }
          modelUsed = 'payment-detector:auto';
        } else if (budgetExceeded) {
          // Graceful fallback to deterministic catalog responder without consuming LLM budget
          replyText = demoResponder(client.id, text, prodsRes.rows, history, kbRes.rows);
          modelUsed = 'budget-fallback:deterministic';
        } else {
          // Licence credit: atomic reserve-a-credit before generating. If
          // the last credit was taken by a concurrent reply, fall back to
          // the deterministic responder instead of sending an AI reply
          // unpaid. (The daily cap above is a separate, coarser limit.)
          const creditOk = this.licensing
            ? await this.licensing.consumeAiCredit(client.id)
            : false;
          if (!creditOk) {
            replyText = demoResponder(client.id, text, prodsRes.rows, history, kbRes.rows);
            modelUsed = 'budget-fallback:deterministic';
          } else {
            // Ultra-fast path: Go AI Engine with native language detection & in-memory caching
            const goResult = await queryGoAIEngine({
              clientId: client.id,
              clientName: client.name,
              businessType: client.business_type,
              text: text,
              history: history,
              products: prodsRes.rows,
              knowledge: kbRes.rows,
            });

            if (goResult && goResult.reply) {
              replyText = goResult.reply;
              modelUsed = goResult.model;
            } else {
              const lang = detectCustomerLanguage(text);
              const langDir = languageDirective(lang);
              const sysPrompt = buildSystemPrompt({
                clientName: client.name,
                businessType: client.business_type,
                products: prodsRes.rows,
                knowledge: kbRes.rows,
              }, langDir);

              const promptMessages: any[] = [
                { role: 'system', content: sysPrompt },
                ...history.map(h => ({ role: h.role, content: h.content })),
                { role: 'user', content: text },
              ];

              replyText = await getAIResponse(promptMessages, `widget:${client.id}`);

              if (!replyText || replyText.trim().length === 0) {
                replyText = demoResponder(client.id, text, prodsRes.rows, history, kbRes.rows);
              }
            }

            // Increment daily used counter
            await this.pool.query(
              'UPDATE clients SET widget_ai_used = $1, widget_ai_day = $2 WHERE id = $3',
              [used + 1, todayStr, client.id]
            ).catch(() => {});
          }
        }
      }
    }

    if (replyText) {
      const outMsg = await this.pool.query(
        `INSERT INTO messages (conversation_id, direction, text, raw_json, created_at)
         VALUES ($1, 'out', $2, $3, NOW())
         RETURNING *`,
        [conv.id, replyText, JSON.stringify({ via: 'ai', model: modelUsed })]
      );
      replyId = outMsg.rows[0].id;

      if (this.eventsService) {
        await this.eventsService.broadcastTenantEvent(client.id, {
          type: SSE_EVENT_TYPES.MESSAGE,
          conversation: conv,
          outbound: outMsg.rows[0],
        });
      }
    }

    return {
      reply: replyText,
      reply_id: replyId,
      conversation_id: conv.id,
      message_id: msg.id,
      needs_human: conv.needs_human || false,
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
