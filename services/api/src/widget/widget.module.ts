import { Module } from '@nestjs/common';
import { WidgetController } from './widget.controller.js';
import { LicensingModule } from '../licensing/licensing.module.js';

@Module({
  imports: [LicensingModule],
  controllers: [WidgetController],
})
export class WidgetModule {}
