import { Controller, Get, UseGuards } from '@nestjs/common';
import { AppService } from './app.service.js';
import { TenantGuard } from './tenant/tenant.guard.js';
import { CurrentTenant } from './tenant/current-tenant.decorator.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get(['healthz', 'api/healthz'])
  getHealth() {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      service: 'tectobox-core-api',
      uptime: process.uptime(),
    };
  }

  // RC7: moved from AdminController — any logged-in tenant user may read
  // their own workspace status. AdminGuard previously returned 403 for
  // client users. Payload unchanged.
  @Get('api/status')
  @UseGuards(TenantGuard)
  getStatus(@CurrentTenant() tenantId: number) {
    const metaToken = Boolean(process.env.META_PAGE_ACCESS_TOKEN);
    const tgToken = Boolean(process.env.TELEGRAM_BOT_TOKEN);

    return {
      status: 'healthy',
      ok: true,
      platforms: {
        whatsapp: { mode: 'live', note: 'Baileys worker active' },
        telegram: { mode: tgToken ? 'live' : 'demo', note: tgToken ? 'Bot token configured' : 'Add token' },
        messenger: { mode: metaToken ? 'live' : 'demo', note: metaToken ? 'Meta token present' : 'Connect Facebook Page' },
        instagram: { mode: metaToken ? 'live' : 'demo', note: metaToken ? 'Meta token present' : 'Connect Instagram' },
      },
    };
  }

  // RC7: Web Push VAPID public key. No VAPID key is configured, so this
  // honestly returns key: null (frontend treats that as push unavailable).
  // Set VAPID_PUBLIC_KEY (+ VAPID_PRIVATE_KEY for sending) to enable push.
  @Get('api/push/vapid-key')
  @UseGuards(TenantGuard)
  getVapidKey() {
    const key = process.env.VAPID_PUBLIC_KEY || null;
    return { key, configured: Boolean(key) };
  }
}
