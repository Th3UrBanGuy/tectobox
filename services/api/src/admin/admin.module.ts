import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller.js';
import { AiKeysController } from './ai-keys.controller.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { LicensingModule } from '../licensing/licensing.module.js';

@Module({
  imports: [TenantModule, LicensingModule],
  controllers: [AdminController, AiKeysController],
})
export class AdminModule {}
