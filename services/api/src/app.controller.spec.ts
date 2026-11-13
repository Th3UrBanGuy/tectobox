import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ErrorTrackingService } from './common/errors/error-tracking.service.js';
import { BadRequestException, PayloadTooLargeException, UnauthorizedException } from '@nestjs/common';
import { TenantGuard } from './tenant/tenant.guard.js';

describe('AppController', () => {
  let appController: AppController;
  let tracker: ErrorTrackingService;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
    tracker = ErrorTrackingService.getInstance();
    tracker.clear();
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });

    it('should return health and watchdog status', () => {
      const health = appController.getHealth();
      expect(health.status).toBeDefined();
      expect(health.watchdogStatus).toBeDefined();
      expect(health.service).toBe('tectobox-core-api');
    });

    it('should return watchdog metrics', () => {
      const metrics = appController.getWatchdogMetrics();
      expect(metrics.requests).toBeDefined();
      expect(metrics.performance).toBeDefined();
    });
  });

  describe('M3 Diagnostics null-tenant exclusion', () => {
    it('non-admin diagnostics callers never see null-tenant errors', () => {
      tracker.track({
        method: 'GET',
        path: '/internal/sys',
        statusCode: 500,
        error: 'GlobalSystemFailure',
        message: 'DB unhandled deadlock',
        tenantId: null as any,
      });
      tracker.track({
        method: 'POST',
        path: '/api/cart',
        statusCode: 400,
        error: 'Tenant1Validation',
        message: 'Invalid item',
        tenantId: 1,
      });
      tracker.track({
        method: 'POST',
        path: '/api/cart',
        statusCode: 400,
        error: 'Tenant2Validation',
        message: 'Invalid item',
        tenantId: 2,
      });

      const reqClient = { user: { role: 'client', clientId: 1 } } as any;
      const res = appController.getDiagnosticsErrors(1, reqClient);

      expect(res.errors.length).toBe(1);
      expect(res.errors[0].error).toBe('Tenant1Validation');
      expect(res.errors.some((e: any) => e.error === 'GlobalSystemFailure')).toBe(false);
      expect(res.errors.some((e: any) => e.error === 'Tenant2Validation')).toBe(false);
    });

    it('admin diagnostics callers may see null-tenant errors', () => {
      tracker.track({
        method: 'GET',
        path: '/internal/sys',
        statusCode: 500,
        error: 'GlobalSystemFailure',
        message: 'DB unhandled deadlock',
        tenantId: null as any,
      });
      tracker.track({
        method: 'POST',
        path: '/api/orders',
        statusCode: 400,
        error: 'Tenant1Error',
        message: 'Bad order',
        tenantId: 1,
      });

      const reqAdmin = { user: { role: 'admin', clientId: null } } as any;
      const res = appController.getDiagnosticsErrors(1, reqAdmin);

      expect(res.errors.some((e: any) => e.error === 'GlobalSystemFailure')).toBe(true);
      expect(res.errors.some((e: any) => e.error === 'Tenant1Error')).toBe(true);
    });
  });

  describe('M4 Client Telemetry auth, tenant scoping & caps', () => {
    it('takes tenant from session, ignoring claimed tenant in body', () => {
      const req = {
        user: { role: 'client', clientId: 42 },
        headers: { 'user-agent': 'vitest-browser' },
        socket: { remoteAddress: '127.0.0.1' },
      } as any;

      const body = {
        error: 'ClientUIBug',
        message: 'Cannot render component',
        tenantId: 9999, // spoofed tenant
      };

      const res = appController.receiveClientTelemetry(body, req);
      expect(res.received).toBe(true);
      expect(res.id).toBeDefined();

      const errors = tracker.getRecentErrors(10, 42);
      expect(errors.length).toBe(1);
      expect(errors[0].tenantId).toBe(42);

      // Verify tenant 9999 got nothing
      const spoofedErrors = tracker.getRecentErrors(10, 9999);
      expect(spoofedErrors.length).toBe(0);
    });

    it('caps event count to maximum 50 events', () => {
      const req = {
        user: { role: 'client', clientId: 1 },
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      } as any;

      const events = Array.from({ length: 51 }, (_, i) => ({
        error: `Err_${i}`,
        message: `msg ${i}`,
      }));

      expect(() =>
        appController.receiveClientTelemetry(events, req)
      ).toThrow(BadRequestException);
    });

    it('caps payload size to 64KB', () => {
      const req = {
        user: { role: 'client', clientId: 1 },
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      } as any;

      const hugePayload = {
        error: 'HugeError',
        message: 'A'.repeat(70000),
      };

      expect(() =>
        appController.receiveClientTelemetry(hugePayload, req)
      ).toThrow(PayloadTooLargeException);
    });

    it('requires authentication via TenantGuard (401 without auth)', () => {
      const guard = new TenantGuard();
      const mockContextNoAuth = {
        switchToHttp: () => ({
          getRequest: () => ({ headers: {}, cookies: {} }),
        }),
      } as any;

      expect(() => guard.canActivate(mockContextNoAuth)).toThrow(UnauthorizedException);
    });
  });
});
