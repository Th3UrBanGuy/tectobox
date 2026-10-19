import { Module } from '@nestjs/common';
import { LeadsController } from './leads.controller.js';
import { TenantModule } from '../tenant/tenant.module.js';

@Module({
  imports: [TenantModule],
  controllers: [LeadsController],
})
export class LeadsModule {}
