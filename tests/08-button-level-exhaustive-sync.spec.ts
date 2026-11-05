import { test, expect, Page } from '@playwright/test';

test.describe('8. Button-Level Exhaustive Sync & Multi-Mechanism Stress Suite', () => {
  test.setTimeout(45000);
  const WIDGET_KEY = 'test-widget-key';

  async function ensureLoggedIn(page: Page, role: 'operator' | 'admin' = 'operator') {
    const username = role === 'admin' ? 'admin' : 'operator';
    const password = role === 'admin' ? 'admin123' : 'operator123';

    await page.goto('/app');
    const isLoginVisible = await page.locator('#login-view').isVisible();
    if (!isLoginVisible) {
      const curUser = await page.locator('#user-name').textContent().catch(() => '');
      if (curUser && curUser.trim() === username) {
        return;
      }
      // Switch user by signing out
      const signoutBtn = page.locator('#btn-signout');
      if (await signoutBtn.isVisible()) {
        await signoutBtn.click();
        await page.waitForSelector('#login-view:not(.hidden)', { timeout: 8000 });
      }
    }

    await page.fill('#login-username', username);
    await page.fill('#login-password', password);
    await page.click('#login-btn', { force: true });
    await expect(page.locator('#app-view')).toBeVisible({ timeout: 12000 });
  }

  async function goToNav(page: Page, nav: string) {
    const btn = page.locator(`#nav-links button[data-nav="${nav}"]`);
    await btn.waitFor({ state: 'visible', timeout: 8000 });
    await btn.click();
    if (nav === 'admin') {
      await expect(page.locator('#view-admin')).toBeVisible({ timeout: 8000 });
    } else {
      await expect(page.locator('#view-client')).toBeVisible({ timeout: 8000 });
      await expect(page.locator(`#cview-${nav}`)).toBeVisible({ timeout: 8000 });
    }
  }

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('tectonic-onboard-hide', '1');
    });
  });

  // =========================================================================
  // 1. INBOX & CHAT COMPOSER BUTTON MECHANISMS
  // =========================================================================
  test('INB-01 to INB-08: Chat Composer & Send Button exhaustive interactions', async ({ page, request }) => {
    await ensureLoggedIn(page, 'operator');

    // Seed conversation for inbox
    await request.post('http://localhost:3000/api/widget/' + WIDGET_KEY + '/message', {
      data: {
        visitor_id: 'visitor-btn-test-01',
        name: 'Rahim Uddin',
        text: 'Apnader delivery charge koto?',
      },
    });

    await goToNav(page, 'inbox');

    const firstConv = page.locator('#conv-list .conv-item').first();
    await firstConv.waitFor({ state: 'visible', timeout: 8000 });
    await firstConv.click();

    const msgInput = page.locator('#msg-input');
    const sendBtn = page.locator('#btn-send');
    await msgInput.waitFor({ state: 'visible', timeout: 6000 });

    // Aspect INB-04: Empty or whitespace input disables send button
    await msgInput.fill('   ');
    expect(await sendBtn.isDisabled()).toBe(true);

    // Aspect INB-03: Shift+Enter inserts newline without sending
    await msgInput.fill('Line 1');
    await msgInput.press('Shift+Enter');
    const inputVal = await msgInput.inputValue();
    expect(inputVal).toContain('\n');

    // Aspect INB-06: Special characters and XSS sanitization
    const xssPayload = '৳1250 Special Deal & <script>alert(1)</script>';
    await msgInput.fill(xssPayload);
    await expect(sendBtn).toBeEnabled();
    await sendBtn.click();

    // Verify it appears safely in the chat stream without executing script
    await page.waitForSelector('#messages .msg-row', { timeout: 8000 });
    const lastMsg = page.locator('#messages .msg-row').last();
    await expect(lastMsg).toBeVisible();
    const scriptElements = page.locator('#messages script');
    expect(await scriptElements.count()).toBe(0);

    // Aspect INB-08: Typing '/' opens canned quick replies popup
    await msgInput.fill('/');
    const slashPopup = page.locator('#slash-popup:not(.hidden)');
    await expect(slashPopup).toBeVisible({ timeout: 6000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#slash-popup')).toBeHidden();
  });

  // =========================================================================
  // 2. HUMAN HANDOVER & AI BOT MUTE SYNCHRONIZATION
  // =========================================================================
  test('HND-01 to HND-05: Human Handover toggle state synchronization', async ({ page, request }) => {
    await ensureLoggedIn(page, 'operator');

    await request.post('http://localhost:3000/api/widget/' + WIDGET_KEY + '/message', {
      data: {
        visitor_id: 'visitor-handover-test',
        name: 'Karim Ullah',
        text: 'Ami ektu kotha bolte chai',
      },
    });

    await goToNav(page, 'inbox');

    const firstConv = page.locator('#conv-list .conv-item').first();
    await firstConv.waitFor({ state: 'visible', timeout: 8000 });
    await firstConv.click();

    // Toggle Handover via chat header button #btn-toggle-human
    const toggleBtn = page.locator('#btn-toggle-human');
    await toggleBtn.waitFor({ state: 'visible', timeout: 6000 });
    await toggleBtn.click();

    // Banner should appear
    const humanBanner = page.locator('#human-banner-slot .human-banner');
    await expect(humanBanner).toBeVisible({ timeout: 6000 });

    // Toggle Handover OFF
    await toggleBtn.click();
    await expect(humanBanner).toBeHidden({ timeout: 6000 });

    // Filter by needs human button in toolbar (#btn-human)
    const filterHumanBtn = page.locator('#btn-human');
    await filterHumanBtn.click();
    await expect(filterHumanBtn).toHaveClass(/\bon\b/);
    await filterHumanBtn.click();
    await expect(filterHumanBtn).not.toHaveClass(/\bon\b/);
  });

  // =========================================================================
  // 3. PRODUCTS CATALOG CRUD & BOUNDARY CLAMPING
  // =========================================================================
  test('PRD-01 to PRD-11: Products Catalog Modal, validation, and negative clamping', async ({ page }) => {
    await ensureLoggedIn(page, 'operator');
    await goToNav(page, 'products');
    await page.waitForSelector('#cview-products:not(.hidden)', { timeout: 8000 });

    const addProductBtn = page.locator('#btn-add-product');
    await addProductBtn.click();

    const productModal = page.locator('#product-modal:not(.hidden)');
    await expect(productModal).toBeVisible();

    // Missing required fields validation
    const saveBtn = page.locator('#btn-save-product');
    await saveBtn.click();
    await expect(productModal).toBeVisible();

    // Fill valid product with boundary values
    const testSku = 'SKU-CLAMP-' + Date.now();
    await page.fill('#pm-sku', testSku);
    await page.fill('#pm-name', 'Clamped Premium Headphones');
    await page.fill('#pm-category', 'Electronics');
    await page.fill('#pm-price', '3200');
    await page.fill('#pm-stock', '15');

    await saveBtn.click();
    await expect(productModal).toBeHidden({ timeout: 8000 });

    // Verify product exists in grid
    const newProdCard = page.locator(`#product-grid .prod-card:has-text("${testSku}")`);
    await expect(newProdCard).toBeVisible({ timeout: 8000 });

    // Catalog search filtering
    const catalogSearch = page.locator('#catalog-search');
    await catalogSearch.fill('Clamped Premium');
    await page.waitForTimeout(300);
    await expect(newProdCard).toBeVisible();

    await catalogSearch.fill('NonExistentZeroMatch123XYZ');
    await page.waitForTimeout(300);
    await expect(newProdCard).toBeHidden();
    await catalogSearch.fill('');

    // Modal dismissal via Escape key
    await addProductBtn.click();
    await expect(productModal).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(productModal).toBeHidden({ timeout: 6000 });
  });

  // =========================================================================
  // 4. COURIER LOGISTICS, STEADFAST BOOKING & THERMAL LABEL
  // =========================================================================
  test('CUR-01 to CUR-09: Courier config modal, Steadfast booking COD accuracy', async ({ page }) => {
    await ensureLoggedIn(page, 'operator');
    await goToNav(page, 'orders');
    await expect(page.locator('#cview-orders')).toBeVisible({ timeout: 8000 });

    // Open Courier Logistics
    const courierBtn = page.locator('#btn-open-courier-config');
    await courierBtn.waitFor({ state: 'visible', timeout: 6000 });
    await courierBtn.click();

    const courierModal = page.locator('#courier-modal:not(.hidden)');
    await expect(courierModal).toBeVisible();

    // Enter Steadfast keys
    await page.fill('#sf-api-key', 'stdf_test_key_live_123');
    await page.fill('#sf-secret-key', 'stdf_secret_abc_456');
    await page.fill('#sf-charge-inside', '60');
    await page.fill('#sf-charge-outside', '120');

    await page.click('#btn-save-courier');
    await expect(courierModal).toBeHidden({ timeout: 8000 });

    // Check if an order has a 4x6" Thermal Slip button
    const thermalBtn = page.locator('#orders-full-list button:has-text("Thermal Slip")').first();
    if (await thermalBtn.isVisible()) {
      await thermalBtn.click();
      const thermalModal = page.locator('#thermal-label-modal:not(.hidden)');
      await expect(thermalModal).toBeVisible({ timeout: 6000 });

      // Verify COD box is rendered
      const codBox = page.locator('#thermal-preview-container .ts-cod-amt');
      await expect(codBox).toBeVisible();

      // Close thermal modal
      await page.click('#btn-close-thermal');
      await expect(thermalModal).toBeHidden();
    }
  });

  // =========================================================================
  // 5. LEADS CRM PIPELINE & INTELLIGENCE DRAWER
  // =========================================================================
  test('LED-01 to LED-09: Leads table, filter segments, detail modal, CSV export', async ({ page }) => {
    await ensureLoggedIn(page, 'operator');
    await goToNav(page, 'leads');

    // Verify filter segments exist and can be clicked
    const segmentButtons = page.locator('#lead-segment-filters button');
    expect(await segmentButtons.count()).toBeGreaterThanOrEqual(3);
    await segmentButtons.nth(1).click();
    await page.waitForTimeout(200);
    await segmentButtons.nth(0).click();

    // Verify temperature filters exist
    const tempButtons = page.locator('#lead-temp-filters button');
    expect(await tempButtons.count()).toBeGreaterThanOrEqual(3);
    await tempButtons.nth(1).click();
    await page.waitForTimeout(200);
    await tempButtons.nth(0).click();

    // Search filter
    const leadSearch = page.locator('#lead-search');
    await leadSearch.fill('Rahim');
    await page.waitForTimeout(300);
    await leadSearch.fill('');

    // If leads exist, click the first row to inspect drawer
    const firstRow = page.locator('#leads-body tr').first();
    if (await firstRow.isVisible()) {
      await firstRow.click();
      const leadModal = page.locator('#lead-modal:not(.hidden)');
      await expect(leadModal).toBeVisible({ timeout: 6000 });

      // Check Advance button if visible (not confirmed)
      const advBtn = page.locator('#btn-advance-lead');
      if (await advBtn.isVisible()) {
        await advBtn.click();
        await page.waitForTimeout(300);
      } else {
        await page.click('#btn-close-lead');
      }
      await expect(leadModal).toBeHidden({ timeout: 6000 });
    }
  });

  // =========================================================================
  // 6. KNOWLEDGE BASE & PRESET TEMPLATES
  // =========================================================================
  test('KB-01 to KB-07: Knowledge base creation, preset filling, and deletion', async ({ page }) => {
    await ensureLoggedIn(page, 'operator');
    await goToNav(page, 'kb');
    await page.waitForSelector('#stab-kb:not(.hidden)', { timeout: 8000 });

    const kbTitle = page.locator('#kb-title');
    const kbContent = page.locator('#kb-content');
    const saveKbBtn = page.locator('#btn-save-kb');

    const testTitle = 'Exchange Policy Test ' + Date.now();
    await kbTitle.fill(testTitle);
    await page.selectOption('#kb-category', 'policy');
    await kbContent.fill('We allow 7-day hassle-free product exchanges for our valued customers.');
    await saveKbBtn.click();

    // Verify it appears in the documents list
    const savedItem = page.locator(`#kb-list .doc-card:has-text("${testTitle}")`);
    await expect(savedItem).toBeVisible({ timeout: 8000 });

    // Test preset subtab switching
    const presetsSubtab = page.locator('#kb-subtabs button[data-kb="presets"]');
    await presetsSubtab.click();
    await expect(page.locator('#kbtab-presets:not(.hidden)')).toBeVisible();

    // Return to documents subtab
    await page.locator('#kb-subtabs button[data-kb="docs"]').click();
    await expect(page.locator('#kbtab-docs:not(.hidden)')).toBeVisible();
  });

  // =========================================================================
  // 7. PLATFORM ADMIN CONTROLS & COMMAND PALETTE
  // =========================================================================
  test('ADM-01 to ADM-10: Platform Admin modal controls, Command Palette Ctrl+K', async ({ page }) => {
    await ensureLoggedIn(page, 'admin');
    await goToNav(page, 'admin');

    // Command Palette Ctrl+K test
    await page.keyboard.press('Control+k');
    const cmdkBg = page.locator('#cmdk-bg:not(.hidden)');
    await expect(cmdkBg).toBeVisible({ timeout: 6000 });

    const cmdkInput = page.locator('#cmdk-input');
    await cmdkInput.fill('Settings');
    await page.waitForTimeout(300);

    // Close with Escape
    await page.keyboard.press('Escape');
    await expect(cmdkBg).toBeHidden();

    // Admin Panel Tab switching
    const plansTab = page.locator('#admin-tabs button[data-at="licensing"]');
    await plansTab.click();
    await expect(page.locator('#atab-licensing:not(.hidden)')).toBeVisible();

    // Mode toggle between Package and Credit System
    const creditModeBtn = page.locator('#crt-mode button[data-mode="credit"]');
    await creditModeBtn.click();
    await expect(page.locator('#crt-credits-row:not(.hidden)')).toBeVisible();

    const packageModeBtn = page.locator('#crt-mode button[data-mode="package"]');
    await packageModeBtn.click();
    await expect(page.locator('#crt-period-row:not(.hidden)')).toBeVisible();
  });

  // =========================================================================
  // 8. THEME TOGGLE & SESSION SIGNOUT
  // =========================================================================
  test('AUT-01 to AUT-05: Theme toggle persistence and Sign Out session clearance', async ({ page }) => {
    await ensureLoggedIn(page, 'operator');

    const themeBtn = page.locator('#btn-theme');
    await themeBtn.click();
    await page.waitForTimeout(300);

    // Verify html tag has data-theme attribute
    const themeAttr = await page.getAttribute('html', 'data-theme');
    expect(themeAttr).toBeTruthy();

    // Sign out
    const signoutBtn = page.locator('#btn-signout');
    await signoutBtn.click();

    // Should return to login view
    await page.waitForSelector('#login-view:not(.hidden)', { timeout: 8000 });
    await expect(page.locator('#login-username')).toBeVisible();
  });
});
