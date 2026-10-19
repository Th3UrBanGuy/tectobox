import { test, expect } from '@playwright/test';

test.describe('5. Categorized More Menu, Webchat Widget & Courier Logistics', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('tectonic-onboard-hide', '1');
    });
    await page.goto('/app');
    const isLoginVisible = await page.locator('#login-view').isVisible();
    if (isLoginVisible) {
      await page.fill('#login-username', 'operator');
      await page.fill('#login-password', 'operator123');
      await page.click('#login-btn');
      await expect(page.locator('#app-view')).toBeVisible();
    }
  });

  test('should display clean, categorized sections in More view', async ({ page }) => {
    // Navigate to More view
    await page.click('#nav-links button[data-nav="more"]');
    await expect(page.locator('#cview-more')).toBeVisible();

    // Verify all 5 structured category titles
    const moreWrap = page.locator('#more-workspace-wrap');
    await expect(moreWrap.locator('.more-group-title').filter({ hasText: 'Store & Logistics' })).toBeVisible();
    await expect(moreWrap.locator('.more-group-title').filter({ hasText: 'Channels & Live Chat' })).toBeVisible();
    await expect(moreWrap.locator('.more-group-title').filter({ hasText: 'AI & Intelligence' })).toBeVisible();
    await expect(moreWrap.locator('.more-group-title').filter({ hasText: 'Marketing & Growth' })).toBeVisible();
    await expect(moreWrap.locator('.more-group-title').filter({ hasText: 'Settings & System' })).toBeVisible();

    // Verify items in each category
    await expect(moreWrap.locator('.mrow').filter({ hasText: 'My Products' })).toBeVisible();
    await expect(moreWrap.locator('.mrow').filter({ hasText: 'Courier Logistics' })).toBeVisible();
    await expect(moreWrap.locator('.mrow').filter({ hasText: 'Orders & Shipping Slips' })).toBeVisible();
    await expect(moreWrap.locator('.mrow').filter({ hasText: 'Connect Channels' })).toBeVisible();
    await expect(moreWrap.locator('.mrow').filter({ hasText: 'Webchat Widget' })).toBeVisible();
    await expect(moreWrap.locator('.mrow').filter({ hasText: 'Canned Quick Replies' })).toBeVisible();
    await expect(moreWrap.locator('.mrow').filter({ hasText: 'Teach the AI' })).toBeVisible();
    await expect(moreWrap.locator('.mrow').filter({ hasText: 'Lead Intelligence' })).toBeVisible();
  });

  test('should display Webchat Widget embed code, preview, and live customization', async ({ page }) => {
    // Navigate to More -> Webchat Widget
    await page.click('#nav-links button[data-nav="more"]');
    await expect(page.locator('#cview-more')).toBeVisible();

    const webchatBtn = page.locator('#more-workspace-wrap .mrow').filter({ hasText: 'Webchat Widget' });
    await expect(webchatBtn).toBeVisible();
    await webchatBtn.click();

    // Verify Settings view opened on Webchat Widget tab
    await expect(page.locator('#cview-settings')).toBeVisible();
    await expect(page.locator('#stab-appearance')).toBeVisible();

    // Verify embed code snippet box
    const snippetBox = page.locator('#appearance-card .code-box');
    await expect(snippetBox).toBeVisible();
    await expect(snippetBox).toContainText('widget.js');

    // Verify Copy & Try buttons
    await expect(page.locator('#wc-tab-copy')).toBeVisible();
    await expect(page.locator('#wc-tab-test')).toBeVisible();

    // Verify live preview and controls
    await expect(page.locator('#wc-pv-bubble')).toBeVisible();
    await expect(page.locator('#wc-pv-title')).toBeVisible();
    await expect(page.locator('#wc-title')).toBeVisible();
    await expect(page.locator('#wc-save-appear')).toBeVisible();

    // Save appearance
    await page.fill('#wc-title', 'Tectobox Store');
    await page.click('#wc-save-appear');
    await page.waitForTimeout(500);
  });

  test('should configure Courier Logistics and open Steadfast settings modal', async ({ page }) => {
    // Navigate to More -> Courier Logistics
    await page.click('#nav-links button[data-nav="more"]');
    await expect(page.locator('#cview-more')).toBeVisible();

    const courierBtn = page.locator('#more-workspace-wrap .mrow').filter({ hasText: 'Courier Logistics' });
    await expect(courierBtn).toBeVisible();
    await courierBtn.click();

    // Verify modal is open
    const modal = page.locator('#courier-modal');
    await expect(modal).toBeVisible();

    // Verify provider dropdown and delivery charges
    await expect(page.locator('#courier-provider')).toHaveValue('steadfast');
    await expect(page.locator('#sf-charge-inside')).toBeVisible();
    await expect(page.locator('#sf-charge-outside')).toBeVisible();

    // Fill sample config and save
    await page.fill('#sf-api-key', 'stdf_test_key_sample');
    await page.fill('#sf-secret-key', 'stdf_sec_sample');
    await page.click('#btn-save-courier');
    await page.waitForTimeout(600);

    // Modal should be closed after saving
    await expect(modal).toBeHidden();
  });

  test('should open Orders modal and render 4x6" Thermal Shipping Slip', async ({ page }) => {
    // Navigate to More -> Orders & Shipping Slips
    await page.click('#nav-links button[data-nav="more"]');
    await expect(page.locator('#cview-more')).toBeVisible();

    const ordersBtn = page.locator('#more-workspace-wrap .mrow').filter({ hasText: 'Orders & Shipping Slips' });
    await expect(ordersBtn).toBeVisible();
    await ordersBtn.click();

    // Verify orders modal is open
    const modal = page.locator('#orders-modal');
    await expect(modal).toBeVisible();

    // If orders exist, test clicking "Print Label"
    const printBtns = modal.locator('[data-print-order]');
    const count = await printBtns.count();
    if (count > 0) {
      await printBtns.first().click();
      const thermalModal = page.locator('#thermal-label-modal');
      await expect(thermalModal).toBeVisible();
      await expect(page.locator('#thermal-preview-container .thermal-sheet')).toBeVisible();
      await expect(page.locator('#btn-print-thermal')).toBeVisible();
      await page.click('#btn-close-thermal');
      await expect(thermalModal).toBeHidden();
    }

    // Close orders modal
    await page.click('#btn-close-orders');
    await expect(modal).toBeHidden();
  });

  test('should trigger Canned Quick Replies slash command popup in chat composer', async ({ page }) => {
    await expect(page.locator('#cview-inbox')).toBeVisible();

    // Open first conversation
    const convItems = page.locator('#conv-list .conv-item');
    await expect(convItems.first()).toBeVisible({ timeout: 5000 });
    await convItems.first().click();

    const composer = page.locator('#msg-input');
    await expect(composer).toBeVisible();

    // Type "/" to trigger autocomplete popup
    await composer.fill('/');
    const slashPopup = page.locator('#slash-popup');
    await expect(slashPopup).toBeVisible({ timeout: 3000 });

    // Verify standard templates are present (/bkash, /delivery, etc.)
    const bkashItem = slashPopup.locator('.slash-item').filter({ hasText: '/bkash' });
    await expect(bkashItem).toBeVisible();
    const deliveryItem = slashPopup.locator('.slash-item').filter({ hasText: '/delivery' });
    await expect(deliveryItem).toBeVisible();

    // Click /bkash item to insert canned response
    await bkashItem.click();
    await expect(slashPopup).toBeHidden();

    // Verify composer contains the bKash text
    const text = await composer.inputValue();
    expect(text).toContain('বিকাশ মার্চেন্ট');
  });
});
