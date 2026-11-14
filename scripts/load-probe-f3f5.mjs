#!/usr/bin/env node

/**
 * Load Probe: F3 AI Worker Concurrency & F5 listWorkspaces Alignment
 *
 * Command to execute:
 *   E2E_ADMIN_PASSWORD="<password>" LIVE_URL="http://160.25.5.64" node scripts/load-probe-f3f5.mjs
 *
 * Parameters (configurable via env):
 *   CONCURRENCY: Default 50 concurrent widget requests
 *   NUM_WORKSPACES: Default 5 workspaces
 *   LIVE_URL / TARGET_URL: Base URL of the live site (default http://160.25.5.64)
 *   E2E_ADMIN_PASSWORD / ADMIN_PASSWORD: Admin password for provisioning throwaway workspaces
 *
 * Verification Targets:
 *   - Failure rate < 2.0% (was 15.5% in 2026-11-12 swarm report)
 *   - p50 latency < 10.0s (was 22.0s in 2026-11-12 swarm report)
 *
 * Safety & Isolation Invariants:
 *   - Creates M throwaway workspaces
 *   - Dispatches N concurrent widget questions across the M workspaces
 *   - Automatically cleans up and DELETES all created throwaway workspaces at the end (try/finally)
 *   - NEVER touches client 69 (strictly enforced with guards)
 */

// ============================================================================
// CONFIGURATION & PARAMETERS
// ============================================================================
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '50', 10);
const NUM_WORKSPACES = parseInt(process.env.NUM_WORKSPACES || '5', 10);
const TARGET_FAILURE_RATE_PCT = 2.0; // Target: < 2% failure rate
const TARGET_P50_MS = 10000;         // Target: < 10s (10,000ms) p50 latency

const BASE_URL = (process.env.LIVE_URL || process.env.TARGET_URL || 'http://160.25.5.64').replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;

const QUERIES = [
  'আপনাদের ডেলিভারি চার্জ কত ঢাকার বাইরে?',
  'What is your delivery charge and delivery time?',
  'Smart watch এর দাম কত ভাই?',
  'Earbuds কি স্টকে এভেইলেবল আছে?',
  'What is your store return and warranty policy?',
  'আমি একটি প্রোডাক্ট অর্ডার করতে চাই',
];

// ============================================================================
// MAIN RUNNER
// ============================================================================
async function main() {
  console.log('================================================================');
  console.log(' TECTOBOX F3/F5 LOAD PROBE (CONCURRENCY & TIMEOUT ALIGNMENT)');
  console.log(` Target Server: ${BASE_URL}`);
  console.log(` Timestamp:     ${new Date().toISOString()}`);
  console.log(` Concurrency:   ${CONCURRENCY} requests`);
  console.log(` Workspaces:    ${NUM_WORKSPACES} throwaway workspaces`);
  console.log(` Targets:       Failure Rate < ${TARGET_FAILURE_RATE_PCT}% | p50 < ${TARGET_P50_MS / 1000}s`);
  console.log('================================================================\n');

  if (!ADMIN_PASSWORD) {
    console.error('[ERROR] E2E_ADMIN_PASSWORD (or ADMIN_PASSWORD) environment variable must be set.');
    process.exit(1);
  }

  let adminToken = '';
  const createdWorkspaces = [];

  try {
    // -------------------------------------------------------------------------
    // 1. Admin Authentication
    // -------------------------------------------------------------------------
    console.log('[1/4] Authenticating admin user...');
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
    });

    if (!loginRes.ok) {
      throw new Error(`Admin login failed with HTTP ${loginRes.status}: ${await loginRes.text()}`);
    }

    const loginData = await loginRes.json();
    adminToken = loginData.token || loginData.access_token;
    if (!adminToken) {
      throw new Error('No JWT token received from admin login.');
    }
    console.log('  -> Admin authenticated successfully.\n');

    // -------------------------------------------------------------------------
    // 2. Provision M Throwaway Workspaces (Never touch client 69!)
    // -------------------------------------------------------------------------
    console.log(`[2/4] Provisioning ${NUM_WORKSPACES} throwaway workspaces...`);
    for (let i = 0; i < NUM_WORKSPACES; i++) {
      const wsName = `ProbeThrowaway_${Date.now()}_${i + 1}`;
      const createRes = await fetch(`${BASE_URL}/api/admin/workspaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          name: wsName,
          business_type: 'physical',
        }),
      });

      if (!createRes.ok) {
        throw new Error(`Failed to create workspace ${wsName}: HTTP ${createRes.status} ${await createRes.text()}`);
      }

      const ws = await createRes.json();
      const wsId = Number(ws.id || ws.client_id);
      const widgetKey = ws.widget_key;

      // HARD INVARIANT: NEVER touch or conflict with client 69
      if (wsId === 69) {
        throw new Error('SAFETY VIOLATION: Created workspace assigned protected ID 69!');
      }

      // Provision active license for AI and Webchat
      const licRes = await fetch(`${BASE_URL}/api/admin/licenses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          client_id: wsId,
          days: 1,
          features: ['webchat', 'ai_response', 'knowledge'],
        }),
      });

      if (!licRes.ok) {
        console.warn(`  [!] Warning: License issuance for WS ${wsId} returned HTTP ${licRes.status}`);
      }

      createdWorkspaces.push({
        id: wsId,
        name: ws.name,
        widgetKey,
      });

      console.log(`  [+] Created Workspace #${wsId} ("${wsName}") with widgetKey=${widgetKey}`);
    }
    console.log(`  -> Successfully provisioned ${createdWorkspaces.length} workspaces.\n`);

    // -------------------------------------------------------------------------
    // 3. Dispatch N Concurrent Widget Questions Across M Workspaces
    // -------------------------------------------------------------------------
    console.log(`[3/4] Dispatching ${CONCURRENCY} concurrent widget questions across ${NUM_WORKSPACES} workspaces...`);
    const latencies = [];
    let successCount = 0;
    let rateLimitedCount = 0;
    let errorCount = 0;

    const tStart = Date.now();

    const tasks = Array.from({ length: CONCURRENCY }, async (_, idx) => {
      const ws = createdWorkspaces[idx % createdWorkspaces.length];
      const query = QUERIES[idx % QUERIES.length];
      const visitorId = `probe_v_${idx}_${Date.now()}`;
      const reqStart = Date.now();

      try {
        const res = await fetch(`${BASE_URL}/api/widget/${ws.widgetKey}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            visitor_id: visitorId,
            text: query,
          }),
        });

        const dur = Date.now() - reqStart;
        latencies.push(dur);

        if (res.status === 200 || res.status === 201) {
          successCount++;
        } else if (res.status === 429) {
          rateLimitedCount++;
          // Rate-limiting indicates system backpressure rather than crash, but counts as non-success
          errorCount++;
        } else {
          errorCount++;
        }
      } catch (err) {
        const dur = Date.now() - reqStart;
        latencies.push(dur);
        errorCount++;
      }
    });

    await Promise.all(tasks);

    const totalElapsedSec = (Date.now() - tStart) / 1000;
    const qps = CONCURRENCY / totalElapsedSec;

    // -------------------------------------------------------------------------
    // 4. Compute Metrics & Verdict
    // -------------------------------------------------------------------------
    console.log('\n[4/4] Computing Benchmark Metrics & Evaluating Verdict...');
    latencies.sort((a, b) => a - b);

    const totalRequests = CONCURRENCY;
    const failureRatePct = (errorCount / totalRequests) * 100;
    const minLat = latencies[0] || 0;
    const maxLat = latencies[latencies.length - 1] || 0;
    const avgLat = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
    const p50 = latencies[Math.floor(latencies.length * 0.50)] || 0;
    const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;

    const passFailureRate = failureRatePct < TARGET_FAILURE_RATE_PCT;
    const passP50 = p50 < TARGET_P50_MS;
    const overallVerdict = passFailureRate && passP50 ? 'PASS' : 'FAIL';

    console.log('\n================================================================');
    console.log(' BENCHMARK RESULTS');
    console.log('================================================================');
    console.log(` Total Requests:       ${totalRequests}`);
    console.log(` Concurrency:          ${CONCURRENCY}`);
    console.log(` Workspaces Tested:    ${NUM_WORKSPACES}`);
    console.log(` Total Duration:       ${totalElapsedSec.toFixed(2)}s (${qps.toFixed(1)} req/sec)`);
    console.log(` Successful (200/201): ${successCount}`);
    console.log(` Rate Limited (429):   ${rateLimitedCount}`);
    console.log(` Failed Requests:      ${errorCount}`);
    console.log(` Failure Rate:         ${failureRatePct.toFixed(2)}% (Target: < ${TARGET_FAILURE_RATE_PCT}%) -> ${passFailureRate ? '[PASS]' : '[FAIL]'}`);
    console.log(` Min Latency:          ${minLat}ms`);
    console.log(` Avg Latency:          ${avgLat}ms`);
    console.log(` p50 Median Latency:   ${p50}ms (${(p50 / 1000).toFixed(2)}s) (Target: < ${TARGET_P50_MS}ms) -> ${passP50 ? '[PASS]' : '[FAIL]'}`);
    console.log(` p95 Latency:          ${p95}ms (${(p95 / 1000).toFixed(2)}s)`);
    console.log(` Max Latency:          ${maxLat}ms (${(maxLat / 1000).toFixed(2)}s)`);
    console.log('----------------------------------------------------------------');
    console.log(` OVERALL VERDICT:      [${overallVerdict}]`);
    console.log('================================================================\n');

    if (overallVerdict !== 'PASS') {
      process.exitCode = 1;
    }
  } finally {
    // -------------------------------------------------------------------------
    // CLEANUP: Always delete all created throwaway workspaces
    // -------------------------------------------------------------------------
    if (createdWorkspaces.length > 0 && adminToken) {
      console.log(`[CLEANUP] Deleting ${createdWorkspaces.length} throwaway workspaces...`);
      for (const ws of createdWorkspaces) {
        // STRICT SAFETY CHECK: NEVER TOUCH CLIENT 69
        if (ws.id === 69) {
          console.error(`  [CRITICAL SAFETY CHECK] Skipping deletion for client 69!`);
          continue;
        }

        try {
          const delRes = await fetch(`${BASE_URL}/api/admin/workspaces/${ws.id}`, {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${adminToken}`,
            },
          });
          if (delRes.ok) {
            console.log(`  [-] Cleaned up throwaway workspace #${ws.id}`);
          } else {
            console.warn(`  [!] Failed to delete throwaway workspace #${ws.id}: HTTP ${delRes.status}`);
          }
        } catch (e) {
          console.warn(`  [!] Error cleaning up workspace #${ws.id}:`, e.message || e);
        }
      }
      console.log('  -> Cleanup complete.\n');
    }
  }
}

main().catch((err) => {
  console.error('\n[FATAL ERROR]', err.message || err);
  process.exit(1);
});
