import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { TenantModule } from '../tenant/tenant.module.js';

@Module({
  imports: [TenantModule],
  controllers: [AuthController],
})
export class AuthModule {}

