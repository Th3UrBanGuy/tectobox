import { Injectable, Logger } from '@nestjs/common';
import { ErrorTrackingService } from '../errors/error-tracking.service.js';

export interface EndpointStat {
  hits: number;
  lastHit: string;
  totalDurationMs: number;
  avgDurationMs: number;
  errors: number;
}

export interface SlowRequestRecord {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  durationMs: number;
  statusCode: number;
}

export interface WatchdogMetrics {
  uptimeSec: number;
  status: 'HEALTHY' | 'DEGRADED' | 'CRITICAL';
  requests: {
    total: number;
    active: number;
    rates: {
      lastMinute: number;
      rpm: number;
    };
    statusDistribution: {
      '2xx': number;
      '3xx': number;
      '4xx': number;
      '5xx': number;
    };
  };
  performance: {
    avgLatencyMs: number;
    p95LatencyMs: number;
    maxLatencyMs: number;
  };
  memory: {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
  };
  endpoints: Record<string, EndpointStat>;
  alerts: string[];
  recentSlowRequests: SlowRequestRecord[];
  recentErrorsCount: number;
}

@Injectable()
export class WatchdogService {
  private static instance: WatchdogService;
  private readonly logger = new Logger('Watchdog');
  private readonly startTime = Date.now();

  private totalRequests = 0;
  private activeRequests = 0;
  private status2xx = 0;
  private status3xx = 0;
  private status4xx = 0;
  private status5xx = 0;

  private totalDurationMs = 0;
  private maxLatencyMs = 0;
  private recentLatencies: number[] = [];
  private readonly maxLatencySamples = 200;

  // Rolling request timestamps for RPM calculation
  private requestTimestamps: number[] = [];

  private endpointStats = new Map<string, EndpointStat>();
  private recentSlowRequests: SlowRequestRecord[] = [];
  private readonly maxSlowRequests = 30;

  constructor() {
    WatchdogService.instance = this;
    this.logger.log('[Watchdog] Traffic & Telemetry Watchdog Service initialized.');
  }

  static getInstance(): WatchdogService {
    if (!WatchdogService.instance) {
      WatchdogService.instance = new WatchdogService();
    }
    return WatchdogService.instance;
  }

  startRequest(): () => number {
    this.activeRequests++;
    const start = process.hrtime();
    return () => {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      const diff = process.hrtime(start);
      return Math.round((diff[0] * 1e9 + diff[1]) / 1e6); // duration in ms
    };
  }

  recordRequest(method: string, rawPath: string, statusCode: number, durationMs: number) {
    const now = Date.now();
    this.totalRequests++;

    // Track status distribution
    if (statusCode >= 200 && statusCode < 300) this.status2xx++;
    else if (statusCode >= 300 && statusCode < 400) this.status3xx++;
    else if (statusCode >= 400 && statusCode < 500) this.status4xx++;
    else if (statusCode >= 500) this.status5xx++;

    // Rolling RPM
    this.requestTimestamps.push(now);
    const oneMinuteAgo = now - 60000;
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] < oneMinuteAgo) {
      this.requestTimestamps.shift();
    }

    // Latency
    this.totalDurationMs += durationMs;
    if (durationMs > this.maxLatencyMs) {
      this.maxLatencyMs = durationMs;
    }
    this.recentLatencies.push(durationMs);
    if (this.recentLatencies.length > this.maxLatencySamples) {
      this.recentLatencies.shift();
    }

    // Endpoint aggregation (normalize numeric IDs and UUIDs to :id)
    const normalizedRoute = this.normalizeRoute(rawPath);
    let stat = this.endpointStats.get(normalizedRoute);
    if (!stat) {
      stat = {
        hits: 0,
        lastHit: new Date(now).toISOString(),
        totalDurationMs: 0,
        avgDurationMs: 0,
        errors: 0,
      };
      this.endpointStats.set(normalizedRoute, stat);
    }
    stat.hits++;
    stat.lastHit = new Date(now).toISOString();
    stat.totalDurationMs += durationMs;
    stat.avgDurationMs = Math.round(stat.totalDurationMs / stat.hits);
    if (statusCode >= 400) {
      stat.errors++;
    }

    // Slow / 5xx request anomaly log
    if (durationMs >= 1000 || statusCode >= 500) {
      this.recentSlowRequests.unshift({
        id: `slow_${now}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date(now).toISOString(),
        method,
        path: rawPath,
        durationMs,
        statusCode,
      });
      if (this.recentSlowRequests.length > this.maxSlowRequests) {
        this.recentSlowRequests.pop();
      }
    }
  }

  recordClientTelemetry(payload: {
    error: string;
    message: string;
    url?: string;
    line?: number;
    col?: number;
    stack?: string;
    userAgent?: string;
    tenantId?: number;
    ip?: string;
  }) {
    const errorTracker = ErrorTrackingService.getInstance();
    return errorTracker.track({
      method: 'CLIENT',
      path: payload.url || 'browser-window',
      statusCode: 499, // Client-originated exception marker
      error: payload.error || 'ClientRuntimeError',
      message: payload.message || 'Unhandled client-side exception',
      tenantId: payload.tenantId || null,
      userAgent: payload.userAgent,
      ip: payload.ip,
      stackSnippet: payload.stack
        ? payload.stack.split('\n').slice(0, 5).join('\n')
        : `at ${payload.url}:${payload.line}:${payload.col}`,
      source: 'frontend',
    });
  }

  getMetrics(): WatchdogMetrics {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] < oneMinuteAgo) {
      this.requestTimestamps.shift();
    }
    const rpm = this.requestTimestamps.length;

    const avgLatencyMs =
      this.totalRequests > 0 ? Math.round(this.totalDurationMs / this.totalRequests) : 0;

    let p95LatencyMs = 0;
    if (this.recentLatencies.length > 0) {
      const sorted = [...this.recentLatencies].sort((a, b) => a - b);
      const idx = Math.floor(sorted.length * 0.95);
      p95LatencyMs = sorted[Math.min(idx, sorted.length - 1)];
    }

    const mem = process.memoryUsage();
    const rssMb = Math.round(mem.rss / 1024 / 1024);
    const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotalMb = Math.round(mem.heapTotal / 1024 / 1024);

    const alerts: string[] = [];
    const errorRate =
      this.totalRequests > 0 ? (this.status5xx / this.totalRequests) * 100 : 0;

    if (errorRate > 20) {
      alerts.push(`CRITICAL: 5xx error rate is elevated at ${errorRate.toFixed(1)}%`);
    } else if (errorRate > 5) {
      alerts.push(`WARNING: 5xx error rate is above threshold at ${errorRate.toFixed(1)}%`);
    }

    if (avgLatencyMs > 1500) {
      alerts.push(`WARNING: Average API latency is degraded at ${avgLatencyMs}ms`);
    }

    if (rssMb > 500) {
      alerts.push(`WARNING: High server memory footprint (${rssMb}MB RSS)`);
    }

    let status: 'HEALTHY' | 'DEGRADED' | 'CRITICAL' = 'HEALTHY';
    if (errorRate > 20) {
      status = 'CRITICAL';
    } else if (errorRate > 5 || avgLatencyMs > 1500 || rssMb > 500) {
      status = 'DEGRADED';
    }

    const errorTracker = ErrorTrackingService.getInstance();
    const recentErrorsCount = errorTracker.getRecentErrors(100).length;

    // Convert map to plain object
    const endpoints: Record<string, EndpointStat> = {};
    for (const [route, stat] of this.endpointStats.entries()) {
      endpoints[route] = stat;
    }

    return {
      uptimeSec: Math.round((now - this.startTime) / 1000),
      status,
      requests: {
        total: this.totalRequests,
        active: this.activeRequests,
        rates: {
          lastMinute: rpm,
          rpm,
        },
        statusDistribution: {
          '2xx': this.status2xx,
          '3xx': this.status3xx,
          '4xx': this.status4xx,
          '5xx': this.status5xx,
        },
      },
      performance: {
        avgLatencyMs,
        p95LatencyMs,
        maxLatencyMs: this.maxLatencyMs,
      },
      memory: {
        rssMb,
        heapUsedMb,
        heapTotalMb,
      },
      endpoints,
      alerts,
      recentSlowRequests: this.recentSlowRequests,
      recentErrorsCount,
    };
  }

  private normalizeRoute(rawPath: string): string {
    const clean = rawPath.split('?')[0];
    return clean
      .replace(/\/[0-9]+(?=\/|$)/g, '/:id')
      .replace(
        /\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?=\/|$)/g,
        '/:uuid',
      );
  }
}
