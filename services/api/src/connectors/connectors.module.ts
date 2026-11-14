import { Module } from '@nestjs/common';
import { ChannelsController } from './channels.controller.js';
import { WebchatConfigController } from './webchat-config.controller.js';
import { ChannelConnectController } from './channel-connect.controller.js';
import { DeveloperController } from './developer.controller.js';
import { CommentsController } from './comments.controller.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { LicensingModule } from '../licensing/licensing.module.js';

/**
 * Connectors module (Phase 3 of the modular restructure). The old
 * 780-line `ConnectorsController` is split into five focused
 * controllers; the Meta OAuth routes moved to `MetaModule`.
 */
@Module({
  imports: [TenantModule, LicensingModule],
  controllers: [
    ChannelsController,
    WebchatConfigController,
    ChannelConnectController,
    DeveloperController,
    CommentsController,
  ],
})
export class ConnectorsModule {}
