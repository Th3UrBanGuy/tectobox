import { describe, it, expect, vi, afterEach } from 'vitest';
import { demoResponder, queryGoAIEngine, GO_AI_TIMEOUT_MS } from './router.js';

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
});

describe('queryGoAIEngine (F1 bridge)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
});
