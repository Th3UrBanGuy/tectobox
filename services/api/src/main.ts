import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { StructuredLogger } from './common/logger/logger.service.js';

async function bootstrap() {
  const logger = new StructuredLogger();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger,
  });
  app.enableShutdownHooks();
  app.useGlobalFilters(new AllExceptionsFilter());
  app.use(cookieParser());
  app.enableCors({
    origin: true,
    credentials: true,
  });

  const expressApp = app.getHttpAdapter().getInstance();
  const candidatePublicDirs = [
    path.join(process.cwd(), 'services/api/public'),
    path.join(process.cwd(), 'public'),
    path.resolve(process.cwd(), '..', 'services', 'api', 'public'),
    path.resolve(process.cwd(), 'old-code', 'public'),
  ];
  const publicDir = candidatePublicDirs.find((d) => fs.existsSync(d)) || candidatePublicDirs[0];

  expressApp.get('/', (req: any, res: any) => {
    const sid = req.cookies?.tb_session;
    if (sid) {
      return res.redirect(302, '/app');
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(publicDir, 'welcome.html'));
  });

  expressApp.get('/app', (_req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  expressApp.get('/install', (_req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(publicDir, 'install.html'));
  });

  expressApp.get('/welcome', (_req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(publicDir, 'welcome.html'));
  });

  // CDN & Static Asset Optimization headers (immutable caching for images/icons, no-cache for app HTML/JS)
  expressApp.use(
    express.static(publicDir, {
      dotfiles: 'deny',
      maxAge: '7d',
      setHeaders(res: any, filePath: string) {
        if (/\.(html|js|css)$/.test(filePath)) {
          res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        } else if (/\.(png|jpg|jpeg|svg|ico|webp|woff2?)$/.test(filePath)) {
          // CDN cacheable for 30 days with stale-while-revalidate
          res.setHeader('Cache-Control', 'public, max-age=2592000, stale-while-revalidate=86400');
          res.setHeader('CDN-Cache-Control', 'max-age=2592000');
        }
      },
    })
  );

  // In-memory sliding window token bucket rate limiter & brute force guard
  const ipBuckets = new Map<string, { tokens: number; lastRefill: number; failedAuth: number; blockedUntil?: number }>();
  expressApp.use((req: any, res: any, next: any) => {
    // Only rate-limit /api/ endpoints; exempt all static assets, UI routes, and health checks
    if (!req.path.startsWith('/api/') || req.path === '/api/health') {
      return next();
    }

    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
    const now = Date.now();
    let entry = ipBuckets.get(ip);
    if (!entry) {
      entry = { tokens: 5000, lastRefill: now, failedAuth: 0 };
      ipBuckets.set(ip, entry);
    }

    // Check brute force block
    if (entry.blockedUntil && now < entry.blockedUntil) {
      return res.status(429).json({
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Temporarily blocked due to repeated failed attempts. Please retry later.',
      });
    }

    // Token bucket refill: 5000 burst, 2000 tokens/second
    const elapsedSec = (now - entry.lastRefill) / 1000;
    entry.tokens = Math.min(5000, entry.tokens + elapsedSec * 2000);
    entry.lastRefill = now;

    if (entry.tokens >= 1) {
      entry.tokens -= 1;
      // Track auth failures for brute force prevention
      if (req.path === '/api/auth/login' && req.method === 'POST') {
        const origSend = res.send;
        res.send = function (body: any) {
          if (res.statusCode === 401 || res.statusCode === 400) {
            entry!.failedAuth++;
            if (entry!.failedAuth >= 10) {
              entry!.blockedUntil = Date.now() + 15 * 60 * 1000; // 15 min block
            }
          } else if (res.statusCode === 200) {
            entry!.failedAuth = 0;
          }
          return origSend.apply(this, arguments as any);
        };
      }
      return next();
    }

    return res.status(429).json({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. System is operating under load shedding.',
    });
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`[tectobox] Core API running on port ${port}`);
}
await bootstrap();

