import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PlansController } from './plans.controller.js';
import { LicensesController } from './licenses.controller.js';
import { AccessController } from './access.controller.js';
import { LicensingService } from './licensing.service.js';
import { LicensingInterceptor } from './licensing.interceptor.js';
import { TenantModule } from '../tenant/tenant.module.js';

@Module({
  imports: [TenantModule],
  controllers: [PlansController, LicensesController, AccessController],
  providers: [
    LicensingService,
    { provide: APP_INTERCEPTOR, useClass: LicensingInterceptor },
  ],
  exports: [LicensingService],
})
export class LicensingModule {}
