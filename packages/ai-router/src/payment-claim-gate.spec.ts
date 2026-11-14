import { describe, it, expect } from 'vitest';
import { isActualPaymentStatement } from './payment-claim-gate.js';

/**
 * P16 (2026-11-15): a payment claim is triggered ONLY by an actual
 * payment statement WITH a TrxID. Questions about payment must never
 * reach the claim handler.
 */
describe('isActualPaymentStatement — claim trigger gate (P16)', () => {
  it('rejects the audit cases: questions about payment', () => {
    expect(isActualPaymentStatement('Can I pay with bKash?', 'X')).toBe(false);
    expect(isActualPaymentStatement('What is your bKash number?', 'X')).toBe(false);
    expect(isActualPaymentStatement('Do you accept bKash?', 'X')).toBe(false);
    expect(isActualPaymentStatement('How do I pay?', 'X')).toBe(false);
  });

  it('rejects a statement with no TrxID', () => {
    expect(isActualPaymentStatement('I paid for the chocklate', '')).toBe(false);
    expect(isActualPaymentStatement('payment done', '')).toBe(false);
  });

  it('accepts an actual payment statement with a TrxID', () => {
    expect(isActualPaymentStatement('I paid, TrxID is XYZ', 'XYZ')).toBe(true);
    expect(isActualPaymentStatement('Payment done, TrxID: 9H7K2M4P1Q', '9H7K2M4P1Q')).toBe(true);
    expect(isActualPaymentStatement('Sent money, TrxID 8A3B9C2D1E', '8A3B9C2D1E')).toBe(true);
  });

  it('accepts Bengali payment statements with a TrxID', () => {
    expect(isActualPaymentStatement('টাকা পাঠিয়েছি, TrxID 9H7K2M4P1Q', '9H7K2M4P1Q')).toBe(true);
    expect(isActualPaymentStatement('পেমেন্ট করেছি TrxID 8A3B9C2D1E', '8A3B9C2D1E')).toBe(true);
    expect(isActualPaymentStatement('পেমেন্ট ডান, TrxID 8A3B9C2D1E', '8A3B9C2D1E')).toBe(true);
  });

  it('rejects a Bengali question even with a TrxID-looking token', () => {
    expect(isActualPaymentStatement('আপনার বিকাশ নম্বর কি?', '9H7K2M4P1Q')).toBe(false);
    expect(isActualPaymentStatement('কিভাবে পেমেন্ট করবো?', '9H7K2M4P1Q')).toBe(false);
  });
});
