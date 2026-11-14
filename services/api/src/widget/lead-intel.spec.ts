import { describe, it, expect } from 'vitest';
import { extractLeadSignals } from './lead-intel.js';

/**
 * P15 (2026-11-15): lead fields must be populated from the real chat,
 * never left at the hardcoded 20 / 'warm' placeholder.
 */
describe('extractLeadSignals — lead intel from chat (P15)', () => {
  const products = [
    { id: 1, name: 'chocklate', price_bdt: 700, stock: 50 },
    { id: 2, name: 'Red Hoodie', price_bdt: 1200, stock: 5 },
  ];

  it('extracts product, intent, value and a hot temperature', () => {
    const s = extractLeadSignals('I want to buy 2 chocklate, price koto?', products);
    expect(s.productAffinity[0]?.name).toBe('chocklate');
    expect(s.productAffinity[0]?.quantity).toBe(2);
    expect(s.predictedValueBdt).toBe(1400);
    expect(s.intentSummary).toBe('wants to buy');
    expect(s.score).toBeGreaterThanOrEqual(60);
    expect(s.temperature).toBe('hot');
    expect(s.conversionProbability).toBe(s.score / 100);
    expect(s.nextAction).toContain('chocklate');
  });

  it('leaves every field empty/zero when the chat says nothing', () => {
    const s = extractLeadSignals('hello', products);
    expect(s.productAffinity).toEqual([]);
    expect(s.intentSummary).toBe('');
    expect(s.score).toBe(0);
    expect(s.temperature).toBe('cold');
    expect(s.predictedValueBdt).toBe(0);
    expect(s.conversionProbability).toBe(0);
    expect(s.nextAction).toBe('');
  });

  it('matches a Bengali buy intent with a product', () => {
    const s = extractLeadSignals('chocklate কিনতে চাই', products);
    expect(s.productAffinity[0]?.name).toBe('chocklate');
    expect(s.intentSummary).toBe('wants to buy');
    expect(s.temperature).not.toBe('cold');
  });

  it('detects a price question without a product', () => {
    const s = extractLeadSignals('price koto?', products);
    expect(s.productAffinity).toEqual([]);
    expect(s.intentSummary).toBe('asking price');
    expect(s.predictedValueBdt).toBe(0);
  });
});
