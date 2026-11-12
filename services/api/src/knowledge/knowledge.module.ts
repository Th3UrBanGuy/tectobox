import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { LicensingModule } from '../licensing/licensing.module.js';

@Module({
  imports: [TenantModule, LicensingModule],
  controllers: [KnowledgeController],
})
export class KnowledgeModule {}
