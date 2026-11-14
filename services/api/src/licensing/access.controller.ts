import { Controller, Get, Param, Req, UseGuards, Inject } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { LicensingService } from './licensing.service.js';
import { toAccessResponse } from './access-response.js';

/**
 * The single licence read path.
 *
 * Split out of `LicensingController` (Phase 3 of the modular
 * restructure). Method moved verbatim; no behaviour change. Delegates
 * to LicensingService: no auto-provision, no legacy full-access
 * fallbacks. A workspace without an active licence gets mode 'none'
 * (features []), a suspended one gets mode 'suspended'.
 */
@Controller('api')
@UseGuards(TenantGuard)
export class AccessController {
  constructor(
    @Inject(LicensingService) private readonly licensing: LicensingService
  ) {}

  @Get(['client/access', 'admin/clients/:id/access'])
  async getClientAccess(@CurrentTenant() tenantId: number, @Param('id') paramId?: string, @Req() req?: any) {
    // C2/C3 rule: only an admin may address another workspace via :id.
    // A non-admin's :id is ignored and their own tenant is used instead.
    const isAdmin = req?.user?.role === 'admin' || req?.user?.role === 'superadmin';
    const targetTenantId = isAdmin && paramId ? Number(paramId) : tenantId;
    if (!targetTenantId) {
      return {
        active: false,
        mode: 'none',
        licenseId: null,
        code: null,
        features: [],
        creditsTotal: 0,
        creditsUsed: 0,
        license: null,
        aiAllowed: false,
        aiReason: 'no_active_license',
        suspended: false,
        aiPaused: false,
      };
    }
    const access = await this.licensing.resolveAccess(targetTenantId);
    return toAccessResponse(access);
  }
}
