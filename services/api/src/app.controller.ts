import { Controller, Get, Post, Body, Req, UseGuards, Query } from '@nestjs/common';
import type { Request } from 'express';
import { AppService } from './app.service.js';
import { TenantGuard } from './tenant/tenant.guard.js';
import { CurrentTenant } from './tenant/current-tenant.decorator.js';
import { ErrorTrackingService } from './common/errors/error-tracking.service.js';
import { WatchdogService } from './common/watchdog/watchdog.service.js';

@Controller()
export class AppController {
  private readonly tracker = ErrorTrackingService.getInstance();
  private readonly watchdog = WatchdogService.getInstance();

  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get(['healthz', 'api/healthz'])
  getHealth() {
    const watchdogMetrics = this.watchdog.getMetrics();
    return {
      status: watchdogMetrics.status === 'CRITICAL' ? 'degraded' : 'healthy',
      watchdogStatus: watchdogMetrics.status,
      timestamp: new Date().toISOString(),
      service: 'tectobox-core-api',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      activeRequests: watchdogMetrics.requests.active,
      totalRequests: watchdogMetrics.requests.total,
      rpm: watchdogMetrics.requests.rates.rpm,
      avgLatencyMs: watchdogMetrics.performance.avgLatencyMs,
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

  // Diagnostic error tracking endpoint for real-time observability
  @Get('api/diagnostics/errors')
  @UseGuards(TenantGuard)
  getDiagnosticsErrors(
    @CurrentTenant() tenantId: number,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    return {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      errors: this.tracker.getRecentErrors(parsedLimit, tenantId),
    };
  }

  // Watchdog live metrics & traffic stats endpoint
  @Get('api/diagnostics/watchdog')
  @UseGuards(TenantGuard)
  getWatchdogMetrics() {
    return {
      timestamp: new Date().toISOString(),
      ...this.watchdog.getMetrics(),
    };
  }

  // Client telemetry receiver: browser errors sent via beacon or fetch
  @Post('api/diagnostics/client-telemetry')
  receiveClientTelemetry(
    @Body() body: any,
    @Req() req: Request,
  ) {
    const tenantId = (req as any).user?.clientId || (req as any).tenantId || body?.tenantId || null;
    const ip = (req.headers['x-forwarded-for'] as string) || req.socket?.remoteAddress || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || body?.userAgent;

    const record = this.watchdog.recordClientTelemetry({
      error: body?.error || 'ClientError',
      message: body?.message || 'Unknown browser error',
      url: body?.url,
      line: body?.line,
      col: body?.col,
      stack: body?.stack,
      userAgent,
      tenantId,
      ip,
    });

    return { received: true, id: record.id };
  }
}
