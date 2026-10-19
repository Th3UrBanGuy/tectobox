import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller.js';
import { TenantModule } from '../tenant/tenant.module.js';

@Module({
  imports: [TenantModule],
  controllers: [CatalogController],
})
export class CatalogModule {}

