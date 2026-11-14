import {
  Controller,
  Get,
  Put,
  Body,
  Param,
  UseGuards,
  Inject,
  ParseIntPipe,
} from '@nestjs/common';
import pg from 'pg';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { DB_POOL } from '../database/database.module.js';

/**
 * Facebook comment automation config + comment log.
 *
 * Split out of `ConnectorsController` (Phase 3 of the modular
 * restructure). Methods moved verbatim; no behaviour change.
 */
@Controller('api')
export class CommentsController {
  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool
  ) {}

  @Get('clients/:clientId/comment-config')
  @UseGuards(TenantGuard)
  async getCommentConfig(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number
  ) {
    const target = tenantId || clientId;
    const rows = await this.pool.query(
      'SELECT key, value FROM settings WHERE key LIKE $1',
      [`comment.%.${target}`]
    );
    const cfg: Record<string, string> = {};
    for (const r of rows.rows) cfg[r.key] = r.value;
    let rules: any[] = [];
    try { rules = JSON.parse(cfg[`comment.rules.${target}`] || '[]'); } catch {}
    return {
      autoReply: cfg[`comment.autoreply.${target}`] === '1',
      dmFollowup: cfg[`comment.dm.${target}`] === '1',
      likeComment: cfg[`comment.like.${target}`] === '1',
      rules: Array.isArray(rules) ? rules : [],
    };
  }

  @Put('clients/:clientId/comment-config')
  @UseGuards(TenantGuard)
  async updateCommentConfig(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number,
    @Body() body: any
  ) {
    const target = tenantId || clientId;
    if (body.autoReply !== undefined) {
      await this.pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [`comment.autoreply.${target}`, body.autoReply ? '1' : '0']
      );
    }
    if (body.dmFollowup !== undefined) {
      await this.pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [`comment.dm.${target}`, body.dmFollowup ? '1' : '0']
      );
    }
    if (body.likeComment !== undefined) {
      await this.pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [`comment.like.${target}`, body.likeComment ? '1' : '0']
      );
    }
    if (body.rules !== undefined) {
      await this.pool.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [`comment.rules.${target}`, JSON.stringify(body.rules)]
      );
    }
    return this.getCommentConfig(tenantId, clientId);
  }

  @Get('clients/:clientId/comments')
  @UseGuards(TenantGuard)
  async getComments(
    @CurrentTenant() tenantId: number,
    @Param('clientId', ParseIntPipe) clientId: number
  ) {
    const target = tenantId || clientId;
    const rows = await this.pool.query(
      'SELECT * FROM fb_comment_log WHERE client_id = $1 ORDER BY id DESC LIMIT 30',
      [target]
    );
    return rows.rows;
  }
}
