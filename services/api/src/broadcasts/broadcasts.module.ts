import { Module } from '@nestjs/common';
import { BroadcastsController } from './broadcasts.controller.js';
import { TenantModule } from '../tenant/tenant.module.js';

@Module({
  imports: [TenantModule],
  controllers: [BroadcastsController],
})
export class BroadcastsModule {}
