import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
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

    it('should receive client telemetry', () => {
      const res = appController.receiveClientTelemetry(
        { error: 'TestErr', message: 'Client UI glitch' },
        { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as any,
      );
      expect(res.received).toBe(true);
      expect(res.id).toBeDefined();
    });
  });
});
