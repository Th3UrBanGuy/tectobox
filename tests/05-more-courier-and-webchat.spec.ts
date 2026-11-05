import { test, expect } from '@playwright/test';

test.describe('5. Isolated Workspace Screens, Webchat Widget & Courier Logistics', () => {
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

  test('should display clean, isolated sections in modern sidebar', async ({ page }) => {
    const sidebar = page.locator('#app-sidebar');
    await expect(sidebar).toBeVisible();

    // Verify groups in sidebar
    await expect(sidebar.locator('.sidebar-group-header').filter({ hasText: 'MAIN' })).toBeVisible();
    await expect(sidebar.locator('.sidebar-group-header').filter({ hasText: 'WORKSPACE' })).toBeVisible();

    // Verify all first-class isolated items
    await expect(sidebar.locator('.nav-link[data-nav="inbox"]')).toBeVisible();
    await expect(sidebar.locator('.nav-link[data-nav="leads"]')).toBeVisible();
    await expect(sidebar.locator('.nav-link[data-nav="orders"]')).toBeVisible();
    await expect(sidebar.locator('.nav-link[data-nav="products"]')).toBeVisible();
    await expect(sidebar.locator('.nav-link[data-nav="channels"]')).toBeVisible();
    await expect(sidebar.locator('.nav-link[data-nav="kb"]')).toBeVisible();
    await expect(sidebar.locator('.nav-link[data-nav="webchat"]')).toBeVisible();
    await expect(sidebar.locator('.nav-link[data-nav="backup"]')).toBeVisible();
    await expect(sidebar.locator('.nav-link[data-nav="plan"]')).toBeVisible();
    await expect(sidebar.locator('.nav-link[data-nav="apikeys"]')).toBeVisible();
    await expect(sidebar.locator('.nav-link[data-nav="broadcast"]')).toBeVisible();
    await expect(sidebar.locator('.nav-link[data-nav="guide"]')).toBeVisible();
  });

  test('should display Webchat Widget embed code, preview, and live customization', async ({ page }) => {
    // Navigate via sidebar to Chat Widget Style
    const webchatBtn = page.locator('#nav-links button[data-nav="webchat"]');
    await expect(webchatBtn).toBeVisible();
    await webchatBtn.click();

    // Verify isolated view opened
    await expect(page.locator('#cview-webchat')).toBeVisible();
    await expect(page.locator('#appearance-card')).toBeVisible();

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
    // Navigate via sidebar to Orders & Logistics
    await page.click('#nav-links button[data-nav="orders"]');
    await expect(page.locator('#cview-orders')).toBeVisible();

    const courierBtn = page.locator('#btn-open-courier-config');
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

  test('should open Orders isolated view and render 4x6" Thermal Shipping Slip', async ({ page }) => {
    // Navigate via sidebar to Orders
    await page.click('#nav-links button[data-nav="orders"]');
    await expect(page.locator('#cview-orders')).toBeVisible();

    // Verify order cards in full page list
    const thermalBtns = page.locator('#orders-full-list [data-thermal-order]');
    const count = await thermalBtns.count();
    if (count > 0) {
      await thermalBtns.first().click();
      const thermalModal = page.locator('#thermal-label-modal');
      await expect(thermalModal).toBeVisible();
      await expect(page.locator('#thermal-preview-container .thermal-sheet')).toBeVisible();
      await expect(page.locator('#btn-print-thermal')).toBeVisible();
      await page.click('#btn-close-thermal');
      await expect(thermalModal).toBeHidden();
    }
  });

  test('should trigger Canned Quick Replies slash command popup in chat composer', async ({ page }) => {
    await page.click('#nav-links button[data-nav="inbox"]');
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
