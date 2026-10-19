import { test, expect } from '@playwright/test';

test.describe('2. Platform Admin Panel & Interfaces', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('tectonic-onboard-hide', '1');
    });
    await page.goto('/app');
    const isLoginVisible = await page.locator('#login-view').isVisible();
    if (isLoginVisible) {
      await page.fill('#login-username', 'admin');
      await page.fill('#login-password', 'admin123');
      await page.click('#login-btn');
      await expect(page.locator('#app-view')).toBeVisible();
    }
  });

  test('should display Platform Panel hero, kicker, and live stats', async ({ page }) => {
    await expect(page.locator('#view-admin')).toBeVisible();
    await expect(page.locator('.admin-kicker')).toContainText('PLATFORM OWNER');
    await expect(page.locator('#view-admin h2')).toHaveText('Platform Panel');

    // Verify stats cards are populated
    const stats = page.locator('#admin-stats .hstat');
    await expect(stats.first()).toBeVisible({ timeout: 5000 });
    const count = await stats.count();
    expect(count).toBeGreaterThanOrEqual(4); // Workspaces, Channels, Connected, Errored
  });

  test('should navigate across all 6 Platform Admin tabs and verify interfaces', async ({ page }) => {
    // 1. Connected resources tab
    await page.click('#admin-tabs button[data-at="resources"]');
    await expect(page.locator('#atab-resources')).toBeVisible();
    await expect(page.locator('#atab-resources table')).toBeVisible();

    // 2. Workspaces tab
    await page.click('#admin-tabs button[data-at="users"]');
    await expect(page.locator('#atab-users')).toBeVisible();
    await expect(page.locator('#btn-create-user')).toBeVisible();
    
    // Check workspace cards rendered
    const wsCards = page.locator('#users-grid .ws-card');
    await expect(wsCards.first()).toBeVisible({ timeout: 5000 });
    await expect(wsCards.first().locator('.ws-name')).toContainText('Aurora Demo Store');

    // 3. Plans & licenses tab
    await page.click('#admin-tabs button[data-at="licensing"]');
    await expect(page.locator('#atab-licensing')).toBeVisible();
    // Mode toggles
    await expect(page.locator('#crt-mode')).toBeVisible();
    // Period chips
    await expect(page.locator('#crt-period-chips')).toBeVisible();
    // Feature checkboxes
    await expect(page.locator('#crt-features')).toBeVisible();
    const featureLabels = page.locator('#crt-features label b');
    await expect(featureLabels.first()).toBeVisible();
    await expect(page.locator('#crt-features')).toContainText('Combined inbox');
    await expect(page.locator('#crt-features')).toContainText('AI auto-replies');
    // Create button
    await expect(page.locator('#btn-create')).toBeVisible();

    // 4. Platform config tab
    await page.click('#admin-tabs button[data-at="config"]');
    await expect(page.locator('#atab-config')).toBeVisible();
    await expect(page.locator('#cfg-autoreply')).toBeAttached();
    await expect(page.locator('#cfg-baseurl')).toBeVisible();
    await expect(page.locator('#admin-webhook-urls')).toBeVisible();

    // 5. Notifications tab
    await page.click('#admin-tabs button[data-at="notify"]');
    await expect(page.locator('#atab-notify')).toBeVisible();
    await expect(page.locator('#nt-target')).toBeVisible();
    await expect(page.locator('#nt-body')).toBeVisible();
    await expect(page.locator('#btn-send-notif')).toBeVisible();

    // 6. Audit log tab
    await page.click('#admin-tabs button[data-at="audit"]');
    await expect(page.locator('#atab-audit')).toBeVisible();
    await expect(page.locator('#audit-list')).toBeVisible();
  });

  test('should interact with workspace control buttons (AI Pause toggle & modals)', async ({ page }) => {
    await page.click('#admin-tabs button[data-at="users"]');
    await expect(page.locator('#atab-users')).toBeVisible();

    // Find AI switch on workspace card
    const aiSwitch = page.locator('#users-grid input[data-wsai="1"]');
    await expect(aiSwitch).toBeAttached();
    const checkedBefore = await aiSwitch.isChecked();

    // Toggle AI switch by clicking its parent .switch label
    const switchLabel = page.locator('#users-grid label.switch:has(input[data-wsai="1"])');
    await expect(switchLabel).toBeVisible();
    await switchLabel.click();
    await page.waitForTimeout(500);
    const checkedAfter = await aiSwitch.isChecked();
    expect(checkedAfter).not.toBe(checkedBefore);

    // Toggle back
    await switchLabel.click();
    await page.waitForTimeout(500);

    // Click "Create workspace user" button to open modal
    await page.click('#btn-create-user');
    const modal = page.locator('#user-modal');
    await expect(modal).toBeVisible();
    await expect(page.locator('#um-workspace')).toBeVisible();
    await expect(page.locator('#um-username')).toBeVisible();
    await expect(page.locator('#um-password')).toBeVisible();

    // Close modal
    await page.click('#btn-close-user');
    await expect(modal).toBeHidden();
  });

  test('should trigger Command Palette via keyboard shortcut and search', async ({ page }) => {
    // Press Ctrl+K or Cmd+K
    await page.keyboard.press('Control+KeyK');
    const cmdk = page.locator('#cmdk-bg');
    await expect(cmdk).toBeVisible({ timeout: 5000 });

    const searchInput = page.locator('#cmdk-input');
    await expect(searchInput).toBeFocused();

    // Type search query
    await searchInput.fill('inbox');
    await expect(page.locator('#cmdk-list .cmdk-item')).toBeVisible();

    // Press Escape to close
    await page.keyboard.press('Escape');
    await expect(cmdk).toBeHidden();
  });

  test('should switch seamlessly between Platform Panel and Workspace Inbox', async ({ page }) => {
    // Currently on Platform Panel
    await expect(page.locator('#view-admin')).toBeVisible();
    await expect(page.locator('#view-client')).toBeHidden();

    // Click 'Inbox' tab in top navigation
    const inboxTab = page.locator('#nav-links button[data-nav="inbox"]');
    await expect(inboxTab).toBeVisible();
    await inboxTab.click();

    // Verify Workspace Inbox is visible and Platform Admin Panel is hidden
    await expect(page.locator('#view-client')).toBeVisible();
    await expect(page.locator('#cview-inbox')).toBeVisible();
    await expect(page.locator('#view-admin')).toBeHidden();

    // Click 'Platform Panel' tab in top navigation to return
    const platformTab = page.locator('#nav-links button[data-nav="admin"]');
    await expect(platformTab).toBeVisible();
    await platformTab.click();

    // Verify back on Platform Admin Panel
    await expect(page.locator('#view-admin')).toBeVisible();
    await expect(page.locator('#view-client')).toBeHidden();
  });
});
