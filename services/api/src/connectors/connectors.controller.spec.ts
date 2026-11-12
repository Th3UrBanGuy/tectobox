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

describe('ConnectorsController.getConnectors — honest statuses (no demo data)', () => {
  // Fake pool: answers per table so the endpoint's fallbacks are observable.
  function fakePool(sessions: any[], pages: any[], client: any) {
    return {
      query: async (sql: string) => {
        if (sql.includes('FROM channel_sessions')) return { rows: sessions };
        if (sql.includes('FROM meta_pages')) return { rows: pages };
        if (sql.includes('FROM clients')) return { rows: client ? [client] : [] };
        return { rows: [] };
      },
    } as any;
  }
  const events = { getQrCode: async () => null } as any;

  it('empty workspace: no invented Primary accounts, everything disconnected', async () => {
    const ctrl = new ConnectorsController(
      fakePool([], [], { widget_key: 'wk_real123', website_url: null }),
      events,
    );
    const res: any = await ctrl.getConnectors(1, 1);
    expect(res.whatsapp.accounts).toEqual([]);
    expect(res.whatsapp.status).toBe('disconnected');
    expect(res.telegram.accounts).toEqual([]);
    expect(res.telegram.status).toBe('disconnected');
    expect(res.messenger.pages).toEqual([]);
    expect(res.messenger.status).toBe('disconnected');
    expect(res.instagram.pages).toEqual([]);
    expect(res.instagram.status).toBe('disconnected');
    expect(res.webchat.widgetKey).toBe('wk_real123');
    expect(res.webchat.widgetKey).not.toBe('test-widget-key');
    expect(JSON.stringify(res)).not.toContain('Primary');
  });

  it('no widget key: webchat reports disconnected with a null key', async () => {
    const ctrl = new ConnectorsController(fakePool([], [], { widget_key: null, website_url: null }), events);
    const res: any = await ctrl.getConnectors(1, 1);
    expect(res.webchat.status).toBe('disconnected');
    expect(res.webchat.widgetKey).toBeNull();
  });

  it('a real connected WA session is reported as-is', async () => {
    const ctrl = new ConnectorsController(
      fakePool(
        [{ channel: 'whatsapp', slot: 'default', status: 'connected', label: 'Shop WA', ai_paused: false }],
        [],
        { widget_key: 'wk_real123', website_url: null },
      ),
      events,
    );
    const res: any = await ctrl.getConnectors(1, 1);
    expect(res.whatsapp.status).toBe('connected');
    expect(res.whatsapp.accounts).toHaveLength(1);
    expect(res.whatsapp.accounts[0].label).toBe('Shop WA');
    expect(res.telegram.status).toBe('disconnected');
  });
});

