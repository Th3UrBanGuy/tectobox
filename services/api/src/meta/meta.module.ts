import { Module } from '@nestjs/common';
import { MetaOAuthController } from './meta-oauth.controller.js';

/**
 * Meta module (Phase 3 of the modular restructure). `meta/` used to
 * hold only the OAuth state manager with no module file; the OAuth
 * controller moved here from `ConnectorsController`. `DB_POOL` is
 * global and `EventsService` comes from the global `EventsModule`,
 * so this module needs no imports of its own.
 */
@Module({
  controllers: [MetaOAuthController],
})
export class MetaModule {}
