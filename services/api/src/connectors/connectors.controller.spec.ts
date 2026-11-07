import { describe, it, expect, afterEach, vi } from 'vitest';

// Mock workspace packages (same pattern as sse.controller.spec.ts) —
// importing the controller pulls in events.service, which imports these.
vi.mock('@tectonic/coordination', () => ({
  RedisCoordinator: class {},
}));
vi.mock('@tectonic/messaging', () => ({
  RabbitMQClient: class {},
}));

import { ConnectorsController } from './connectors.controller.js';

function fakeReq(host: string, proto?: string) {
  return {
    get: (name: string) => (name.toLowerCase() === 'host' ? host : undefined),
    headers: proto ? { 'x-forwarded-proto': proto } : {},
    secure: false,
  } as any;
}

describe('ConnectorsController.getWebhookUrls', () => {
  const ctrl = new ConnectorsController({} as any, {} as any);

  afterEach(() => {
    delete process.env.BASE_URL;
    delete process.env.PUBLIC_URL;
    delete process.env.DOMAIN;
  });

  it('uses the request host + forwarded proto (Caddy) when no env is set', () => {
    const urls = ctrl.getWebhookUrls(fakeReq('box.tect0nic.com', 'https'));
    expect(urls.telegram).toBe('https://box.tect0nic.com/webhooks/telegram');
    expect(urls.meta).toBe('https://box.tect0nic.com/webhooks/meta');
  });

  it('falls back to localhost for local dev', () => {
    const urls = ctrl.getWebhookUrls(fakeReq('localhost:3000'));
    expect(urls.telegram).toBe('http://localhost:3000/webhooks/telegram');
  });

  it('prefers BASE_URL env over the request host', () => {
    process.env.BASE_URL = 'https://box.tect0nic.com/';
    const urls = ctrl.getWebhookUrls(fakeReq('other.example', 'http'));
    expect(urls.telegram).toBe('https://box.tect0nic.com/webhooks/telegram');
  });

  it('ignores a blank/bare-slash BASE_URL (e.g. a build tool default)', () => {
    process.env.BASE_URL = '/';
    const urls = ctrl.getWebhookUrls(fakeReq('box.tect0nic.com', 'https'));
    expect(urls.telegram).toBe('https://box.tect0nic.com/webhooks/telegram');
  });

  it('derives https from DOMAIN env', () => {
    process.env.DOMAIN = 'box.tect0nic.com';
    const urls = ctrl.getWebhookUrls(fakeReq('10.0.0.5:3120'));
    expect(urls.telegram).toBe('https://box.tect0nic.com/webhooks/telegram');
  });
});
