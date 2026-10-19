import { Module } from '@nestjs/common';
import { TenantGuard } from './tenant.guard.js';

@Module({
  providers: [TenantGuard],
  exports: [TenantGuard],
})
export class TenantModule {}
