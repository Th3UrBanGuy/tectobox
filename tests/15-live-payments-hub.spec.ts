import { test, expect } from '@playwright/test';

test.describe('15. Live Payments Hub & AI Payment Claim Detection', () => {

  test('UI renders payments trigger button, pending badge and modal', async ({ page }) => {
    await page.goto('/app');
    await expect(page.locator('#login-view')).toBeVisible();

    // Login as operator
    await page.fill('#login-username', 'operator');
    await page.fill('#login-password', 'operator123');
    await page.click('#login-btn');

    // App view should be visible
    await expect(page.locator('#app-view')).toBeVisible({ timeout: 8000 });

    // Dismiss onboarding popup if active for operator
    const gsOverlay = page.locator('#gs-overlay');
    if (await gsOverlay.isVisible().catch(() => false)) {
      await page.locator('#gs-close').click().catch(() => {});
      await expect(gsOverlay).toBeHidden();
    }

    // Payments trigger button should be visible in toolbar
    const payTrigger = page.locator('#btn-open-payments');
    await expect(payTrigger).toBeVisible();

    // Open Payments Modal
    await payTrigger.click();
    const modal = page.locator('#payments-modal');
    await expect(modal).toBeVisible();

    // Check stats grid cards
    await expect(page.locator('#pay-stat-pending')).toBeVisible();
    await expect(page.locator('#pay-stat-verified')).toBeVisible();
    await expect(page.locator('#pay-stat-volume')).toBeVisible();

    // Check tabs
    const tabPending = page.locator('#payments-tabs button[data-ptab="pending"]');
    const tabVerified = page.locator('#payments-tabs button[data-ptab="verified"]');
    await expect(tabPending).toBeVisible();
    await expect(tabVerified).toBeVisible();

    // Toggle manual payment form
    const toggleManual = page.locator('#btn-toggle-manual-pay');
    await expect(toggleManual).toBeVisible();
    await toggleManual.click();
    await expect(page.locator('#manual-pay-box')).toBeVisible();

    // Close modal
    await page.click('#btn-close-payments');
    await expect(modal).toBeHidden();
  });

});
