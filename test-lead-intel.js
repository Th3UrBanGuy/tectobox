// Disposable-DB test for the Lead Intelligence engine.
// Run: DB_PATH=/tmp/test-lead-intel.db node test-lead-intel.js
// Uses a stubbed AI (no network, no keys) via require-cache injection.
const assert = require('assert');

const DB = process.env.DB_PATH || '/tmp/test-lead-intel.db';
require('fs').rmSync(DB, { force: true });

// ---- stub ./ai BEFORE lead-intel loads it ----
const aiPath = require.resolve('./src/ai.js');
let aiCalls = 0;
let aiStub = async (messages, scope) => {
  aiCalls++;
  assert.ok(scope.startsWith('leadintel:'), 'scope must be leadintel-scoped, got ' + scope);
  return JSON.stringify({
    stage: 'intent', score: 82, temperature: 'hot',
    product_affinity: [{ product: 'Chocklate kitkat', confidence: 0.9 }],
    intent_summary: 'wants to buy chocolate',
    predicted_value_bdt: 600, conversion_probability: 0.75,
    next_action: 'Send follow-up tomorrow morning',
    followup_due_at: '2026-10-02T04:00:00.000Z',
    verification_state: 'partial', reasoning: 'asked price twice',
  });
};
require.cache[aiPath] = {
  id: aiPath, filename: aiPath, loaded: true,
  exports: { getAIResponse: (messages, scope) => aiStub(messages, scope) },
};

const db = require('./src/db');
const li = require('./src/lead-intel');

(async () => {
  // 1. migration: columns exist
  const cols = db.__test_cols
    ? db.__test_cols('leads')
    : null;
  // (no test helper exported; check via a fresh DatabaseSync read)
  const { DatabaseSync } = require('node:sqlite');
  const probe = new DatabaseSync(DB);
  const names = probe.prepare('PRAGMA table_info(leads)').all().map(r => r.name);
  probe.close();
  for (const c of ['stage', 'score', 'temperature', 'product_affinity_json', 'intent_summary',
    'predicted_value_bdt', 'conversion_probability', 'next_action', 'last_intent_at',
    'followup_due_at', 'source', 'verification_state', 'intel_updated_at']) {
    assert.ok(names.includes(c), 'missing column ' + c);
  }
  console.log('PASS: migration added all intel columns');

  // 2. seed: client + lead + conversation + messages + product
  const clientId = db.createClient({ name: 'TestCo', business_type: 'physical' }).id;
  db.addProduct({ clientId, sku: 'CK1', name: 'Chocklate kitkat', category: 'food', price_bdt: 600, stock: 10 });
  const lead = db.upsertLead({ clientId, platform: 'telegram', platformUserId: 'u1',
    fields: { name: 'Rahim', phone: '01700000000' } });
  assert.strictEqual(lead.status, 'user', 'name+phone => status user');
  assert.strictEqual(lead.stage, 'new', 'default stage new');
  const conv = db.upsertConversation({ clientId, platform: 'telegram', platformUserId: 'u1' });
  db.addMessage(conv.id, 'in', 'Chocklate kitkat er dam koto?');
  db.addMessage(conv.id, 'out', '600 taka');
  db.addMessage(conv.id, 'in', 'Ami nibo, order korbo');

  // 3. analyzeLead updates intel fields + maps stage->status
  const r = await li.analyzeLead(clientId, 'telegram', 'u1');
  assert.ok(r.ok, 'analyzeLead ok: ' + JSON.stringify(r));
  assert.strictEqual(aiCalls, 1, 'AI called once');
  const l2 = db.getLead(lead.id);
  assert.strictEqual(l2.stage, 'intent');
  assert.strictEqual(l2.score, 82);
  assert.strictEqual(l2.temperature, 'hot');
  assert.strictEqual(l2.status, 'user', 'intent + name/phone keeps status user');
  assert.strictEqual(l2.intent_summary, 'wants to buy chocolate');
  assert.strictEqual(l2.predicted_value_bdt, 600);
  assert.strictEqual(l2.conversion_probability, 0.75);
  assert.strictEqual(l2.next_action, 'Send follow-up tomorrow morning');
  assert.strictEqual(l2.verification_state, 'partial');
  assert.ok(l2.intel_updated_at, 'intel_updated_at set');
  assert.ok(l2.last_intent_at, 'last_intent_at set for intent stage');
  const aff = JSON.parse(l2.product_affinity_json);
  assert.strictEqual(aff[0].product, 'Chocklate kitkat');
  console.log('PASS: analyzeLead writes + validates intel fields');

  // 4. debounce: second call within 15 min is skipped, AI not called
  const r2 = await li.analyzeLead(clientId, 'telegram', 'u1');
  assert.strictEqual(r2.skipped, 'debounced');
  assert.strictEqual(aiCalls, 1, 'debounced => no extra AI call');
  console.log('PASS: debounce skips recent leads');

  // 5. force bypasses debounce
  const r3 = await li.analyzeLead(clientId, 'telegram', 'u1', { force: true });
  assert.ok(r3.ok && aiCalls === 2, 'force re-analyzes');
  console.log('PASS: force bypasses debounce');

  // 6. stage->status mapping: converted => confirmed; converted is ground truth
  // and can never be downgraded by the intel engine (a buyer stays a buyer).
  db.updateLeadIntel(lead.id, { stage: 'converted', score: 99 });
  assert.strictEqual(db.getLead(lead.id).status, 'confirmed', 'converted => confirmed');
  db.updateLeadIntel(lead.id, { stage: 'lost', score: 5 });
  const l3 = db.getLead(lead.id);
  assert.strictEqual(l3.status, 'confirmed', 'never demote confirmed');
  assert.strictEqual(l3.stage, 'converted', 'never downgrade converted stage');
  assert.strictEqual(l3.score, 5);
  console.log('PASS: stage->status mapping (converted=>confirmed, no demotion)');

  // 7. clamping: score >100, bad enums ignored
  db.updateLeadIntel(lead.id, { score: 150, temperature: 'lava', stage: 'nope', conversion_probability: 9 });
  const l4 = db.getLead(lead.id);
  assert.strictEqual(l4.score, 100, 'score clamped to 100');
  assert.strictEqual(l4.temperature, 'hot', 'bad temperature ignored');
  assert.strictEqual(l4.stage, 'converted', 'bad stage ignored (converted is sticky)');
  assert.strictEqual(l4.conversion_probability, 1, 'probability clamped to 1');
  console.log('PASS: validation + clamping');

  // 7b. chat-format fallback replies ({reply,lead,order}) are rejected as
  // unparseable — no empty row is written, lead stays stale for retry
  aiStub = async () => { aiCalls++; return '{"reply":"hi","lead":{"name":null},"order":null}'; };
  const beforeCalls = aiCalls;
  const rChat = await li.analyzeLead(clientId, 'telegram', 'u1', { force: true });
  assert.strictEqual(rChat.skipped, 'unparseable');
  assert.strictEqual(aiCalls, beforeCalls + 1);
  const stillStale = db.getStaleIntelLeads(10, { maxAgeMs: 0, clientId }).some(l => l.id === lead.id);
  assert.ok(stillStale, 'rejected lead stays stale for retry');
  console.log('PASS: chat-shaped fallback output rejected, no empty row');
  aiStub = async (messages, scope) => {
    aiCalls++;
    assert.ok(scope.startsWith('leadintel:'), 'scope must be leadintel-scoped, got ' + scope);
    return JSON.stringify({
      stage: 'intent', score: 82, temperature: 'hot',
      product_affinity: [{ product: 'Chocklate kitkat', confidence: 0.9 }],
      intent_summary: 'wants to buy chocolate',
      predicted_value_bdt: 600, conversion_probability: 0.75,
      next_action: 'Send follow-up tomorrow morning',
      followup_due_at: '2026-10-02T04:00:00.000Z',
      verification_state: 'partial', reasoning: 'asked price twice',
    });
  };

  // 8. stats + stale sweep helpers
  const stats = db.getLeadIntelStats(clientId);
  assert.strictEqual(stats.total, 1);
  assert.strictEqual(stats.byTemperature.hot, 1);
  // make it stale again
  db.updateLeadIntel(lead.id, { score: 10 });
  const stale = db.getStaleIntelLeads(10, { maxAgeMs: 0, clientId });
  assert.ok(stale.length >= 1, 'stale query finds lead');
  console.log('PASS: intel stats + stale-lead query');

  // 9. sweepStaleLeads analyzes stale leads sequentially, never throws
  // backdate intel_updated_at so the lead is stale under the 6h window
  {
    const backdate = new DatabaseSync(DB);
    backdate.prepare('UPDATE leads SET intel_updated_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', lead.id);
    backdate.close();
  }
  const before = aiCalls;
  const sw = await li.sweepStaleLeads(5, { clientId });
  assert.strictEqual(sw.analyzed, 1);
  assert.ok(aiCalls > before, 'sweep called AI');
  // second sweep immediately after: nothing stale -> no AI call
  const sw2 = await li.sweepStaleLeads(5, { clientId });
  assert.strictEqual(sw2.analyzed, 0);
  assert.strictEqual(aiCalls, before + 1, 'fresh leads not re-analyzed');
  console.log('PASS: sweepStaleLeads');

  // 10. getLeads filters (lead stayed 'converted' through the sweep —
  // the ground-truth guard never lets intel downgrade a converted lead)
  const hot = db.getLeads({ clientId, temperature: 'hot' });
  assert.strictEqual(hot.length, 1);
  const cold = db.getLeads({ clientId, temperature: 'cold' });
  assert.strictEqual(cold.length, 0);
  const byStage = db.getLeads({ clientId, stage: 'converted' });
  assert.strictEqual(byStage.length, 1);
  const byIntent = db.getLeads({ clientId, stage: 'intent' });
  assert.strictEqual(byIntent.length, 0);
  console.log('PASS: getLeads temperature/stage filters');

  console.log('\nALL LEAD-INTEL TESTS PASSED');
  process.exit(0);
})().catch(err => { console.error('TEST FAILED:', err); process.exit(1); });
