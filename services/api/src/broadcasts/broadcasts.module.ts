import { Module } from '@nestjs/common';
import { BroadcastsController } from './broadcasts.controller.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { LicensingModule } from '../licensing/licensing.module.js';

@Module({
  imports: [TenantModule, LicensingModule],
  controllers: [BroadcastsController],
})
export class BroadcastsModule {}
