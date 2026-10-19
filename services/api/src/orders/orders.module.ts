import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller.js';
import { TenantModule } from '../tenant/tenant.module.js';

@Module({
  imports: [TenantModule],
  controllers: [OrdersController],
})
export class OrdersModule {}
