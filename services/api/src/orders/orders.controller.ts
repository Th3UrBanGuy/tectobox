import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards, Inject, ParseIntPipe, BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import pg from 'pg';
import { DB_POOL } from '../database/database.module.js';

@Controller('api')
@UseGuards(TenantGuard)
export class OrdersController {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  @Get('orders')
  async getOrders(
    @CurrentTenant() tenantId: number,
    @Query('status') status?: string,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string
  ) {
    const limit = Math.min(200, Math.max(1, parseInt(limitStr || '', 10) || 50));
    const offset = Math.max(0, parseInt(offsetStr || '', 10) || 0);

    let whereSql = `WHERE client_id = $1`;
    const params: any[] = [tenantId];

    if (status && status !== 'all') {
      params.push(status);
      whereSql += ` AND status = $${params.length}`;
    }

    const countRes = await this.pool.query(`SELECT COUNT(*) AS total FROM orders ${whereSql}`, params);
    const total = parseInt(countRes.rows[0]?.total || '0', 10);

    const queryParams = [...params, limit, offset];
    const dataSql = `SELECT id, client_id, conversation_id, items_json, subtotal_bdt, delivery_charge_bdt,
                            total_bdt, advance_required_bdt, advance_paid_bdt, transaction_id, payment_status,
                            status, customer_name, customer_phone, customer_address, courier_name,
                            courier_tracking_code, courier_consignment_id, courier_status, idempotency_key, created_at
                     FROM orders
                     ${whereSql}
                     ORDER BY created_at DESC
                     LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`;
    const result = await this.pool.query(dataSql, queryParams);

    const res: any = result.rows;
    res.success = true;
    res.tenantId = tenantId;
    res.orders = result.rows;
    res.total = total;
    res.limit = limit;
    res.offset = offset;
    return res;
  }

  @Get('conversations/:id/orders')
  async getOrdersByConversation(
    @CurrentTenant() tenantId: number,
    @Param('id', ParseIntPipe) conversationId: number,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string
  ) {
    const limit = Math.min(200, Math.max(1, parseInt(limitStr || '', 10) || 50));
    const offset = Math.max(0, parseInt(offsetStr || '', 10) || 0);

    const countRes = await this.pool.query(
      'SELECT COUNT(*) as total FROM orders WHERE client_id = $1 AND conversation_id = $2',
      [tenantId, conversationId]
    );
    const total = parseInt(countRes.rows[0]?.total || '0', 10);

    const result = await this.pool.query(
      `SELECT id, client_id, conversation_id, items_json, subtotal_bdt, delivery_charge_bdt,
              total_bdt, advance_required_bdt, advance_paid_bdt, transaction_id, payment_status,
              status, customer_name, customer_phone, customer_address, courier_name,
              courier_tracking_code, courier_consignment_id, courier_status, idempotency_key, created_at
       FROM orders
       WHERE client_id = $1 AND conversation_id = $2
       ORDER BY created_at DESC
       LIMIT $3 OFFSET $4`,
      [tenantId, conversationId, limit, offset]
    );

    const res: any = result.rows;
    res.success = true;
    res.tenantId = tenantId;
    res.orders = result.rows;
    res.total = total;
    res.limit = limit;
    res.offset = offset;
    return res;
  }

  @Post('orders')
  async createOrder(
    @CurrentTenant() tenantId: number,
    @Body() body: any
  ) {
    const idempotencyKey = body.idempotency_key || body.idempotencyKey || null;

    if (idempotencyKey) {
      const dup = await this.pool.query(
        'SELECT * FROM orders WHERE client_id = $1 AND idempotency_key = $2 LIMIT 1',
        [tenantId, idempotencyKey]
      );
      if (dup.rows.length > 0) {
        return { ok: true, deduped: true, order: dup.rows[0] };
      }
    }

    const conversationId = body.conversation_id || body.conversationId || null;
    let itemsJson = '[]';
    if (typeof body.items_json === 'string') {
      try {
        JSON.parse(body.items_json);
        itemsJson = body.items_json;
      } catch {
        itemsJson = '[]';
      }
    } else {
      try {
        itemsJson = JSON.stringify(body.items || body.items_json || []);
      } catch {
        itemsJson = '[]';
      }
    }

    const subtotal = Math.max(0, Number(body.subtotal_bdt ?? body.subtotal ?? 0));
    const delivery = Math.max(0, Number(body.delivery_charge_bdt ?? body.delivery_charge ?? 0));
    const total = Math.max(0, Number(body.total_bdt ?? body.total ?? (subtotal + delivery)));
    const advanceReq = Math.max(0, Number(body.advance_required_bdt ?? body.advance_required ?? 0));
    const advancePaid = Math.max(0, Number(body.advance_paid_bdt ?? body.advance_paid ?? 0));
    const status = body.status || 'confirmed';
    const customerName = body.customer_name ? String(body.customer_name).slice(0, 200) : null;
    const customerPhone = body.customer_phone ? String(body.customer_phone).slice(0, 50) : null;
    const customerAddress = body.customer_address ? String(body.customer_address).slice(0, 500) : null;

    const result = await this.pool.query(
      `INSERT INTO orders (client_id, conversation_id, items_json, subtotal_bdt, delivery_charge_bdt,
                           total_bdt, advance_required_bdt, advance_paid_bdt, status, customer_name,
                           customer_phone, customer_address, idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
       RETURNING *`,
      [
        tenantId,
        conversationId,
        itemsJson,
        subtotal,
        delivery,
        total,
        advanceReq,
        advancePaid,
        status,
        customerName,
        customerPhone,
        customerAddress,
        idempotencyKey,
      ]
    );

    return { ok: true, success: true, order: result.rows[0] };
  }

  @Patch('orders/:id')
  async updateOrder(
    @CurrentTenant() tenantId: number,
    @Param('id', ParseIntPipe) orderId: number,
    @Body() body: any
  ) {
    const check = await this.pool.query(
      'SELECT id FROM orders WHERE id = $1 AND client_id = $2 LIMIT 1',
      [orderId, tenantId]
    );
    if (!check.rows.length) throw new NotFoundException('Order not found');

    const updates: string[] = [];
    const params: any[] = [orderId, tenantId];

    if (body.status !== undefined) {
      params.push(String(body.status).slice(0, 50));
      updates.push(`status = $${params.length}`);
    }
    if (body.payment_status !== undefined) {
      params.push(String(body.payment_status).slice(0, 50));
      updates.push(`payment_status = $${params.length}`);
    }
    if (body.customer_name !== undefined) {
      params.push(String(body.customer_name).slice(0, 200));
      updates.push(`customer_name = $${params.length}`);
    }
    if (body.customer_phone !== undefined) {
      params.push(String(body.customer_phone).slice(0, 50));
      updates.push(`customer_phone = $${params.length}`);
    }
    if (body.customer_address !== undefined) {
      params.push(String(body.customer_address).slice(0, 500));
      updates.push(`customer_address = $${params.length}`);
    }
    if (body.advance_paid_bdt !== undefined) {
      params.push(Math.max(0, Number(body.advance_paid_bdt)));
      updates.push(`advance_paid_bdt = $${params.length}`);
    }

    if (!updates.length) {
      return { ok: true, message: 'No fields to update' };
    }

    const res = await this.pool.query(
      `UPDATE orders SET ${updates.join(', ')} WHERE id = $1 AND client_id = $2 RETURNING *`,
      params
    );

    return { ok: true, success: true, order: res.rows[0] };
  }
}
