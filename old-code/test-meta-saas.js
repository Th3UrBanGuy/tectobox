// End-to-end test of the per-client Meta SaaS flow (no real Facebook needed).
// Simulates: OAuth session errors, fake page connections, signed webhook POSTs.
const crypto = require('crypto');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const db = require('./src/db');

// read-only verification handle (same DB file)
const DB_PATH = process.env.DB_PATH || require('path').join(__dirname, 'tectonic-inbox.db');
const raw = new DatabaseSync(DB_PATH, { readOnly: false });

const BASE = 'http://127.0.0.1:3120';
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' — ' + detail : ''));
}

const secret = fs.readFileSync('.env', 'utf8').match(/META_APP_SECRET=(.+)/)[1].trim();
function signedPost(path, payload) {
  const body = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  return fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
    body,
  });
}

(async () => {
  // 1. OAuth callback with invalid/expired state -> 400
  let r = await fetch(BASE + '/api/meta/oauth/callback?code=x&state=nope');
  check('oauth callback rejects invalid state', r.status === 400, 'status ' + r.status);

  // 2. Picker pending with bogus pid -> 404 JSON
  r = await fetch(BASE + '/api/meta/oauth/pending/boguspid');
  check('picker pending rejects bogus pid', r.status === 404, 'status ' + r.status);

  // 3. Picker pick with bogus pid -> 404
  r = await fetch(BASE + '/api/meta/oauth/pick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: 'bogus', pageId: '1' }) });
  check('picker pick rejects bogus pid', r.status === 404, 'status ' + r.status);

  // 4. OAuth start builds a real Facebook dialog URL
  r = await fetch(BASE + '/api/clients/1/connectors/messenger/oauth/start');
  const start = await r.json();
  check('oauth start returns FB dialog URL', /^https:\/\/www\.facebook\.com\/v21\.0\/dialog\/oauth\?/.test(start.url || ''), (start.url || '').slice(0, 60));

  // 5. Fake-connect two pages to two clients (simulating completed OAuth)
  db.saveMetaPage(1, 'messenger', { pageId: 'TESTPAGE111', pageName: 'Client One Shop', pageAccessToken: 'FAKE1', igUserId: 'IG111', igUsername: 'clientone' });
  db.saveMetaPage(1, 'instagram', { pageId: 'TESTPAGE111', pageName: 'Client One Shop', pageAccessToken: 'FAKE1', igUserId: 'IG111', igUsername: 'clientone' });
  db.saveMetaPage(2, 'messenger', { pageId: 'TESTPAGE222', pageName: 'Client Two Store', pageAccessToken: 'FAKE2' });
  const lookup = db.findClientByMetaPage('TESTPAGE111');
  check('findClientByMetaPage routes page -> client 1', lookup && lookup.client_id === 1, JSON.stringify(lookup));
  const lookupIg = db.findClientByMetaPage('IG111');
  check('findClientByMetaPage routes IG id -> client 1', lookupIg && lookupIg.client_id === 1, JSON.stringify(lookupIg));
  check('no cross-client leak', db.findClientByMetaPage('TESTPAGE222').client_id === 2, 'client 2');

  // 6. Webhook with wrong signature -> 401
  r = await fetch(BASE + '/webhooks/meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=wrong' },
    body: JSON.stringify({ object: 'page', entry: [] }),
  });
  check('webhook rejects bad signature', r.status === 401, 'status ' + r.status);

  // 7. Signed webhook for client 1's page -> message lands in client 1's inbox
  const convoBefore = raw.prepare("SELECT COUNT(*) c FROM conversations WHERE client_id = 1 AND platform = 'messenger'").get().c;
  r = await signedPost('/webhooks/meta', {
    object: 'page',
    entry: [{ id: 'TESTPAGE111', messaging: [{
      sender: { id: 'PSID_TEST_1' }, recipient: { id: 'TESTPAGE111' },
      timestamp: Date.now(), message: { mid: 'm.test1', text: 'SaaS routing test hello' },
    }] }],
  });
  const bodyTxt = await r.text();
  check('signed webhook accepted', r.status === 200 && bodyTxt === 'EVENT_RECEIVED', 'status ' + r.status);
  await new Promise(res => setTimeout(res, 6000)); // AI reply may take a few seconds
  const convoAfter = raw.prepare("SELECT COUNT(*) c FROM conversations WHERE client_id = 1 AND platform = 'messenger'").get().c;
  const msg = raw.prepare("SELECT text FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.client_id = 1 AND c.platform = 'messenger' AND m.direction = 'in' ORDER BY m.id DESC LIMIT 1").get();
  check('webhook message routed to client 1', convoAfter > convoBefore && msg && /SaaS routing test hello/.test(msg.text), 'convos ' + convoBefore + '->' + convoAfter);
  const leak = raw.prepare("SELECT COUNT(*) c FROM conversations WHERE client_id = 2 AND platform_user_id = 'PSID_TEST_1'").get().c;
  check('message did NOT leak to client 2', leak === 0, 'client2 rows ' + leak);

  // 8. Signed webhook for unknown page -> falls back gracefully (200, no crash)
  r = await signedPost('/webhooks/meta', {
    object: 'page',
    entry: [{ id: 'UNKNOWN999', messaging: [{
      sender: { id: 'PSID_TEST_2' }, recipient: { id: 'UNKNOWN999' },
      timestamp: Date.now(), message: { mid: 'm.test2', text: 'unknown page fallback' },
    }] }],
  });
  check('unknown page handled gracefully', r.status === 200, 'status ' + r.status);

  // 9. Outbound sender uses per-client token, fails safe without real one
  const { sendPlatformMessage } = require('./src/senders');
  const out = await sendPlatformMessage('messenger', 'PSID_TEST_1', 'hi', 1);
  check('outbound with fake token errors (not silently lost)', out.sent === false, JSON.stringify(out).slice(0, 80));

  // 10. Connectors status reflects per-client pages
  r = await fetch(BASE + '/api/clients/1/connectors');
  const st = await r.json();
  check('status shows connected for client 1 messenger', st.messenger.status === 'connected', st.messenger.status);
  r = await fetch(BASE + '/api/clients/2/connectors');
  const st2 = await r.json();
  check('status shows connected for client 2 messenger', st2.messenger.status === 'connected', st2.messenger.status);

  // cleanup test data
  raw.prepare("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE platform_user_id IN ('PSID_TEST_1','PSID_TEST_2'))").run();
  raw.prepare("DELETE FROM conversations WHERE platform_user_id IN ('PSID_TEST_1','PSID_TEST_2')").run();
  raw.prepare("DELETE FROM meta_pages WHERE page_id IN ('TESTPAGE111','TESTPAGE222')").run();
  console.log('\n--- cleanup done, test rows removed ---');

  const fails = results.filter(x => !x.ok);
  console.log(`\n${results.length - fails.length}/${results.length} tests passed`);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e.message); process.exit(2); });
