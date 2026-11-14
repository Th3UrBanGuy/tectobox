import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './database/database.module.js';
import { EventsModule } from './events/events.module.js';
import { AuthModule } from './auth/auth.module.js';
import { TenantModule } from './tenant/tenant.module.js';
import { InboxModule } from './inbox/inbox.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { LeadsModule } from './leads/leads.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { KnowledgeModule } from './knowledge/knowledge.module.js';
import { BroadcastsModule } from './broadcasts/broadcasts.module.js';
import { WidgetModule } from './widget/widget.module.js';
import { LicensingModule } from './licensing/licensing.module.js';
import { AdminModule } from './admin/admin.module.js';
import { ConnectorsModule } from './connectors/connectors.module.js';
import { MetaModule } from './meta/meta.module.js';
import { SseModule } from './sse/sse.module.js';
import { CourierModule } from './courier/courier.module.js';
import { BackupModule } from './backup/backup.module.js';
import { PaymentsModule } from './payments/payments.module.js';

@Module({
  imports: [
    DatabaseModule,
    EventsModule,
    AuthModule,
    TenantModule,
    InboxModule,
    CatalogModule,
    LeadsModule,
    OrdersModule,
    KnowledgeModule,
    BroadcastsModule,
    WidgetModule,
    LicensingModule,
    AdminModule,
    ConnectorsModule,
    MetaModule,
    SseModule,
    CourierModule,
    BackupModule,
    PaymentsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

