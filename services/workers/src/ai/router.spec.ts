import { describe, it } from 'node:test';
import assert from 'node:assert';
import { demoResponder } from './router.ts';

describe('demoResponder (Workers)', () => {
  it('answers delivery questions from knowledge when seeded', () => {
    const knowledge = [
      {
        title: 'Delivery Policy',
        content: 'Delivery charge 130 taka nationwide via Steadfast.',
      },
    ];

    const reply = demoResponder('client1', 'What is your delivery charge?', [], [], knowledge);
    assert.ok(reply.includes('130'), 'reply must contain 130');
    assert.ok(!reply.includes('60'), 'reply must not contain default 60');
    assert.ok(!reply.includes('120'), 'reply must not contain default 120');
  });

  it('returns generic delivery template when knowledge is empty', () => {
    const replyEn = demoResponder('client1', 'What is the delivery fee?', [], []);
    assert.ok(replyEn.includes('60') && replyEn.includes('120'), 'generic English template must contain 60 and 120');

    const replyBn = demoResponder('client1', 'আপনাদের ডেলিভারি চার্জ কত?', [], []);
    assert.ok(replyBn.includes('৬০') && replyBn.includes('১২০'), 'generic Bangla template must contain 60 and 120');
  });

  it('F4: does not confuse charger/চার্জার with delivery charge and matches product', () => {
    const products = [
      {
        name: 'Charger X',
        price_bdt: 450,
        stock: 20,
      },
    ];

    const replyBn = demoResponder('client1', 'চার্জার এর দাম কত?', products, []);
    assert.ok(!replyBn.includes('৬০') && !replyBn.includes('১২০'), 'should not contain delivery template');
    assert.ok(replyBn.includes('Charger X') && replyBn.includes('450'), 'must match Charger X product and price');

    const replyEn = demoResponder('client1', 'How much is the charger?', products, []);
    assert.ok(!replyEn.includes('60') && !replyEn.includes('120'), 'should not contain delivery template');
    assert.ok(replyEn.includes('Charger X') && replyEn.includes('450'), 'must match Charger X product and price');
  });

  it('answers policy questions from seeded knowledge', () => {
    const knowledge = [
      {
        title: 'Return Policy',
        content: 'Returns accepted within 14 business days.',
      },
    ];

    const reply = demoResponder('client1', 'What is your return policy?', [], [], knowledge);
    assert.ok(reply.includes('14 business days'), 'must return seeded policy');
  });
});
