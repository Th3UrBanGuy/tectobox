import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Inject, Optional } from '@nestjs/common';
import { Observable } from 'rxjs';
import { LicensingService } from './licensing.service.js';

/**
 * LicensingInterceptor — resolves the caller's licence ONCE per request and
 * puts it on the request object, so controllers/handlers can read
 * `request.access` / `request.features` without re-querying. Guards cannot
 * use it (guards run before interceptors in NestJS) — RequireFeature
 * resolves the access itself via LicensingService.
 *
 * Runs after TenantGuard (guards run before interceptors), so
 * `request.tenantId` and `request.user` are already set. Skipped when:
 * - there is no tenant (public routes, login, widget-by-key),
 * - the caller is a platform admin (admins bypass feature gates anyway).
 */
@Injectable()
export class LicensingInterceptor implements NestInterceptor {
  constructor(
    @Optional() @Inject(LicensingService) private readonly licensing?: LicensingService
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const tenantId = request.tenantId;
    const user = request.user;
    if (
      this.licensing &&
      tenantId &&
      user?.role !== 'admin' &&
      user?.role !== 'superadmin'
    ) {
      const access = await this.licensing.resolveAccess(Number(tenantId));
      request.access = access;
      request.features = access.features;
    }
    return next.handle();
  }
}
