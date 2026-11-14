import {
  Controller,
  Delete,
  Post,
  Param,
  UseGuards,
  Inject,
  ParseIntPipe,
  NotFoundException,
  Req,
} from '@nestjs/common';
import pg from 'pg';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { DB_POOL } from '../database/database.module.js';

/**
 * RC8: Purge path hard-deletes rows past purge_at (now >= purge_at).
 * Since no cron scheduler exists in the codebase, this function is exposed
 * for scheduled cron jobs or admin execution.
 */
export async function purgeExpiredConversations(pool: pg.Pool): Promise<number> {
  const client =
    typeof (pool as any).connect === 'function'
      ? await (pool as any).connect()
      : pool;

  try {
    await client.query('BEGIN');
    const expiredRes = await client.query(
      'SELECT id FROM conversations WHERE purge_at IS NOT NULL AND purge_at <= NOW()'
    );
    const expiredIds: number[] = (expiredRes.rows || []).map((r: any) => r.id);

    if (expiredIds.length > 0) {
      await client.query(
        'DELETE FROM messages WHERE conversation_id = ANY($1::int[])',
        [expiredIds]
      );
      await client.query(
        'UPDATE orders SET conversation_id = NULL WHERE conversation_id = ANY($1::int[])',
        [expiredIds]
      );
      await client.query(
        'UPDATE payments SET conversation_id = NULL WHERE conversation_id = ANY($1::int[])',
        [expiredIds]
      );
      await client.query(
        'DELETE FROM conversations WHERE id = ANY($1::int[])',
        [expiredIds]
      );
    }
    await client.query('COMMIT');
    return expiredIds.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    if (typeof client.release === 'function') {
      client.release();
    }
  }
}

@Controller('api')
export class ConversationsController {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  @Delete('clients/:clientId/conversations/:conversationId')
  @UseGuards(TenantGuard)
  async deleteConversation(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number,
    @Param('conversationId', ParseIntPipe) conversationId: number,
    @Req() req: any
  ) {
    const userRole = req?.user?.role;
    const isAdmin = userRole === 'admin' || userRole === 'superadmin';
    const targetClient = isAdmin ? clientId : (tenantId || clientId);

    // Non-admin callers cannot delete conversations from another tenant
    if (!isAdmin && tenantId && tenantId !== clientId) {
      throw new NotFoundException('Conversation not found');
    }

    // Verify the conversation exists, belongs to targetClient, and is not already deleted
    const convCheck = await this.pool.query(
      'SELECT id, client_id, deleted_at FROM conversations WHERE id = $1 AND client_id = $2',
      [conversationId, targetClient]
    );

    if (!convCheck.rows || convCheck.rows.length === 0 || convCheck.rows[0].deleted_at) {
      throw new NotFoundException('Conversation not found');
    }

    // RC8: Soft delete: set deleted_at = NOW(), purge_at = NOW() + 15 days
    const res = await this.pool.query(
      `UPDATE conversations
       SET deleted_at = NOW(), purge_at = NOW() + INTERVAL '15 days'
       WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL
       RETURNING id, deleted_at, purge_at`,
      [conversationId, targetClient]
    );

    const updated = res.rows[0];
    return {
      ok: true,
      success: true,
      conversationId,
      deleted_at: updated?.deleted_at,
      purge_at: updated?.purge_at,
    };
  }

  @Post('clients/:clientId/conversations/:conversationId/restore')
  @UseGuards(TenantGuard)
  async restoreConversation(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number,
    @Param('conversationId', ParseIntPipe) conversationId: number,
    @Req() req: any
  ) {
    const userRole = req?.user?.role;
    const isAdmin = userRole === 'admin' || userRole === 'superadmin';
    const targetClient = isAdmin ? clientId : (tenantId || clientId);

    if (!isAdmin && tenantId && tenantId !== clientId) {
      throw new NotFoundException('Conversation not found');
    }

    const convCheck = await this.pool.query(
      'SELECT id, client_id, deleted_at FROM conversations WHERE id = $1 AND client_id = $2',
      [conversationId, targetClient]
    );

    if (!convCheck.rows || convCheck.rows.length === 0 || !convCheck.rows[0].deleted_at) {
      throw new NotFoundException('Conversation not found or not deleted');
    }

    const res = await this.pool.query(
      'UPDATE conversations SET deleted_at = NULL, purge_at = NULL WHERE id = $1 AND client_id = $2 RETURNING id, deleted_at, purge_at',
      [conversationId, targetClient]
    );

    return {
      ok: true,
      success: true,
      restored: true,
      conversationId,
      conversation: res.rows[0],
    };
  }

  @Post('admin/conversations/purge')
  @UseGuards(TenantGuard)
  async purgeExpired(@Req() req: any) {
    const userRole = req?.user?.role;
    const isAdmin = userRole === 'admin' || userRole === 'superadmin';
    if (!isAdmin) {
      throw new NotFoundException('Not found');
    }
    const purged = await purgeExpiredConversations(this.pool);
    return { ok: true, purged };
  }
}
