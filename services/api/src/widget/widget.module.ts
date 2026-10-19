import { Module } from '@nestjs/common';
import { WidgetController } from './widget.controller.js';

@Module({
  controllers: [WidgetController],
})
export class WidgetModule {}
