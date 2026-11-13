import { Controller, Get, Post, Body, Req, UseGuards, Query, BadRequestException, PayloadTooLargeException } from '@nestjs/common';
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
    @Req() req: Request,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    const user = (req as any)?.user;
    const isAdmin = Boolean(user && (user.role === 'admin' || user.role === 'superadmin'));
    return {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      errors: this.tracker.getRecentErrors(parsedLimit, tenantId, isAdmin),
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
  @UseGuards(TenantGuard)
  receiveClientTelemetry(
    @Body() body: any,
    @Req() req: Request,
  ) {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException('Invalid telemetry payload');
    }

    const rawStr = JSON.stringify(body);
    if (rawStr.length > 65536) {
      throw new PayloadTooLargeException('Telemetry payload exceeds maximum allowed size of 64KB');
    }

    if (Array.isArray(body) && body.length > 50) {
      throw new BadRequestException('Telemetry event count exceeds limit of 50');
    }
    if (Array.isArray(body.events) && body.events.length > 50) {
      throw new BadRequestException('Telemetry event count exceeds limit of 50');
    }

    const user = (req as any).user;
    const tenantId = user?.clientId ?? (req as any).tenantId ?? null;
    const ip = (req.headers['x-forwarded-for'] as string) || req.socket?.remoteAddress || '127.0.0.1';
    const userAgent = (req.headers['user-agent'] as string) || body?.userAgent;

    const events = Array.isArray(body) ? body : (Array.isArray(body.events) ? body.events : [body]);
    let lastRecordId = '';
    for (const evt of events.slice(0, 50)) {
      const record = this.watchdog.recordClientTelemetry({
        error: String(evt?.error || 'ClientError').slice(0, 200),
        message: String(evt?.message || 'Unknown browser error').slice(0, 1000),
        url: evt?.url ? String(evt.url).slice(0, 500) : undefined,
        line: typeof evt?.line === 'number' ? evt.line : undefined,
        col: typeof evt?.col === 'number' ? evt.col : undefined,
        stack: evt?.stack ? String(evt.stack).slice(0, 4000) : undefined,
        userAgent: userAgent ? String(userAgent).slice(0, 500) : undefined,
        tenantId,
        ip,
      });
      lastRecordId = record.id;
    }

    return { received: true, id: lastRecordId };
  }
}
