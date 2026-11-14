import pg from 'pg';
import { EventsService } from '../events/events.service.js';
import { SSE_EVENT_TYPES } from '@tectonic/contracts';
import { detectCustomerLanguage } from '../ai/router.js';

export interface PaymentClaimContext {
  client: any;
  conv: any;
  text: string;
  name: string | null;
  phone: string | null;
  products: any[];
  history: any[];
  paymentClaim: any;
}

/**
 * Payment-claim handling (bKash / Nagad TrxID confirmation): duplicate
 * check, order link, payment row, realtime broadcast, and the
 * language-specific acknowledgement reply.
 *
 * Split out of `WidgetController.handleWidgetMessage` step 6.1
 * (Phase 3 of the modular restructure). Code moved verbatim; no
 * behaviour change. This is payments logic that used to live inside
 * the widget; it still writes the same rows in the same order.
 */
export class PaymentClaimService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly eventsService?: EventsService
  ) {}

  async handlePaymentClaim(ctx: PaymentClaimContext): Promise<{ replyText: string; modelUsed: string }> {
    const { client, conv, text, name, phone, products, history, paymentClaim } = ctx;
    void products;
    void history;

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

    let replyText: string;
    if (lang === 'bn') {
      replyText = `ধন্যবাদ! আপনার ${paymentClaim.method.toUpperCase()} পেমেন্ট তথ্য (TrxID: ${paymentClaim.trxId}${amtStr ? ', ' + amtStr : ''}) গ্রহণ করা হয়েছে${dupWarnText}। আমাদের টিম অবিলম্বে পেমেন্টটি যাচাই করে আপনার অর্ডার নিশ্চিত করছে।`;
    } else if (lang === 'banglish') {
      replyText = `Dhonnobad! Apnar ${paymentClaim.method.toUpperCase()} payment info (TrxID: ${paymentClaim.trxId}${amtStr ? ', ' + amtStr : ''}) amra peyechi. Amader verification team ekhoni payment check kore order confirm korche.`;
    } else {
      replyText = `Thank you! We received your ${paymentClaim.method.toUpperCase()} payment claim (TrxID: ${paymentClaim.trxId}${amtStr ? ', ' + amtStr : ''}). Our verification team is confirming the transaction now.`;
    }

    return { replyText, modelUsed: 'payment-detector:auto' };
  }
}
