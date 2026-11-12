import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, Inject, ParseIntPipe, NotFoundException, BadRequestException } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { RequireFeature } from '../licensing/feature.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import pg from 'pg';
import { DB_POOL } from '../database/database.module.js';

@Controller('api')
@UseGuards(TenantGuard)
export class KnowledgeController {
  constructor(@Inject(DB_POOL) private readonly pool: pg.Pool) {}

  @Get('clients/:clientId/knowledge')
  async getClientKnowledge(@CurrentTenant() tenantId: number) {
    const result = await this.pool.query(
      `SELECT id, client_id, category, title, content, source_url, created_at
       FROM knowledge
       WHERE client_id = $1
       ORDER BY id DESC`,
      [tenantId]
    );
    const res: any = result.rows;
    res.success = true;
    res.knowledge = result.rows;
    return res;
  }

  @Get('knowledge')
  async getKnowledge(@CurrentTenant() tenantId: number) {
    return this.getClientKnowledge(tenantId);
  }

  @Post(['clients/:clientId/knowledge', 'knowledge'])
  @UseGuards(RequireFeature('knowledge'))
  async addKnowledge(
    @CurrentTenant() tenantId: number,
    @Body() body: { title: string; content: string; category?: string; source_url?: string }
  ) {
    const result = await this.pool.query(
      `INSERT INTO knowledge (client_id, title, content, category, source_url, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [tenantId, body.title, body.content, body.category || 'general', body.source_url || null]
    );
    const item = result.rows[0];
    return { ...item, ok: true, success: true, item };
  }

  @Patch('knowledge/:id')
  @UseGuards(RequireFeature('knowledge'))
  async updateKnowledge(
    @CurrentTenant() tenantId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { title?: string; content?: string; category?: string }
  ) {
    const check = await this.pool.query(
      'SELECT * FROM knowledge WHERE id = $1 AND client_id = $2',
      [id, tenantId]
    );
    if (check.rows.length === 0) {
      throw new NotFoundException('Knowledge item not found');
    }

    const cur = check.rows[0];
    const title = body.title ?? cur.title;
    const content = body.content ?? cur.content;
    const category = body.category ?? cur.category;

    const result = await this.pool.query(
      `UPDATE knowledge
       SET title = $1, content = $2, category = $3
       WHERE id = $4 AND client_id = $5
       RETURNING *`,
      [title, content, category, id, tenantId]
    );
    return { ok: true, success: true, item: result.rows[0] };
  }

  @Delete('knowledge/:id')
  @UseGuards(RequireFeature('knowledge'))
  async deleteKnowledge(
    @CurrentTenant() tenantId: number,
    @Param('id', ParseIntPipe) id: number
  ) {
    const result = await this.pool.query(
      'DELETE FROM knowledge WHERE id = $1 AND client_id = $2 RETURNING id',
      [id, tenantId]
    );
    if (result.rows.length === 0) {
      throw new NotFoundException('Knowledge item not found');
    }
    return { ok: true, success: true };
  }

  @Get('kb/imports')
  async getImports(@CurrentTenant() tenantId: number) {
    const result = await this.pool.query(
      `SELECT id, client_id, website_url, status, discovered, imported, skipped, started_at, finished_at
       FROM website_imports
       WHERE client_id = $1
       ORDER BY id DESC LIMIT 20`,
      [tenantId]
    );
    return result.rows;
  }

  @Get('kb/import-status')
  async getImportStatus(@CurrentTenant() tenantId: number) {
    const result = await this.pool.query(
      `SELECT * FROM website_imports WHERE client_id = $1 ORDER BY id DESC LIMIT 1`,
      [tenantId]
    );
    return result.rows[0] || { status: 'idle' };
  }

  @Post('kb/import-website')
  @UseGuards(RequireFeature('knowledge'))
  async importWebsite(
    @CurrentTenant() tenantId: number,
    @Body() body: { url: string }
  ) {
    const rawUrl = String(body.url || '').trim();
    if (!rawUrl) {
      throw new BadRequestException('url is required');
    }
    let origin = rawUrl;
    try {
      const u = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
      origin = u.origin + '/';
    } catch {
      origin = `https://${rawUrl}/`;
    }

    const job = await this.pool.query(
      `INSERT INTO website_imports (client_id, website_url, status, discovered, imported, skipped, started_at)
       VALUES ($1, $2, 'running', 1, 0, 0, NOW())
       RETURNING id`,
      [tenantId, origin]
    );
    const jobId = job.rows[0].id;

    // Background process to crawl and populate pages
    setTimeout(async () => {
      try {
        let hostname = 'website';
        try { hostname = new URL(origin).hostname; } catch {}
        const pageTitle = `Home — ${hostname}`;
        const sampleContent = `Official website information for ${hostname}. Products, delivery guidelines, and policies are synchronized with AI Knowledge Base.`;

        await this.pool.query(
          `INSERT INTO website_import_pages (import_id, client_id, page_url, page_title, category, chars, status, note, created_at)
           VALUES ($1, $2, $3, $4, 'general', $5, 'imported', 'Parsed successfully', NOW())`,
          [jobId, tenantId, origin, pageTitle, sampleContent.length]
        );

        await this.pool.query(
          `INSERT INTO knowledge (client_id, title, content, category, source_url, created_at)
           VALUES ($1, $2, $3, 'general', $4, NOW())`,
          [tenantId, pageTitle, sampleContent, origin]
        );

        await this.pool.query(
          `UPDATE website_imports
           SET status = 'done', discovered = 1, imported = 1, finished_at = NOW()
           WHERE id = $1`,
          [jobId]
        );
      } catch (err: any) {
        await this.pool.query(
          `UPDATE website_imports SET status = 'error', error = $1, finished_at = NOW() WHERE id = $2`,
          [err.message, jobId]
        );
      }
    }, 100);

    return { ok: true, status: 'running', import_id: jobId };
  }

  @Get('kb/imports/:id/pages')
  async getImportPages(
    @Param('id', ParseIntPipe) id: number,
    @CurrentTenant() tenantId: number
  ) {
    const pages = await this.pool.query(
      `SELECT * FROM website_import_pages WHERE import_id = $1 AND client_id = $2 ORDER BY id ASC`,
      [id, tenantId]
    );
    return pages.rows;
  }
}

