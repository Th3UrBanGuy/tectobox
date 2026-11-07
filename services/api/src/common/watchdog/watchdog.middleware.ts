import type { Request, Response, NextFunction } from 'express';
import { WatchdogService } from './watchdog.service.js';

export function watchdogMiddleware(req: Request, res: Response, next: NextFunction) {
  // Only monitor API routes; bypass static files and health checks if desired, but monitor /api/
  if (!req.path.startsWith('/api')) {
    return next();
  }

  const watchdog = WatchdogService.getInstance();
  const endTimer = watchdog.startRequest();

  res.on('finish', () => {
    const durationMs = endTimer();
    watchdog.recordRequest(req.method, req.path, res.statusCode, durationMs);
  });

  next();
}
