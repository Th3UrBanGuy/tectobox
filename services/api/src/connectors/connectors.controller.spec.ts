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
import { metaOAuthState } from '../meta/meta.controller.js';

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

describe('ConnectorsController.connectChannel — RC5 WhatsApp trigger', () => {
  function fakePool() {
    const queries: string[] = [];
    return {
      queries,
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
    } as any;
  }

  it('whatsapp: upserts the row AND publishes a connect command to the worker', async () => {
    const pool = fakePool();
    const events = { publishChannelConnect: vi.fn(async () => true) } as any;
    const ctrl = new ConnectorsController(pool, events);
    const res: any = await ctrl.connectChannel(69, 69, 'whatsapp', { slot: 'b' });
    expect(res).toEqual({ ok: true, channel: 'whatsapp', slot: 'b', status: 'connecting' });
    expect(pool.queries.some((q: string) => q.includes('INSERT INTO channel_sessions'))).toBe(true);
    expect(events.publishChannelConnect).toHaveBeenCalledTimes(1);
    expect(events.publishChannelConnect).toHaveBeenCalledWith(69, 'b');
  });

  it('telegram: row only, no worker trigger (Telegram connect not built yet)', async () => {
    const pool = fakePool();
    const events = { publishChannelConnect: vi.fn(async () => true) } as any;
    const ctrl = new ConnectorsController(pool, events);
    const res: any = await ctrl.connectChannel(69, 69, 'telegram', { slot: 'hh' });
    expect(res.status).toBe('connecting');
    expect(events.publishChannelConnect).not.toHaveBeenCalled();
  });

  it('broker down: still returns ok (row stays connecting; re-tap retries)', async () => {
    const pool = fakePool();
    const events = { publishChannelConnect: vi.fn(async () => false) } as any;
    const ctrl = new ConnectorsController(pool, events);
    const res: any = await ctrl.connectChannel(69, 69, 'whatsapp', { slot: 'tt' });
    expect(res).toEqual({ ok: true, channel: 'whatsapp', slot: 'tt', status: 'connecting' });
    expect(events.publishChannelConnect).toHaveBeenCalledTimes(1);
  });

  it('defaults to the default slot when none is given', async () => {
    const pool = fakePool();
    const events = { publishChannelConnect: vi.fn(async () => true) } as any;
    const ctrl = new ConnectorsController(pool, events);
    await ctrl.connectChannel(69, 69, 'whatsapp', {});
    expect(events.publishChannelConnect).toHaveBeenCalledWith(69, 'default');
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

describe('ConnectorsController.metaOAuthCallback — 10-minute TTL expiry (M8)', () => {
  const ctrl = new ConnectorsController({} as any, {} as any);

  function mockRes() {
    let statusCode = 200;
    let body = '';
    const res: any = {
      status: vi.fn((code: number) => {
        statusCode = code;
        return res;
      }),
      send: vi.fn((data: string) => {
        body = data;
        return res;
      }),
      getStatusCode: () => statusCode,
      getBody: () => body,
    };
    return res;
  }

  it('rejects a state older than 10 minutes with 400', async () => {
    const expiredState = 'test-client.expired-state-xyz';
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    metaOAuthState.setState(expiredState, 99, elevenMinutesAgo);

    const res = mockRes();
    const req = { protocol: 'https', get: () => 'example.com' } as any;

    await ctrl.metaOAuthCallback('sample-code-123', expiredState, req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.getBody()).toContain('Invalid or expired connection session');
    expect(metaOAuthState.getState(expiredState)).toBeNull();
  });

  it('rejects unknown or invalid state with 400', async () => {
    const res = mockRes();
    const req = { protocol: 'https', get: () => 'example.com' } as any;

    await ctrl.metaOAuthCallback('sample-code-123', 'non-existent-state', req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.getBody()).toContain('Invalid or expired connection session');
  });
});

