import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { TenantGuard } from '../tenant/tenant.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { RedisSubscriber } from '@tectonic/coordination';
import { tenantEventsChannel } from '@tectonic/contracts';

@Controller('api/events')
export class SseController {
  @Get()
  @UseGuards(TenantGuard)
  async sseStream(
    @Req() req: Request,
    @Res() res: Response,
    @CurrentTenant() tenantId: number
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // Initial connected handshake matching old server.js format
    res.write(': connected\n\n');

    const channel = tenantEventsChannel(tenantId);
    let redisSubscriber: RedisSubscriber | null = null;

    try {
      redisSubscriber = new RedisSubscriber(
        process.env.REDIS_URL
          ? { url: process.env.REDIS_URL }
          : {
              host: process.env.REDIS_HOST || 'redis',
              port: Number(process.env.REDIS_PORT) || 6379,
              password: process.env.REDIS_PASSWORD,
            },
      );

      await redisSubscriber.subscribe(channel, (payload) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      });
      console.log(`[sse] Redis subscriber connected for ${channel}`);
    } catch (err) {
      console.error(`[sse] Failed to initialize Redis subscriber for ${channel}:`, err);
    }

    // Heartbeat ping interval
    const interval = setInterval(() => {
      res.write(': ping\n\n');
    }, 25000);

    req.on('close', async () => {
      clearInterval(interval);
      if (redisSubscriber) {
        try {
          await redisSubscriber.unsubscribe(channel);
          await redisSubscriber.close();
        } catch (err) {
          console.error(`[sse] Error closing Redis subscriber for ${channel}:`, err);
        }
      }
    });
  }
}

