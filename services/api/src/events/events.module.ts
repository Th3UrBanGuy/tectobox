import { Global, Module } from '@nestjs/common';
import { EventsService } from './events.service.js';
import { LicensingModule } from '../licensing/licensing.module.js';

@Global()
@Module({
  imports: [LicensingModule],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
