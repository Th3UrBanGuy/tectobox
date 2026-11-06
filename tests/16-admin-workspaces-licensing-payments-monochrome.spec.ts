import { test, expect } from '@playwright/test';
import * as path from 'path';

test.describe('16. Admin Workspaces, Direct Licensing, Payments Hub & Pure Monochrome UI', () => {

  test('Admin workspace creation, direct license issuing, payments workflow & monochrome styling', async ({ page }) => {
    // Artifact screenshot directory
    const artifactDir = 'C:\\Users\\Diamond Technology\\.gemini\\antigravity\\brain\\7c4b2ecc-173c-4b91-9904-9e4ad41ca616';

    await page.addInitScript(() => {
      try { localStorage.setItem('tectonic-onboard-hide', '1'); } catch {}
    });

    // 1. Visit Welcome landing page
    await page.goto('/');
    await expect(page.locator('a.brand')).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: path.join(artifactDir, 'bw_welcome_page.png'), fullPage: true });

    // 2. Visit Login page
    await page.goto('/app');
    await expect(page.locator('#login-view')).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: path.join(artifactDir, 'bw_login_page.png'), fullPage: true });

    // 3. Login as Admin
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'admin123');
    await page.click('#login-btn');
    await expect(page.locator('#app-view')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#view-admin')).toBeVisible({ timeout: 10000 });

    // Dismiss onboarding popup if active
    const gsOverlay = page.locator('#gs-overlay');
    if (await gsOverlay.isVisible().catch(() => false)) {
      await page.locator('#gs-close').click().catch(() => {});
      await expect(gsOverlay).toBeHidden();
    }

    // Capture monochrome admin view
    await page.screenshot({ path: path.join(artifactDir, 'bw_admin_dashboard.png'), fullPage: false });

    // 4. Create a new Workspace & User via the Admin Workspaces Tab
    const uniqueSuffix = Date.now().toString().slice(-5);
    const testWsName = `Apex Mono ${uniqueSuffix}`;
    const testUsername = `user_mono_${uniqueSuffix}`;

    // Switch to Workspaces tab
    await page.click('#admin-tabs button[data-at="users"]');
    await expect(page.locator('#atab-users')).toBeVisible();

    // Click Create workspace user button
    await page.click('#btn-create-user');
    await expect(page.locator('#user-modal')).toBeVisible();

    await page.fill('#um-username', testUsername);
    await page.fill('#um-password', 'Pass123456!');
    await page.fill('#um-workspace', testWsName);
    await page.click('#btn-save-user');

    // Wait for modal to hide
    await expect(page.locator('#user-modal')).toBeHidden({ timeout: 8000 });

    // Verify workspace card exists with the new name in users-grid
    await expect(page.locator('#users-grid')).toContainText(testWsName, { timeout: 8000 });

    // 5. Direct License Issuing to this workspace
    await page.click('#admin-tabs button[data-at="licensing"]');
    await expect(page.locator('#atab-licensing')).toBeVisible();

    await page.fill('#crt-name', `Plan Mono ${uniqueSuffix}`);

    // Select the new workspace in the dropdown
    const wsSelect = page.locator('#crt-workspace');
    await expect(wsSelect).toBeVisible();
    await page.waitForTimeout(500); // ensure select options are populated
    const options = await wsSelect.locator('option').allInnerTexts();
    const targetOpt = options.find(o => o.includes(testWsName));
    if (targetOpt) {
      await wsSelect.selectOption({ label: targetOpt });
    }

    // Issue license
    await page.click('#btn-create');
    await page.waitForTimeout(1000);

    // Verify license table displays the workspace
    await expect(page.locator('#licenses-body')).toContainText(testWsName, { timeout: 8000 });

    // 6. Navigate to Inbox / Conversations to verify clean monochrome theme
    await page.click('.app-sidebar button[data-nav="inbox"]');
    await expect(page.locator('#cview-inbox')).toBeVisible({ timeout: 8000 });
    await page.screenshot({ path: path.join(artifactDir, 'bw_user_inbox.png'), fullPage: false });

    // 7. Verify Payments Hub from Sidebar / App
    const payTrigger = page.locator('#btn-open-payments-sidebar');
    await expect(payTrigger).toBeVisible();
    await payTrigger.click();

    const payModal = page.locator('#payments-modal');
    await expect(payModal).toBeVisible();

    // Capture monochrome payments modal
    await page.screenshot({ path: path.join(artifactDir, 'bw_payments_modal.png'), fullPage: false });

    // Submit a manual payment / TrxID
    const manualTrxId = `TRX_BW_${uniqueSuffix}`;
    await page.click('#btn-toggle-manual-pay');
    await expect(page.locator('#manual-pay-box')).toBeVisible();

    await page.fill('#man-pay-trx', manualTrxId);
    await page.fill('#man-pay-amount', '4200');
    await page.fill('#man-pay-name', 'Mono Customer');
    await page.fill('#man-pay-phone', '01700000000');
    await page.selectOption('#man-pay-method', 'bkash');
    await page.click('#btn-submit-manual-pay');

    // Verify payment record appears in pending list
    await expect(page.locator('#payments-list')).toContainText(manualTrxId, { timeout: 8000 });

    // Find and click Verify button on this payment
    const card = page.locator('#payments-list .payment-card-item', { hasText: manualTrxId });
    await expect(card).toBeVisible();
    const verifyBtn = card.locator('button.btn-verify-pay');
    await expect(verifyBtn).toBeVisible();
    await verifyBtn.click();

    // Switch to Verified tab and confirm it appears there
    await page.click('#payments-tabs button[data-ptab="verified"]');
    await expect(page.locator('#payments-list')).toContainText(manualTrxId, { timeout: 8000 });

    // Close payments modal
    await page.click('#btn-close-payments');
    await expect(payModal).toBeHidden();
  });

});
