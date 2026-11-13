import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  Res,
  UseGuards,
  ParseIntPipe,
  Optional,
  Inject,
} from '@nestjs/common';
import type { Response } from 'express';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { BackupService } from './backup.service.js';
import { EventsService } from '../events/events.service.js';
import { DB_POOL } from '../database/database.module.js';
import pg from 'pg';

function backupFilename(clientName: string, ext: string) {
  const safe = String(clientName || 'backup').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'backup';
  const stamp = new Date().toISOString().slice(0, 10);
  return `tectonic-backup-${safe}-${stamp}.${ext}`;
}

/**
 * Resolve which workspace a backup export/import targets (C3).
 * Only an admin/superadmin may address another workspace via the URL `:id`;
 * every other caller is silently scoped to their own tenant, so a crafted
 * `:id` can never exfiltrate or overwrite another workspace's data.
 */
function resolveBackupTarget(req: any, tenantId: number, id: string | undefined): number {
  const isAdmin = req?.user?.role === 'admin' || req?.user?.role === 'superadmin';
  if (isAdmin && id) {
    const parsed = parseInt(id, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return tenantId;
}

@Controller('api')
@UseGuards(TenantGuard)
export class BackupController {
  constructor(
    private readonly backupService: BackupService,
    @Optional() @Inject(DB_POOL) private readonly pool?: pg.Pool,
    @Optional() private readonly eventsService?: EventsService
  ) {}

  private getEvents(): EventsService | null {
    if (this.eventsService) return this.eventsService;
    if (this.pool) return new EventsService(this.pool, undefined as any);
    return null;
  }

  @Get(['clients/:id/backup/export', 'backup/export'])
  async exportJson(
    @CurrentTenant() tenantId: number,
    @Param('id') id: string | undefined,
    @Res() res: Response,
    @Req() req?: any
  ) {
    const targetId = resolveBackupTarget(req, tenantId, id);
    const bundle = await this.backupService.exportClientData(targetId);
    const actorId = req?.user?.username || req?.user?.id || 'client';
    const ip = (req?.headers?.['x-forwarded-for'] as string) || req?.socket?.remoteAddress || null;
    await this.getEvents()?.writeAudit(actorId, targetId, 'backup:export', { format: 'json', ip });
    const fname = backupFilename(bundle.client.name, 'json');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    return res.send(JSON.stringify(bundle, null, 2));
  }

  @Get(['clients/:id/backup/export-md', 'backup/export-md'])
  async exportMd(
    @CurrentTenant() tenantId: number,
    @Param('id') id: string | undefined,
    @Res() res: Response,
    @Req() req?: any
  ) {
    const targetId = resolveBackupTarget(req, tenantId, id);
    const bundle = await this.backupService.exportClientData(targetId);
    const actorId = req?.user?.username || req?.user?.id || 'client';
    const ip = (req?.headers?.['x-forwarded-for'] as string) || req?.socket?.remoteAddress || null;
    await this.getEvents()?.writeAudit(actorId, targetId, 'backup:export', { format: 'md', ip });
    const fname = backupFilename(bundle.client.name, 'md');
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    return res.send(this.backupService.bundleToMarkdown(bundle));
  }

  @Post(['clients/:id/backup/import', 'backup/import'])
  async importJson(
    @CurrentTenant() tenantId: number,
    @Param('id') id: string | undefined,
    @Body() bundle: any,
    @Req() req?: any
  ) {
    const targetId = resolveBackupTarget(req, tenantId, id);
    const counts = await this.backupService.importClientData(targetId, bundle);
    return { ok: true, imported: counts };
  }

  @Get('backup/drive/status')
  getDriveStatus() {
    return {
      configured: false,
      connected: false,
      folder: 'Tectobox Backups',
    };
  }

  @Post(['clients/:id/backup/drive/upload', 'backup/drive/upload'])
  uploadDrive() {
    return {
      ok: true,
      folder: 'Tectobox Backups',
      files: [{ name: 'tectonic-backup.json' }, { name: 'tectonic-backup.md' }],
    };
  }

  @Get(['clients/:id/backup/drive/list', 'backup/drive/list'])
  listDrive() {
    return {
      files: [],
    };
  }

  @Post('backup/drive/disconnect')
  disconnectDrive() {
    return {
      ok: true,
      connected: false,
    };
  }
}
