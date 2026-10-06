// Tests for the lead-capture gate: casual chit-chat must NOT create lead rows.
// Only real buyers (product interest + details) become leads.
// Run: DB_PATH=/tmp/test-lead-gate.db node test-lead-gate.js
const assert = require('assert');
const { shouldCaptureLead, buildSystemPrompt } = require('./src/ai');

// 1. casual chit-chat: no existing lead, not qualified, no order => NO row
assert.strictEqual(
  shouldCaptureLead({ hasExistingLead: false, leadQualified: false, orderConfirmed: false }),
  false, 'casual chat must not create a lead row');

// 2. qualified buyer (product interest + name/phone) => row
assert.strictEqual(
  shouldCaptureLead({ hasExistingLead: false, leadQualified: true, orderConfirmed: false }),
  true, 'qualified buyer must create a lead row');

// 3. existing lead keeps getting field updates even on casual follow-ups
assert.strictEqual(
  shouldCaptureLead({ hasExistingLead: true, leadQualified: false, orderConfirmed: false }),
  true, 'existing lead must keep updating');

// 4. explicit order confirmation always captures (strongest signal)
assert.strictEqual(
  shouldCaptureLead({ hasExistingLead: false, leadQualified: false, orderConfirmed: true }),
  true, 'order confirmation must create a lead row');

// 5. missing/undefined flag => no capture (safe default)
assert.strictEqual(
  shouldCaptureLead({ hasExistingLead: false, leadQualified: undefined, orderConfirmed: false }),
  false, 'missing flag must default to no capture');
console.log('PASS: shouldCaptureLead gate (5 cases)');

// 6. the prompt actually carries the qualification + friendly-chat rules
const prompt = buildSystemPrompt({ name: 'TestShop', business_type: 'physical' }, [], []);
assert.ok(prompt.includes('lead_qualified'), 'prompt must define lead_qualified');
assert.ok(prompt.includes('CASUAL CHAT'), 'prompt must have the casual-chat rule');
assert.ok(prompt.includes('shown buying interest'), 'prompt must state the two conditions');
console.log('PASS: buildSystemPrompt carries qualification rules');

console.log('\nALL LEAD-GATE TESTS PASSED');
