import {
  Controller,
  Delete,
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

    // Verify the conversation exists and belongs to targetClient
    const convCheck = await this.pool.query(
      'SELECT id, client_id FROM conversations WHERE id = $1 AND client_id = $2',
      [conversationId, targetClient]
    );

    if (!convCheck.rows || convCheck.rows.length === 0) {
      throw new NotFoundException('Conversation not found');
    }

    const client =
      typeof (this.pool as any).connect === 'function'
        ? await (this.pool as any).connect()
        : this.pool;

    try {
      await client.query('BEGIN');
      // Delete dependent messages
      await client.query('DELETE FROM messages WHERE conversation_id = $1', [conversationId]);
      // Clear dependent nullable foreign keys (orders, payments)
      await client.query('UPDATE orders SET conversation_id = NULL WHERE conversation_id = $1', [conversationId]);
      await client.query('UPDATE payments SET conversation_id = NULL WHERE conversation_id = $1', [conversationId]);
      // Delete the conversation row
      await client.query('DELETE FROM conversations WHERE id = $1 AND client_id = $2', [conversationId, targetClient]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      if (typeof client.release === 'function') {
        client.release();
      }
    }

    return { ok: true, success: true, conversationId };
  }
}
