import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  Inject,
  ParseIntPipe,
  BadRequestException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import pg from 'pg';
import { DB_POOL } from '../database/database.module.js';
import { EventsService } from '../events/events.service.js';
import { SSE_EVENT_TYPES } from '@tectonic/contracts';

@Controller('api')
@UseGuards(TenantGuard)
export class InboxController {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Optional() private readonly eventsService?: EventsService
  ) {}

  @Get('conversations')
  async getConversations(
    @CurrentTenant() tenantId: number,
    @Query('platform') platform?: string,
    @Query('q') query?: string,
    @Query('needs_human') needsHuman?: string,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string
  ) {
    const limit = Math.min(200, Math.max(1, parseInt(limitStr || '', 10) || 50));
    const offset = Math.max(0, parseInt(offsetStr || '', 10) || 0);

    let whereClause = `WHERE c.client_id = $1 AND c.deleted_at IS NULL`;
    const params: any[] = [tenantId];

    if (platform && platform !== 'all') {
      params.push(platform);
      whereClause += ` AND c.platform = $${params.length}`;
    }

    if (needsHuman === '1' || needsHuman === 'true') {
      whereClause += ` AND c.needs_human = true`;
    }

    if (query && query.trim()) {
      params.push(`%${query.trim()}%`);
      whereClause += ` AND (c.customer_name ILIKE $${params.length} OR c.customer_phone ILIKE $${params.length} OR c.platform_user_id ILIKE $${params.length})`;
    }

    const countSql = `SELECT COUNT(*) AS total FROM conversations c ${whereClause}`;
    const countRes = await this.pool.query(countSql, params);
    const total = parseInt(countRes.rows[0]?.total || '0', 10);

    const queryParams = [...params, limit, offset];
    const dataSql = `SELECT c.id, c.client_id, c.platform, c.platform_user_id, c.slot, c.customer_name, c.customer_phone,
                            c.last_message_at, c.unread_count, c.status, c.needs_human,
                            (SELECT text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message_text
                     FROM conversations c
                     ${whereClause}
                     ORDER BY c.last_message_at DESC
                     LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`;
    const result = await this.pool.query(dataSql, queryParams);

    const res: any = result.rows;
    res.success = true;
    res.tenantId = tenantId;
    res.conversations = result.rows;
    res.total = total;
    res.limit = limit;
    res.offset = offset;
    return res;
  }

  @Get('conversations/:id/messages')
  async getMessages(
    @CurrentTenant() tenantId: number,
    @Param('id', ParseIntPipe) conversationId: number,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string
  ) {
    const limit = Math.min(200, Math.max(1, parseInt(limitStr || '', 10) || 50));
    const offset = Math.max(0, parseInt(offsetStr || '', 10) || 0);

    const convCheck = await this.pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL',
      [conversationId, tenantId]
    );

    if (convCheck.rows.length === 0) {
      throw new NotFoundException('Conversation not found');
    }

    const countRes = await this.pool.query(
      'SELECT COUNT(*) as total FROM messages WHERE conversation_id = $1',
      [conversationId]
    );
    const total = parseInt(countRes.rows[0]?.total || '0', 10);

    const messagesResult = await this.pool.query(
      `SELECT id, conversation_id, direction, text, raw_json, external_id, created_at 
       FROM messages 
       WHERE conversation_id = $1 
       ORDER BY id ASC
       LIMIT $2 OFFSET $3`,
      [conversationId, limit, offset]
    );

    const res: any = messagesResult.rows;
    res.success = true;
    res.tenantId = tenantId;
    res.conversationId = conversationId;
    res.messages = messagesResult.rows;
    res.total = total;
    res.limit = limit;
    res.offset = offset;
    return res;
  }

  @Post('conversations/:id/read')
  async markRead(
    @CurrentTenant() tenantId: number,
    @Param('id', ParseIntPipe) conversationId: number
  ) {
    const result = await this.pool.query(
      `UPDATE conversations
       SET unread_count = 0
       WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL
       RETURNING id, client_id, unread_count`,
      [conversationId, tenantId]
    );

    if (result.rows.length === 0) {
      throw new NotFoundException('Conversation not found');
    }

    if (this.eventsService) {
      await this.eventsService.broadcastTenantEvent(tenantId, {
        type: SSE_EVENT_TYPES.CONVERSATION_READ,
        conversationId,
      });
    }

    return { ok: true, success: true };
  }

  @Post('conversations/:id/reply')
  async reply(
    @CurrentTenant() tenantId: number,
    @Param('id', ParseIntPipe) conversationId: number,
    @Body() body: { text: string }
  ) {
    const text = String(body.text || '').trim();
    if (!text) {
      throw new BadRequestException('text is required');
    }

    const convResult = await this.pool.query(
      'SELECT * FROM conversations WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL',
      [conversationId, tenantId]
    );

    if (convResult.rows.length === 0) {
      throw new NotFoundException('Conversation not found');
    }

    const conv = convResult.rows[0];

    // 1. Insert message
    const insertMsg = await this.pool.query(
      `INSERT INTO messages (conversation_id, direction, text, created_at)
       VALUES ($1, 'out', $2, NOW())
       RETURNING id, conversation_id, direction, text, created_at`,
      [conversationId, text]
    );
    const msg = insertMsg.rows[0];

    // 2. Update conversation
    await this.pool.query(
      `UPDATE conversations
       SET last_message_at = NOW(), needs_human = false
       WHERE id = $1`,
      [conversationId]
    );

    // 3. Dispatch to outbox / RabbitMQ
    if (this.eventsService) {
      await this.eventsService.enqueueOutboundMessage({
        conversationId,
        clientId: tenantId,
        platform: conv.platform,
        platformUserId: conv.platform_user_id,
        slot: conv.slot || 'default',
        text,
        timestamp: new Date().toISOString(),
      });

      // 4. Broadcast SSE
      await this.eventsService.broadcastTenantEvent(tenantId, {
        type: SSE_EVENT_TYPES.MESSAGE,
        conversation: conv,
        outbound: msg,
      });
      await this.eventsService.broadcastTenantEvent(tenantId, {
        type: SSE_EVENT_TYPES.CONVERSATION_FLAG,
        conversationId,
        needsHuman: false,
      });
    }

    return {
      ok: true,
      success: true,
      message: msg,
      send: { sent: true, mode: 'live' },
    };
  }

  @Post('messages/send')
  async sendMessage(
    @CurrentTenant() tenantId: number,
    @Body() body: { conversationId: number; text: string }
  ) {
    return this.reply(tenantId, body.conversationId, { text: body.text });
  }

  @Post('conversations/:id/flag')
  async flagConversation(
    @CurrentTenant() tenantId: number,
    @Param('id', ParseIntPipe) conversationId: number,
    @Body() body: { needs_human?: boolean }
  ) {
    const needsHuman = body.needs_human !== false;
    const res = await this.pool.query(
      `UPDATE conversations
       SET needs_human = $1
       WHERE id = $2 AND client_id = $3 AND deleted_at IS NULL
       RETURNING id, client_id, needs_human`,
      [needsHuman, conversationId, tenantId]
    );
    if (!res.rows.length) throw new NotFoundException('Conversation not found');

    if (this.eventsService) {
      await this.eventsService.broadcastTenantEvent(tenantId, {
        type: SSE_EVENT_TYPES.CONVERSATION_FLAG,
        conversationId,
        needsHuman,
      });
    }

    return { ok: true, conversationId, needsHuman };
  }
}
