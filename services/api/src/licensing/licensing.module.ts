import { Module } from '@nestjs/common';
import { LicensingController } from './licensing.controller.js';
import { TenantModule } from '../tenant/tenant.module.js';

@Module({
  imports: [TenantModule],
  controllers: [LicensingController],
})
export class LicensingModule {}
