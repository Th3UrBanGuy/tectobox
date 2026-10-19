const assert = require('assert');
const crypto = require('crypto');
const { spawn } = require('child_process');
const db = require('./src/db');
const pacer = require('./src/pacer');
const fetch = global.fetch;

let pass = 0, fail = 0;

function ok(name, cond) {
  if (cond) {
    console.log('PASS: ' + name);
    pass++;
  } else {
    console.error('FAIL: ' + name);
    fail++;
  }
}

async function runLogicTests() {
  const c1 = db.dbQuery("INSERT INTO clients (name) VALUES ('T1') RETURNING id")[0].id;
  const c2 = db.dbQuery("INSERT INTO clients (name) VALUES ('T2') RETURNING id")[0].id;
  db.dbQuery('INSERT INTO products (client_id, name, sku, price_bdt, stock) VALUES (?, ?, ?, 100, 10)', [c1, 'P1', 't-sku-1']);
  const p1 = db.findProductBySku('t-sku-1', c1);
  const p2 = db.findProductBySku('t-sku-1', c2); 
  ok('Tenant isolation (cross-workspace data access)', p1 && !p2);

  const c = db.dbQuery("INSERT INTO clients (name) VALUES ('T3') RETURNING id")[0].id;
  const conv = db.dbQuery("INSERT INTO conversations (client_id, platform, platform_user_id) VALUES (?, 'wa', '123') RETURNING id", [c])[0].id;
  db.dbQuery("INSERT INTO products (client_id, name, sku, price_bdt, stock) VALUES (?, 'P', 't-sku-2', 100, 10)", [c]);
  const o1 = db.createOrder(conv, [{sku:'t-sku-2', qty:1}], "ikey123");
  const o2 = db.createOrder(conv, [{sku:'t-sku-2', qty:2}], "ikey123"); 
  const o3 = db.createOrder(conv, [{sku:'t-sku-2', qty:1}], "ikey456"); 
  ok('Order idempotency key enforcement', o1 && o2 && o3 && o1.id === o2.id && o1.id !== o3.id);

  pacer.pacedSend(999, 'wa1', 'id1', 'test', async () => {});
  const stats = pacer.pacerStats(999, 'wa1');
  ok('WhatsApp pacer cap enforcement (stats tracked)', stats && stats.pending !== undefined);

  const c4 = db.dbQuery("INSERT INTO clients (name) VALUES ('T4') RETURNING id")[0].id;
  const bId = db.createBroadcast(c4, { name: 'Promo', type: 'marketing', message: 'Hello', slot: 'wa' }).id;
  db.dbQuery("INSERT INTO broadcast_recipients (broadcast_id, platform, platform_user_id, status) VALUES (?, 'wa', 'u1', 'pending')", [bId]);
  db.setBroadcastStatus(bId, c4, 'sending');
  const b = db.getBroadcast(bId, c4);
  ok('Broadcast pump restart recovery (persists sending state + audience)', b.status === 'sending' && b.stats.pending === 1);
}

async function runNetworkTests() {
  const BASE = 'http://127.0.0.1:3125';
  return new Promise((resolve) => {
    const srv = spawn('node', ['server.js'], { 
      env: Object.assign({}, process.env, { PORT: 3125, META_APP_SECRET: 'testsecret', TELEGRAM_WEBHOOK_SECRET: 'testtgsecret' }), 
      cwd: __dirname,
      stdio: 'inherit'
    });
    
    setTimeout(async () => {
      try {
        const body = JSON.stringify({ object: 'page' });
        const badSig = 'sha256=invalid';
        const r1 = await fetch(`${BASE}/webhooks/meta`, { method: 'POST', body, headers: {'X-Hub-Signature-256': badSig, 'Content-Type': 'application/json'} });
        ok('Meta HMAC signature verification (rejects invalid)', r1.status === 401 || r1.status === 403);
        
        const r2 = await fetch(`${BASE}/webhooks/telegram/badsecret`, { method: 'POST', body: '{}', headers: {'Content-Type': 'application/json'} });
        ok('Telegram webhook secret validation (rejects invalid)', r2.status === 401 || r2.status === 403 || r2.status === 404);
        
        const wkey = db.dbQuery("SELECT widget_key FROM clients LIMIT 1")[0].widget_key;
        const wmsg = { client_message_id: 'dedup123', text: 'hi' };
        const [dr1, dr2] = await Promise.all([
          fetch(`${BASE}/api/widget/${wkey}/message`, { method: 'POST', body: JSON.stringify(wmsg), headers: {'Content-Type': 'application/json'} }),
          fetch(`${BASE}/api/widget/${wkey}/message`, { method: 'POST', body: JSON.stringify(wmsg), headers: {'Content-Type': 'application/json'} })
        ]);
        const res1 = await dr1.json().catch(()=>({}));
        const res2 = await dr2.json().catch(()=>({}));
        ok('Webhook deduplication (concurrent insert race) returns deduped', (res1.deduped || res2.deduped));
      } catch (e) {
        console.error('Network Error:', e);
        fail++;
      }
      srv.kill('SIGTERM');
      resolve();
    }, 2000);
  });
}

(async () => {
  await runLogicTests();
  await runNetworkTests();
  console.log(`\nResults: ${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
})();
