import { describe, it, expect, beforeEach } from 'vitest';
import { WatchdogService } from './watchdog.service.js';

describe('WatchdogService', () => {
  let watchdog: WatchdogService;

  beforeEach(() => {
    watchdog = WatchdogService.getInstance();
  });

  it('tracks requests and computes metrics properly', () => {
    const end = watchdog.startRequest();
    // Simulate some work
    const duration = end();
    expect(duration).toBeGreaterThanOrEqual(0);

    watchdog.recordRequest('GET', '/api/chats', 200, 15);
    watchdog.recordRequest('POST', '/api/messages', 201, 25);
    watchdog.recordRequest('GET', '/api/chats/99', 404, 8);

    const metrics = watchdog.getMetrics();
    expect(metrics.requests.total).toBeGreaterThanOrEqual(3);
    expect(metrics.requests.statusDistribution['2xx']).toBeGreaterThanOrEqual(2);
    expect(metrics.requests.statusDistribution['4xx']).toBeGreaterThanOrEqual(1);
    expect(metrics.status).toBe('HEALTHY');
    expect(metrics.endpoints['/api/chats']).toBeDefined();
    expect(metrics.endpoints['/api/chats/:id']).toBeDefined();
  });

  it('records client telemetry into the system buffer', () => {
    const record = watchdog.recordClientTelemetry({
      error: 'TypeError',
      message: 'Cannot read properties of undefined',
      url: 'https://box.tect0nic.com/app.js',
      line: 42,
      col: 10,
    });

    expect(record.id).toBeDefined();
    expect(record.source).toBe('frontend');
    expect(record.statusCode).toBe(499);
  });
});
