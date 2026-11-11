import { test, expect } from '@playwright/test';
import { e2ePassword } from './e2e-credentials';

test.describe('3. Workspace Features, Interfaces & Buttons', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('tectonic-onboard-hide', '1');
    });
    await page.goto('/app');
    const isLoginVisible = await page.locator('#login-view').isVisible();
    if (isLoginVisible) {
      // Login as operator to directly enter Workspace Client View
      await page.fill('#login-username', 'operator');
      await page.fill('#login-password', e2ePassword('operator'));
      await page.click('#login-btn');
      await expect(page.locator('#app-view')).toBeVisible();
    }
  });

  test('should render Inbox conversation list, chat pane, messages, and side tabs', async ({ page }) => {
    await expect(page.locator('#cview-inbox')).toBeVisible({ timeout: 10000 });

    // Verify conversation items are rendered in left list pane
    const convItems = page.locator('#conv-list .conv-item');
    await expect(convItems.first()).toBeVisible({ timeout: 5000 });
    const convCount = await convItems.count();
    expect(convCount).toBeGreaterThan(0);

    // Click first conversation to open thread
    await convItems.first().click();
    await expect(page.locator('#chat-header')).toBeVisible();

    // Verify message composer textarea and send button
    const composer = page.locator('#msg-input');
    await expect(composer).toBeVisible();
    const sendBtn = page.locator('#btn-send');
    await expect(sendBtn).toBeVisible();

    // Type a message in composer
    await composer.fill('Automated UI test reply verification');
    await expect(composer).toHaveValue('Automated UI test reply verification');

    // Verify side pane tabs (Customer, Products, New Order)
    const sideTabs = page.locator('#side-pane .side-tab');
    await expect(sideTabs.filter({ hasText: 'Customer' })).toBeVisible();
    await expect(sideTabs.filter({ hasText: 'Products' })).toBeVisible();
    await expect(sideTabs.filter({ hasText: 'New Order' })).toBeVisible();

    // Switch side tab to Products and verify product items
    await sideTabs.filter({ hasText: 'Products' }).click();
    await page.waitForTimeout(300);

    // Switch side tab to New Order
    await sideTabs.filter({ hasText: 'New Order' }).click();
    await page.waitForTimeout(300);
  });

  test('should filter and inspect Leads CRM interface', async ({ page }) => {
    // Navigate to Leads view
    const leadsTab = page.locator('#nav-links button[data-nav="leads"]');
    await expect(leadsTab).toBeVisible();
    await leadsTab.click();

    await expect(page.locator('#cview-leads')).toBeVisible();

    // Verify temperature filter buttons (All, Hot, Warm, Cold)
    const tempFilters = page.locator('#lead-temp-filters button');
    await expect(tempFilters.filter({ hasText: 'All' })).toBeVisible();
    await expect(tempFilters.filter({ hasText: 'Hot' })).toBeVisible();
    await expect(tempFilters.filter({ hasText: 'Warm' })).toBeVisible();
    await expect(tempFilters.filter({ hasText: 'Cold' })).toBeVisible();

    // Click 'Hot' filter button
    await tempFilters.filter({ hasText: 'Hot' }).click();
    await expect(tempFilters.filter({ hasText: 'Hot' })).toHaveClass(/active/);

    // Click 'All' filter button back
    await tempFilters.filter({ hasText: 'All' }).click();
    await expect(tempFilters.filter({ hasText: 'All' })).toHaveClass(/active/);

    // Verify Leads Table rows
    const leadRows = page.locator('#leads-body tr');
    await expect(leadRows.first()).toBeVisible({ timeout: 5000 });

    // Verify CSV button is clickable
    const csvBtn = page.locator('#btn-csv');
    await expect(csvBtn).toBeVisible();
  });

  test('should navigate via sidebar and open Products catalog interface', async ({ page }) => {
    // Click 'My Products' in sidebar
    const productsTab = page.locator('#nav-links button[data-nav="products"]');
    await expect(productsTab).toBeVisible();
    await productsTab.click();

    // Verify Products catalog view is displayed
    await expect(page.locator('#cview-products')).toBeVisible();
    await expect(page.locator('#btn-add-product')).toBeVisible();

    // Verify products grid contains seeded items
    const prodCards = page.locator('#product-grid .prod-card');
    await expect(prodCards.first()).toBeVisible({ timeout: 5000 });
    const count = await prodCards.count();
    expect(count).toBeGreaterThanOrEqual(4);

    // Click "Add product" button to open modal
    await page.click('#btn-add-product');
    const modal = page.locator('#product-modal');
    await expect(modal).toBeVisible();

    // Verify inputs in modal
    await expect(page.locator('#pm-sku')).toBeVisible();
    await expect(page.locator('#pm-name')).toBeVisible();
    await expect(page.locator('#pm-price')).toBeVisible();

    // Close modal
    await page.click('#btn-close-product');
    await expect(modal).toBeHidden();
  });

  test('should open isolated workspace screens: Channels, Knowledge Base, Appearance', async ({ page }) => {
    // 1. Connect Channels screen via sidebar
    const chanTab = page.locator('#nav-links button[data-nav="channels"]');
    await expect(chanTab).toBeVisible();
    await chanTab.click();
    await expect(page.locator('#cview-channels')).toBeVisible();
    await expect(page.locator('#btn-add-channel')).toBeVisible();

    // 2. Knowledge Base screen via sidebar
    const kbTab = page.locator('#nav-links button[data-nav="kb"]');
    await expect(kbTab).toBeVisible();
    await kbTab.click();
    await expect(page.locator('#cview-kb')).toBeVisible();
    await expect(page.locator('#kb-title')).toBeVisible();
    await expect(page.locator('#kb-content')).toBeVisible();
    await expect(page.locator('#btn-save-kb')).toBeVisible();

    // 3. Chat Widget Style screen via sidebar
    const webchatTab = page.locator('#nav-links button[data-nav="webchat"]');
    await expect(webchatTab).toBeVisible();
    await webchatTab.click();
    await expect(page.locator('#cview-webchat')).toBeVisible();
    await expect(page.locator('#appearance-card')).toBeVisible();
  });
});
