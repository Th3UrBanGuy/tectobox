import { test, expect } from '@playwright/test';

test.describe('6. Comprehensive Button Crawler & Interaction Test Suite', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('tectonic-onboard-hide', '1');
    });
  });

  test('should test all buttons in Platform Admin Panel (tabs, actions, licensing, totp, broadcasts)', async ({ page }) => {
    // 1. Sign in as Admin
    await page.goto('/app');
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'admin123');
    await page.click('#login-btn');
    await expect(page.locator('#view-admin')).toBeVisible({ timeout: 5000 });

    // 2. Test Admin Tab Switcher Buttons
    const adminTabs = ['resources', 'users', 'licensing', 'config', 'notify', 'audit'];
    for (const tab of adminTabs) {
      const tabBtn = page.locator(`#admin-tabs button[data-at="${tab}"]`);
      if (await tabBtn.isVisible()) {
        await tabBtn.click();
        await page.waitForTimeout(150);
        await expect(page.locator(`#atab-${tab}`)).toBeVisible();
      }
    }

    // 3. Test Push Broadcasts Button (#atab-notify)
    await page.click('#admin-tabs button[data-at="notify"]');
    await expect(page.locator('#atab-notify')).toBeVisible();
    await page.fill('#nt-title', 'System Maintenance');
    await page.fill('#nt-body', 'Upgrading database servers at midnight.');
    const notifBtn = page.locator('#btn-send-notif');
    if (await notifBtn.isVisible()) {
      await notifBtn.click();
      await page.waitForTimeout(400);
      const statusEl = page.locator('#nt-status');
      await expect(statusEl).toBeVisible();
    }

    // 4. Test Config & TOTP 2FA Buttons (#atab-config)
    await page.click('#admin-tabs button[data-at="config"]');
    await expect(page.locator('#atab-config')).toBeVisible();

    // Check TOTP Setup button
    const totpSetupBtn = page.locator('#btn-totp-setup');
    if (await totpSetupBtn.isVisible()) {
      await page.fill('#totp-setup-pw', 'admin123');
      await totpSetupBtn.click();
      await page.waitForTimeout(400);
      await expect(page.locator('#totp-setup-area')).toBeVisible();
    }

    // Check Save Config button
    const saveCfgBtn = page.locator('#btn-save-cfg');
    if (await saveCfgBtn.isVisible()) {
      await saveCfgBtn.click();
      await page.waitForTimeout(300);
    }

    // 5. Test Plans & Licensing Buttons (#atab-licensing)
    await page.click('#admin-tabs button[data-at="licensing"]');
    await expect(page.locator('#atab-licensing')).toBeVisible();

    // Switch Plan mode toggles (Package vs Credit System)
    await page.click('#crt-mode .mode-opt[data-mode="package"]');
    await page.waitForTimeout(100);

    // Period chips
    const chips = page.locator('#crt-period-chips .chip');
    const chipCount = await chips.count();
    for (let i = 0; i < chipCount; i++) {
      if (await chips.nth(i).isVisible()) {
        await chips.nth(i).click();
        await page.waitForTimeout(100);
      }
    }

    // Create a test plan
    const uniquePlan = `Plan_${Date.now()}`;
    await page.fill('#crt-name', uniquePlan);
    await page.fill('#crt-price', '2500');
    await page.click('#btn-create');
    await page.waitForTimeout(500);

    // Verify created plan card is displayed
    const planCard = page.locator(`.plan-card:has-text("${uniquePlan}")`);
    await expect(planCard).toBeVisible();

    // Test Delete Plan button
    page.on('dialog', async (dialog) => {
      await dialog.accept();
    });
    const delPlanBtn = planCard.locator('[data-plandel]');
    if (await delPlanBtn.isVisible()) {
      await delPlanBtn.click();
      await page.waitForTimeout(400);
      await expect(planCard).not.toBeVisible();
    }

    // 6. Test Workspaces Tab Actions
    await page.click('#admin-tabs button[data-at="resources"]');
    await page.waitForTimeout(200);

    // Switch to Operator workspace View
    const clientSwitch = page.locator('#admin-switch-client');
    if (await clientSwitch.isVisible()) {
      await clientSwitch.click();
      await expect(page.locator('#view-client')).toBeVisible({ timeout: 5000 });
    }
  });

  test('should test all Operator Workspace buttons (More sections, KB, Connectors, Backup, Webchat)', async ({ page }) => {
    // Sign in as operator
    await page.goto('/app');
    await page.fill('#login-username', 'operator');
    await page.fill('#login-password', 'operator123');
    await page.click('#login-btn');
    await expect(page.locator('#app-view')).toBeVisible({ timeout: 5000 });

    // 1. Navigate to More view
    await page.click('#nav-links button[data-nav="more"]');
    await expect(page.locator('#cview-more')).toBeVisible();

    // 2. Test Backup & Restore Interface Buttons
    const backupItem = page.locator('#more-workspace-wrap .mrow').filter({ hasText: 'Backup My Data' });
    if (await backupItem.isVisible()) {
      await backupItem.click();
      await expect(page.locator('#cview-settings')).toBeVisible();
      await expect(page.locator('#backup-card')).toBeVisible();

      // Verify Export JSON button
      const exportJsonBtn = page.locator('button[data-bk-export]');
      await expect(exportJsonBtn).toBeVisible();

      // Verify Export MD button
      const exportMdBtn = page.locator('button[data-bk-export-md]');
      await expect(exportMdBtn).toBeVisible();

      // Verify Restore input exists
      const restoreInput = page.locator('input[data-bk-import]');
      await expect(restoreInput).toBeAttached();
    }

    // 3. Test Knowledge Base Interface & Buttons
    await page.click('#nav-links button[data-nav="more"]');
    await expect(page.locator('#cview-more')).toBeVisible();
    const kbItem = page.locator('#more-workspace-wrap .mrow').filter({ hasText: 'Teach the AI' });
    await expect(kbItem).toBeVisible();
    await kbItem.click();
    await expect(page.locator('#cview-settings')).toBeVisible();
    await expect(page.locator('#stab-kb')).toBeVisible();

    // Test KB Subtabs: docs, import, presets
    const kbSubtabs = page.locator('#kb-subtabs button');
    const kbCount = await kbSubtabs.count();
    for (let i = 0; i < kbCount; i++) {
      await kbSubtabs.nth(i).click();
      await page.waitForTimeout(150);
    }

    // Test Presets: switch to presets, click "Use this preset"
    await page.click('#kb-subtabs button[data-kb="presets"]');
    const presetBtn = page.locator('[data-preset="0"]');
    if (await presetBtn.isVisible()) {
      await presetBtn.click();
      await page.waitForTimeout(200);
      const titleVal = await page.inputValue('#kb-title');
      expect(titleVal.length).toBeGreaterThan(0);
    }

    // Test Save Knowledge Document button
    const testDocTitle = `Doc_${Date.now()}`;
    await page.fill('#kb-title', testDocTitle);
    await page.fill('#kb-content', 'Test delivery within Dhaka in 24 hours.');
    await page.click('#btn-save-kb');
    await page.waitForTimeout(400);

    // Verify doc appears in list
    const docCard = page.locator(`.doc-card:has-text("${testDocTitle}")`);
    await expect(docCard).toBeVisible();

    // Test Edit and Delete buttons on doc card
    const editBtn = docCard.locator('[data-kbedit]');
    if (await editBtn.isVisible()) {
      await editBtn.click();
      await page.waitForTimeout(200);
      const cancelEditBtn = docCard.locator('[data-kbecancel]');
      if (await cancelEditBtn.isVisible()) {
        await cancelEditBtn.click();
        await page.waitForTimeout(200);
      }
    }

    // Delete doc
    const delDocBtn = docCard.locator('[data-kbdel]');
    if (await delDocBtn.isVisible()) {
      await delDocBtn.click();
      const confirmOk = page.locator('#btn-confirm-ok');
      await expect(confirmOk).toBeVisible({ timeout: 3000 });
      await confirmOk.click();
      await page.waitForTimeout(300);
    }

    // Test Website Import button (#kb-import-btn)
    await page.click('#kb-subtabs button[data-kb="website"]');
    await page.fill('#kb-site-url', 'https://example-shop.com');
    const importBtn = page.locator('#kb-import-btn');
    await expect(importBtn).toBeVisible();
    await importBtn.click();
    await page.waitForTimeout(500);

    // 4. Test API Keys & Webhooks
    await page.click('#nav-links button[data-nav="more"]');
    await expect(page.locator('#cview-more')).toBeVisible();
    const apiKeyItem = page.locator('#more-workspace-wrap .mrow').filter({ hasText: 'API Keys' });
    if (await apiKeyItem.isVisible()) {
      await apiKeyItem.click();
      await expect(page.locator('#cview-settings')).toBeVisible();
      await expect(page.locator('#stab-apikeys')).toBeVisible();

      // Test Create API Key
      const keyName = `Token_${Date.now()}`;
      await page.fill('#ak-name', keyName);
      await page.click('#ak-create');
      await page.waitForTimeout(400);

      const akRow = page.locator('#ak-list .mrow').filter({ hasText: keyName });
      await expect(akRow).toBeVisible();
      const revokeBtn = akRow.locator('[data-ak-del]');
      if (await revokeBtn.isVisible()) {
        await revokeBtn.click();
        await page.waitForTimeout(300);
      }
    }

    // 5. Test Webchat Widget Interface
    await page.click('#nav-links button[data-nav="more"]');
    await expect(page.locator('#cview-more')).toBeVisible();
    const webchatItem = page.locator('#more-workspace-wrap .mrow').filter({ hasText: 'Webchat Widget' });
    await expect(webchatItem).toBeVisible();
    await webchatItem.click();
    await expect(page.locator('#cview-settings')).toBeVisible();

    // Verify Copy Snippet button
    const copyBtn = page.locator('#wc-tab-copy');
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();

    // Verify Test Widget button
    const testWidgetBtn = page.locator('#wc-tab-test');
    await expect(testWidgetBtn).toBeVisible();
    await testWidgetBtn.click();
    await page.waitForTimeout(300);

    // Verify Save Appearance button
    const saveAppearBtn = page.locator('#wc-save-appear');
    await expect(saveAppearBtn).toBeVisible();
    await saveAppearBtn.click();
    await page.waitForTimeout(300);

    // 6. Test Courier Logistics Modal
    await page.click('#nav-links button[data-nav="more"]');
    await expect(page.locator('#cview-more')).toBeVisible();
    const courierItem = page.locator('#more-workspace-wrap .mrow').filter({ hasText: 'Courier Logistics' });
    await expect(courierItem).toBeVisible();
    await courierItem.click();
    await expect(page.locator('#courier-modal')).toBeVisible();

    const saveCourierBtn = page.locator('#btn-save-courier');
    await expect(saveCourierBtn).toBeVisible();
    await saveCourierBtn.click();
    await page.waitForTimeout(300);
    await expect(page.locator('#courier-modal')).not.toBeVisible();

    // 7. Test Orders & Thermal Shipping Slips Modal
    await page.click('#nav-links button[data-nav="more"]');
    await expect(page.locator('#cview-more')).toBeVisible();
    const ordersItem = page.locator('#more-workspace-wrap .mrow').filter({ hasText: 'Orders & Shipping Slips' });
    await expect(ordersItem).toBeVisible();
    await ordersItem.click();
    await expect(page.locator('#orders-modal')).toBeVisible();
    await page.click('#btn-close-orders');
    await page.waitForTimeout(200);
    await expect(page.locator('#orders-modal')).not.toBeVisible();

    // 8. Test Canned Quick Replies Modal
    await page.click('#nav-links button[data-nav="more"]');
    await expect(page.locator('#cview-more')).toBeVisible();
    const qrItem = page.locator('#more-workspace-wrap .mrow').filter({ hasText: 'Canned Quick Replies' });
    await expect(qrItem).toBeVisible();
    await qrItem.click();
    await expect(page.locator('#quickreplies-modal')).toBeVisible();
    await page.click('#btn-close-quickreplies');
    await page.waitForTimeout(200);
    await expect(page.locator('#quickreplies-modal')).not.toBeVisible();
  });
});
