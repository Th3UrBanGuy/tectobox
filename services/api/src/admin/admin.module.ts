import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { TenantModule } from '../tenant/tenant.module.js';

@Module({
  imports: [TenantModule],
  controllers: [AdminController],
})
export class AdminModule {}
