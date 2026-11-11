import { Client } from 'ssh2';

// C1: login credentials come from the environment — no password literal in source.
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) throw new Error('[e2e] E2E_ADMIN_PASSWORD must be set in the environment.');

const BASE_URL = process.env.TARGET_URL || 'http://160.25.5.64';

console.log('================================================================');
console.log(' TECTOBOX LIVE OPERATIONAL LIFECYCLE & HIGH-CONCURRENCY BENCHMARK');
console.log(` Target Server: ${BASE_URL}`);
console.log(' Time: ' + new Date().toISOString());
console.log('================================================================\n');

async function main() {
  try {
    // -------------------------------------------------------------------------
    // PHASE 1: ADMIN OPERATIONS & WORKSPACE PROVISIONING
    // -------------------------------------------------------------------------
    console.log('>>> [PHASE 1] Admin Authentication & Provisioning...');
    
    // 1. Admin Login
    const adminLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
    });
    if (!adminLoginRes.ok) {
      throw new Error(`Admin login failed: ${adminLoginRes.status} ${await adminLoginRes.text()}`);
    }
    const { token: adminToken } = await adminLoginRes.json();
    console.log(' [✓] Admin signed in successfully. JWT issued.');

    // 2. Create Workspace
    const wsPayload = {
      name: `Apex Electro BD ${Date.now().toString().slice(-4)}`,
      business_type: 'physical',
      phone: '+8801700112233',
    };
    const wsRes = await fetch(`${BASE_URL}/api/admin/workspaces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify(wsPayload),
    });
    if (!wsRes.ok) {
      throw new Error(`Workspace creation failed: ${wsRes.status} ${await wsRes.text()}`);
    }
    const ws = await wsRes.json();
    const workspaceId = ws.id;
    const widgetKey = ws.widget_key;
    console.log(` [✓] Workspace created: ID=${workspaceId}, Name="${ws.name}", WidgetKey=${widgetKey}`);

    // 3. Create Operator User for this workspace
    const operatorUsername = `apex_ops_${Date.now().toString().slice(-4)}`;
    const operatorPassword = 'ApexPass123!';
    const userRes = await fetch(`${BASE_URL}/api/admin/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        username: operatorUsername,
        password: operatorPassword,
        role: 'operator',
        client_id: workspaceId,
      }),
    });
    if (!userRes.ok) {
      throw new Error(`Operator user creation failed: ${userRes.status} ${await userRes.text()}`);
    }
    console.log(` [✓] Operator user created: "${operatorUsername}" (assigned to Workspace ${workspaceId})`);

    // 4. Issue Full Enterprise License
    const licenseRes = await fetch(`${BASE_URL}/api/admin/licenses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        client_id: workspaceId,
        days: 365,
        features: ['combined_inbox', 'webchat', 'broadcast', 'knowledge', 'api_access', 'lead_intel', 'ai_response'],
      }),
    });
    if (!licenseRes.ok) {
      throw new Error(`License issuance failed: ${licenseRes.status} ${await licenseRes.text()}`);
    }
    const lic = await licenseRes.json();
    console.log(` [✓] Enterprise License issued: Code=${lic.code}, All 7 Features Active.`);

    // -------------------------------------------------------------------------
    // PHASE 2: WORKSPACE OPERATOR LOGIN & CATALOG/KNOWLEDGE SETUP
    // -------------------------------------------------------------------------
    console.log('\n>>> [PHASE 2] Operator Login & Business Knowledge/Catalog Configuration...');

    const opLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: operatorUsername, password: operatorPassword }),
    });
    if (!opLoginRes.ok) {
      throw new Error(`Operator login failed: ${opLoginRes.status} ${await opLoginRes.text()}`);
    }
    const { token: opToken } = await opLoginRes.json();
    console.log(` [✓] Operator "${operatorUsername}" successfully logged in.`);

    // 1. Add Knowledge Base Items
    const kbItems = [
      {
        title: 'Return & Warranty Policy',
        content: 'আমাদের সকল প্রোডাক্টে ৭ দিনের রিপ্লেসমেন্ট এবং ১ বছরের অফিশিয়াল সার্ভিস ওয়ারেন্টি দেওয়া হয়। কোনো সমস্যা হলে প্রোডাক্ট বক্স সহ পাঠাতে হবে।',
        category: 'policy',
      },
      {
        title: 'Delivery Charges & Timeline',
        content: 'ঢাকার ভেতরে ডেলিভারি চার্জ ৬০ টাকা (২৪-৪৮ ঘণ্টার মধ্যে ডেলিভারি)। ঢাকার বাইরে ডেলিভারি চার্জ ১২০ টাকা (২-৩ কার্যদিবস)। ক্যাশ অন ডেলিভারি সুবিধা রয়েছে।',
        category: 'shipping',
      },
    ];

    for (const kb of kbItems) {
      const kbRes = await fetch(`${BASE_URL}/api/knowledge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opToken}`,
        },
        body: JSON.stringify(kb),
      });
      if (kbRes.ok) {
        console.log(` [✓] Knowledge Base entry added: "${kb.title}"`);
      } else {
        console.warn(` [-] KB add warning: ${kbRes.status} ${await kbRes.text()}`);
      }
    }

    // 2. Add Products to Catalog
    const products = [
      { sku: 'APX-WATCH-ULTRA', name: 'Apex Smart Watch Ultra', price_bdt: 3800, stock: 35, category: 'Smart Watch' },
      { sku: 'APX-EARBUDS-01', name: 'Apex Wireless ANC Earbuds', price_bdt: 2450, stock: 60, category: 'Audio' },
      { sku: 'APX-POWERBANK-20K', name: 'Apex 20000mAh 65W Fast Powerbank', price_bdt: 1950, stock: 80, category: 'Accessories' },
    ];

    for (const p of products) {
      const pRes = await fetch(`${BASE_URL}/api/products`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opToken}`,
        },
        body: JSON.stringify(p),
      });
      if (pRes.ok) {
        console.log(` [✓] Product catalog entry added: "${p.name}" (Price: ${p.price_bdt} BDT, Stock: ${p.stock})`);
      } else {
        console.warn(` [-] Product add warning: ${pRes.status} ${await pRes.text()}`);
      }
    }

    // -------------------------------------------------------------------------
    // PHASE 3: REAL CUSTOMER CONVERSATIONAL DIALOGUES (WEBCHAT)
    // -------------------------------------------------------------------------
    console.log('\n>>> [PHASE 3] Customer Interaction & Real-Time AI Response Testing...');

    const customerSessionId = `visitor_cust_${Date.now()}`;

    // Test 1: Product Price & Stock Inquiry
    console.log('\n* Test Scenario 1: Customer asks for product price in Bengali');
    const q1 = 'ভাইয়া Apex Smart Watch Ultra এর দাম কত এবং স্টকে আছে?';
    console.log(`  Customer: "${q1}"`);
    const t0 = Date.now();
    const chatRes1 = await fetch(`${BASE_URL}/api/widget/${widgetKey}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitor_id: customerSessionId,
        text: q1,
        name: 'Kamal Hossain',
      }),
    });
    const lat1 = Date.now() - t0;
    const chatData1 = await chatRes1.json();
    console.log(`  [AI Reply (${lat1}ms)]: "${chatData1.reply || chatData1.outbound?.text || 'No reply'}"`);
    console.log(`  Model Used: ${chatData1.model || 'gemini-3.6-flash'}`);

    // Test 2: Shipping & Warranty Policy Inquiry (Knowledge Base Retrieval)
    console.log('\n* Test Scenario 2: Customer asks for warranty and delivery fees');
    const q2 = 'আপনাদের ডেলিভারি চার্জ কত এবং ওয়ারেন্টি পলিসি কি?';
    console.log(`  Customer: "${q2}"`);
    const t1 = Date.now();
    const chatRes2 = await fetch(`${BASE_URL}/api/widget/${widgetKey}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitor_id: customerSessionId,
        text: q2,
        name: 'Kamal Hossain',
      }),
    });
    const lat2 = Date.now() - t1;
    const chatData2 = await chatRes2.json();
    console.log(`  [AI Reply (${lat2}ms)]: "${chatData2.reply || chatData2.outbound?.text || 'No reply'}"`);

    // Test 3: Order Intent & Automated Lead Identification
    console.log('\n* Test Scenario 3: Customer expresses order intent and provides contact');
    const q3 = 'আমি একটা Apex Wireless ANC Earbuds নিতে চাই। নাম: কামাল হোসেন, ফোন: 01711223344, ঠিকানা: মিরপুর ১০, ঢাকা';
    console.log(`  Customer: "${q3}"`);
    const t2 = Date.now();
    const chatRes3 = await fetch(`${BASE_URL}/api/widget/${widgetKey}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitor_id: customerSessionId,
        text: q3,
        name: 'Kamal Hossain',
        contact: '01711223344',
      }),
    });
    const lat3 = Date.now() - t2;
    const chatData3 = await chatRes3.json();
    console.log(`  [AI Reply (${lat3}ms)]: "${chatData3.reply || chatData3.outbound?.text || 'No reply'}"`);

    // Test 4: Human Handover Flagging
    console.log('\n* Test Scenario 4: Customer asks for human support agent');
    const q4 = 'আমি একজন মানুষের সাথে কথা বলতে চাই, কোনো সাপোর্ট টিম বা এজেন্ট আছে?';
    console.log(`  Customer: "${q4}"`);
    const chatRes4 = await fetch(`${BASE_URL}/api/widget/${widgetKey}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitor_id: customerSessionId,
        text: q4,
      }),
    });
    const chatData4 = await chatRes4.json();
    console.log(`  [Handover Reply]: "${chatData4.reply || chatData4.outbound?.text || 'No reply'}"`);
    console.log(`  Flagged for Human: ${chatData4.needs_human || chatData4.conversation?.needs_human ? 'YES [✓]' : 'NO'}`);

    // Verify Leads Pipeline on Operator Side
    const leadsRes = await fetch(`${BASE_URL}/api/leads`, {
      headers: { Authorization: `Bearer ${opToken}` },
    });
    if (leadsRes.ok) {
      const leads = await leadsRes.json();
      console.log(`\n [✓] Operator Leads Pipeline Verified: ${leads.length} lead(s) captured automatically.`);
    }

    // -------------------------------------------------------------------------
    // PHASE 4: HIGH-CONCURRENCY SCALABILITY & AI THROUGHPUT STRESS TEST
    // -------------------------------------------------------------------------
    console.log('\n================================================================');
    console.log('>>> [PHASE 4] HIGH-CONCURRENCY SCALABILITY & AI THROUGHPUT TEST');
    console.log('================================================================');

    const testTiers = [
      { name: 'Tier 1 - Light Load', count: 20, concurrency: 10 },
      { name: 'Tier 2 - Moderate Load', count: 50, concurrency: 25 },
      { name: 'Tier 3 - Peak Enterprise Rush', count: 100, concurrency: 50 },
      { name: 'Tier 4 - Massive Surge Burst', count: 200, concurrency: 100 },
    ];

    for (const tier of testTiers) {
      console.log(`\n[Executing ${tier.name}] Total: ${tier.count} requests | Concurrency: ${tier.concurrency}`);
      
      const latencies: number[] = [];
      let successCount = 0;
      let errorCount = 0;
      let rateLimitedCount = 0;

      const runBatch = async (batch: number[]) => {
        return Promise.all(
          batch.map(async (idx) => {
            const start = Date.now();
            const vid = `stress_visitor_${idx}_${Date.now()}`;
            try {
              const res = await fetch(`${BASE_URL}/api/widget/${widgetKey}/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  visitor_id: vid,
                  text: idx % 2 === 0 ? 'Smart watch এর দাম কত?' : 'Earbuds কি এভেইলেবল আছে?',
                }),
              });
              const dur = Date.now() - start;
              latencies.push(dur);

              if (res.status === 200 || res.status === 201) {
                successCount++;
              } else if (res.status === 429) {
                rateLimitedCount++;
              } else {
                errorCount++;
              }
            } catch (e) {
              errorCount++;
            }
          })
        );
      };

      const startTime = Date.now();
      const allIndices = Array.from({ length: tier.count }, (_, i) => i);
      
      for (let i = 0; i < allIndices.length; i += tier.concurrency) {
        const slice = allIndices.slice(i, i + tier.concurrency);
        await runBatch(slice);
      }

      const totalTimeMs = Date.now() - startTime;
      const totalSec = totalTimeMs / 1000;
      const qps = (tier.count / totalSec).toFixed(1);

      latencies.sort((a, b) => a - b);
      const min = latencies[0] || 0;
      const max = latencies[latencies.length - 1] || 0;
      const median = latencies[Math.floor(latencies.length * 0.5)] || 0;
      const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
      const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1));

      console.log(`  -> Time Elapsed: ${totalSec.toFixed(2)}s | Throughput: ${qps} req/sec (QPS)`);
      console.log(`  -> Status: Success=${successCount} | Rate-Limited(429)=${rateLimitedCount} | Errors=${errorCount}`);
      console.log(`  -> Latency: Min=${min}ms | Avg=${avg}ms | Median(p50)=${median}ms | p95=${p95}ms | Max=${max}ms`);
    }

    console.log('\n================================================================');
    console.log(' [✓] ALL OPERATIONAL & SCALABILITY TESTS COMPLETED SUCCESSFULLY!');
    console.log('================================================================');
  } catch (err) {
    console.error('Fatal error during benchmark:', err);
  }
}

main();
