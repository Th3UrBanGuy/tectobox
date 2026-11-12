import { Module } from '@nestjs/common';
import { ConnectorsController } from './connectors.controller.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { LicensingModule } from '../licensing/licensing.module.js';

@Module({
  imports: [TenantModule, LicensingModule],
  controllers: [ConnectorsController],
})
export class ConnectorsModule {}
