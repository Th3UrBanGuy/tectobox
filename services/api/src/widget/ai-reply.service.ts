import pg from 'pg';
import { EventsService } from '../events/events.service.js';
import { SSE_EVENT_TYPES } from '@tectonic/contracts';
import { LicensingService } from '../licensing/licensing.service.js';
import {
  buildSystemPrompt,
  getAIResponse,
  queryGoAIEngine,
  demoResponder,
  languageDirective,
  parsePaymentClaim,
  isActualPaymentStatement,
  detectCustomerLanguage,
} from '../ai/router.js';
import { evaluatePromptSafety } from '../ai/guardrails.js';
import { PaymentClaimService } from './payment-claim.service.js';
import { OrderService } from './order.service.js';
import type { WidgetIntakeContext } from './intake.service.js';

export interface AiReplyResult {
  replyText: string | null;
  replyId: number | null;
  modelUsed: string;
  /** Per-stage timings in ms (Seg-D instrumentation, logged by the controller). */
  timings?: { dbMs: number; goMs: number; fallbackMs: number; outDbMs: number };
}

const GENERIC_FALLBACK_REPLIES: Record<string, string> = {
  bn: 'দুঃখিত, এখন উত্তর দিতে সমস্যা হচ্ছে। অনুগ্রহ করে একটু পরে আবার চেষ্টা করুন।',
  banglish: 'Dukkhito, ekhon uttor dite shomossha hocche. Ektu pore abar cheshta korun.',
  hi: 'माफ़ कीजिए, अभी जवाब देने में परेशानी हो रही है। कृपया थोड़ी देर में फिर कोशिश करें।',
  en: "Sorry, we're having trouble replying right now. Please try again in a moment.",
};

/**
 * AI reply generation (steps 5–7 of `handleWidgetMessage`): the
 * human-intent handover, the safety guardrails, the knowledge-grounded
 * reply chain (Go engine → LLM → deterministic fallback), and the
 * outbound-message insert + broadcast.
 *
 * Split out of `WidgetController` (Phase 3 of the modular
 * restructure). Code moved verbatim; no behaviour change. In
 * particular: the auto-reply gate still reads the `settings` table
 * (`ai.auto_reply`), the budget still uses the `widget_ai_*` columns
 * on `clients`, `demoResponder` is still called as
 * `demoResponder(client.id, ...)` and is imported from
 * `../ai/router.js` exactly as before, so the spec's spy on it keeps
 * intercepting.
 */
export class AiReplyService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly eventsService?: EventsService,
    private readonly licensing?: LicensingService,
    private readonly paymentClaimService?: PaymentClaimService,
    private readonly orderService?: OrderService
  ) {}

  /**
   * Never-throw guarantee (Seg-D, W1): the widget endpoint must never
   * drop a customer's message silently. Any unexpected failure inside
   * the reply path falls back to a generic graceful reply (and a
   * best-effort store of it) instead of throwing up to the controller.
   */
  async generateReply(ctx: WidgetIntakeContext): Promise<AiReplyResult> {
    const started = Date.now();
    try {
      const result = await this.generateReplyInner(ctx);
      return { ...result, timings: result.timings ?? { dbMs: 0, goMs: 0, fallbackMs: 0, outDbMs: 0 } };
    } catch (err: any) {
      console.warn('[widget-ai-reply] reply path failed, sending generic fallback:', err?.message || err);
      const lang = detectCustomerLanguage(ctx.text);
      const replyText = GENERIC_FALLBACK_REPLIES[lang] || GENERIC_FALLBACK_REPLIES.en;
      let replyId: number | null = null;
      try {
        const outMsg = await this.pool.query(
          `INSERT INTO messages (conversation_id, direction, text, raw_json, created_at)
           VALUES ($1, 'out', $2, $3, NOW())
           RETURNING *`,
          [ctx.conv.id, replyText, JSON.stringify({ via: 'ai', model: 'error-fallback:generic' })],
        );
        replyId = outMsg.rows[0]?.id ?? null;
      } catch {
        // Best-effort only: the reply below is still returned to the
        // customer even when the store is down.
      }
      return {
        replyText,
        replyId,
        modelUsed: 'error-fallback:generic',
        timings: { dbMs: 0, goMs: 0, fallbackMs: 0, outDbMs: Date.now() - started },
      };
    }
  }

  private async generateReplyInner(ctx: WidgetIntakeContext): Promise<AiReplyResult> {
    const { client, conv, msg, text, access } = ctx;
    const timings = { dbMs: 0, goMs: 0, fallbackMs: 0, outDbMs: 0 };

    // 5. Check if customer is asking for a human agent
    const humanRegex = /(human|agent|person|representative|support|real person|customer care|help me talk|help me|manager|talk to someone|call me|মানুষ|এজেন্ট|প্রতিনিধি|কল দেন|কথা বলব|অপারেটর|সাপোর্ট|সাহায্য|manush|kotha bolbo|call den|kew asen|operator|sahajjo|madad|insaan|sahayata)/i;
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
        // Fire-and-forget (Seg-D): the SSE fan-out must never stall the
        // customer's reply if Redis is slow or reconnecting.
        this.eventsService.broadcastTenantEvent(client.id, {
          type: SSE_EVENT_TYPES.CONVERSATION_FLAG,
          conversationId: conv.id,
          needsHuman: true,
        }).catch(() => {});
      }
    } else {
      // 6. Generate AI auto-reply if enabled and not paused/needs_human.
      // The licence gate (aiAllowed) was resolved at the top of this
      // handler: without the ai_response feature (or with an expired /
      // exhausted licence) the inbound stays stored and a human replies.
      const autoReplyRow = await this.pool.query("SELECT value FROM settings WHERE key = 'ai.auto_reply' LIMIT 1");
      const isGlobalAutoReply = !autoReplyRow.rows[0] || autoReplyRow.rows[0].value !== '0';

      if (isGlobalAutoReply && !client.ai_paused && !conv.needs_human && (access?.aiAllowed ?? false)) {
        // Any failure in the AI chain below must fall back to the
        // deterministic responder, never drop the reply (Seg-D, W1).
        // prodsRows/kbRows are hoisted so the fallback can still use
        // whatever catalog data was already loaded.
        let prodsRows: any[] = [];
        let kbRows: any[] = [];
        const history: Array<{ role: string; content: string }> = [];
        const dbStarted = Date.now();
        try {
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

        const prodsRes = await this.pool.query('SELECT id, name, sku, price_bdt, stock FROM products WHERE client_id = $1 ORDER BY id ASC', [client.id]);
        const kbRes = await this.pool.query('SELECT title, content, category FROM knowledge WHERE client_id = $1 ORDER BY id ASC', [client.id]);
        prodsRows = prodsRes.rows;
        kbRows = kbRes.rows;

        // Retrieve past messages for conversational memory & multi-turn dialog context.
        // Window is 20 messages (10 turns): the whole active session should be
        // remembered, and the Go engine now threads these turns into the
        // web2api request (2026-11-16 — before that, Tier 3 dropped them).
        const recentHistoryRes = await this.pool.query(
          `SELECT direction, text FROM messages
           WHERE conversation_id = $1 AND id < $2
           ORDER BY id DESC LIMIT 20`,
          [conv.id, msg.id]
        );
        history.push(...recentHistoryRes.rows.reverse().map(r => ({
          role: r.direction === 'in' ? 'user' : 'assistant',
          content: r.text,
        })));
        timings.dbMs = Date.now() - dbStarted;

        // 6.1 Check if message contains a payment claim (TrxID / bKash / Nagad confirmation)
        // P16 (2026-11-15): the claim flow is TRIGGERED only by an actual
        // payment statement WITH a TrxID (isActualPaymentStatement). A
        // question about payment ("Can I pay with bKash?", "What is your
        // bKash number?") still parses into a claim object, but it must
        // NEVER reach handlePaymentClaim — it falls through to the normal
        // AI reply (payment methods / merchant number) instead.
        const paymentClaim = parsePaymentClaim(text, prodsRes.rows, history);
        // 6.2 Order placement (W3/W4): a customer confirmation with
        // name + phone + address on file creates exactly one `orders`
        // row (idempotent) — or refuses with the out-of-stock reply
        // when stock does not cover it. This runs before the AI
        // budget/credit chain on purpose: placing an order is a DB
        // write, not an LLM call, so an exhausted AI budget must
        // never block a paying customer. When the message is not an
        // order placement (or the placement fails safe) the outcome
        // is not_applicable/error and the normal reply chain below
        // runs unchanged.
        const orderOutcome =
          !paymentClaim && this.orderService
            ? await this.orderService.tryCreateOrder({
                client,
                conv,
                text,
                name: ctx.name,
                phone: ctx.phone,
                products: prodsRes.rows,
                history,
              })
            : null;
        const orderHandled =
          !!orderOutcome &&
          (orderOutcome.status === 'created' ||
            orderOutcome.status === 'already_exists' ||
            orderOutcome.status === 'out_of_stock');

        if (paymentClaim && this.paymentClaimService && isActualPaymentStatement(text, paymentClaim.trxId)) {
          const claimResult = await this.paymentClaimService.handlePaymentClaim({
            client,
            conv,
            text,
            name: ctx.name,
            phone: ctx.phone,
            products: prodsRes.rows,
            history,
            paymentClaim,
          });
          replyText = claimResult.replyText;
          modelUsed = claimResult.modelUsed;
        } else if (orderHandled) {
          replyText = (orderOutcome as { replyText: string }).replyText;
          modelUsed = (orderOutcome as { modelUsed: string }).modelUsed;
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
            const goStarted = Date.now();
            const goResult = await queryGoAIEngine({
              clientId: client.id,
              clientName: client.name,
              businessType: client.business_type,
              text: text,
              history: history,
              products: prodsRes.rows,
              knowledge: kbRes.rows,
            });
            timings.goMs = Date.now() - goStarted;

            if (goResult && goResult.reply) {
              replyText = goResult.reply;
              modelUsed = goResult.model;
            } else {
              const fallbackStarted = Date.now();
              const lang = detectCustomerLanguage(text);
              const langDir = languageDirective(lang);
              const sysPrompt = buildSystemPrompt({
                clientName: client.name,
                businessType: client.business_type,
                products: prodsRes.rows,
                knowledge: kbRes.rows,
              }, langDir, { includeSecurityDirective: true });

              const promptMessages: any[] = [
                { role: 'system', content: sysPrompt },
                ...history.map(h => ({ role: h.role, content: h.content })),
                { role: 'user', content: text },
              ];

              replyText = await getAIResponse(promptMessages, `widget:${client.id}`);

              if (!replyText || replyText.trim().length === 0) {
                replyText = demoResponder(client.id, text, prodsRes.rows, history, kbRes.rows);
              }
              timings.fallbackMs = Date.now() - fallbackStarted;
            }

            // Increment daily used counter
            await this.pool.query(
              'UPDATE clients SET widget_ai_used = $1, widget_ai_day = $2 WHERE id = $3',
              [used + 1, todayStr, client.id]
            ).catch(() => {});
          }
        }
        } catch (err: any) {
          // The AI chain failed (DB, licence, Go engine, fallback) — answer
          // from the deterministic responder with whatever catalog data was
          // loaded instead of dropping the customer's reply (Seg-D, W1).
          console.warn('[widget-ai-reply] AI chain failed, deterministic fallback:', err?.message || err);
          replyText = demoResponder(client.id, text, prodsRows, history, kbRows);
          modelUsed = 'error-fallback:deterministic';
        }
      }
    }

    if (replyText) {
      const outStarted = Date.now();
      try {
        const outMsg = await this.pool.query(
          `INSERT INTO messages (conversation_id, direction, text, raw_json, created_at)
           VALUES ($1, 'out', $2, $3, NOW())
           RETURNING *`,
          [conv.id, replyText, JSON.stringify({ via: 'ai', model: modelUsed })]
        );
        replyId = outMsg.rows[0].id;
        timings.outDbMs = Date.now() - outStarted;

        if (this.eventsService) {
          // Fire-and-forget (Seg-D): see the inbound broadcast above.
          this.eventsService.broadcastTenantEvent(client.id, {
            type: SSE_EVENT_TYPES.MESSAGE,
            conversation: conv,
            outbound: outMsg.rows[0],
          }).catch(() => {});
        }
      } catch (err: any) {
        // The reply was generated but could not be stored — still return
        // it to the customer (replyId null) instead of dropping it.
        console.warn('[widget-ai-reply] outbound insert failed, reply still returned:', err?.message || err);
        timings.outDbMs = Date.now() - outStarted;
      }
    }

    return { replyText, replyId, modelUsed, timings };
  }
}
