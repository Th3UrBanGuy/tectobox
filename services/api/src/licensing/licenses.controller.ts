import { Controller, Get, Post, Body, Param, Req, UseGuards, Inject, ParseIntPipe, Optional } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import pg from 'pg';
import { DB_POOL } from '../database/database.module.js';
import { LicensingService } from './licensing.service.js';
import { EventsService } from '../events/events.service.js';
import { IssueLicenseDto, ActivateLicenseDto } from './dto/licensing.dto.js';
import { LicenseIssuanceService } from './license-issuance.service.js';
import { LicenseActivationService } from './license-activation.service.js';

/**
 * Licence list / issue / activate / pause / resume / cancel / top-up.
 *
 * Split out of `LicensingController` (Phase 3 of the modular
 * restructure). Issue and activation delegate to the focused services;
 * the lifecycle methods stay inline, moved verbatim. The class-level
 * TenantGuard and the method-level AdminGuard on the admin routes are
 * preserved; `activateLicense` stays tenant-guarded but NOT admin-only
 * (client self-service).
 */
@Controller('api')
@UseGuards(TenantGuard)
export class LicensesController {
  private readonly issuance: LicenseIssuanceService;
  private readonly activation: LicenseActivationService;

  constructor(
    @Inject(DB_POOL) private readonly pool: pg.Pool,
    @Inject(LicensingService) private readonly licensing: LicensingService,
    @Optional() private readonly eventsService?: EventsService
  ) {
    this.issuance = new LicenseIssuanceService(pool, licensing, eventsService);
    this.activation = new LicenseActivationService(pool, licensing);
  }

  @Get('admin/licenses')
  @UseGuards(AdminGuard)
  async listLicenses() {
    const result = await this.pool.query(
      `SELECT l.*, c.name as client_name, p.name as plan_name
       FROM licenses l
       LEFT JOIN clients c ON c.id = l.client_id
       LEFT JOIN plans p ON p.id = l.plan_id
       ORDER BY l.id DESC LIMIT 100`
    );
    return result.rows;
  }

  @Post('admin/licenses')
  @UseGuards(AdminGuard)
  async issueLicense(@Body() body: IssueLicenseDto, @Req() req?: any) {
    return this.issuance.issueLicense(body, req);
  }

  @Post('client/licenses/activate')
  async activateLicense(
    @CurrentTenant() tenantId: number,
    @Body() body: ActivateLicenseDto,
    @Req() req?: any
  ) {
    return this.activation.activateLicense(tenantId, body, req);
  }

  @Post('admin/licenses/:id/pause')
  @UseGuards(AdminGuard)
  async pauseLicense(@Param('id', ParseIntPipe) id: number, @Req() req?: any) {
    const res = await this.pool.query(
      "UPDATE licenses SET status = 'paused' WHERE id = $1 RETURNING *",
      [id]
    );
    const row = res.rows[0];
    if (row) {
      await this.licensing.audit('pause', req?.user?.username ?? null, row.client_id, row.id, row.code, null);
    }
    return row;
  }

  @Post('admin/licenses/:id/resume')
  @UseGuards(AdminGuard)
  async resumeLicense(@Param('id', ParseIntPipe) id: number, @Req() req?: any) {
    const res = await this.pool.query(
      "UPDATE licenses SET status = 'active' WHERE id = $1 RETURNING *",
      [id]
    );
    const row = res.rows[0];
    if (row) {
      await this.licensing.audit('resume', req?.user?.username ?? null, row.client_id, row.id, row.code, null);
    }
    return row;
  }

  @Post('admin/licenses/:id/cancel')
  @UseGuards(AdminGuard)
  async cancelLicense(@Param('id', ParseIntPipe) id: number, @Req() req?: any) {
    const res = await this.pool.query(
      "UPDATE licenses SET status = 'cancelled' WHERE id = $1 RETURNING *",
      [id]
    );
    const row = res.rows[0];
    if (row) {
      await this.licensing.audit('cancel', req?.user?.username ?? null, row.client_id, row.id, row.code, null);
    }
    return row;
  }

  @Post(['admin/licenses/:id/topup', 'admin/licenses/:id/topup-feature'])
  @UseGuards(AdminGuard)
  async topupLicense(@Param('id', ParseIntPipe) id: number, @Body() body: { credits: number }, @Req() req?: any) {
    const res = await this.pool.query(
      'UPDATE licenses SET credits_total = credits_total + $1 WHERE id = $2 RETURNING *',
      [body.credits || 0, id]
    );
    const row = res.rows[0];
    if (row) {
      await this.licensing.audit(
        'topup',
        req?.user?.username ?? null,
        row.client_id,
        row.id,
        row.code,
        `+${body.credits || 0} credits`
      );
    }
    return row;
  }
}
