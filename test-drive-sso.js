// Drive SSO + backup engine tests (2026-10-03).
// Runs against a TEMP SQLite DB — never touches production data.
process.env.SESSION_ENC_KEY = 'a'.repeat(64); // fixed test key, no .env writes
process.env.DB_PATH = `/tmp/tectonic-test-drive-${process.pid}.db`;

const assert = require('assert');
const fs = require('fs');
const { issueState, verifyState } = require('./src/drive-state');
const drive = require('./src/drive');
const db = require('./src/db');
const backup = require('./src/backup');

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log("PASS", name); }
  catch (e) { console.error('FAIL', name, '—', e.message); process.exitCode = 1; }
}
const req = (user) => ({ user });

// ---------- 1. OAuth state ----------
const alice = { id: 7, username: 'alice', role: 'client', clientId: 4 };
const bob = { id: 9, username: 'bob', role: 'client', clientId: 5 };

ok('state round-trip', () => {
  const s = issueState(alice, 4);
  assert.strictEqual(verifyState(req(alice), s), 4);
});
ok('state single-use (replay rejected)', () => {
  const s = issueState(alice, 4);
  verifyState(req(alice), s);
  assert.throws(() => verifyState(req(alice), s), /already used/);
});
ok('tampered state rejected', () => {
  const s = issueState(alice, 4);
  const [body] = s.split('.');
  assert.throws(() => verifyState(req(alice), body + '.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), /signature/);
});
ok('wrong session user rejected', () => {
  const s = issueState(alice, 4);
  assert.throws(() => verifyState(req(bob), s), /not your flow/);
});
ok('cross-workspace rejected for non-admin', () => {
  const s = issueState(alice, 5); // alice trying for bob's workspace
  assert.throws(() => verifyState(req(alice), s), /forbidden/);
});
ok('garbage state rejected', () => {
  assert.throws(() => verifyState(req(alice), 'not-a-state'), /Invalid OAuth state/);
  assert.throws(() => verifyState(req(alice), ''), /Invalid OAuth state/);
});
ok('admin can issue for any client', () => {
  const admin = { id: 1, username: 'admin', role: 'admin', clientId: null };
  const s = issueState(admin, 5);
  assert.strictEqual(verifyState(req(admin), s), 5);
});

// ---------- 2. token encryption ----------
ok('tokens encrypted at rest, decrypt on read', () => {
  drive.saveDriveTokenSecure(4, { access_token: 'ya29.AT', refresh_token: '1//RT', expires_at: 999, email: 'a@x.com' });
  const raw = db.getDriveToken(4);
  assert.ok(raw.access_token.startsWith('enc:v1:'), 'access_token must be encrypted');
  assert.ok(raw.refresh_token.startsWith('enc:v1:'), 'refresh_token must be encrypted');
  assert.ok(!raw.access_token.includes('ya29.AT'), 'no plaintext leak');
  const t = drive.getDriveTokenSecure(4);
  assert.strictEqual(t.access_token, 'ya29.AT');
  assert.strictEqual(t.refresh_token, '1//RT');
  assert.strictEqual(t.email, 'a@x.com');
  assert.ok(drive.driveConnected(4));
});
ok('legacy plaintext rows still readable', () => {
  db.saveDriveToken(5, { access_token: 'plain-at', refresh_token: 'plain-rt', expires_at: 999, email: null });
  const t = drive.getDriveTokenSecure(5);
  assert.strictEqual(t.access_token, 'plain-at');
  assert.strictEqual(t.refresh_token, 'plain-rt');
});
ok('driveApi is exported', () => {
  assert.strictEqual(typeof drive.driveApi, 'function');
  assert.strictEqual(typeof drive.getAccountEmail, 'function');
});

// ---------- 3. backup export/import round-trip ----------
const clientA = db.createClient({ name: 'Test Shop A', business_type: 'physical' });
db.addProduct({ clientId: clientA.id, sku: 'SKU-T1', name: 'Test Kurti', category: 'Fashion', price_bdt: 1200, stock: 10 });
db.addKnowledge(clientA.id, { title: 'Test Policy', content: '40% advance required', category: 'policy', source_url: 'test:policy' });
const conv = db.upsertConversation({ clientId: clientA.id, platform: 'webchat', platformUserId: 'u1', customerName: 'Rahim', bumpUnread: false });
db.addMessage(conv.id, 'in', 'dam koto?', null, '2026-10-01T10:00:00Z', 'ext-1');
db.addMessage(conv.id, 'out', '1200 BDT', null, '2026-10-01T10:01:00Z', 'ext-2');
db.createOrder(conv.id, [{ sku: 'SKU-T1', qty: 1 }], 'test-order-1', { deliveryCharge: 60, advanceRequired: 480, advancePaid: 480, transactionId: 'TRX1', paymentStatus: 'partial' });
db.upsertLead({ clientId: clientA.id, platform: 'webchat', platformUserId: 'u1', fields: { name: 'Rahim', phone: '01700000000' } });
db.setWebchatAppearance(clientA.id, { title: 'Test Shop', color: '#ff0000' });

let bundle;
ok('export collects everything', () => {
  bundle = backup.exportClientData(clientA.id);
  assert.strictEqual(bundle.products.length, 1);
  assert.strictEqual(bundle.knowledge.length, 1);
  assert.strictEqual(bundle.leads.length, 1);
  assert.strictEqual(bundle.orders.length, 1);
  assert.strictEqual(bundle.conversations.length, 1);
  assert.strictEqual(bundle.conversations[0].messages.length, 2);
  assert.ok(bundle.appearance && bundle.appearance.color === '#ff0000');
  assert.ok(bundleToMarkdownHas(bundle));
  function bundleToMarkdownHas(b) { return backup.bundleToMarkdown(b).includes('Test Shop A'); }
});

const clientB = db.createClient({ name: 'Test Shop B', business_type: 'physical' });
let counts1;
ok('import restores everything into another client', () => {
  counts1 = backup.importClientData(clientB.id, bundle);
  assert.strictEqual(counts1.products, 1);
  assert.strictEqual(counts1.knowledge, 1);
  assert.strictEqual(counts1.leads, 1);
  assert.strictEqual(counts1.orders, 1);
  assert.strictEqual(counts1.conversations, 1);
  assert.strictEqual(counts1.messages, 2);
  assert.strictEqual(counts1.appearance, 1);
  // Verify the data actually landed.
  assert.ok(db.findProductBySku('SKU-T1', clientB.id));
  assert.strictEqual(db.getKnowledge(clientB.id).length, 1);
  assert.ok(db.getLeadByPlatform(clientB.id, 'webchat', 'u1'));
  const convs = db.getConversations({ clientId: clientB.id });
  assert.strictEqual(convs.length, 1);
  assert.strictEqual(db.getMessages(convs[0].id).length, 2);
  assert.strictEqual(db.getOrders(clientB.id).length, 1);
  // Restored order points at the restored conversation, not the old ID.
  const restoredOrder = db.getOrders(clientB.id)[0];
  assert.strictEqual(restoredOrder.conversation_id, convs[0].id);
  assert.strictEqual(db.getWebchatAppearance(clientB.id).color, '#ff0000');
});

ok('import is idempotent (second import adds nothing)', () => {
  const c2 = backup.importClientData(clientB.id, bundle);
  assert.deepStrictEqual(c2, { products: 0, knowledge: 0, leads: 0, orders: 0, conversations: 0, messages: 0, appearance: 0 });
});

ok('export-all includes client list + data', () => {
  const all = backup.exportAllClients();
  assert.strictEqual(all.scope, 'all-clients');
  assert.ok(all.clients.length >= 2);
  assert.ok(all.clients.every(c => c.client && c.client.name && c.data && Array.isArray(c.data.products)));
});

ok('invalid bundles rejected', () => {
  assert.throws(() => backup.importClientData(clientB.id, null), /valid Tectonic backup/);
  assert.throws(() => backup.importClientData(clientB.id, { version: 99, app: 'tectonic-inbox' }), /valid Tectonic backup/);
});

// cleanup temp db
try { fs.unlinkSync(process.env.DB_PATH); } catch {}
console.log(pass + ' CHECKS PASS');
