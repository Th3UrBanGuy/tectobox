import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller.js';
import { TenantModule } from '../tenant/tenant.module.js';

@Module({
  imports: [TenantModule],
  controllers: [KnowledgeController],
})
export class KnowledgeModule {}
