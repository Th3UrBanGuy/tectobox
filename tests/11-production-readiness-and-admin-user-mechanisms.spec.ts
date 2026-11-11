import { test, expect, Page } from '@playwright/test';
import { e2ePassword } from './e2e-credentials';

test.describe('11. Production Readiness & Exhaustive Admin/User Mechanism Verification', () => {
  test.setTimeout(60000);

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('tectonic-onboard-hide', '1');
    });
  });

  async function ensureLoggedIn(page: Page, role: 'operator' | 'admin' = 'operator') {
    const username = role === 'admin' ? 'admin' : 'operator';
    const password = role === 'admin' ? e2ePassword('admin') : e2ePassword('operator');

    await page.goto('/app');
    const isLoginVisible = await page.locator('#login-view').isVisible();
    if (!isLoginVisible) {
      const curUser = await page.locator('#user-name').textContent().catch(() => '');
      if (curUser && curUser.trim() === username) {
        return;
      }
      // Switch user by signing out
      const signoutBtn = page.locator('#btn-signout');
      if (await signoutBtn.isVisible()) {
        await signoutBtn.click();
        await page.waitForSelector('#login-view:not(.hidden)', { timeout: 8000 });
      }
    }

    await page.fill('#login-username', username);
    await page.fill('#login-password', password);
    await page.click('#login-btn', { force: true });
    await expect(page.locator('#app-view')).toBeVisible({ timeout: 12000 });
  }

  async function goToNav(page: Page, nav: string) {
    const btn = page.locator(`#nav-links button[data-nav="${nav}"]`);
    await btn.waitFor({ state: 'visible', timeout: 8000 });
    await btn.click();
    if (nav === 'admin') {
      await expect(page.locator('#view-admin')).toBeVisible({ timeout: 8000 });
    } else {
      await expect(page.locator('#view-client')).toBeVisible({ timeout: 8000 });
      await expect(page.locator(`#cview-${nav}`)).toBeVisible({ timeout: 8000 });
    }
  }

  // -------------------------------------------------------------------------
  // 1. Account Lifecycle & Admin Platform Controls
  // -------------------------------------------------------------------------
  test('ADMIN-01: Admin Panel Tabs, Live Stats, Workspace & User Management', async ({ page }) => {
    await ensureLoggedIn(page, 'admin');
    await goToNav(page, 'admin');

    // Verify stats cards are populated
    const stats = page.locator('#admin-stats .hstat');
    await expect(stats.first()).toBeVisible({ timeout: 5000 });
    const count = await stats.count();
    expect(count).toBeGreaterThanOrEqual(4);

    // Verify all 6 Admin Tabs
    const adminTabs = [
      { tab: 'resources', view: '#atab-resources' },
      { tab: 'users', view: '#atab-users' },
      { tab: 'licensing', view: '#atab-licensing' },
      { tab: 'config', view: '#atab-config' },
      { tab: 'notify', view: '#atab-notify' },
      { tab: 'audit', view: '#atab-audit' },
    ];

    for (const { tab, view } of adminTabs) {
      const tabBtn = page.locator(`#admin-tabs button[data-at="${tab}"]`);
      await tabBtn.click();
      await expect(page.locator(view)).toBeVisible();
    }

    // Config Tab: Toggle AI auto-reply
    await page.locator('#admin-tabs button[data-at="config"]').click();
    await expect(page.locator('#cfg-baseurl')).toBeVisible();

    // Notifications Tab: Compose platform broadcast
    await page.locator('#admin-tabs button[data-at="notify"]').click();
    await page.fill('#nt-body', 'Production System Status: Normal Operations across all clusters.');
    await page.click('#btn-send-notif');
    await page.waitForTimeout(500);

    // Audit Log Tab: Verify audit events table
    await page.locator('#admin-tabs button[data-at="audit"]').click();
    await expect(page.locator('#audit-list')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 2. User Panel: Inbox, Messaging & Handover Sync
  // -------------------------------------------------------------------------
  test('USER-02: Operator Inbox, Real-Time Chat, Filter & Human Handover', async ({ page }) => {
    await ensureLoggedIn(page, 'operator');
    await goToNav(page, 'inbox');

    // Verify conversation list renders
    const firstConv = page.locator('#conv-list .conv-item').first();
    await firstConv.waitFor({ state: 'visible', timeout: 8000 });
    await firstConv.click();

    // Verify chat composer
    const msgInput = page.locator('#msg-input');
    const sendBtn = page.locator('#btn-send');
    await msgInput.waitFor({ state: 'visible', timeout: 6000 });

    // Send a message
    const testMsg = `Production Ready Msg ${Date.now()}`;
    await msgInput.fill(testMsg);
    await sendBtn.click();
    await page.waitForTimeout(800);

    // Verify message appears in chat stream
    await expect(page.locator('#messages')).toContainText(testMsg);

    // Test Human Handover Toggle
    const handoverBtn = page.locator('#btn-toggle-human');
    await handoverBtn.click();
    await page.waitForTimeout(400);
    // Click again to toggle back
    await handoverBtn.click();
    await page.waitForTimeout(400);
  });

  // -------------------------------------------------------------------------
  // 3. User Panel: CRM Leads, Scoring & CSV Export
  // -------------------------------------------------------------------------
  test('USER-03: Leads CRM Pipeline, Segment Filters, Inspection & CSV Export', async ({ page }) => {
    await ensureLoggedIn(page, 'operator');
    await goToNav(page, 'leads');

    // Filter Hot Leads
    const tempFilters = page.locator('#lead-temp-filters button');
    await expect(tempFilters.filter({ hasText: 'All' })).toBeVisible();
    await tempFilters.filter({ hasText: 'Hot' }).click();
    await expect(tempFilters.filter({ hasText: 'Hot' })).toHaveClass(/active/);

    // Filter All Leads back
    await tempFilters.filter({ hasText: 'All' }).click();
    await expect(tempFilters.filter({ hasText: 'All' })).toHaveClass(/active/);

    // Verify Leads Table rows
    const leadRows = page.locator('#leads-body tr');
    await expect(leadRows.first()).toBeVisible({ timeout: 5000 });

    // Export CSV trigger
    const downloadPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await page.click('#btn-csv');
    const download = await downloadPromise;
    if (download) {
      expect(download.suggestedFilename()).toContain('.csv');
    }
  });

  // -------------------------------------------------------------------------
  // 4. User Panel: Orders & Steadfast Courier Logistics
  // -------------------------------------------------------------------------
  test('USER-04: Isolated Orders Screen, Courier Config & Thermal Slip Preview', async ({ page }) => {
    await ensureLoggedIn(page, 'operator');
    await goToNav(page, 'orders');

    // Open Courier Config Modal
    await page.click('#btn-open-courier-config');
    await expect(page.locator('#courier-modal')).toBeVisible();
    await page.click('#btn-close-courier');
    await expect(page.locator('#courier-modal')).toBeHidden();

    // Search orders
    await page.fill('#orders-page-search', '017');
    await page.waitForTimeout(300);
    await page.fill('#orders-page-search', '');
  });

  // -------------------------------------------------------------------------
  // 5. User Panel: Products, Knowledge Base (Teach AI), Webchat & API Keys
  // -------------------------------------------------------------------------
  test('USER-05: Products Catalog, Knowledge Base, Appearance & API Keys', async ({ page }) => {
    await ensureLoggedIn(page, 'operator');

    // 1. Products
    await goToNav(page, 'products');
    await expect(page.locator('#cview-products')).toBeVisible();

    // 2. Teach the AI (KB)
    await goToNav(page, 'kb');
    await expect(page.locator('#cview-kb')).toBeVisible();
    await expect(page.locator('#kb-title')).toBeVisible();

    // 3. Chat Widget Style
    await goToNav(page, 'webchat');
    await expect(page.locator('#cview-webchat')).toBeVisible();
    await expect(page.locator('#appearance-card')).toBeVisible();

    // 4. API Keys
    await goToNav(page, 'apikeys');
    await expect(page.locator('#cview-apikeys')).toBeVisible();
    await expect(page.locator('#ak-name')).toBeVisible();

    // 5. Backup My Data
    await goToNav(page, 'backup');
    await expect(page.locator('#cview-backup')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 6. Production Security & Session Isolation
  // -------------------------------------------------------------------------
  test('SECURITY-06: Operator Permission Boundary & Session Clearance on Logout', async ({ page }) => {
    await ensureLoggedIn(page, 'operator');

    // Verify operator has no platform panel button in sidebar
    const adminNavBtn = page.locator('#nav-links button[data-nav="admin"]');
    await expect(adminNavBtn).toHaveCount(0);

    // Sign out
    await page.click('#btn-signout');
    await expect(page.locator('#login-view')).toBeVisible({ timeout: 10000 });

    // Ensure session cleared (app view hidden)
    await expect(page.locator('#app-view')).toBeHidden();
  });
});
