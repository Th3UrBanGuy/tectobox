import pg from 'pg';
import { EventsService } from '../events/events.service.js';
import { SSE_EVENT_TYPES } from '@tectonic/contracts';
import { detectCustomerLanguage } from '../ai/router.js';
import type { PaymentClaim } from '@tectonic/ai-router';

export interface PaymentClaimContext {
  client: any;
  conv: any;
  text: string;
  name: string | null;
  phone: string | null;
  products: any[];
  history: any[];
  paymentClaim: PaymentClaim;
}

/**
 * Payment-claim handling (bKash / Nagad TrxID confirmation): duplicate
 * check, order link, payment row, realtime broadcast, and the
 * language-specific acknowledgement reply.
 *
 * Split out of `WidgetController.handleWidgetMessage` step 6.1
 * (Phase 3 of the modular restructure). Behaviour changed by the W5
 * fix (2026-11-15): invalid TrxIDs are rejected before any write and
 * the amount is never invented — see the security rules below.
 *
 * Security rules (W5, 2026-11-15) — this is a money path:
 * - An invalid or missing TrxID is rejected BEFORE any database write:
 *   nothing is stored and nothing is confirmed. The customer gets a
 *   clear message asking for the 10-character TrxID.
 * - The amount comes from the ACTUAL order (looked up by
 *   conversation/client). If there is no order, it comes from the
 *   amount the customer stated in the message. If neither exists, the
 *   customer is asked for the amount — a payment row is never written
 *   and a confirmation is never sent with an invented amount.
 */
export class PaymentClaimService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly eventsService?: EventsService
  ) {}

  async handlePaymentClaim(ctx: PaymentClaimContext): Promise<{ replyText: string; modelUsed: string }> {
    const { client, conv, text, name, phone, paymentClaim } = ctx;

    const lang = detectCustomerLanguage(text);

    // 1. Reject an invalid or missing TrxID before touching the database.
    // A fake claim must never be stored or confirmed.
    if (!paymentClaim.trxValid) {
      return {
        replyText: this.rejectionReply(lang, paymentClaim),
        modelUsed: 'payment-detector:invalid-trxid',
      };
    }

    // 2. Check for duplicate TrxID
    const dupCheck = await this.pool.query(
      `SELECT id FROM payments
       WHERE client_id = $1 AND UPPER(transaction_id) = UPPER($2) AND status != 'rejected'
       LIMIT 1`,
      [client.id, paymentClaim.trxId]
    );
    const isDuplicate = dupCheck.rows.length > 0;

    // 3. Find or link active order. The order total is the authoritative
    // amount — it always wins over an amount stated in the message.
    let orderId: number | null = null;
    let amount = paymentClaim.amount > 0 ? paymentClaim.amount : 0;
    const existOrder = await this.pool.query(
      `SELECT id, total_bdt FROM orders
       WHERE client_id = $1 AND conversation_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [client.id, conv.id]
    );
    if (existOrder.rows.length > 0) {
      orderId = existOrder.rows[0].id;
      amount = Number(existOrder.rows[0].total_bdt);
      await this.pool.query(
        `UPDATE orders
         SET transaction_id = $1, payment_status = 'verification_pending'
         WHERE id = $2`,
        [paymentClaim.trxId, orderId]
      );
    }

    // 4. No order and no amount stated: ask the customer for the amount.
    // Do not store a payment row and do not confirm anything — there is
    // no real amount to confirm yet.
    if (amount <= 0) {
      return {
        replyText: this.amountRequestReply(lang, paymentClaim),
        modelUsed: 'payment-detector:amount-needed',
      };
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
        amount,
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

    const amtStr = `৳${amount}`;
    const dupWarnText = !isDuplicate
      ? ''
      : lang === 'bn'
        ? ' (দ্রষ্টব্য: এই TrxID পূর্বে অন্য অর্ডারে ব্যবহৃত হয়েছে)'
        : lang === 'banglish'
          ? ' (Note: ei TrxID-ta agey arek order-e use hoyeche)'
          : lang === 'hi'
            ? ' (Note: yeh TrxID pehle kisi aur order mein use hui thi)'
            : ' (Note: this TrxID was already used on another order)';

    let replyText: string;
    if (lang === 'bn') {
      replyText = `ধন্যবাদ! আপনার ${paymentClaim.method.toUpperCase()} পেমেন্ট তথ্য (TrxID: ${paymentClaim.trxId}, ${amtStr}) গ্রহণ করা হয়েছে${dupWarnText}। আমাদের টিম অবিলম্বে পেমেন্টটি যাচাই করে আপনার অর্ডার নিশ্চিত করছে।`;
    } else if (lang === 'banglish') {
      replyText = `Dhonnobad! Apnar ${paymentClaim.method.toUpperCase()} payment info (TrxID: ${paymentClaim.trxId}, ${amtStr}) amra peyechi${dupWarnText}. Amader verification team ekhoni payment check kore order confirm korche.`;
    } else if (lang === 'hi') {
      replyText = `Dhanyavaad! Aapki ${paymentClaim.method.toUpperCase()} payment jaankari (TrxID: ${paymentClaim.trxId}, ${amtStr}) humein mil gayi hai${dupWarnText}. Hamari verification team abhi payment check karke aapka order confirm kar rahi hai.`;
    } else {
      replyText = `Thank you! We received your ${paymentClaim.method.toUpperCase()} payment claim (TrxID: ${paymentClaim.trxId}, ${amtStr})${dupWarnText}. Our verification team is confirming the transaction now.`;
    }

    return { replyText, modelUsed: 'payment-detector:auto' };
  }

  /**
   * Rejection reply for an invalid or missing TrxID, in the customer's
   * language. Sent without storing anything.
   */
  private rejectionReply(
    lang: 'bn' | 'banglish' | 'en' | 'hi',
    paymentClaim: PaymentClaim
  ): string {
    if (paymentClaim.rejectionReason === 'missing_trxid') {
      if (lang === 'bn') {
        return 'আপনার পেমেন্ট যাচাই করতে অনুগ্রহ করে ১০ অক্ষরের TrxID টি পাঠান।';
      }
      if (lang === 'banglish') {
        return 'Apnar payment verify korte 10 character-er TrxID-ta pathan.';
      }
      if (lang === 'hi') {
        return 'Kripya apni 10 aksharon ki TrxID bhejein taaki hum aapke payment ki jaanch kar sakein.';
      }
      return 'Please send your 10-character TrxID so we can verify your payment.';
    }
    if (lang === 'bn') {
      return 'এই ট্রানজেকশন আইডিটি সঠিক মনে হচ্ছে না — অনুগ্রহ করে যাচাই করে ১০ অক্ষরের TrxID টি আবার পাঠান।';
    }
    if (lang === 'banglish') {
      return 'Ei transaction ID-ta thik mone hocche na — please check kore 10 character-er TrxID-ta abar pathan.';
    }
    if (lang === 'hi') {
      return 'Yeh transaction ID sahi nahi lag rahi hai — kripya jaanchkar 10 aksharon ki TrxID dobara bhejein.';
    }
    return "That transaction ID doesn't look right — please check it and send the 10-character TrxID again.";
  }

  /**
   * Reply when a valid TrxID was received but there is no order to take
   * the amount from and the customer did not state one. The TrxID itself
   * is acknowledged; the payment is NOT confirmed and nothing is stored
   * until the amount is known.
   */
  private amountRequestReply(
    lang: 'bn' | 'banglish' | 'en' | 'hi',
    paymentClaim: PaymentClaim
  ): string {
    const method = paymentClaim.method.toUpperCase();
    if (lang === 'bn') {
      return `ধন্যবাদ — আপনার ${method} TrxID (${paymentClaim.trxId}) পেয়েছি। অনুগ্রহ করে আপনি কত টাকা পাঠিয়েছেন তা জানান, যাতে আমরা আপনার অর্ডারের সাথে মিলিয়ে যাচাই করতে পারি।`;
    }
    if (lang === 'banglish') {
      return `Dhonnobad — apnar ${method} TrxID (${paymentClaim.trxId}) peyechi. Apni koto taka pathiyechen, janaben ki? Tahole amra order-er sathe miliye verify korte parbo.`;
    }
    if (lang === 'hi') {
      return `Dhanyavaad — aapki ${method} TrxID (${paymentClaim.trxId}) humein mil gayi hai. Kripya batayein aapne kitni raashi bheji hai, taaki hum use aapke order se milakar verify kar sakein.`;
    }
    return `Thanks — we have your ${method} TrxID (${paymentClaim.trxId}). Could you please confirm the amount you paid, so we can verify it against your order?`;
  }
}
