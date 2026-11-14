import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  Inject,
  ParseIntPipe,
  BadRequestException,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import pg from 'pg';
import { DB_POOL } from '../database/database.module.js';
import { EventsService } from '../events/events.service.js';
import { VerifyPaymentDto, RejectPaymentDto } from './dto/payments.dto.js';

@Controller('api')
@UseGuards(TenantGuard)
export class PaymentsController implements OnModuleInit {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    private readonly eventsService: EventsService,
  ) {}

  async onModuleInit() {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS payments (
          id SERIAL PRIMARY KEY,
          client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
          order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
          conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
          customer_name VARCHAR(255),
          customer_phone VARCHAR(50),
          channel VARCHAR(50) DEFAULT 'webchat',
          amount DECIMAL(12,2) NOT NULL DEFAULT 0,
          method VARCHAR(50) NOT NULL DEFAULT 'bkash',
          transaction_id VARCHAR(255) NOT NULL,
          status VARCHAR(50) NOT NULL DEFAULT 'pending',
          duplicate_flag BOOLEAN DEFAULT FALSE,
          evidence_text TEXT,
          verified_by VARCHAR(255),
          verified_at TIMESTAMPTZ,
          rejection_reason TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_payments_client_status ON payments(client_id, status);
        CREATE INDEX IF NOT EXISTS idx_payments_trx ON payments(client_id, transaction_id);
      `);
      console.log('[payments] Payments table and indexes verified.');
    } catch (err: any) {
      console.warn('[payments] Failed to ensure payments table:', err.message);
    }
  }

  @Get('payments')
  async getPayments(
    @CurrentTenant() tenantId: number | null,
    @Query('status') status?: string,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string,
    @Query('client_id') queryClientId?: string,
  ) {
    const limit = Math.min(200, Math.max(1, Number(limitStr) || 50));
    const offset = Math.max(0, Number(offsetStr) || 0);
    const targetTenantId = tenantId || (queryClientId ? Number(queryClientId) : null);

    let baseWhere = `WHERE 1=1`;
    const countParams: any[] = [];
    if (targetTenantId) {
      countParams.push(targetTenantId);
      baseWhere += ` AND p.client_id = $${countParams.length}`;
    }
    if (status && status !== 'all') {
      countParams.push(status);
      baseWhere += ` AND p.status = $${countParams.length}`;
    }

    const countRes = await this.pool.query(`SELECT COUNT(*) AS total FROM payments p ${baseWhere}`, countParams);
    const total = parseInt(countRes.rows[0]?.total || '0', 10);

    let sql = `
      SELECT p.*,
             c_info.name as client_name,
             o.total_bdt as order_total,
             o.items_json as order_items,
             o.status as order_status,
             c.platform as conversation_platform
      FROM payments p
      LEFT JOIN clients c_info ON c_info.id = p.client_id
      LEFT JOIN orders o ON o.id = p.order_id
      LEFT JOIN conversations c ON c.id = p.conversation_id
      ${baseWhere}
    `;
    const params = [...countParams, limit, offset];
    sql += ` ORDER BY p.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await this.pool.query(sql, params);
    return {
      ok: true,
      payments: result.rows,
      total,
      limit,
      offset,
      tenantId: targetTenantId,
    };
  }

  @Get('payments/stats')
  async getStats(@CurrentTenant() tenantId: number | null) {
    return this.getStatsInternal(tenantId);
  }

  private async getStatsInternal(tenantId: number | null) {
    let sql = `
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
        COUNT(*) FILTER (WHERE status = 'verified') as verified_count,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejected_count,
        COUNT(*) FILTER (WHERE duplicate_flag = true) as duplicate_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'verified' AND verified_at >= CURRENT_DATE), 0) as verified_volume_today
      FROM payments
    `;
    const params: any[] = [];
    if (tenantId) {
      sql += ` WHERE client_id = $1`;
      params.push(tenantId);
    }

    const countsRes = await this.pool.query(sql, params);
    const r = countsRes.rows[0] || {};
    return {
      pending: Number(r.pending_count || 0),
      verified: Number(r.verified_count || 0),
      rejected: Number(r.rejected_count || 0),
      duplicates: Number(r.duplicate_count || 0),
      verified_volume_today: Number(r.verified_volume_today || 0),
    };
  }

  @Post('payments/claim')
  async claimPayment(
    @CurrentTenant() tenantId: number | null,
    @Body() body: any,
  ) {
    const trxId = String(body.transaction_id || body.trx_id || '').trim();
    if (!trxId) {
      throw new BadRequestException('Transaction ID (TrxID) is required.');
    }

    const effectiveTenantId = tenantId || (body.client_id ? Number(body.client_id) : 1);
    const amount = Math.max(0, Number(body.amount) || 0);
    const method = String(body.method || 'bkash').toLowerCase().trim();
    const customerName = body.customer_name ? String(body.customer_name).slice(0, 200) : null;
    const customerPhone = body.customer_phone ? String(body.customer_phone).slice(0, 50) : null;
    const channel = String(body.channel || 'webchat').slice(0, 50);
    const conversationId = body.conversation_id ? Number(body.conversation_id) : null;
    let orderId = body.order_id ? Number(body.order_id) : null;
    const evidenceText = body.evidence_text ? String(body.evidence_text).slice(0, 1000) : null;

    // Check for duplicate TrxID within this client
    const dupCheck = await this.pool.query(
      `SELECT id, order_id, created_at, status FROM payments
       WHERE client_id = $1 AND UPPER(transaction_id) = UPPER($2) AND status != 'rejected'
       LIMIT 1`,
      [effectiveTenantId, trxId],
    );
    const duplicateFlag = dupCheck.rows.length > 0;

    // If no orderId was provided, look for an active order in this conversation
    if (!orderId && conversationId) {
      const orderSearch = await this.pool.query(
        `SELECT id FROM orders
         WHERE client_id = $1 AND conversation_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        [effectiveTenantId, conversationId],
      );
      if (orderSearch.rows.length > 0) {
        orderId = orderSearch.rows[0].id;
      }
    }

    // Insert payment record
    const insRes = await this.pool.query(
      `INSERT INTO payments (
         client_id, order_id, conversation_id, customer_name, customer_phone,
         channel, amount, method, transaction_id, status, duplicate_flag, evidence_text, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, NOW())
       RETURNING *`,
      [
        effectiveTenantId,
        orderId,
        conversationId,
        customerName,
        customerPhone,
        channel,
        amount,
        method,
        trxId,
        duplicateFlag,
        evidenceText,
      ],
    );

    const payment = insRes.rows[0];

    // Update order status to verification_pending if linked
    if (orderId) {
      await this.pool.query(
        `UPDATE orders
         SET transaction_id = $1, payment_status = 'verification_pending'
         WHERE id = $2 AND client_id = $3`,
        [trxId, orderId, effectiveTenantId],
      );
    }

    // Broadcast real-time SSE event to tenant dashboard!
    const stats = await this.getStatsInternal(effectiveTenantId);
    if (this.eventsService) {
      await this.eventsService.broadcastTenantEvent(effectiveTenantId, {
        type: 'payment:received',
        payment,
        stats,
      });
    }

    return {
      ok: true,
      success: true,
      payment,
      duplicate_warning: duplicateFlag,
      stats,
    };
  }

  @Post('payments/:id/verify')
  @UseGuards(AdminGuard)
  async verifyPayment(
    @CurrentTenant() tenantId: number | null,
    @Param('id', ParseIntPipe) paymentId: number,
    @Body() body: VerifyPaymentDto,
    @Req() req?: any,
  ) {
    const checkSql = tenantId
      ? 'SELECT * FROM payments WHERE id = $1 AND client_id = $2 LIMIT 1'
      : 'SELECT * FROM payments WHERE id = $1 LIMIT 1';
    const checkParams = tenantId ? [paymentId, tenantId] : [paymentId];

    const check = await this.pool.query(checkSql, checkParams);
    if (!check.rows.length) {
      throw new NotFoundException('Payment not found');
    }
    const payment = check.rows[0];
    const targetClientId = payment.client_id;
    const sessionUser = req?.user?.username || String(req?.user?.id || 'admin');
    const verifiedBy = sessionUser;

    // Update payment record scoped by client_id
    const updRes = await this.pool.query(
      `UPDATE payments
       SET status = 'verified', verified_by = $1, verified_at = NOW(), rejection_reason = NULL
       WHERE id = $2 AND client_id = $3
       RETURNING *`,
      [verifiedBy, paymentId, targetClientId],
    );
    const updatedPayment = updRes.rows[0];

    // Update associated order if present
    if (payment.order_id) {
      await this.pool.query(
        `UPDATE orders
         SET status = 'confirmed', payment_status = 'paid', advance_paid_bdt = $1
         WHERE id = $2 AND client_id = $3`,
        [payment.amount, payment.order_id, targetClientId],
      );
    }

    // Auto-send friendly confirmation message in customer chat
    if (payment.conversation_id) {
      const formattedAmount = Number(payment.amount) > 0 ? `৳${payment.amount}` : '';
      const replyText = `আপনার পেমেন্ট (TrxID: ${payment.transaction_id}${formattedAmount ? ', ' + formattedAmount : ''}) সফলভাবে যাচাই ও গ্রহণ করা হয়েছে। আপনার অর্ডারটি নিশ্চিত করা হয়েছে এবং ডেলিভারির জন্য প্রস্তুত করা হচ্ছে। ধন্যবাদ!`;

      const outMsg = await this.pool.query(
        `INSERT INTO messages (conversation_id, direction, text, raw_json, created_at)
         VALUES ($1, 'out', $2, $3, NOW())
         RETURNING *`,
        [
          payment.conversation_id,
          replyText,
          JSON.stringify({ via: 'system', action: 'payment_verified', payment_id: paymentId }),
        ],
      );

      if (this.eventsService) {
        await this.eventsService.broadcastTenantEvent(targetClientId, {
          type: 'message',
          conversationId: payment.conversation_id,
          outbound: outMsg.rows[0],
        });
      }
    }

    // Broadcast SSE payment update
    const stats = await this.getStatsInternal(targetClientId);
    if (this.eventsService) {
      await this.eventsService.broadcastTenantEvent(targetClientId, {
        type: 'payment:updated',
        payment: updatedPayment,
        stats,
      });
    }

    return {
      ok: true,
      success: true,
      payment: updatedPayment,
      stats,
      message: 'পেমেন্ট সফলভাবে ভেরিফাই ও গ্রহণ করা হয়েছে।',
    };
  }

  @Post('payments/:id/reject')
  @UseGuards(AdminGuard)
  async rejectPayment(
    @CurrentTenant() tenantId: number | null,
    @Param('id', ParseIntPipe) paymentId: number,
    @Body() body: RejectPaymentDto,
    @Req() req?: any,
  ) {
    const checkSql = tenantId
      ? 'SELECT * FROM payments WHERE id = $1 AND client_id = $2 LIMIT 1'
      : 'SELECT * FROM payments WHERE id = $1 LIMIT 1';
    const checkParams = tenantId ? [paymentId, tenantId] : [paymentId];

    const check = await this.pool.query(checkSql, checkParams);
    if (!check.rows.length) {
      throw new NotFoundException('Payment not found');
    }
    const payment = check.rows[0];
    const targetClientId = payment.client_id;
    const reason = body?.reason || 'TrxID স্টেটমেন্টে পাওয়া যায়নি / টাকা ক্রেডিট হয়নি';

    // Update payment record scoped by client_id
    const updRes = await this.pool.query(
      `UPDATE payments
       SET status = 'rejected', rejection_reason = $1, verified_at = NULL
       WHERE id = $2 AND client_id = $3
       RETURNING *`,
      [reason, paymentId, targetClientId],
    );
    const updatedPayment = updRes.rows[0];

    // Update associated order if present
    if (payment.order_id) {
      await this.pool.query(
        `UPDATE orders
         SET payment_status = 'rejected'
         WHERE id = $1 AND client_id = $2`,
        [payment.order_id, targetClientId],
      );
    }

    // Auto-send polite rejection / clarification message in customer chat
    if (payment.conversation_id) {
      const replyText = `দুঃখিত, আপনার দেওয়া TrxID (${payment.transaction_id}) এর বিপরীতে কোনো পেমেন্ট পাওয়া যায়নি (${reason})। অনুগ্রহ করে আপনার স্টেটমেন্ট চেক করে সঠিক TrxID অথবা পেমেন্ট স্লিপের স্ক্রিনশট পাঠিয়ে সহায়তা করুন।`;

      const outMsg = await this.pool.query(
        `INSERT INTO messages (conversation_id, direction, text, raw_json, created_at)
         VALUES ($1, 'out', $2, $3, NOW())
         RETURNING *`,
        [
          payment.conversation_id,
          replyText,
          JSON.stringify({ via: 'system', action: 'payment_rejected', payment_id: paymentId }),
        ],
      );

      if (this.eventsService) {
        await this.eventsService.broadcastTenantEvent(targetClientId, {
          type: 'message',
          conversationId: payment.conversation_id,
          outbound: outMsg.rows[0],
        });
      }
    }

    // Broadcast SSE payment update
    const stats = await this.getStatsInternal(targetClientId);
    if (this.eventsService) {
      await this.eventsService.broadcastTenantEvent(targetClientId, {
        type: 'payment:updated',
        payment: updatedPayment,
        stats,
      });
    }

    return {
      ok: true,
      success: true,
      payment: updatedPayment,
      stats,
      message: 'পেমেন্ট প্রত্যাখ্যান করা হয়েছে এবং কাস্টমারকে নোটিফাই করা হয়েছে।',
    };
  }
}
