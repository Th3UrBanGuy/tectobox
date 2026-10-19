import { Module } from '@nestjs/common';
import { SseController } from './sse.controller.js';
import { TenantGuard } from '../tenant/tenant.guard.js';

@Module({
  controllers: [SseController],
  providers: [TenantGuard],
})
export class SseModule {}
