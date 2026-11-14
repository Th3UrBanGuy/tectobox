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
  detectCustomerLanguage,
} from '../ai/router.js';
import { evaluatePromptSafety } from '../ai/guardrails.js';
import { PaymentClaimService } from './payment-claim.service.js';
import type { WidgetIntakeContext } from './intake.service.js';

export interface AiReplyResult {
  replyText: string | null;
  replyId: number | null;
  modelUsed: string;
}

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
    private readonly paymentClaimService?: PaymentClaimService
  ) {}

  async generateReply(ctx: WidgetIntakeContext): Promise<AiReplyResult> {
    const { client, conv, msg, text, access } = ctx;

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
        if (paymentClaim && this.paymentClaimService) {
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

    return { replyText, replyId, modelUsed };
  }
}
