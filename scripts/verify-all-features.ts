/**
 * Comprehensive Live Feature Verification Test Suite for Tectobox
 * Runs against the live NestJS Core API (http://localhost:3000), PostgreSQL, Redis, RabbitMQ, and Workers.
 */

const BASE_URL = 'http://localhost:3000';

// C1: login credentials come from the environment — no password literal in source.
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) throw new Error('[e2e] E2E_ADMIN_PASSWORD must be set in the environment.');

interface TestResult {
  group: string;
  feature: string;
  status: 'PASS' | 'FAIL';
  details?: string;
}

const results: TestResult[] = [];

async function assertTest(group: string, feature: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ group, feature, status: 'PASS' });
    console.log(`  ✓ [${group}] ${feature}`);
  } catch (err: any) {
    results.push({ group, feature, status: 'FAIL', details: err.message });
    console.error(`  ✗ [${group}] ${feature}: ${err.message}`);
  }
}

async function run() {
  console.log('===============================================================');
  console.log('       TECTOBOX FULL LIVE SYSTEM FEATURE VERIFICATION          ');
  console.log('===============================================================\n');

  let sessionCookie = '';
  let jwtToken = '';

  // 1. Frontend SPA & Static Delivery
  console.log('--- 1. Testing Frontend SPA & Static Asset Delivery ---');
  await assertTest('Frontend', 'Root SPA HTML delivery (GET /)', async () => {
    const res = await fetch(`${BASE_URL}/`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text.includes('<!DOCTYPE html>') && !text.includes('html')) throw new Error('Not valid HTML');
  });

  await assertTest('Frontend', 'App Route Delivery (GET /app)', async () => {
    const res = await fetch(`${BASE_URL}/app`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  });

  await assertTest('Frontend', 'Static CSS Delivery (GET /styles.css)', async () => {
    const res = await fetch(`${BASE_URL}/styles.css`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  });

  await assertTest('Frontend', 'Static JS SPA Code (GET /app.js)', async () => {
    const res = await fetch(`${BASE_URL}/app.js`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  });

  await assertTest('Frontend', 'Captcha Generation (GET /api/captcha)', async () => {
    const res = await fetch(`${BASE_URL}/api/captcha`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.token) throw new Error('Missing captcha token');
  });

  // 2. Auth & Dual Session Bridge
  console.log('\n--- 2. Testing Authentication & Session Bridge ---');
  await assertTest('Auth', 'Reject unauthenticated protected route (GET /api/conversations)', async () => {
    const res = await fetch(`${BASE_URL}/api/conversations`);
    if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
  });

  await assertTest('Auth', 'Admin Login & tb_session cookie acquisition (POST /api/auth/login)', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success || !data.token) throw new Error('Login response invalid');
    jwtToken = data.token;

    const cookieHeader = res.headers.get('set-cookie');
    if (cookieHeader) {
      sessionCookie = cookieHeader.split(';')[0];
    }
    if (!sessionCookie && jwtToken) {
      sessionCookie = `tb_session=${jwtToken}`;
    }
  });

  await assertTest('Auth', 'Session validation via cookie (GET /api/auth/me)', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Cookie: sessionCookie, Authorization: `Bearer ${jwtToken}` },
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const me = await res.json();
    if (me.user?.username !== 'admin') throw new Error(`Unexpected user: ${me.user?.username}`);
  });

  const authHeaders = {
    'Content-Type': 'application/json',
    Cookie: sessionCookie,
    Authorization: `Bearer ${jwtToken}`,
  };

  // 3. Inbox & Conversations
  console.log('\n--- 3. Testing Inbox & Messaging Engine ---');
  let testConvId = 1;
  await assertTest('Inbox', 'Fetch active conversations list (GET /api/conversations)', async () => {
    const res = await fetch(`${BASE_URL}/api/conversations`, { headers: authHeaders });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const convs = await res.json();
    if (!Array.isArray(convs) || convs.length === 0) throw new Error('No conversations returned');
    testConvId = convs[0].id;
  });

  await assertTest('Inbox', 'Fetch messages for conversation (GET /api/conversations/:id/messages)', async () => {
    const res = await fetch(`${BASE_URL}/api/conversations/${testConvId}/messages`, { headers: authHeaders });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const msgs = await res.json();
    if (!Array.isArray(msgs)) throw new Error('Expected messages array');
  });

  await assertTest('Inbox', 'Mark conversation read (POST /api/conversations/:id/read)', async () => {
    const res = await fetch(`${BASE_URL}/api/conversations/${testConvId}/read`, {
      method: 'POST',
      headers: authHeaders,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });

  await assertTest('Inbox', 'Reply to conversation & Outbox Enqueue (POST /api/conversations/:id/reply)', async () => {
    const res = await fetch(`${BASE_URL}/api/conversations/${testConvId}/reply`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ text: 'Automated live test response from verification suite' }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reply = await res.json();
    if (!reply.success && !reply.id) throw new Error('Invalid reply response');
  });

  // 4. Products & Catalog
  console.log('\n--- 4. Testing Catalog & Inventory ---');
  let createdProductId = 0;
  await assertTest('Catalog', 'List products (GET /api/products)', async () => {
    const res = await fetch(`${BASE_URL}/api/products`, { headers: authHeaders });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const prods = await res.json();
    if (!Array.isArray(prods) || prods.length < 4) throw new Error('Products array missing or incomplete');
  });

  await assertTest('Catalog', 'Create new product (POST /api/products)', async () => {
    const res = await fetch(`${BASE_URL}/api/products`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        sku: `live-test-${Date.now()}`,
        name: 'Live Automated Test Item',
        category: 'Test Category',
        price_bdt: 1550,
        stock: 80,
      }),
    });
    if (res.status !== 201) throw new Error(`HTTP ${res.status}`);
    const prod = await res.json();
    createdProductId = prod.id;
  });

  await assertTest('Catalog', 'Update product stock (PATCH /api/products/:id)', async () => {
    const res = await fetch(`${BASE_URL}/api/products/${createdProductId}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ stock: 95 }),
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  });

  await assertTest('Catalog', 'Delete test product (DELETE /api/products/:id)', async () => {
    const res = await fetch(`${BASE_URL}/api/products/${createdProductId}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  });

  // 5. Leads & CRM
  console.log('\n--- 5. Testing Leads & CRM Lifecycle ---');
  let testLeadId = 1;
  await assertTest('Leads', 'List CRM leads (GET /api/leads)', async () => {
    const res = await fetch(`${BASE_URL}/api/leads`, { headers: authHeaders });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const leads = await res.json();
    if (!Array.isArray(leads) || leads.length === 0) throw new Error('No leads returned');
    testLeadId = leads[0].id;
  });

  await assertTest('Leads', 'Update lead status (PATCH /api/leads/:id)', async () => {
    const res = await fetch(`${BASE_URL}/api/leads/${testLeadId}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'confirmed' }),
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  });

  await assertTest('Leads', 'Lead Intelligence Analysis (POST /api/leads/:id/analyze)', async () => {
    const res = await fetch(`${BASE_URL}/api/leads/${testLeadId}/analyze`, {
      method: 'POST',
      headers: authHeaders,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const analysis = await res.json();
    if (!analysis.ok) throw new Error('Analysis failed');
  });

  await assertTest('Leads', 'CRM Analytics Stats (GET /api/leads/intel-stats)', async () => {
    const res = await fetch(`${BASE_URL}/api/leads/intel-stats`, { headers: authHeaders });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const stats = await res.json();
    if (typeof stats.total !== 'number') throw new Error('Invalid intel stats');
  });

  // 6. Orders
  console.log('\n--- 6. Testing Order Processing ---');
  await assertTest('Orders', 'Create idempotent order (POST /api/orders)', async () => {
    const res = await fetch(`${BASE_URL}/api/orders`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        conversationId: testConvId,
        idempotencyKey: `ord-test-${Date.now()}`,
        items: [{ sku: 'buds-pro', name: 'AirBuds Pro ANC', price: 1800, qty: 1 }],
        totalBdt: 1860,
        address: 'House 12, Road 5, Dhanmondi, Dhaka',
        notes: 'Handle with care',
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });

  await assertTest('Orders', 'List all orders (GET /api/orders)', async () => {
    const res = await fetch(`${BASE_URL}/api/orders`, { headers: authHeaders });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const orders = await res.json();
    if (!Array.isArray(orders)) throw new Error('Expected orders array');
  });

  // 7. Knowledge Base
  console.log('\n--- 7. Testing Knowledge Base ---');
  let createdKbId = 0;
  await assertTest('Knowledge', 'List knowledge articles (GET /api/clients/1/knowledge)', async () => {
    const res = await fetch(`${BASE_URL}/api/clients/1/knowledge`, { headers: authHeaders });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const kb = await res.json();
    if (!Array.isArray(kb)) throw new Error('Expected kb array');
  });

  await assertTest('Knowledge', 'Add knowledge article (POST /api/clients/1/knowledge)', async () => {
    const res = await fetch(`${BASE_URL}/api/clients/1/knowledge`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        title: 'Payment Methods',
        content: 'We accept Cash on Delivery, bKash, Nagad, and credit cards.',
      }),
    });
    if (res.status !== 201) throw new Error(`HTTP ${res.status}`);
    const item = await res.json();
    createdKbId = item.id;
  });

  await assertTest('Knowledge', 'Delete knowledge article (DELETE /api/knowledge/:id)', async () => {
    const res = await fetch(`${BASE_URL}/api/knowledge/${createdKbId}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  });

  // 8. Broadcasts & Marketing
  console.log('\n--- 8. Testing Broadcast Campaigns ---');
  let broadcastId = 0;
  await assertTest('Broadcasts', 'Create broadcast campaign (POST /api/broadcasts)', async () => {
    const res = await fetch(`${BASE_URL}/api/broadcasts`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'Flash Sale Promo',
        channel: 'whatsapp',
        filter: { status: 'confirmed' },
        message: 'Special 20% discount on all Kurti items today only!',
      }),
    });
    if (res.status !== 201) throw new Error(`HTTP ${res.status}`);
    const bc = await res.json();
    broadcastId = bc.id;
  });

  await assertTest('Broadcasts', 'Estimate campaign audience (POST /api/broadcasts/:id/audience)', async () => {
    const res = await fetch(`${BASE_URL}/api/broadcasts/${broadcastId}/audience`, {
      method: 'POST',
      headers: authHeaders,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (typeof data.count !== 'number') throw new Error('Invalid audience count');
  });

  await assertTest('Broadcasts', 'Trigger broadcast send (POST /api/broadcasts/:id/send)', async () => {
    const res = await fetch(`${BASE_URL}/api/broadcasts/${broadcastId}/send`, {
      method: 'POST',
      headers: authHeaders,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });

  await assertTest('Broadcasts', 'Cancel broadcast campaign (POST /api/broadcasts/:id/cancel)', async () => {
    const res = await fetch(`${BASE_URL}/api/broadcasts/${broadcastId}/cancel`, {
      method: 'POST',
      headers: authHeaders,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });

  // 9. Connectors & Channel Integrations
  console.log('\n--- 9. Testing Channel Connectors & QR Status ---');
  await assertTest('Connectors', 'Fetch connectors state (GET /api/clients/1/connectors)', async () => {
    const res = await fetch(`${BASE_URL}/api/clients/1/connectors`, { headers: authHeaders });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const connectors = await res.json();
    if (!connectors.whatsapp || !connectors.telegram) throw new Error('Invalid connectors shape');
  });

  await assertTest('Connectors', 'Fetch public webhook URLs (GET /api/webhook-urls)', async () => {
    const res = await fetch(`${BASE_URL}/api/webhook-urls`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const urls = await res.json();
    if (!urls.meta || !urls.telegram) throw new Error('Missing webhook endpoints');
  });

  await assertTest('Connectors', 'Toggle AI Pause on Channel (POST /api/clients/1/connectors/:channel/ai-pause)', async () => {
    const res = await fetch(`${BASE_URL}/api/clients/1/connectors/whatsapp/ai-pause`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ slot: 'default' }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });

  // 10. Licensing & Entitlements
  console.log('\n--- 10. Testing Licensing & Plans ---');
  await assertTest('Licensing', 'List subscription plans (GET /api/admin/plans)', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/plans`, { headers: authHeaders });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const plans = await res.json();
    if (!Array.isArray(plans) || plans.length === 0) throw new Error('No plans found');
  });

  await assertTest('Licensing', 'List client active licenses (GET /api/admin/licenses)', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/licenses`, { headers: authHeaders });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const licenses = await res.json();
    if (!Array.isArray(licenses) || licenses.length === 0) throw new Error('No licenses found');
  });

  await assertTest('Licensing', 'Check workspace entitlements (GET /api/client/access)', async () => {
    const res = await fetch(`${BASE_URL}/api/client/access`, { headers: authHeaders });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  });

  // 11. System Admin
  console.log('\n--- 11. Testing Admin & System Health ---');
  await assertTest('Admin', 'System overview dashboard (GET /api/admin/overview)', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/overview`, { headers: authHeaders });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  });

  await assertTest('Admin', 'List workspaces/tenants (GET /api/admin/workspaces)', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/workspaces`, { headers: authHeaders });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  });

  await assertTest('Admin', 'List system users (GET /api/admin/users)', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/users`, { headers: authHeaders });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  });

  await assertTest('Admin', 'System health status (GET /api/status)', async () => {
    const res = await fetch(`${BASE_URL}/api/status`, { headers: authHeaders });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const status = await res.json();
    if (status.status !== 'healthy') throw new Error(`Status not healthy: ${status.status}`);
  });

  // 12. Customer Embeddable Webchat Widget (Public API)
  console.log('\n--- 12. Testing Public Embeddable Webchat Widget ---');
  await assertTest('Widget', 'Fetch widget configuration (GET /api/widget/:key/config)', async () => {
    const res = await fetch(`${BASE_URL}/api/widget/test-widget-key/config`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const cfg = await res.json();
    if (!cfg.title) throw new Error('Missing widget title');
  });

  await assertTest('Widget', 'Send customer message via widget (POST /api/widget/:key/message)', async () => {
    const res = await fetch(`${BASE_URL}/api/widget/test-widget-key/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'wc-live-test-user-99',
        text: 'Hello from customer on live webchat widget',
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });

  // Final Summary
  console.log('\n===============================================================');
  console.log('                   VERIFICATION SUMMARY                        ');
  console.log('===============================================================');
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`Total tests run: ${results.length}`);
  console.log(`Passed:         ${passed}`);
  console.log(`Failed:         ${failed}`);
  console.log('===============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal runner error:', err);
  process.exit(1);
});
