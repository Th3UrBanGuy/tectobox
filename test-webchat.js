// Webchat widget tests — run: DB_PATH=/tmp/test-webchat.db node test-webchat.js
// The crawler's SSRF guard blocks loopback; the local fixture server needs the
// test bypass.
process.env.CRAWLER_ALLOW_PRIVATE = '1';
const assert = require('assert');
const http = require('http');
const db = require('./src/db');
const { normalizeMessage } = require('./src/normalize');
const crawler = require('./src/crawler');

let pass = 0;
const ok = (name, cond) => { assert(cond, name); pass++; console.log('  ✓', name); };

async function main() {
  console.log('[1] normalize webchat');
  const n = normalizeMessage('webchat', { visitor_id: 'v1', name: 'Rafi', text: 'hello', message_id: 'm1' });
  ok('valid widget payload', n && n.platform === 'webchat' && n.platformUserId === 'v1' && n.text === 'hello' && n.externalId === 'm1');
  ok('missing visitor_id → null', normalizeMessage('webchat', { text: 'hi' }) === null);
  ok('empty text → null', normalizeMessage('webchat', { visitor_id: 'v1', text: '  ' }) === null);

  console.log('[2] crawler text extraction');
  const html = `<html><head><title>Shop</title><style>.x{color:red}</style></head>
    <body><nav>Home About</nav><main><h1>Our Products</h1>
    <p>We sell <b>kurtis</b> &amp; sarees.</p><script>alert(1)</script></main>
    <footer>© 2026</footer></body></html>`;
  const txt = crawler.extractMainText(html);
  ok('keeps article text', txt.includes('kurtis') && txt.includes('sarees'));
  ok('strips script/style/nav/footer', !txt.includes('alert') && !txt.includes('color:red') && !txt.includes('© 2026'));

  console.log('[3] crawler categorization');
  ok('shipping url', crawler.categorizeByUrl('https://x.com/shipping-info') === 'shipping');
  ok('return url → policy', crawler.categorizeByUrl('https://x.com/return-policy') === 'policy');
  ok('faq url', crawler.categorizeByUrl('https://x.com/faqs') === 'faq');
  ok('shop url → product', crawler.categorizeByUrl('https://x.com/shop/kurti') === 'product');
  ok('other → general', crawler.categorizeByUrl('https://x.com/about-us') === 'general');

  console.log('[4] sitemap parsing');
  const sm = `<?xml version="1.0"?><urlset><url><loc>https://x.com/a</loc></url><url><loc>https://x.com/b</loc></url></urlset>`;
  ok('two locs', crawler.sitemapUrls(sm).length === 2);

  console.log('[5] full website import against a local server');
  const srv = http.createServer((req, res) => {
    if (req.url === '/sitemap.xml') {
      res.setHeader('content-type', 'application/xml');
      return res.end(`<urlset><url><loc>http://127.0.0.1:PORTX/</loc></url><url><loc>http://127.0.0.1:PORTX/shipping</loc></url><url><loc>http://127.0.0.1:PORTX/thin</loc></url></urlset>`.replace(/PORTX/g, srv.address().port));
    }
    res.setHeader('content-type', 'text/html');
    if (req.url === '/shipping') return res.end('<html><head><title>Shipping Info</title></head><body><main><p>We deliver inside Dhaka in 24 hours and outside Dhaka in 48 to 72 hours. Delivery charge inside Dhaka is 60 taka and outside Dhaka is 120 taka. Cash on delivery is available all over Bangladesh. Please keep your phone reachable so our courier partner can contact you for a smooth handover.</p></main></body></html>');
    if (req.url === '/thin') return res.end('<html><body><div id="app"></div><script>render()</script></body></html>');
    res.end('<html><head><title>Demo Shop</title></head><body><main><p>Welcome to Demo Shop. We sell the best kurtis in town, made from premium georgette and soft cotton fabrics. Our collection includes casual everyday kurtis, elegant party wear, and festive Eid specials. Every piece is quality checked before dispatch and we offer easy size exchanges within seven days of delivery.</p></main></body></html>');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const client = db.createClient({ name: 'WebchatTest', business_type: 'physical' });
  const r = await crawler.importWebsite(client.id, base);
  ok('discovered 3 pages', r.discovered === 3);
  ok('imported 2 (thin skipped)', r.imported === 2);
  ok('thin page reported', r.thin.length === 1);
  ok('website_url saved', db.getClient(client.id).website_url === base + '/');
  const kb = db.getKnowledge(client.id);
  ok('2 KB rows', kb.length === 2);
  ok('shipping categorized', kb.some(k => k.category === 'shipping' && k.content.includes('60 taka')));
  ok('source_url stored', kb.every(k => k.source_url && k.source_url.startsWith(base)));
  const r2 = await crawler.importWebsite(client.id, base);
  ok('re-import is idempotent (no dup rows)', db.getKnowledge(client.id).length === 2 && r2.imported === 2);
  srv.close();

  console.log('[6] widget key plumbing');
  ok('new client has widget_key', typeof client.widget_key === 'string' && client.widget_key.length >= 16);
  ok('lookup by key', db.getClientByWidgetKey(client.widget_key).id === client.id);
  ok('unknown key → null', db.getClientByWidgetKey('nope') === null);
  const c2 = db.createClient({ name: 'Second', business_type: 'physical' });
  ok('keys are unique', c2.widget_key !== client.widget_key);

  console.log(`\nALL ${pass} WEBCHAT TESTS PASSED`);
}
main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
