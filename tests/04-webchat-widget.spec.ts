import { test, expect } from '@playwright/test';

test.describe('4. Public Embeddable Webchat Widget', () => {
  test('should render widget launcher bubble on storefront demo page', async ({ page }) => {
    await page.goto('/widget-demo.html');
    await expect(page).toHaveTitle(/Chat Demo/i);

    // Verify hero text
    await expect(page.locator('.hero h1')).toHaveText('Test Workspace');

    // Verify shadow DOM widget launcher bubble exists and is visible
    const bubble = page.locator('.tc-bubble');
    await expect(bubble).toBeVisible({ timeout: 5000 });
  });

  test('should open widget window on bubble click and show header and composer', async ({ page }) => {
    await page.goto('/widget-demo.html');

    const bubble = page.locator('.tc-bubble');
    await expect(bubble).toBeVisible({ timeout: 5000 });

    // Click bubble to toggle open widget
    await bubble.click();

    // Verify panel opens
    const panel = page.locator('.tc-panel');
    await expect(panel).toHaveClass(/tc-open/, { timeout: 5000 });

    // Verify widget header and title
    const header = page.locator('.tc-header');
    await expect(header).toBeVisible();
    const title = page.locator('.tc-htext b');
    await expect(title).toBeVisible();

    // Verify composer inputbar or intro form exists
    const introForm = page.locator('.tc-intro');
    const inputbar = page.locator('.tc-inputbar');
    
    // Either intro form or inputbar is attached
    const isIntroVisible = await introForm.isVisible();
    if (isIntroVisible) {
      await expect(page.locator('.tc-in-name')).toBeVisible();
      await expect(page.locator('.tc-in-contact')).toBeVisible();
      await expect(page.locator('.tc-start')).toBeVisible();
    } else {
      await expect(inputbar).toBeVisible();
    }

    // Click close button inside header to collapse widget
    const closeBtn = page.locator('.tc-close');
    await closeBtn.click();
    await expect(panel).not.toHaveClass(/tc-open/);
  });

  test('should exchange live messages with AI and receive an intelligent response', async ({ page }) => {
    // Pre-identify visitor to skip captcha and intro form in automated tests
    await page.addInitScript(() => {
      localStorage.setItem('tectonic_wc_vid', 'playwright-ai-visitor-1');
      localStorage.setItem('tectonic_wc_name', 'Tanvir Ahmed');
      localStorage.setItem('tectonic_wc_contact', '01712345678');
    });

    await page.goto('/widget-demo.html');
    const bubble = page.locator('.tc-bubble');
    await expect(bubble).toBeVisible({ timeout: 5000 });
    await bubble.click();

    const panel = page.locator('.tc-panel');
    await expect(panel).toHaveClass(/tc-open/, { timeout: 5000 });

    const input = page.locator('.tc-inputbar input');
    await expect(input).toBeVisible({ timeout: 5000 });
    await input.fill('delivery charge koto?');
    await page.locator('.tc-send').click();

    // Verify user message appears in conversation
    await expect(page.locator('.tc-row.out .tc-msg')).toContainText('delivery charge koto?');

    // Wait for AI auto-reply (inbound message after greeting)
    const aiReply = page.locator('.tc-row.in .tc-msg').nth(1);
    await expect(aiReply).toBeVisible({ timeout: 20000 });
    await expect(aiReply).toContainText(/(60|120|delivery|charge|ডেলিভারি)/i);
  });
});
