import { Module } from '@nestjs/common';
import { CourierController } from './courier.controller.js';
import { DatabaseModule } from '../database/database.module.js';

@Module({
  imports: [DatabaseModule],
  controllers: [CourierController],
})
export class CourierModule {}
