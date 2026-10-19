import { Module } from '@nestjs/common';
import { ConnectorsController } from './connectors.controller.js';
import { TenantModule } from '../tenant/tenant.module.js';

@Module({
  imports: [TenantModule],
  controllers: [ConnectorsController],
})
export class ConnectorsModule {}
