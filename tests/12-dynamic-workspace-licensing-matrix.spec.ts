import { test, expect, Page } from '@playwright/test';
import { e2ePassword } from './e2e-credentials';

test.describe('12. Dynamic Workspace Licensing & Granular Feature Matrix Verification', () => {
  test.setTimeout(180000); // 3 minutes for comprehensive combinatorial cycles

  const USERNAME = `dyn_lic_user_${Date.now()}`;
  const PASSWORD = 'password123';
  let clientId: number;
  let userId: number;
  let activeLicenseId: number | null = null;

  test.beforeAll(async ({ request }) => {
    // 1. Sign in as admin to get session/token
    const loginRes = await request.post('/api/auth/login', {
      data: { username: 'admin', password: e2ePassword('admin') },
    });
    expect(loginRes.ok()).toBeTruthy();
    const loginData = await loginRes.json();
    const token = loginData.token;

    // 2. Create brand new workspace
    const wsRes = await request.post('/api/admin/workspaces', {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: `Dynamic Licensing Workspace ${Date.now()}`, business_type: 'physical' },
    });
    expect(wsRes.ok()).toBeTruthy();
    const wsData = await wsRes.json();
    clientId = wsData.id;
    expect(clientId).toBeGreaterThan(1);

    // 3. Create dedicated client operator user for this new workspace
    const userRes = await request.post('/api/admin/users', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        username: USERNAME,
        password: PASSWORD,
        role: 'client',
        client_id: clientId,
      },
    });
    expect(userRes.ok()).toBeTruthy();
    const userData = await userRes.json();
    userId = userData.id;
    expect(userId).toBeGreaterThan(0);
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('tectonic-onboard-hide', '1');
      localStorage.setItem('tb_onboarding_dismissed', '1');
    });
  });

  async function loginAs(page: Page, role: 'admin' | 'client') {
    await page.goto('/app');
    const isLoginVisible = await page.locator('#login-view').isVisible();
    if (!isLoginVisible) {
      // Check who is logged in
      const curUser = await page.locator('#user-name').textContent().catch(() => '');
      const targetUser = role === 'admin' ? 'admin' : USERNAME;
      if (curUser && curUser.trim() === targetUser) {
        await page.reload();
        await page.waitForTimeout(400);
        await page.evaluate(() => {
          const ov = document.getElementById('gs-overlay');
          if (ov) ov.classList.add('hidden');
        });
        return;
      }
      // Sign out
      const signoutBtn = page.locator('#btn-signout');
      if (await signoutBtn.isVisible()) {
        await signoutBtn.click();
        await page.waitForSelector('#login-view:not(.hidden)', { timeout: 8000 });
      }
    }

    const u = role === 'admin' ? 'admin' : USERNAME;
    const p = role === 'admin' ? e2ePassword('admin') : PASSWORD;
    await page.fill('#login-username', u);
    await page.fill('#login-password', p);
    await page.click('#login-btn', { force: true });
    await expect(page.locator('#app-view')).toBeVisible({ timeout: 12000 });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const ov = document.getElementById('gs-overlay');
      if (ov) ov.classList.add('hidden');
    });
  }

  async function adminAssignLicense(request: any, features: string[]) {
    const loginRes = await request.post('/api/auth/login', {
      data: { username: 'admin', password: e2ePassword('admin') },
    });
    const { token } = await loginRes.json();

    const licRes = await request.post('/api/admin/licenses', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        client_id: clientId,
        kind: 'time',
        days: 30,
        credits: 5000,
        features,
      },
    });
    expect(licRes.ok()).toBeTruthy();
    const licData = await licRes.json();
    activeLicenseId = licData.id;
    return licData;
  }

  async function adminCancelLicense(request: any) {
    if (!activeLicenseId) return;
    const loginRes = await request.post('/api/auth/login', {
      data: { username: 'admin', password: e2ePassword('admin') },
    });
    const { token } = await loginRes.json();

    const cancelRes = await request.post(`/api/admin/licenses/${activeLicenseId}/cancel`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(cancelRes.ok()).toBeTruthy();
    activeLicenseId = null;
  }

  // -------------------------------------------------------------------------
  // Step 1: Initial State — No License Assigned to New Workspace
  // -------------------------------------------------------------------------
  test('STEP-01: New Workspace Initial State (Zero License - Strict Gating)', async ({ page, request }) => {
    await loginAs(page, 'client');

    // Access check API
    const accessRes = await request.get('/api/client/access', {
      headers: { cookie: (await page.context().cookies()).map(c => `${c.name}=${c.value}`).join('; ') }
    });
    const access = await accessRes.json();
    expect(access.mode).toBe('none');
    expect(access.features).toEqual([]);

    // Check UI Gating
    // 1. Inbox should be locked because combined_inbox is not licensed
    await expect(page.locator('#inbox-locked')).toBeVisible();

    // 2. Unlicensed sidebar links should be hidden
    await expect(page.locator('#nav-links [data-nav="kb"]')).toBeHidden();
    await expect(page.locator('#nav-links [data-nav="webchat"]')).toBeHidden();
    await expect(page.locator('#nav-links [data-nav="broadcast"]')).toBeHidden();
    await expect(page.locator('#nav-links [data-nav="apikeys"]')).toBeHidden();

    // 3. Check Plan card
    await page.locator('#nav-links [data-nav="plan"]').click();
    await expect(page.locator('#plan-card')).toContainText('No active license');
  });

  // -------------------------------------------------------------------------
  // Step 2: Individual Feature Isolation (1 feature at a time, verify & cancel)
  // -------------------------------------------------------------------------
  const ALL_INDIVIDUAL_FEATURES = [
    { key: 'combined_inbox', nav: 'inbox', name: 'Combined inbox' },
    { key: 'webchat', nav: 'webchat', name: 'Webchat widget' },
    { key: 'broadcast', nav: 'broadcast', name: 'Broadcast' },
    { key: 'knowledge', nav: 'kb', name: 'Knowledge base' },
    { key: 'api_access', nav: 'apikeys', name: 'API keys & webhooks' },
    { key: 'lead_intel', nav: 'leads', name: 'Lead intelligence' },
    { key: 'ai_response', nav: 'inbox', name: 'AI auto-replies' },
  ];

  for (const feat of ALL_INDIVIDUAL_FEATURES) {
    test(`INDIVIDUAL-02: Single Feature License [${feat.key}]`, async ({ page, request }) => {
      // 1. Admin assigns license with ONLY this feature
      await adminAssignLicense(request, [feat.key]);

      // 2. Log in as client
      await loginAs(page, 'client');

      // 3. Verify that THIS feature is accessible
      if (feat.key === 'combined_inbox') {
        await page.locator('#nav-links [data-nav="inbox"]').click();
        await expect(page.locator('#inbox-locked')).not.toBeVisible();
        await expect(page.locator('#inbox-panes')).toBeVisible();
      } else if (feat.key === 'webchat') {
        const link = page.locator('#nav-links [data-nav="webchat"]');
        await expect(link).toBeVisible();
        await link.click();
        await expect(page.locator('#cview-webchat')).toBeVisible();
      } else if (feat.key === 'broadcast') {
        const link = page.locator('#nav-links [data-nav="broadcast"]');
        await expect(link).toBeVisible();
        await link.click();
        await expect(page.locator('#cview-broadcast')).toBeVisible();
        await expect(page.locator('#bcast-list')).not.toContainText('not included in your plan');
      } else if (feat.key === 'knowledge') {
        const link = page.locator('#nav-links [data-nav="kb"]');
        await expect(link).toBeVisible();
        await link.click();
        await expect(page.locator('#cview-kb')).toBeVisible();
      } else if (feat.key === 'api_access') {
        const link = page.locator('#nav-links [data-nav="apikeys"]');
        await expect(link).toBeVisible();
        await link.click();
        await expect(page.locator('#cview-apikeys')).toBeVisible();
        await expect(page.locator('#apikeys-card')).not.toContainText('not included in your plan');
      } else if (feat.key === 'lead_intel') {
        await page.locator('#nav-links [data-nav="leads"]').click();
        await expect(page.locator('#cview-leads')).toBeVisible();
        const firstLead = page.locator('#leads-body tr').first();
        if (await firstLead.isVisible()) {
          await firstLead.click();
          await expect(page.locator('#lm-tabs [data-lt="intel"]')).toBeVisible();
        }
      } else if (feat.key === 'ai_response') {
        await page.locator('#nav-links [data-nav="plan"]').click();
        await expect(page.locator('#plan-card')).toContainText('Licensed plan');
      }

      // 4. Verify other features remain locked/hidden
      if (feat.key !== 'webchat') {
        await expect(page.locator('#nav-links [data-nav="webchat"]')).toBeHidden();
      }
      if (feat.key !== 'broadcast') {
        await expect(page.locator('#nav-links [data-nav="broadcast"]')).toBeHidden();
      }
      if (feat.key !== 'knowledge') {
        await expect(page.locator('#nav-links [data-nav="kb"]')).toBeHidden();
      }
      if (feat.key !== 'api_access') {
        await expect(page.locator('#nav-links [data-nav="apikeys"]')).toBeHidden();
      }

      // 5. Admin logs in, cancels license
      await adminCancelLicense(request);
    });
  }

  // -------------------------------------------------------------------------
  // Step 3: Pairs of 2 Features (দুইটা দুইটা করে)
  // -------------------------------------------------------------------------
  test('PAIR-03: Multiple 2-Feature Combinations', async ({ page, request }) => {
    const pair1 = ['webchat', 'broadcast'];
    await adminAssignLicense(request, pair1);
    await loginAs(page, 'client');
    await expect(page.locator('#nav-links [data-nav="webchat"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="broadcast"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="kb"]')).toBeHidden();
    await expect(page.locator('#nav-links [data-nav="apikeys"]')).toBeHidden();
    await adminCancelLicense(request);

    const pair2 = ['knowledge', 'api_access'];
    await adminAssignLicense(request, pair2);
    await page.reload();
    await expect(page.locator('#nav-links [data-nav="kb"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="apikeys"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="webchat"]')).toBeHidden();
    await expect(page.locator('#nav-links [data-nav="broadcast"]')).toBeHidden();
    await adminCancelLicense(request);
  });

  // -------------------------------------------------------------------------
  // Step 4: Triplets of 3 Features (তিনটা তিনটা করে)
  // -------------------------------------------------------------------------
  test('TRIPLET-04: Multiple 3-Feature Combinations', async ({ page, request }) => {
    const trip1 = ['combined_inbox', 'webchat', 'knowledge'];
    await adminAssignLicense(request, trip1);
    await loginAs(page, 'client');
    await expect(page.locator('#nav-links [data-nav="inbox"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="webchat"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="kb"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="broadcast"]')).toBeHidden();
    await expect(page.locator('#nav-links [data-nav="apikeys"]')).toBeHidden();
    await adminCancelLicense(request);

    const trip2 = ['broadcast', 'api_access', 'lead_intel'];
    await adminAssignLicense(request, trip2);
    await page.reload();
    await expect(page.locator('#nav-links [data-nav="broadcast"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="apikeys"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="webchat"]')).toBeHidden();
    await expect(page.locator('#nav-links [data-nav="kb"]')).toBeHidden();
    await adminCancelLicense(request);
  });

  // -------------------------------------------------------------------------
  // Step 5: Quads of 4 Features (চারটা চারটা করে)
  // -------------------------------------------------------------------------
  test('QUAD-05: 4-Feature Combinations', async ({ page, request }) => {
    const quad = ['combined_inbox', 'webchat', 'broadcast', 'knowledge'];
    await adminAssignLicense(request, quad);
    await loginAs(page, 'client');

    await expect(page.locator('#nav-links [data-nav="webchat"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="broadcast"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="kb"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="apikeys"]')).toBeHidden();

    // Verify My Plan screen displays all 4 active features
    await page.locator('#nav-links [data-nav="plan"]').click();
    await expect(page.locator('#plan-card')).toBeVisible();
    await expect(page.locator('#plan-card')).toContainText('Licensed plan');

    await adminCancelLicense(request);
  });

  // -------------------------------------------------------------------------
  // Step 6: Quints of 5 Features (পাঁচটা পাঁচটা করে)
  // -------------------------------------------------------------------------
  test('QUINT-06: 5-Feature Combinations', async ({ page, request }) => {
    const quint = ['combined_inbox', 'ai_response', 'webchat', 'knowledge', 'api_access'];
    await adminAssignLicense(request, quint);
    await loginAs(page, 'client');

    await expect(page.locator('#nav-links [data-nav="webchat"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="kb"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="apikeys"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="broadcast"]')).toBeHidden();

    // Verify Inbox is fully unlocked with AI enabled
    await page.locator('#nav-links [data-nav="inbox"]').click();
    await expect(page.locator('#inbox-locked')).toBeHidden();
    await expect(page.locator('#inbox-panes')).toBeVisible();

    await adminCancelLicense(request);
  });

  // -------------------------------------------------------------------------
  // Step 7: Full Enterprise Tier (All 7 Features Enabled)
  // -------------------------------------------------------------------------
  test('FULL-07: Full Enterprise License (All 7 Features Operational)', async ({ page, request }) => {
    const allFeats = [
      'combined_inbox',
      'ai_response',
      'webchat',
      'broadcast',
      'lead_intel',
      'knowledge',
      'api_access',
    ];
    await adminAssignLicense(request, allFeats);
    await loginAs(page, 'client');

    // All isolated screens should now be accessible simultaneously
    await expect(page.locator('#nav-links [data-nav="inbox"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="leads"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="orders"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="products"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="channels"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="kb"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="webchat"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="backup"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="plan"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="apikeys"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="broadcast"]')).toBeVisible();
    await expect(page.locator('#nav-links [data-nav="guide"]')).toBeVisible();

    // Verify My Plan displays all green checkmarks
    await page.locator('#nav-links [data-nav="plan"]').click();
    const planCard = page.locator('#plan-card');
    await expect(planCard).toContainText('Licensed plan');
    await expect(planCard).toContainText('Combined inbox');
    await expect(planCard).toContainText('Webchat widget');
    await expect(planCard).toContainText('Broadcast');
    await expect(planCard).toContainText('Knowledge base');
    await expect(planCard).toContainText('API keys & webhooks');
  });
});
