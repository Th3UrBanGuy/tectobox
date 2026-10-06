// Group-mode tests: Telegram groups stay silent unless the account is mentioned,
// and mentions get a human-like reply with the last messages as context.
// Run: node test-group-mode.js
'use strict';
const assert = require('assert');
const { normalizeMessage } = require('./src/normalize');
const ai = require('./src/ai');

let pass = 0;
function ok(name, cond) {
  assert(cond, 'FAILED: ' + name);
  pass++;
  console.log('  ok -', name);
}

// ---------- 1. normalize: group-shaped raw (gramjs path) ----------
const groupRaw = {
  text: '@shopowner price koto?',
  message_id: 777,
  from: { id: 111, first_name: 'Rahim' },
  chat: { id: -555, type: 'group', title: 'Buyers Group' },
  mentioned: true,
  replyToMsgId: 777,
  groupHistory: [
    { name: 'Karim', text: 'ei shirt ta ache?' },
    { name: 'you', text: 'ha ache' },
  ],
};
const g = normalizeMessage('telegram', groupRaw);
ok('group: platformUserId is the GROUP id', g.platformUserId === '-555');
ok('group: customerName is the group title', g.customerName === 'Buyers Group');
ok('group: isGroup true', g.isGroup === true);
ok('group: mentioned true', g.mentioned === true);
ok('group: replyToMsgId passed through', g.replyToMsgId === 777);
ok('group: history passed through', Array.isArray(g.groupHistory) && g.groupHistory.length === 2);
ok('group: senderName kept', g.senderName === 'Rahim');

// ---------- 2. normalize: DM unchanged (Bot API shape) ----------
const dmRaw = {
  text: 'hello',
  message_id: 1,
  from: { id: 222, first_name: 'Ayesha' },
  chat: { id: 222, type: 'private' },
};
const d = normalizeMessage('telegram', dmRaw);
ok('dm: platformUserId is the user id', d.platformUserId === '222');
ok('dm: customerName is the sender', d.customerName === 'Ayesha');
ok('dm: isGroup false', d.isGroup === false);
ok('dm: no history', d.groupHistory === null);

// ---------- 3. group system prompt ----------
const client = { name: 'Test Shop' };
const extra = { senderName: 'Rahim', groupTitle: 'Buyers Group' };
const products = [{ name: 'Shirt', price_bdt: 550 }];
const sys = ai.buildGroupSystemPrompt(client, extra, products);
ok('prompt: names the group', sys.includes('Buyers Group'));
ok('prompt: names the mentioner', sys.includes('Rahim'));
ok('prompt: forbids AI reveal', /NEVER like a bot or AI/.test(sys));
ok('prompt: exact price verbatim', sys.includes('Shirt: 550 BDT'));
ok('prompt: short-reply rule', /1-2 sentences/.test(sys));
ok('prompt: no JSON contract', !sys.includes('Respond with JSON'));

// ---------- 4. aiResponder group branch end-to-end (stubbed fetch) ----------
let capturedBody = null;
global.fetch = async (url, opts) => {
  capturedBody = JSON.parse(opts.body);
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'ha bhai, 550 taka — nile janaiyo' } }] }),
  };
};

(async () => {
  const conv = { id: 999, client_id: 1, platform: 'telegram', platform_user_id: '-555' };
  const reply = await ai.aiResponder(conv, '@shopowner price koto?', {
    isGroup: true,
    senderName: 'Rahim',
    groupTitle: 'Buyers Group',
    groupHistory: [
      { name: 'Karim', text: 'ei shirt ta ache?' },
      { name: 'you', text: 'ha ache' },
    ],
  });
  ok('aiResponder: returns the model text', reply === 'ha bhai, 550 taka — nile janaiyo');
  const sysMsg = capturedBody.messages.find(m => m.role === 'system');
  ok('aiResponder: system prompt sent', sysMsg && /human owner/.test(sysMsg.content));
  const ctxMsg = capturedBody.messages.find(m => m.role === 'user' && /context only/.test(m.content));
  ok('aiResponder: last messages sent as context', ctxMsg && ctxMsg.content.includes('Karim: ei shirt ta ache?'));
  const mentionMsg = capturedBody.messages[capturedBody.messages.length - 1];
  ok('aiResponder: mention is the final user turn', /Rahim mentioned you/.test(mentionMsg.content));
  console.log(`\nALL ${pass} GROUP-MODE TESTS PASSED`);
})().catch((e) => { console.error('\nTEST FAILURE:', e.message); process.exit(1); });
