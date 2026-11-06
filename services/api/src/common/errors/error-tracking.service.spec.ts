import { describe, it, expect, beforeEach } from 'vitest';
import { ErrorTrackingService } from './error-tracking.service.js';

describe('ErrorTrackingService', () => {
  let tracker: ErrorTrackingService;

  beforeEach(() => {
    tracker = ErrorTrackingService.getInstance();
    tracker.clear();
  });

  it('tracks runtime error records correctly', () => {
    const err = tracker.track({
      method: 'POST',
      path: '/api/test',
      statusCode: 500,
      error: 'TestError',
      message: 'Something broke',
      tenantId: 1,
    });

    expect(err.id).toBeDefined();
    expect(err.statusCode).toBe(500);

    const recent = tracker.getRecentErrors(10);
    expect(recent.length).toBe(1);
    expect(recent[0].error).toBe('TestError');
  });

  it('filters error records by tenantId', () => {
    tracker.track({
      method: 'GET',
      path: '/api/a',
      statusCode: 400,
      error: 'ErrA',
      message: 'msgA',
      tenantId: 1,
    });
    tracker.track({
      method: 'GET',
      path: '/api/b',
      statusCode: 400,
      error: 'ErrB',
      message: 'msgB',
      tenantId: 2,
    });

    const tenant1Errors = tracker.getRecentErrors(10, 1);
    expect(tenant1Errors.length).toBe(1);
    expect(tenant1Errors[0].error).toBe('ErrA');
  });
});
