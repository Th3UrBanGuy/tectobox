import { CanActivate, ExecutionContext, Injectable, Inject, Optional, ForbiddenException, mixin, Type } from '@nestjs/common';
import { LicensingService } from './licensing.service.js';

/**
 * RequireFeature('knowledge') — method decorator factory returning a guard
 * that denies (403) when the caller's active licence does not include the
 * feature. Platform admins bypass. Apply only to writes / sends / creates;
 * reads stay open.
 *
 * ORDERING GOTCHA: NestJS runs guards BEFORE interceptors, so the guard
 * cannot read `request.access` (populated by LicensingInterceptor, which
 * runs later). It resolves the access itself via LicensingService — one
 * extra DB round trip per guarded write, which is acceptable for non-hot
 * paths. `request.access` is still honoured when present (defensive).
 */
export function RequireFeature(featureName: string): Type<CanActivate> {
  @Injectable()
  class FeatureGuardMixin implements CanActivate {
    constructor(
      @Optional() @Inject(LicensingService) private readonly licensing?: LicensingService
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const request = context.switchToHttp().getRequest();
      const user = request.user;
      // Platform admins bypass feature gates (they manage licences, they
      // do not consume them).
      if (user && (user.role === 'admin' || user.role === 'superadmin')) {
        return true;
      }
      const tenantId = request.tenantId;
      if (!tenantId) {
        throw new ForbiddenException('No tenant workspace associated with this user');
      }
      // Prefer the interceptor-populated access when present; otherwise
      // resolve it here (the normal case at guard time).
      const access = request.access ?? (this.licensing
        ? await this.licensing.resolveAccess(Number(tenantId))
        : null);
      if (!access || !access.features.includes(featureName)) {
        throw new ForbiddenException(
          `This feature is not included in your current licence`
        );
      }
      return true;
    }
  }

  return mixin(FeatureGuardMixin);
}
