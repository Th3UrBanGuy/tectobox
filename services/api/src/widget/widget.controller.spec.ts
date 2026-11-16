import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tectonic/coordination', () => ({
  RedisCoordinator: class {},
}));
vi.mock('@tectonic/messaging', () => ({
  RabbitMQClient: class {},
}));

import * as aiRouter from '../ai/router.js';
import { WidgetController } from './widget.controller.js';

describe('WidgetController.handleWidgetMessage — Knowledge Injection into demoResponder', () => {
  let demoResponderSpy: any;

  beforeEach(() => {
    demoResponderSpy = vi.spyOn(aiRouter, 'demoResponder');
  });

  it('passes seeded knowledge rows into demoResponder on budget fallback', async () => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const knowledgeRows = [
      {
        title: 'Delivery Policy',
        content: 'Delivery charge 130 taka nationwide.',
        category: 'shipping',
      },
    ];
    const productRows = [
      {
        name: 'T-Shirt',
        sku: 'TSH-1',
        price_bdt: 500,
        stock: 5,
        aliases: [],
      },
    ];

    const mockPool = {
      query: vi.fn(async (queryText: string, params: any[]) => {
        const q = queryText.toLowerCase();
        if (q.includes('from clients where widget_key')) {
          return { rows: [{ id: 45, name: 'Shop 45', suspended: false }] };
        }
        if (q.includes('insert into conversations')) {
          return { rows: [{ id: 101, needs_human: false }] };
        }
        if (q.includes('insert into messages') && q.includes("'in'")) {
          return { rows: [{ id: 501, text: params[1] }] };
        }
        if (q.includes('insert into leads')) {
          return { rows: [] };
        }
        if (q.includes("from settings where key = 'ai.auto_reply'")) {
          return { rows: [{ value: '1' }] };
        }
        if (q.includes('select widget_ai_daily_cap')) {
          // Budget exceeded -> triggers budget fallback path calling demoResponder
          return {
            rows: [
              {
                widget_ai_daily_cap: 10,
                widget_ai_used: 15,
                widget_ai_day: todayStr,
              },
            ],
          };
        }
        if (q.includes('from products where client_id')) {
          return { rows: productRows };
        }
        if (q.includes('from knowledge where client_id')) {
          return { rows: knowledgeRows };
        }
        if (q.includes('from messages') && q.includes('order by id desc limit 8')) {
          return { rows: [] };
        }
        if (q.includes('insert into messages') && q.includes("'out'")) {
          return { rows: [{ id: 502, text: params[1] }] };
        }
        return { rows: [] };
      }),
    } as any;

    const mockLicensing = {
      resolveAccess: vi.fn(async () => ({
        features: ['webchat', 'ai_response'],
        aiAllowed: true,
      })),
      consumeAiCredit: vi.fn(async () => true),
    } as any;

    const controller = new WidgetController(mockPool, undefined, mockLicensing);

    await controller.handleWidgetMessage('test-widget-key', {
      visitor_id: 'visitor-123',
      text: 'What is your delivery charge?',
    });

    // Acceptance criterion: Widget controller passes knowledge into demoResponder
    expect(demoResponderSpy).toHaveBeenCalled();
    const lastCall = demoResponderSpy.mock.calls[demoResponderSpy.mock.calls.length - 1];
    expect(lastCall[0]).toBe(45);
    expect(lastCall[1]).toBe('What is your delivery charge?');
    expect(lastCall[2]).toEqual(productRows);
    expect(lastCall[3]).toEqual([]); // history
    expect(lastCall[4]).toEqual(knowledgeRows); // knowledge passed into demoResponder!

    // Verify out message was populated with knowledge-grounded reply
    const outCalls = mockPool.query.mock.calls.filter((c: any[]) =>
      c[0].toLowerCase().includes("insert into messages") && c[0].toLowerCase().includes("'out'")
    );
    expect(outCalls.length).toBe(1);
    expect(outCalls[0][1][1]).toContain('130');
    expect(outCalls[0][1][1]).not.toContain('60');
  });
});

describe('WidgetController.getPublicProduct — shareable product pages', () => {
  const prevFlag = process.env.PRODUCT_PAGES_ENABLED;
  beforeEach(() => { process.env.PRODUCT_PAGES_ENABLED = 'true'; });
  afterEach(() => {
    if (prevFlag === undefined) delete process.env.PRODUCT_PAGES_ENABLED;
    else process.env.PRODUCT_PAGES_ENABLED = prevFlag;
  });

  const makePool = (clientRow: any, productRow: any) => ({
    query: vi.fn(async (sql: string) => {
      const q = sql.toLowerCase();
      if (q.includes('from clients where widget_key')) return { rows: clientRow ? [clientRow] : [] };
      if (q.includes('from products where id')) return { rows: productRow ? [productRow] : [] };
      return { rows: [] };
    }),
  });

  it('503s when the product pages module is switched off', async () => {
    delete process.env.PRODUCT_PAGES_ENABLED;
    const mockPool = makePool({ id: 45, name: 'Shop 45', whatsapp_number: null }, null);
    const controller = new WidgetController(mockPool as any);
    await expect(controller.getPublicProduct('key-1', 7)).rejects.toThrow('Product pages are disabled');
  });

  it('returns the product with cleaned variants + shop whatsapp', async () => {
    const mockPool = makePool(
      { id: 45, name: 'Shop 45', whatsapp_number: '8801712345678' },
      {
        id: 7, client_id: 45, sku: 'TSH-1', name: 'T-Shirt', category: 'Apparel',
        price_bdt: 500, stock: 5, image_url: 'https://img.test/t.jpg',
        variants_json: [{ name: 'M', price_bdt: 550, stock: 2 }, { name: '' }, { price_bdt: 1 }],
      },
    );
    const controller = new WidgetController(mockPool as any);
    const res = await controller.getPublicProduct('key-1', 7);
    expect(res.ok).toBe(true);
    expect(res.product.name).toBe('T-Shirt');
    expect(res.product.variants).toEqual([{ name: 'M', price_bdt: 550, stock: 2 }]);
    expect(res.shop.whatsapp).toBe('8801712345678');
  });

  it('404s when the product belongs to another client', async () => {
    const mockPool = makePool({ id: 45, name: 'Shop 45', whatsapp_number: null }, null);
    const controller = new WidgetController(mockPool as any);
    await expect(controller.getPublicProduct('key-1', 7)).rejects.toThrow('Product not found');
  });

  it('404s on an unknown widget key', async () => {
    const mockPool = makePool(null, null);
    const controller = new WidgetController(mockPool as any);
    await expect(controller.getPublicProduct('nope', 7)).rejects.toThrow('Product not found');
  });
});
