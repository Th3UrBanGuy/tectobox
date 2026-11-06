import { test, expect } from '@playwright/test';
import * as path from 'path';

const ARTIFACT_DIR = 'C:/Users/Diamond Technology/.gemini/antigravity/brain/7c4b2ecc-173c-4b91-9904-9e4ad41ca616';

test.describe('Professional Docked Sidebar, Clean User Card, and Gated Inbox', () => {
  test('Desktop: Clean docked sidebar, integrated user card actions, no floating button spillage', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      try { localStorage.setItem('tectonic-onboard-hide', '1'); } catch {}
    });

    await page.goto('/app', { waitUntil: 'networkidle' });

    // Login as operator
    await page.fill('#login-username', 'operator');
    await page.fill('#login-password', 'Operator123!');
    await page.click('#login-btn');

    // Wait for app view
    await expect(page.locator('#app-view')).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1500);

    // Dismiss onboarding popup if active
    const gsOverlay = page.locator('#gs-overlay');
    if (await gsOverlay.isVisible().catch(() => false)) {
      await page.locator('#gs-close').click().catch(() => {});
    }

    // Verify docked sidebar geometry:
    // Sidebar must be docked to left (x = 0) with full height (900px), NO floating gaps
    const sidebar = page.locator('#app-sidebar');
    await expect(sidebar).toBeVisible();

    const sidebarBox = await sidebar.boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(sidebarBox!.x).toBe(0);
    expect(sidebarBox!.height).toBe(900);

    // Verify NO mobile-top-bar exists anywhere on desktop
    const mobileTopBar = page.locator('#mobile-top-bar');
    expect(await mobileTopBar.count()).toBe(0);

    // Verify clean integrated user card with action buttons
    const userCard = page.locator('#sidebar-user-card');
    await expect(userCard).toBeVisible();

    const themeBtn = page.locator('#btn-theme');
    await expect(themeBtn).toBeVisible();

    const signoutBtn = page.locator('#btn-signout');
    await expect(signoutBtn).toBeVisible();

    // Verify Payments Hub in sidebar navigation
    const paymentsNav = page.locator('#nav-links [data-nav="payments"]');
    await expect(paymentsNav).toBeVisible();

    // Verify Chats toolbar Payments Hub trigger button
    const paymentsTrigger = page.locator('#btn-open-payments');
    await expect(paymentsTrigger).toBeVisible();

    // Verify inbox is active for licensed operator
    const panes = page.locator('#inbox-panes');
    await expect(panes).toBeVisible();
    const lockedCard = page.locator('#inbox-locked');
    await expect(lockedCard).toBeHidden();

    // Capture desktop clean screenshot
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'desktop_clean_docked_sidebar.png') });
  });

  test('Mobile: Clean phone view, bottom dock, single-pane conversational drawer', async ({ page }) => {
    // iPhone 14 viewport
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      try { localStorage.setItem('tectonic-onboard-hide', '1'); } catch {}
    });

    await page.goto('/app', { waitUntil: 'networkidle' });

    // Login
    await page.fill('#login-username', 'operator');
    await page.fill('#login-password', 'Operator123!');
    await page.click('#login-btn');

    await expect(page.locator('#app-view')).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1500);

    // Dismiss onboarding popup if active
    const gsOverlay = page.locator('#gs-overlay');
    if (await gsOverlay.isVisible().catch(() => false)) {
      await page.locator('#gs-close').click().catch(() => {});
    }

    // 1. Desktop sidebar must be hidden on mobile
    const sidebar = page.locator('#app-sidebar');
    await expect(sidebar).toBeHidden();

    // 2. Bottom tabs dock is visible
    const bottomTabs = page.locator('#bottom-tabs');
    await expect(bottomTabs).toBeVisible();

    // 3. Capture mobile list view
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'mobile_clean_inbox.png') });

    // 4. Test single-pane conversation drawer
    const convItems = page.locator('.conv-item');
    const convCount = await convItems.count();

    if (convCount > 0) {
      await convItems.first().click();
      await page.waitForTimeout(600);

      // Verify list pane is hidden and chat pane is visible
      const listPane = page.locator('.pane.list-pane');
      const chatPane = page.locator('.pane.chat-pane');
      await expect(listPane).toBeHidden();
      await expect(chatPane).toBeVisible();

      // Back button must be visible
      const backBtn = page.locator('#btn-chat-back');
      await expect(backBtn).toBeVisible();

      // Capture single pane chat screenshot
      await page.screenshot({ path: path.join(ARTIFACT_DIR, 'mobile_clean_chat.png') });

      // Click back button to return to chat list
      await backBtn.click();
      await page.waitForTimeout(500);

      await expect(listPane).toBeVisible();
    }
  });

  test('Strict License Gating: Unlicensed workspace displays ONLY centered Obsidian lock card', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      try { localStorage.setItem('tectonic-onboard-hide', '1'); } catch {}
    });

    await page.goto('/app', { waitUntil: 'networkidle' });

    // Login as unlicensed client 'xyz' (workspace has no license)
    await page.fill('#login-username', 'xyz');
    await page.fill('#login-password', 'Operator123!');
    await page.click('#login-btn');

    await expect(page.locator('#app-view')).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1500);

    // Verify inbox locked card is present and visible
    const lockedCard = page.locator('#inbox-locked');
    await expect(lockedCard).toBeVisible();
    await expect(lockedCard).toContainText('No Active License');

    // CRITICAL SECURITY / GATING CHECK:
    // inbox-panes MUST be strictly hidden with display: none !important
    const panes = page.locator('#inbox-panes');
    await expect(panes).toBeHidden();

    // Capture clean locked screenshot
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'locked_clean_gated.png') });
  });
});
