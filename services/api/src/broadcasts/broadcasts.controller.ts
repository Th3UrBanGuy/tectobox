import { Controller, Get, Post, Delete, Body, Param, UseGuards, Inject, ParseIntPipe, NotFoundException, BadRequestException } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import pg from 'pg';
import { DB_POOL } from '../database/database.module.js';
import { EventsService } from '../events/events.service.js';

@Controller('api')
@UseGuards(TenantGuard)
export class BroadcastsController {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    private readonly eventsService: EventsService,
  ) {}

  @Get('broadcasts')
  async listBroadcasts(@CurrentTenant() tenantId: number) {
    const result = await this.pool.query(
      `SELECT b.*,
              (SELECT COUNT(*) FROM broadcast_recipients r WHERE r.broadcast_id = b.id) AS total,
              (SELECT COUNT(*) FROM broadcast_recipients r WHERE r.broadcast_id = b.id AND r.status = 'sent') AS sent,
              (SELECT COUNT(*) FROM broadcast_recipients r WHERE r.broadcast_id = b.id AND r.status = 'failed') AS failed
       FROM broadcasts b
       WHERE b.client_id = $1
       ORDER BY b.id DESC`,
      [tenantId]
    );

    const res: any = result.rows;
    res.success = true;
    res.broadcasts = result.rows;
    return res;
  }

  @Post('broadcasts')
  async createBroadcast(
    @CurrentTenant() tenantId: number,
    @Body() body: { name: string; channel?: string; text: string }
  ) {
    const name = String(body.name || 'Campaign').slice(0, 120);
    const channel = ['all', 'whatsapp', 'telegram', 'messenger', 'instagram'].includes(body.channel || '')
      ? body.channel
      : 'all';
    const text = String(body.text || '').slice(0, 4000);

    const result = await this.pool.query(
      `INSERT INTO broadcasts (client_id, name, channel, text, status, created_at)
       VALUES ($1, $2, $3, $4, 'draft', NOW())
       RETURNING *`,
      [tenantId, name, channel, text]
    );

    return result.rows[0];
  }

  @Get('broadcasts/:id')
  async getBroadcast(
    @CurrentTenant() tenantId: number,
    @Param('id', ParseIntPipe) id: number
  ) {
    const result = await this.pool.query(
      'SELECT * FROM broadcasts WHERE id = $1 AND client_id = $2',
      [id, tenantId]
    );
    if (result.rows.length === 0) throw new NotFoundException('Broadcast not found');

    const b = result.rows[0];
    const statsResult = await this.pool.query(
      `SELECT COUNT(*) as total,
              COUNT(*) FILTER (WHERE status = 'sent') as sent,
              COUNT(*) FILTER (WHERE status = 'failed') as failed,
              COUNT(*) FILTER (WHERE status = 'pending') as pending
       FROM broadcast_recipients
       WHERE broadcast_id = $1`,
      [id]
    );
    b.stats = statsResult.rows[0];
    return b;
  }

  @Post('broadcasts/:id/audience')
  async buildAudience(
    @CurrentTenant() tenantId: number,
    @Param('id', ParseIntPipe) id: number
  ) {
    const check = await this.pool.query(
      'SELECT * FROM broadcasts WHERE id = $1 AND client_id = $2',
      [id, tenantId]
    );
    if (check.rows.length === 0) throw new NotFoundException('Broadcast not found');
    const b = check.rows[0];

    await this.pool.query('DELETE FROM broadcast_recipients WHERE broadcast_id = $1', [id]);

    let audienceSql = `SELECT platform, platform_user_id, MAX(customer_name) AS customer_name
                       FROM conversations
                       WHERE client_id = $1`;
    const params: any[] = [tenantId];

    if (b.channel !== 'all') {
      params.push(b.channel);
      audienceSql += ` AND platform = $2`;
    }
    audienceSql += ` GROUP BY platform, platform_user_id`;

    const convRows = await this.pool.query(audienceSql, params);

    for (const r of convRows.rows) {
      await this.pool.query(
        `INSERT INTO broadcast_recipients (broadcast_id, platform, platform_user_id, customer_name, status)
         VALUES ($1, $2, $3, $4, 'pending')
         ON CONFLICT (broadcast_id, platform, platform_user_id) DO NOTHING`,
        [id, r.platform, r.platform_user_id, r.customer_name]
      );
    }

    await this.pool.query(
      `UPDATE broadcasts
       SET total = (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = $1)
       WHERE id = $1`,
      [id]
    );

    const full = await this.getBroadcast(tenantId, id);
    return {
      ...full,
      count: Number(full.total || 0),
      ok: true,
      success: true,
    };
  }

  @Post('broadcasts/:id/send')
  async sendBroadcast(
    @CurrentTenant() tenantId: number,
    @Param('id', ParseIntPipe) id: number
  ) {
    const check = await this.pool.query(
      'SELECT * FROM broadcasts WHERE id = $1 AND client_id = $2',
      [id, tenantId]
    );
    if (check.rows.length === 0) throw new NotFoundException('Broadcast not found');
    const b = check.rows[0];
    if (b.status === 'sending') {
      throw new BadRequestException('Campaign is already sending');
    }

    await this.pool.query(
      `UPDATE broadcasts
       SET status = 'sending', started_at = COALESCE(started_at, NOW()), finished_at = NULL
       WHERE id = $1`,
      [id]
    );

    // Re-queue recipients that are still pending, plus previously failed ones
    // (a completed/failed/cancelled campaign can be re-sent; already-sent
    // recipients are never messaged twice).
    const recips = await this.pool.query(
      `SELECT id, platform, platform_user_id, customer_name
       FROM broadcast_recipients
       WHERE broadcast_id = $1 AND status IN ('pending', 'failed')
       ORDER BY id`,
      [id]
    );

    if (recips.rows.length > 0) {
      await this.pool.query(
        `UPDATE broadcast_recipients
         SET status = 'pending', error = NULL
         WHERE broadcast_id = $1 AND status IN ('pending', 'failed')`,
        [id]
      );
    }

    let enqueued = 0;
    for (const r of recips.rows) {
      const ok = await this.eventsService.publishBroadcastJob({
        broadcastId: id,
        recipientId: r.id,
        clientId: tenantId,
        platform: r.platform,
        platformUserId: r.platform_user_id,
        customerName: r.customer_name,
        text: b.text,
      });
      if (ok) {
        enqueued++;
      } else {
        // Broker unavailable: record the failure honestly instead of
        // leaving the recipient pending forever.
        await this.pool.query(
          `UPDATE broadcast_recipients
           SET status = 'failed', error = $2 WHERE id = $1`,
          [r.id, 'Failed to enqueue broadcast job: message broker unavailable']
        );
      }
    }

    // Nothing left to send (empty audience, or everything already sent):
    // finish immediately so the campaign does not stick at 'sending'.
    // The broadcast worker runs the same check after every recipient.
    await this.pool.query(
      `UPDATE broadcasts
       SET status = 'done', finished_at = NOW(),
           sent = (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = $1 AND status = 'sent'),
           failed = (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = $1 AND status = 'failed')
       WHERE id = $1 AND status = 'sending'
         AND NOT EXISTS (SELECT 1 FROM broadcast_recipients WHERE broadcast_id = $1 AND status = 'pending')`,
      [id]
    );

    const result = await this.pool.query(
      'SELECT * FROM broadcasts WHERE id = $1',
      [id]
    );
    return { ...result.rows[0], enqueued, total: recips.rows.length };
  }

  @Post('broadcasts/:id/cancel')
  async cancelBroadcast(
    @CurrentTenant() tenantId: number,
    @Param('id', ParseIntPipe) id: number
  ) {
    const result = await this.pool.query(
      `UPDATE broadcasts
       SET status = 'cancelled', finished_at = NOW()
       WHERE id = $1 AND client_id = $2
       RETURNING *`,
      [id, tenantId]
    );
    if (result.rows.length === 0) throw new NotFoundException('Broadcast not found');
    return result.rows[0];
  }

  @Delete('broadcasts/:id')
  async deleteBroadcast(
    @CurrentTenant() tenantId: number,
    @Param('id', ParseIntPipe) id: number
  ) {
    const check = await this.pool.query(
      'SELECT status FROM broadcasts WHERE id = $1 AND client_id = $2',
      [id, tenantId]
    );
    if (check.rows.length === 0) throw new NotFoundException('Broadcast not found');
    if (check.rows[0].status === 'sending') throw new BadRequestException('Cancel campaign before deleting');

    await this.pool.query('DELETE FROM broadcasts WHERE id = $1 AND client_id = $2', [id, tenantId]);
    return { ok: true, success: true };
  }
}
