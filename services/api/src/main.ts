import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.use(cookieParser());
  app.enableCors({
    origin: true,
    credentials: true,
  });

  const expressApp = app.getHttpAdapter().getInstance();
  const candidatePublicDirs = [
    path.join(process.cwd(), 'services/api/public'),
    path.join(process.cwd(), 'public'),
    path.join(process.cwd(), 'old-code/public'),
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

  expressApp.use(
    express.static(publicDir, {
      dotfiles: 'deny',
      setHeaders(res: any, filePath: string) {
        if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`[tectobox] Core API running on port ${port}`);
}
await bootstrap();

