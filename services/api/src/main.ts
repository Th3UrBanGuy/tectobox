import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { StructuredLogger } from './common/logger/logger.service.js';
import { watchdogMiddleware } from './common/watchdog/watchdog.middleware.js';
import { corsOriginCallback } from './auth/cors.util.js';
import { createRateLimitMiddleware } from './auth/rate-limit.middleware.js';

async function bootstrap() {
  const logger = new StructuredLogger();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger,
  });
  app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    })
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.use(cookieParser());
  app.enableCors({
    origin: (origin, callback) => {
      corsOriginCallback(origin, callback);
    },
    credentials: true,
  });

  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.use(watchdogMiddleware);
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
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
        } else if (/\.(png|jpg|jpeg|svg|ico|webp|woff2?)$/.test(filePath)) {
          // CDN cacheable for 30 days with stale-while-revalidate
          res.setHeader('Cache-Control', 'public, max-age=2592000, stale-while-revalidate=86400');
          res.setHeader('CDN-Cache-Control', 'max-age=2592000');
        }
      },
    })
  );

  // Redis-backed global rate limiter (300 req/min per IP) & brute force guard
  expressApp.use(createRateLimitMiddleware());

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`[tectobox] Core API running on port ${port}`);
}
await bootstrap();

