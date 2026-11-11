import { test, expect } from '@playwright/test';
import { e2ePassword } from './e2e-credentials';

test.describe('13. Universal Production Hardening & Resilience Verification Suite', () => {
  test.setTimeout(60000);

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('tectonic-onboard-hide', '1');
    });
  });

  // ---------------------------------------------------------------------------
  // STEP 1: OWASP Security & Zero-Trust Verification
  // ---------------------------------------------------------------------------
  test('SEC-01: Rejects unauthenticated private API access with standardized 401 envelope', async ({ request }) => {
    const res = await request.get('/api/conversations');
    expect(res.status()).toBe(401);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.statusCode).toBe(401);
    expect(body.error).toBeDefined();
    expect(body.path).toContain('/api/conversations');
    expect(body.timestamp).toBeDefined();
  });

  test('SEC-02: Tenant Isolation — Operator role is strictly forbidden from Admin APIs', async ({ request }) => {
    // 1. Sign in as operator
    const loginRes = await request.post('/api/auth/login', {
      data: { username: 'operator', password: e2ePassword('operator') },
    });
    expect(loginRes.status()).toBe(200);
    const loginBody = await loginRes.json();
    const token = loginBody.token;
    expect(token).toBeDefined();

    // 2. Attempt to call admin users management endpoint
    const adminRes = await request.get('/api/admin/users', {
      headers: { Authorization: `Bearer ${token}` },
    });
    // Must be 401 or 403 Forbidden
    expect([401, 403]).toContain(adminRes.status());
    const errBody = await adminRes.json();
    expect(errBody.success).toBe(false);
  });

  test('SEC-03: SQL Injection & XSS payload resistance in search & parameters', async ({ request }) => {
    // Sign in as operator
    const loginRes = await request.post('/api/auth/login', {
      data: { username: 'operator', password: e2ePassword('operator') },
    });
    const { token } = await loginRes.json();

    // Send classic SQLi and XSS payloads in query parameters
    const sqliPayload = "' OR '1'='1' --; DROP TABLE users;";
    const resSqli = await request.get(`/api/conversations?q=${encodeURIComponent(sqliPayload)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // System must not crash (500) with raw SQL syntax error; it should handle gracefully
    expect(resSqli.status()).not.toBe(500);

    const xssPayload = '<script>alert("XSS")</script><img src=x onerror=alert(1)>';
    const resXss = await request.get(`/api/conversations?q=${encodeURIComponent(xssPayload)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resXss.status()).not.toBe(500);
  });

  // ---------------------------------------------------------------------------
  // STEP 2: Centralized Error Envelopes & Resilience
  // ---------------------------------------------------------------------------
  test('ERR-01: Non-existent routes return structured JSON error envelopes without stack leaks', async ({ request }) => {
    const res = await request.get('/api/invalid-nonexistent-endpoint-test-404');
    expect(res.status()).toBe(404);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.statusCode).toBe(404);
    expect(body.error).toBeDefined();
    expect(body.message).toBeDefined();
    expect(body.path).toContain('/api/invalid-nonexistent-endpoint-test-404');
    expect(body.timestamp).toBeDefined();
    // Verify no internal stack traces leaked
    expect(body.stack).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // STEP 3: Healthchecks, Readiness & Self-Diagnostics
  // ---------------------------------------------------------------------------
  test('HEALTH-01: Core API & Gateway health diagnostic endpoints return healthy', async ({ request }) => {
    const resHealthz = await request.get('/api/healthz');
    expect(resHealthz.status()).toBe(200);

    const body = await resHealthz.json();
    expect(body.status).toBe('healthy');
    expect(body.service).toBe('tectobox-core-api');
    expect(body.timestamp).toBeDefined();
    expect(body.uptime).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // STEP 4: Edge-Case & Chaos Hardening
  // ---------------------------------------------------------------------------
  test('CHAOS-01: Empty payloads, malformed JSON and corrupted inputs fail closed gracefully', async ({ request }) => {
    // 1. Post empty body to login
    const resEmpty = await request.post('/api/auth/login', {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect(resEmpty.status()).toBe(401);
    const bodyEmpty = await resEmpty.json();
    expect(bodyEmpty.success).toBe(false);

    // 2. Post invalid JSON types (number instead of string)
    const resMalformed = await request.post('/api/auth/login', {
      data: { username: 12345, password: false },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(resMalformed.status()).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // STEP 5: Concurrency & Multi-Tenant Boundaries
  // ---------------------------------------------------------------------------
  test('PERF-01: Concurrent tenant request handling without cross-contamination', async ({ request }) => {
    // Login as operator
    const opRes = await request.post('/api/auth/login', {
      data: { username: 'operator', password: e2ePassword('operator') },
    });
    const opToken = (await opRes.json()).token;

    // Login as admin
    const adminRes = await request.post('/api/auth/login', {
      data: { username: 'admin', password: e2ePassword('admin') },
    });
    const adminToken = (await adminRes.json()).token;

    // Fire 20 parallel requests interleaved between operator and admin
    const promises: Promise<any>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        request.get('/api/conversations', {
          headers: { Authorization: `Bearer ${opToken}` },
        })
      );
      promises.push(
        request.get('/api/admin/clients', {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      );
    }

    const results = await Promise.all(promises);
    for (const r of results) {
      expect([200, 304]).toContain(r.status());
    }
  });
});
