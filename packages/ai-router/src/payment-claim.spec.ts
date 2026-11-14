import { describe, it, expect } from 'vitest';
import { parsePaymentClaim, isValidTrxId, TRX_ID_LENGTH } from './payment-claim.js';

/**
 * W5 (2026-11-15): a payment claim must never accept an invalid TrxID,
 * never invent an amount, and never fabricate a CLAIM id.
 */
describe('parsePaymentClaim — TrxID validation (W5)', () => {
  const chocklate = { name: 'chocklate', sku: 'CHOC-1', price_bdt: 700, stock: 10 };

  it('rejects the audit case: "I paid, TrxID is XYZ"', () => {
    const claim = parsePaymentClaim('I paid, TrxID is XYZ', [chocklate as any], []);
    expect(claim).not.toBeNull();
    expect(claim!.trxValid).toBe(false);
    expect(claim!.rejectionReason).toBe('invalid_trxid');
    expect(claim!.trxId).toBe('XYZ');
    // No fabricated CLAIM id, no invented amount.
    expect(claim!.trxId).not.toMatch(/^CLAIM-/);
    expect(claim!.amount).toBe(0);
  });

  it('accepts a valid 10-character bKash TrxID', () => {
    const claim = parsePaymentClaim('I paid, TrxID is 9HX7K2M4PQ', [chocklate as any], []);
    expect(claim).not.toBeNull();
    expect(claim!.trxValid).toBe(true);
    expect(claim!.rejectionReason).toBeUndefined();
    expect(claim!.method).toBe('bkash');
    expect(claim!.trxId).toBe('9HX7K2M4PQ');
  });

  it('accepts a valid 10-character Nagad TrxID and detects the method', () => {
    const claim = parsePaymentClaim('I sent money through Nagad, transaction id NAGAD98765', [], []);
    expect(claim).not.toBeNull();
    expect(claim!.trxValid).toBe(true);
    expect(claim!.method).toBe('nagad');
    expect(claim!.trxId).toBe('NAGAD98765');
  });

  it('rejects the audit case: 11-character Nagad id NAGAD987654', () => {
    const claim = parsePaymentClaim('I sent money through Nagad, transaction id NAGAD987654', [], []);
    expect(claim).not.toBeNull();
    expect(claim!.trxValid).toBe(false);
    expect(claim!.rejectionReason).toBe('invalid_trxid');
  });

  it('rejects a payment claim with no TrxID instead of fabricating one', () => {
    const claim = parsePaymentClaim('I paid via bKash', [chocklate as any], []);
    expect(claim).not.toBeNull();
    expect(claim!.trxValid).toBe(false);
    expect(claim!.rejectionReason).toBe('missing_trxid');
    expect(claim!.trxId).toBe('');
    expect(claim!.trxId).not.toMatch(/^CLAIM-/);
  });

  it('never invents an amount from the product catalog or history', () => {
    const history = [{ role: 'assistant', content: 'chocklate is 700.00 BDT' }];
    const claim = parsePaymentClaim('I paid, TrxID is 9HX7K2M4PQ', [chocklate as any], history);
    expect(claim!.trxValid).toBe(true);
    // No amount was stated — 0 means "unknown", never the chocklate price.
    expect(claim!.amount).toBe(0);
  });

  it('keeps an amount the customer stated in the message', () => {
    const claim = parsePaymentClaim('I paid 500 taka, TrxID ABCDEFGHIJ', [], []);
    expect(claim!.trxValid).toBe(true);
    expect(claim!.amount).toBe(500);
  });

  it('accepts a standalone 10-character token as the TrxID', () => {
    const claim = parsePaymentClaim('I paid ABCDEFGHIJ via bKash', [], []);
    expect(claim!.trxValid).toBe(true);
    expect(claim!.trxId).toBe('ABCDEFGHIJ');
  });

  it('does not mistake a phone number for a TrxID', () => {
    const claim = parsePaymentClaim('I paid, my bKash number is 01712345678', [], []);
    expect(claim).not.toBeNull();
    expect(claim!.trxValid).toBe(false);
    expect(claim!.rejectionReason).toBe('missing_trxid');
  });

  it('returns null when there is no payment intent at all', () => {
    expect(parsePaymentClaim('What is the price of the mug?', [], [])).toBeNull();
    expect(parsePaymentClaim('Do I need to pay advance for the order?', [], [])).toBeNull();
  });

  it('validates Rocket TrxIDs as 10 alphanumeric characters', () => {
    expect(isValidTrxId('rocket', '1234567890')).toBe(true);
    expect(isValidTrxId('rocket', 'ROCKET1')).toBe(false);
    expect(TRX_ID_LENGTH).toBe(10);
  });

  it('isValidTrxId: bKash/Nagad require exactly 10 alphanumeric chars', () => {
    expect(isValidTrxId('bkash', 'XYZ')).toBe(false);
    expect(isValidTrxId('bkash', 'ABCDEFGHIJK')).toBe(false);
    expect(isValidTrxId('bkash', 'ABCD-12345')).toBe(false);
    expect(isValidTrxId('bkash', 'ABCD123456')).toBe(true);
    expect(isValidTrxId('nagad', 'NAGAD98765')).toBe(true);
    expect(isValidTrxId('nagad', 'NAGAD987654')).toBe(false);
  });
});
