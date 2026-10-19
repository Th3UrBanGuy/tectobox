import { Module } from '@nestjs/common';
import { InboxController } from './inbox.controller.js';
import { TenantModule } from '../tenant/tenant.module.js';

@Module({
  imports: [TenantModule],
  controllers: [InboxController],
})
export class InboxModule {}

