import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../events/events.service.js', () => ({
  EventsService: class {
    broadcastTenantEvent = vi.fn(async () => {});
  },
}));

import { PaymentClaimService } from './payment-claim.service.js';

/**
 * W5 (2026-11-15): a fake payment claim must never be stored or
 * confirmed, and the amount must come from the real order — never
 * invented.
 */
describe('PaymentClaimService.handlePaymentClaim — W5', () => {
  const client = { id: 69, name: 'Shop 69' };
  const conv = { id: 101 };

  let query: ReturnType<typeof vi.fn>;
  let pool: any;
  let eventsService: any;
  let service: PaymentClaimService;

  // Orders the mock DB returns for the conversation (null = no order).
  let mockOrder: { id: number; total_bdt: number } | null;
  let mockDuplicate = false;

  function makePool() {
    return {
      query: vi.fn(async (sql: string, params: any[]) => {
        const q = sql.toLowerCase();
        if (q.includes('from payments')) {
          return { rows: mockDuplicate ? [{ id: 7 }] : [] };
        }
        if (q.includes('from orders')) {
          return { rows: mockOrder ? [mockOrder] : [] };
        }
        if (q.includes('update orders')) {
          return { rows: [] };
        }
        if (q.includes('insert into payments')) {
          return {
            rows: [
              {
                id: 1,
                client_id: params[0],
                order_id: params[1],
                amount: params[5],
                method: params[6],
                transaction_id: params[7],
              },
            ],
          };
        }
        return { rows: [] };
      }),
    };
  }

  beforeEach(() => {
    mockOrder = null;
    mockDuplicate = false;
    pool = makePool();
    query = pool.query;
    eventsService = { broadcastTenantEvent: vi.fn(async () => {}) };
    service = new PaymentClaimService(pool, eventsService);
  });

  function insertCalls() {
    return query.mock.calls.filter((c: any[]) =>
      String(c[0]).toLowerCase().includes('insert into payments')
    );
  }

  it('rejects "I paid, TrxID is XYZ": no DB write, clear rejection reply', async () => {
    const result = await service.handlePaymentClaim({
      client,
      conv,
      text: 'I paid, TrxID is XYZ',
      name: null,
      phone: null,
      products: [],
      history: [],
      paymentClaim: {
        isPaymentClaim: true,
        method: 'bkash',
        trxId: 'XYZ',
        trxValid: false,
        rejectionReason: 'invalid_trxid',
        amount: 0,
      },
    });
    expect(insertCalls()).toHaveLength(0);
    expect(result.replyText).toMatch(/doesn't look right/i);
    expect(result.replyText).toMatch(/10-character/i);
    expect(result.replyText).not.toMatch(/CLAIM-/);
    expect(result.replyText).not.toMatch(/700/);
    expect(result.modelUsed).toBe('payment-detector:invalid-trxid');
  });

  it('rejects a claim with no TrxID instead of fabricating a CLAIM id', async () => {
    const result = await service.handlePaymentClaim({
      client,
      conv,
      text: 'I paid via bKash',
      name: null,
      phone: null,
      products: [],
      history: [],
      paymentClaim: {
        isPaymentClaim: true,
        method: 'bkash',
        trxId: '',
        trxValid: false,
        rejectionReason: 'missing_trxid',
        amount: 0,
      },
    });
    expect(insertCalls()).toHaveLength(0);
    // "I paid via bKash" detects as Banglish ("bkash" is a Banglish word),
    // so the rejection comes back in Banglish.
    expect(result.replyText).toMatch(/10 character-er TrxID-ta pathan/);
    expect(result.replyText).not.toMatch(/CLAIM-/);
  });

  it('rejects an 11-character Nagad id (audit [054]) with a clear reply', async () => {
    const result = await service.handlePaymentClaim({
      client,
      conv,
      text: 'I sent money through Nagad, transaction id NAGAD987654',
      name: null,
      phone: null,
      products: [],
      history: [],
      paymentClaim: {
        isPaymentClaim: true,
        method: 'nagad',
        trxId: 'NAGAD987654',
        trxValid: false,
        rejectionReason: 'invalid_trxid',
        amount: 0,
      },
    });
    expect(insertCalls()).toHaveLength(0);
    // "Nagad" twice in the message detects as Banglish, so the rejection
    // comes back in Banglish.
    expect(result.replyText).toMatch(/thik mone hocche na/);
    expect(result.replyText).toMatch(/10 character-er TrxID-ta abar pathan/);
  });

  it('accepts a valid Nagad claim and confirms it with the real order amount', async () => {
    mockOrder = { id: 55, total_bdt: 1250 };
    const result = await service.handlePaymentClaim({
      client,
      conv,
      text: 'I sent money through Nagad, transaction id NAGAD98765',
      name: 'Fahim',
      phone: '01712345678',
      products: [],
      history: [],
      paymentClaim: {
        isPaymentClaim: true,
        method: 'nagad',
        trxId: 'NAGAD98765',
        trxValid: true,
        amount: 0,
      },
    });
    expect(insertCalls()).toHaveLength(1);
    expect(insertCalls()[0][1][5]).toBe(1250);
    expect(insertCalls()[0][1][6]).toBe('nagad');
    expect(insertCalls()[0][1][7]).toBe('NAGAD98765');
    expect(result.replyText).toMatch(/NAGAD98765/);
    expect(result.replyText).toMatch(/৳1250/);
    expect(result.modelUsed).toBe('payment-detector:auto');
    expect(eventsService.broadcastTenantEvent).toHaveBeenCalled();
  });

  it('uses the order total even when the message states a different amount', async () => {
    mockOrder = { id: 56, total_bdt: 900 };
    const result = await service.handlePaymentClaim({
      client,
      conv,
      text: 'I paid 500 taka, TrxID ABCDEFGHIJ',
      name: null,
      phone: null,
      products: [],
      history: [],
      paymentClaim: {
        isPaymentClaim: true,
        method: 'bkash',
        trxId: 'ABCDEFGHIJ',
        trxValid: true,
        amount: 500,
      },
    });
    expect(insertCalls()[0][1][5]).toBe(900);
    expect(result.replyText).toMatch(/৳900/);
    expect(result.replyText).not.toMatch(/৳500/);
  });

  it('accepts a valid claim with a stated amount when there is no order', async () => {
    const result = await service.handlePaymentClaim({
      client,
      conv,
      text: 'I paid 500 taka, TrxID ABCDEFGHIJ',
      name: null,
      phone: null,
      products: [],
      history: [],
      paymentClaim: {
        isPaymentClaim: true,
        method: 'bkash',
        trxId: 'ABCDEFGHIJ',
        trxValid: true,
        amount: 500,
      },
    });
    expect(insertCalls()).toHaveLength(1);
    expect(insertCalls()[0][1][5]).toBe(500);
    expect(result.replyText).toMatch(/৳500/);
  });

  it('asks for the amount when there is no order and none was stated', async () => {
    const result = await service.handlePaymentClaim({
      client,
      conv,
      text: 'I paid, TrxID is ABCDEFGHIJ',
      name: null,
      phone: null,
      products: [],
      history: [],
      paymentClaim: {
        isPaymentClaim: true,
        method: 'bkash',
        trxId: 'ABCDEFGHIJ',
        trxValid: true,
        amount: 0,
      },
    });
    expect(insertCalls()).toHaveLength(0);
    expect(result.replyText).toMatch(/ABCDEFGHIJ/);
    expect(result.replyText).toMatch(/amount/i);
    expect(result.replyText).not.toMatch(/৳\d/);
    expect(result.modelUsed).toBe('payment-detector:amount-needed');
  });

  it('flags a duplicate TrxID and warns in the reply', async () => {
    mockOrder = { id: 57, total_bdt: 700 };
    mockDuplicate = true;
    const result = await service.handlePaymentClaim({
      client,
      conv,
      text: 'I paid, TrxID is ABCDEFGHIJ',
      name: null,
      phone: null,
      products: [],
      history: [],
      paymentClaim: {
        isPaymentClaim: true,
        method: 'bkash',
        trxId: 'ABCDEFGHIJ',
        trxValid: true,
        amount: 0,
      },
    });
    expect(insertCalls()[0][1][8]).toBe(true);
    expect(result.replyText).toMatch(/already used on another order/);
  });

  it('rejects in Bengali when the customer writes in Bengali', async () => {
    const result = await service.handlePaymentClaim({
      client,
      conv,
      text: 'আমি পেমেন্ট করেছি, TrxID XYZ',
      name: null,
      phone: null,
      products: [],
      history: [],
      paymentClaim: {
        isPaymentClaim: true,
        method: 'bkash',
        trxId: 'XYZ',
        trxValid: false,
        rejectionReason: 'invalid_trxid',
        amount: 0,
      },
    });
    expect(insertCalls()).toHaveLength(0);
    expect(result.replyText).toMatch(/১০ অক্ষরের TrxID/);
  });
});
