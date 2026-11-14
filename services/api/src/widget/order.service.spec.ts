import { describe, it, expect, vi, beforeEach } from 'vitest';

import { OrderService } from './order.service.js';

/**
 * W3/W4 (2026-11-15): confirming an order must insert exactly one
 * `orders` row (catalog price, 60/120 delivery, idempotent on a
 * double confirm); an out-of-stock item must never become an order.
 * All DB access goes through a mocked pool — no real orders are ever
 * written by these tests.
 */
describe('OrderService.tryCreateOrder — W3/W4', () => {
  const client = { id: 69, name: 'Shop 69' };
  const conv = { id: 101 };

  const earbuds = { id: 1, name: 'Wireless Earbuds Pro', sku: 'EB-1', price_bdt: 1500, stock: 25 };
  const watch = { id: 2, name: 'Smart Watch', sku: 'SW-1', price_bdt: 2500, stock: 0 };
  const tshirt = { id: 3, name: 'T-Shirt', sku: 'TSH-1', price_bdt: 500, stock: 1 };
  const bottle = { id: 4, name: 'Water Bottle', sku: 'WB-1', price_bdt: 350, stock: 10 };
  const products = [earbuds, watch, tshirt, bottle];

  // Full order flow as the audit ran it: product asked about, then
  // details given, then "confirm".
  const earbudsHistory = [
    { role: 'user', content: 'I want to order the wireless earbuds' },
    { role: 'assistant', content: 'Please provide your name, phone and address.' },
    { role: 'user', content: 'my name is Fahim, phone 01712345678, address Dhanmondi Dhaka' },
  ];

  let pool: any;
  let store: Map<string, any>;
  let service: OrderService;

  function makePool() {
    const s = new Map<string, any>();
    let nextId = 1;
    const p = {
      store: s,
      query: vi.fn(async (sql: string, params: any[]) => {
        const q = sql.toLowerCase();
        if (q.includes('insert into orders')) {
          const key = params[9];
          if (s.has(key)) return { rows: [] }; // ON CONFLICT DO NOTHING
          const row = {
            id: nextId++,
            client_id: params[0],
            conversation_id: params[1],
            items_json: params[2],
            subtotal_bdt: params[3],
            delivery_charge_bdt: params[4],
            total_bdt: params[5],
            customer_name: params[6],
            customer_phone: params[7],
            customer_address: params[8],
            payment_status: 'pending',
            status: 'confirmed',
            idempotency_key: key,
          };
          s.set(key, row);
          return { rows: [row] };
        }
        if (q.includes('from orders')) {
          const row = s.get(params[1]);
          return { rows: row ? [row] : [] };
        }
        return { rows: [] };
      }),
    };
    return p;
  }

  beforeEach(() => {
    pool = makePool();
    store = pool.store;
    service = new OrderService(pool);
  });

  function insertCalls() {
    return pool.query.mock.calls.filter((c: any[]) =>
      String(c[0]).toLowerCase().includes('insert into orders')
    );
  }

  function baseCtx(overrides: any = {}) {
    return {
      client,
      conv,
      text: 'confirm',
      name: null,
      phone: null,
      products,
      history: earbudsHistory,
      ...overrides,
    };
  }

  it('creates one order on confirm: catalog price, Dhaka delivery 60, total in reply', async () => {
    const result = await service.tryCreateOrder(baseCtx());
    expect(result.status).toBe('created');
    expect(insertCalls()).toHaveLength(1);
    const params = insertCalls()[0][1];
    expect(params[0]).toBe(69); // client_id
    expect(params[1]).toBe(101); // conversation_id
    expect(params[3]).toBe(1500); // subtotal = catalog price x 1
    expect(params[4]).toBe(60); // inside Dhaka
    expect(params[5]).toBe(1560); // total
    expect(params[6]).toBe('Fahim');
    expect(params[7]).toBe('01712345678');
    expect(params[9]).toBe('webchat:101:1:qty:1'); // deterministic key
    expect(store.size).toBe(1);
    const row = [...store.values()][0];
    expect(row.payment_status).toBe('pending');
    expect(row.status).toBe('confirmed');
    expect(JSON.parse(row.items_json)[0].name).toBe('Wireless Earbuds Pro');
    if (result.status === 'created') {
      expect(result.replyText).toMatch(/order #1/i);
      expect(result.replyText).toMatch(/1560/);
      expect(result.modelUsed).toBe('order:created');
    }
  });

  it('does NOT create a duplicate on a double confirm: same order, already_exists reply', async () => {
    const first = await service.tryCreateOrder(baseCtx());
    expect(first.status).toBe('created');
    const second = await service.tryCreateOrder(baseCtx());
    expect(second.status).toBe('already_exists');
    expect(store.size).toBe(1);
    expect(insertCalls()).toHaveLength(2); // both attempts ran; 2nd hit the conflict
    if (second.status === 'already_exists') {
      expect(second.order.id).toBe(1);
      expect(second.replyText).toMatch(/already confirmed/i);
      expect(second.replyText).toMatch(/order #1/i);
      expect(second.replyText).toMatch(/1560/);
      expect(second.modelUsed).toBe('order:already-exists');
    }
  });

  it('refuses an out-of-stock product: no row, out-of-stock reply with an in-stock alternative', async () => {
    const result = await service.tryCreateOrder(
      baseCtx({
        history: [
          { role: 'user', content: 'I want to order the smart watch' },
          { role: 'user', content: 'my name is Fahim, phone 01712345678, address Dhanmondi Dhaka' },
        ],
      })
    );
    expect(result.status).toBe('out_of_stock');
    expect(insertCalls()).toHaveLength(0);
    expect(store.size).toBe(0);
    if (result.status === 'out_of_stock') {
      expect(result.replyText).toMatch(/out of stock/i);
      expect(result.replyText).toMatch(/Wireless Earbuds Pro/); // in-stock alternative
      expect(result.replyText).not.toMatch(/order #\d/i);
      expect(result.replyText).not.toMatch(/confirmed/i);
      expect(result.modelUsed).toBe('order:out-of-stock');
    }
  });

  it('refuses when fewer are in stock than ordered, and accepts "confirm 1" for the one left', async () => {
    const lowStockHistory = [
      { role: 'user', content: 'I want to order 2 pcs t-shirt' },
      { role: 'user', content: 'my name is Fahim, phone 01712345678, address Dhanmondi Dhaka' },
    ];
    const refused = await service.tryCreateOrder(baseCtx({ history: lowStockHistory }));
    expect(refused.status).toBe('out_of_stock');
    expect(insertCalls()).toHaveLength(0);
    if (refused.status === 'out_of_stock') {
      expect(refused.replyText).toMatch(/only 1 .* in stock/i);
      expect(refused.replyText).toMatch(/confirm 1/i);
    }
    const accepted = await service.tryCreateOrder(
      baseCtx({ text: 'confirm 1', history: lowStockHistory })
    );
    expect(accepted.status).toBe('created');
    expect(insertCalls()).toHaveLength(1);
    expect(insertCalls()[0][1][3]).toBe(500); // 1 x 500, not 2 x 500
    expect(insertCalls()[0][1][5]).toBe(560); // 500 + 60 Dhaka delivery
  });

  it('creates nothing without a confirmation: order intent alone is not an order', async () => {
    const result = await service.tryCreateOrder(
      baseCtx({ text: 'I want to order the wireless earbuds', history: [] })
    );
    expect(result.status).toBe('not_applicable');
    expect(insertCalls()).toHaveLength(0);
  });

  it('creates nothing on "confirm" when details are missing', async () => {
    const result = await service.tryCreateOrder(
      baseCtx({
        history: [{ role: 'user', content: 'I want to order the wireless earbuds' }],
      })
    );
    expect(result.status).toBe('not_applicable');
    expect(insertCalls()).toHaveLength(0);
  });

  it('creates nothing on a details-only message (no confirm word, no order intent)', async () => {
    const result = await service.tryCreateOrder(
      baseCtx({
        text: 'my name is Fahim, phone 01712345678, address Dhanmondi Dhaka',
        history: [{ role: 'user', content: 'I want to order the wireless earbuds' }],
      })
    );
    expect(result.status).toBe('not_applicable');
    expect(insertCalls()).toHaveLength(0);
  });

  it('creates nothing on "confirm" when no catalog product was ever named', async () => {
    const result = await service.tryCreateOrder(
      baseCtx({
        history: [
          { role: 'user', content: 'I want to order an iPhone 15' },
          { role: 'user', content: 'my name is Fahim, phone 01712345678, address Dhanmondi Dhaka' },
        ],
      })
    );
    expect(result.status).toBe('not_applicable');
    expect(insertCalls()).toHaveLength(0);
  });

  it('creates an order from one complete message (intent + product + all details)', async () => {
    const result = await service.tryCreateOrder(
      baseCtx({
        text: 'I want to buy 2 earbuds, my name is Fahim, phone 01712345678, address Dhanmondi Dhaka',
        history: [],
      })
    );
    expect(result.status).toBe('created');
    expect(insertCalls()).toHaveLength(1);
    const params = insertCalls()[0][1];
    expect(params[3]).toBe(3000); // 2 x 1500 catalog price
    expect(params[4]).toBe(60);
    expect(params[5]).toBe(3060);
    expect(params[9]).toBe('webchat:101:1:qty:2');
    if (result.status === 'created') {
      expect(result.replyText).toMatch(/3060/);
      expect(result.replyText).toMatch(/x 2/);
    }
  });

  it('charges 120 delivery outside Dhaka', async () => {
    const result = await service.tryCreateOrder(
      baseCtx({
        history: [
          { role: 'user', content: 'I want to order the wireless earbuds' },
          { role: 'user', content: 'my name is Fahim, phone 01712345678, address Chattogram' },
        ],
      })
    );
    expect(result.status).toBe('created');
    expect(insertCalls()[0][1][4]).toBe(120);
    expect(insertCalls()[0][1][5]).toBe(1620);
  });

  it('still charges Dhaka 60 when the address has commas before "Dhaka"', async () => {
    const result = await service.tryCreateOrder(
      baseCtx({
        history: [
          { role: 'user', content: 'I want to order the wireless earbuds' },
          {
            role: 'user',
            content: 'my name is Fahim, phone 01712345678, address House 12, Road 5, Dhanmondi, Dhaka',
          },
        ],
      })
    );
    expect(result.status).toBe('created');
    expect(insertCalls()[0][1][4]).toBe(60);
    expect(insertCalls()[0][1][5]).toBe(1560);
  });

  it('confirms in Bengali when the customer confirms in Bengali', async () => {
    const result = await service.tryCreateOrder(baseCtx({ text: 'হ্যাঁ' }));
    expect(result.status).toBe('created');
    if (result.status === 'created') {
      expect(result.replyText).toMatch(/কনফার্ম হয়েছে/);
      expect(result.replyText).toMatch(/১৫৬০/); // Bengali digits total
    }
  });

  it('never creates an order when the insert fails — and never claims one was placed', async () => {
    const failingPool = {
      query: vi.fn(async () => {
        throw new Error('connection terminated');
      }),
    };
    const failing = new OrderService(failingPool);
    const result = await failing.tryCreateOrder(baseCtx());
    expect(result.status).toBe('error');
    expect(insertCalls()).toHaveLength(0);
  });
});
