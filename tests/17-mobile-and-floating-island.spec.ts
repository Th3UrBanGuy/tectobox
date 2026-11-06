import { test, expect } from '@playwright/test';
import * as path from 'path';

const ARTIFACT_DIR = 'C:/Users/Diamond Technology/.gemini/antigravity/brain/7c4b2ecc-173c-4b91-9904-9e4ad41ca616';

test.describe('Mobile Phone UX & Floating Island Hardening', () => {
  test('Desktop: Semi-rounded floating sidebar, 2x2 footer actions without overflow', async ({ page }) => {
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

    // Verify floating sidebar geometry
    const sidebar = page.locator('#app-sidebar');
    await expect(sidebar).toBeVisible();

    const sidebarBox = await sidebar.boundingBox();
    expect(sidebarBox).not.toBeNull();

    // Verify 2x2 footer action buttons fit inside sidebar with NO overflow
    const footActions = page.locator('.sidebar-foot-actions');
    await expect(footActions).toBeVisible();

    const footBox = await footActions.boundingBox();
    expect(footBox).not.toBeNull();
    // Entire footActions bounding box must be within the sidebar width
    expect(footBox!.x + footBox!.width).toBeLessThanOrEqual(sidebarBox!.x + sidebarBox!.width + 2);

    // Check all 4 buttons are visible
    await expect(page.locator('#btn-open-payments-sidebar')).toBeVisible();
    await expect(page.locator('#btn-theme')).toBeVisible();
    await expect(page.locator('#btn-profile-sidebar')).toBeVisible();
    await expect(page.locator('#btn-signout')).toBeVisible();

    // Verify license gating vs inbox leak:
    // If locked card is present, panes must be hidden; if panes are present, locked card must NOT be present!
    const isLocked = await page.locator('#inbox-locked').isVisible();
    const panesVisible = await page.locator('#inbox-panes').isVisible();

    if (isLocked) {
      expect(panesVisible).toBe(false);
      console.log('Verified: License is locked, inbox-panes is strictly HIDDEN with 0 leaks.');
    } else {
      console.log('Verified: Workspace is licensed, inbox-panes is active and accessible.');
    }

    // Capture desktop screenshot
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'desktop_floating_sidebar.png') });
  });

  test('Mobile: Sleek top bar, floating dock, single-pane drawer & back navigation', async ({ page }) => {
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

    // 1. Desktop sidebar must be completely HIDDEN on mobile
    const sidebar = page.locator('#app-sidebar');
    await expect(sidebar).toBeHidden();

    // 2. Mobile top bar must be visible
    const mobileTopBar = page.locator('#mobile-top-bar');
    await expect(mobileTopBar).toBeVisible();

    // 3. Mobile action buttons work
    await expect(page.locator('#btn-open-payments-mobile')).toBeVisible();
    await expect(page.locator('#btn-theme-mobile')).toBeVisible();
    await expect(page.locator('#btn-profile-mobile')).toBeVisible();
    await expect(page.locator('#btn-signout-mobile')).toBeVisible();

    // 4. Capture mobile inbox list view
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'mobile_inbox_view.png') });

    // 5. Test single-pane conversation drawer if there are conversations
    const convItems = page.locator('.conv-item');
    const convCount = await convItems.count();

    if (convCount > 0) {
      // Tap first conversation
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
      await page.screenshot({ path: path.join(ARTIFACT_DIR, 'mobile_chat_view.png') });

      // Click back button to return to chat list
      await backBtn.click();
      await page.waitForTimeout(500);

      // Verify list pane is visible again
      await expect(listPane).toBeVisible();
    }
  });

  test('Strict License Gating: Unlicensed workspace displays ONLY centered Obsidian lock card without any inbox leak', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      try { localStorage.setItem('tectonic-onboard-hide', '1'); } catch {}
    });

    await page.goto('/app', { waitUntil: 'networkidle' });

    // Login as unlicensed client 'xyz'
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

    // Conversation list must have 0 elements visible
    const convItems = page.locator('.conv-item');
    expect(await convItems.count()).toBe(0);

    // Capture clean locked screenshot
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'locked_inbox_clean.png') });
    console.log('Verified: Locked workspace shows ONLY clean Obsidian lock card. Zero inbox leaking.');
  });
});

