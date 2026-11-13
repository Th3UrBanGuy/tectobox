import { Injectable, Logger } from '@nestjs/common';

export interface TrackedErrorRecord {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  statusCode: number;
  error: string;
  message: string;
  tenantId?: number | null;
  userAgent?: string;
  ip?: string;
  stackSnippet?: string;
  source?: 'backend' | 'frontend' | 'watchdog';
}

@Injectable()
export class ErrorTrackingService {
  private static instance: ErrorTrackingService;
  private readonly logger = new Logger('ErrorTracker');
  private readonly buffer: TrackedErrorRecord[] = [];
  private readonly maxBufferSize = 100;

  constructor() {
    ErrorTrackingService.instance = this;
    if (process.env.SENTRY_DSN) {
      this.logger.log(`[ErrorTracker] Sentry DSN detected, telemetry forwarder initialized.`);
    }
  }

  static getInstance(): ErrorTrackingService {
    if (!ErrorTrackingService.instance) {
      ErrorTrackingService.instance = new ErrorTrackingService();
    }
    return ErrorTrackingService.instance;
  }

  track(entry: Omit<TrackedErrorRecord, 'id' | 'timestamp'>): TrackedErrorRecord {
    const record: TrackedErrorRecord = {
      id: `err_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };

    this.buffer.unshift(record);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.pop();
    }

    // Optional Sentry HTTP capture without heavy external bundle
    if (process.env.SENTRY_DSN) {
      this.forwardToSentry(record).catch(() => {});
    }

    return record;
  }

  getRecentErrors(limit = 50, tenantId?: number, includeNullTenant?: boolean): TrackedErrorRecord[] {
    const allowSystem = includeNullTenant ?? (tenantId === undefined);
    const filtered = tenantId
      ? this.buffer.filter((e) => (allowSystem && !e.tenantId) || e.tenantId === tenantId)
      : (allowSystem ? this.buffer : this.buffer.filter((e) => e.tenantId != null));
    return filtered.slice(0, Math.min(limit, this.maxBufferSize));
  }

  clear() {
    this.buffer.length = 0;
  }

  private async forwardToSentry(record: TrackedErrorRecord) {
    try {
      const dsn = process.env.SENTRY_DSN;
      if (!dsn) return;
      const url = new URL(dsn);
      const projectId = url.pathname.replace('/', '');
      const sentryHost = url.hostname;
      const key = url.username;

      const body = {
        event_id: record.id.replace('err_', ''),
        timestamp: record.timestamp,
        level: record.statusCode >= 500 ? 'error' : 'warning',
        logger: 'tectobox-api',
        platform: 'node',
        request: {
          url: record.path,
          method: record.method,
        },
        tags: {
          tenantId: record.tenantId ?? 'none',
          status: record.statusCode,
        },
        message: `${record.error}: ${record.message}`,
        extra: {
          stack: record.stackSnippet,
        },
      };

      await fetch(`https://${sentryHost}/api/${projectId}/store/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=tectobox/1.0, sentry_key=${key}`,
        },
        body: JSON.stringify(body),
      });
    } catch {
      // Sentry delivery failure should never crash the process
    }
  }
}
