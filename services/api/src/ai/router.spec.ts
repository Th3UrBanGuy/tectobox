import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { demoResponder, queryGoAIEngine, GO_AI_TIMEOUT_MS, resetGoAiCircuitBreaker, findProduct, extractCustomerDetails } from './router.js';

describe('demoResponder (API)', () => {
  it('answers delivery from knowledge when delivery knowledge is seeded', () => {
    const knowledge = [
      {
        title: 'Delivery Policy',
        content: 'Delivery charge 130 taka nationwide via courier.',
      },
    ];

    const reply = demoResponder('client1', 'What is your delivery charge?', [], [], knowledge);
    expect(reply).toContain('130');
    expect(reply).not.toContain('60');
    expect(reply).not.toContain('120');
  });

  it('also accepts knowledge as 4th parameter when history is omitted', () => {
    const knowledge = [
      {
        title: 'ডেলিভারি চার্জ',
        content: 'আমাদের ডেলিভারি চার্জ ১৩০ টাকা ফিক্সড।',
      },
    ];

    const reply = demoResponder('client1', 'ডেলিভারি চার্জ কত?', [], knowledge as any);
    expect(reply).toContain('১৩০');
    expect(reply).not.toContain('৬০');
    expect(reply).not.toContain('১২০');
  });

  it('returns generic delivery template when knowledge is empty', () => {
    const replyEn = demoResponder('client1', 'How much is shipping?', [], []);
    expect(replyEn).toContain('60');
    expect(replyEn).toContain('120');

    const replyBn = demoResponder('client1', 'ডেলিভারি চার্জ কত?', [], []);
    expect(replyBn).toContain('৬০');
    expect(replyBn).toContain('১২০');
  });

  it('F4: does not confuse charger/চার্জার with delivery charge and matches product', () => {
    const products = [
      {
        id: 1,
        name: 'Charger X',
        price_bdt: 450,
        stock: 10,
      },
    ];

    // Bengali question for charger price
    const replyBn = demoResponder('client1', 'চার্জার এর দাম কত?', products, []);
    expect(replyBn).not.toContain('৬০');
    expect(replyBn).not.toContain('১২০');
    expect(replyBn).not.toContain('ডেলিভারি চার্জ');
    expect(replyBn).toContain('Charger X');
    expect(replyBn).toContain('450');

    // English question for charger price
    const replyEn = demoResponder('client1', 'How much is the charger?', products, []);
    expect(replyEn).not.toContain('60');
    expect(replyEn).not.toContain('120');
    expect(replyEn).not.toContain('delivery charge');
    expect(replyEn).toContain('Charger X');
    expect(replyEn).toContain('450');
  });

  it('answers policy questions from seeded knowledge', () => {
    const knowledge = [
      {
        title: 'Return Policy',
        content: 'Customers can return items within 7 days.',
      },
    ];

    const reply = demoResponder('client1', 'What is your return policy?', [], [], knowledge);
    expect(reply).toContain('7 days');
  });

  it('out-of-stock alternative prefers the same category, not the lowest-id product', () => {
    const products = [
      { name: 'chocklate', price_bdt: 700, stock: 50, category: 'food' },
      { name: 'Wireless Earbuds Pro', price_bdt: 2499, stock: 25, category: 'electronics' },
      { name: 'Smart Watch Fit X2', price_bdt: 3999, stock: 0, category: 'electronics' },
    ];

    const reply = demoResponder('client1', 'What is the Smart Watch price?', products, []);
    expect(reply).toContain('Smart Watch Fit X2');
    expect(reply).toContain('Wireless Earbuds Pro');
    expect(reply).not.toContain('chocklate');
  });

  it('out-of-stock alternative falls back to any in-stock item when no same-category item exists', () => {
    const products = [
      { name: 'chocklate', price_bdt: 700, stock: 50, category: 'food' },
      { name: 'Smart Watch Fit X2', price_bdt: 3999, stock: 0, category: 'electronics' },
    ];

    const reply = demoResponder('client1', 'What is the Smart Watch price?', products, []);
    expect(reply).toContain('Smart Watch Fit X2');
    expect(reply).toContain('chocklate');
  });

  it('out-of-stock reply has no alternative when nothing is in stock', () => {
    const products = [
      { name: 'Smart Watch Fit X2', price_bdt: 3999, stock: 0, category: 'electronics' },
    ];

    const reply = demoResponder('client1', 'What is the Smart Watch price?', products, []);
    expect(reply).toContain('Smart Watch Fit X2');
    expect(reply).not.toContain('Er bodle');
    expect(reply).not.toContain('instead');
    expect(reply).not.toContain('BDT');
  });

  it('farewell gets a closing reply, never the opening greeting', () => {
    const reply = demoResponder('client1', 'Thank you, bye!', [], []);
    expect(reply).toContain('welcome');
    expect(reply).not.toContain('assist you');

    const replyBn = demoResponder('client1', 'ধন্যবাদ, বিদায়!', [], []);
    expect(replyBn).toContain('ধন্যবাদ');
    expect(replyBn).not.toContain('সাহায্য করতে পারি');

    // A plain greeting still gets the opening greeting.
    const greeting = demoResponder('client1', 'Hello', [], []);
    expect(greeting).toContain('assist you');
  });
});

describe('queryGoAIEngine (F1 bridge)', () => {
  const origGoAiUrl = process.env.GO_AI_URL;

  beforeEach(() => {
    // queryGoAIEngine fails fast when GO_AI_URL is unset (Phase 6); the
    // tests stub fetch, so the URL value itself is irrelevant.
    process.env.GO_AI_URL = 'http://127.0.0.1:8081/api/ai/chat';
    // The circuit breaker is module-level state: reset it so failures
    // recorded by one test cannot trip the breaker in the next.
    resetGoAiCircuitBreaker();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetGoAiCircuitBreaker();
    if (origGoAiUrl === undefined) delete process.env.GO_AI_URL;
    else process.env.GO_AI_URL = origGoAiUrl;
  });

  it('sends snake_case client_id/client_name/business_type to the Go bridge', async () => {
    let sentBody = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: any) => {
      sentBody = String(opts?.body || '');
      return { ok: true, json: async () => ({ reply: 'ok', language: 'en', model: 'x', cached: false }) };
    }));
    const res = await queryGoAIEngine({
      clientId: 77,
      clientName: 'Shop B',
      businessType: 'physical',
      text: 'hi',
      knowledge: [],
    });
    expect(res?.reply).toBe('ok');
    const body = JSON.parse(sentBody);
    expect(body.client_id).toBe(77);
    expect(body.client_name).toBe('Shop B');
    expect(body.business_type).toBe('physical');
    expect(body).not.toHaveProperty('clientId');
    expect(body).not.toHaveProperty('clientName');
    expect(body).not.toHaveProperty('businessType');
  });

  it('returns knowledge-grounded template answer when Go backend times out or aborts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }));

    const knowledge = [
      {
        title: 'Return Policy',
        content: 'Returns accepted within 14 business days.',
      },
    ];

    const res = await queryGoAIEngine({
      clientId: 77,
      clientName: 'Shop B',
      businessType: 'physical',
      text: 'What is your return policy?',
      knowledge,
    });

    expect(res).not.toBeNull();
    expect(res?.reply).toContain('14 business days');
    expect(res?.model).toBe('timeout-fallback:deterministic');
  });

  it('has explicit timeout bounded to 25s below widget 30s abort', () => {
    expect(GO_AI_TIMEOUT_MS).toBe(25000);
    expect(GO_AI_TIMEOUT_MS).toBeLessThan(30000);
  });

  // Seg-D (W1): a missing backend URL must never throw out of the widget
  // path — the caller falls through to the deterministic responder.
  it('returns null (does not throw) when GO_AI_URL is unset', async () => {
    delete process.env.GO_AI_URL;
    const res = await queryGoAIEngine({
      clientId: 77,
      clientName: 'Shop B',
      businessType: 'physical',
      text: 'hi',
      knowledge: [],
    });
    expect(res).toBeNull();
  });

  // Seg-D (W1): after 3 consecutive engine failures the circuit breaker
  // opens and the widget is answered from the deterministic responder
  // without burning the 25s fetch timeout again.
  it('opens the circuit breaker after 3 consecutive failures', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8081');
    });
    vi.stubGlobal('fetch', fetchMock);

    const knowledge = [
      {
        title: 'Return Policy',
        content: 'Returns accepted within 14 business days.',
      },
    ];
    const params = {
      clientId: 77,
      clientName: 'Shop B',
      businessType: 'physical',
      text: 'What is your return policy?',
      knowledge,
    };

    for (let i = 0; i < 3; i++) {
      expect(await queryGoAIEngine(params)).toBeNull();
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const open = await queryGoAIEngine(params);
    expect(open).not.toBeNull();
    expect(open?.reply).toContain('14 business days');
    expect(open?.model).toBe('circuit-open:deterministic');
    // Breaker open: no further fetch attempt was made.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('closes the circuit breaker again after a success', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8081');
    });
    vi.stubGlobal('fetch', fetchMock);
    const params = { clientId: 77, text: 'hi', knowledge: [] };
    for (let i = 0; i < 3; i++) await queryGoAIEngine(params);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ reply: 'ok', language: 'en', model: 'x', cached: false }),
    })));
    // Breaker is still open (cooldown 30s), so the success cannot be
    // observed yet — reset it, then a success must close it: the next
    // failure after that must attempt a fetch again instead of
    // short-circuiting.
    resetGoAiCircuitBreaker();
    expect((await queryGoAIEngine(params))?.reply).toBe('ok');
    vi.stubGlobal('fetch', fetchMock);
    expect(await queryGoAIEngine(params)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe('2026-11-16 order/payment audit fixes (TS responder)', () => {
  const kitkat = { name: 'Kitkat', price_bdt: 900, stock: 75 };
  const kitkatAliased = { ...kitkat, aliases: ['কিটক্যাট'] };

  it('Fix 3: findProduct matches "কিটক্যাট" via the owner alias', () => {
    expect(findProduct('কিটক্যাট কিনতে চাই', [kitkatAliased])?.name).toBe('Kitkat');
  });

  it('Fix 3: findProduct matches "কিটক্যাটের দাম কত?" via the consonant skeleton (no alias)', () => {
    expect(findProduct('কিটক্যাটের দাম কত?', [kitkat])?.name).toBe('Kitkat');
  });

  it('Fix 3: the skeleton does not over-match an unrelated product', () => {
    const saree = { name: 'লাল জামদানি শাড়ি', price_bdt: 8000, stock: 10 };
    expect(findProduct('কিটক্যাট কিনতে চাই', [saree])).toBeUndefined();
  });

  it('Fix 2: extractCustomerDetails reads "নাম করিম" + keyword-less address after the phone', () => {
    const d = extractCustomerDetails('নাম করিম, ০১৬৪২৭৭৫২৭২, ঊলিয়াপুর, চট্টগ্রাম');
    expect(d.name).toBe('করিম');
    expect(d.phone).toBe('01642775272');
    expect(d.address).toBe('ঊলিয়াপুর, চট্টগ্রাম');
  });

  it('Fix 2: "আমার নাম কি?" captures no name', () => {
    const d = extractCustomerDetails('আমার নাম কি?');
    expect(d.name).toBeUndefined();
  });

  it('Fix 2: a bare quantity after the phone is not an address', () => {
    const d = extractCustomerDetails('আমার নাম করিম, ফোন ০১৬৪২৭৭৫২৭২, ২টি');
    expect(d.address).toBeUndefined();
  });

  it('Fix 5: payment question with NO config answers honestly, never invents a method', () => {
    const reply = demoResponder('client1', 'পেমেন্ট কিভাবে করব?', [], []);
    expect(reply).toContain('ঠিক করা হয়নি');
    expect(reply).not.toContain('bKash');
    expect(reply).not.toContain('Nagad');
  });

  it('Fix 5: payment question WITH config quotes the real methods + number + advance', () => {
    const cfg = { modes: 'both', advanceBdt: 100, bkash: '01700000000' } as any;
    const reply = demoResponder('client1', 'পেমেন্ট কিভাবে করব?', [], [], [], cfg);
    expect(reply).toContain('bKash');
    expect(reply).toContain('01700000000');
    expect(reply).toContain('১০০');
    expect(reply).not.toContain('Nagad');
    expect(reply).not.toContain('Rocket');
  });

  it('Fix 5: advance question WITH config quotes the advance + number', () => {
    const cfg = { modes: 'both', advanceBdt: 100, bkash: '01700000000' } as any;
    const reply = demoResponder('client1', 'অগ্রিম কত দিতে হবে?', [], [], [], cfg);
    expect(reply).toContain('১০০');
    expect(reply).toContain('01700000000');
  });

  it('Fix 1: "হে" reaches the order branch (asks for details, not a greeting)', () => {
    const reply = demoResponder('client1', 'হে', [kitkat], []);
    expect(reply).not.toMatch(/নমস্কার|আসসালামু|Hello/);
    expect(reply).toMatch(/নাম|ফোন|ঠিকানা|Kitkat/);
  });
});
