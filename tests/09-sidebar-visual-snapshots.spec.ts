import { test, expect } from '@playwright/test';
import * as path from 'path';

test('Capture visual proof of redesigned sidebar and isolated workspace screens', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('tectonic-onboard-hide', '1');
  });

  // 1. Authenticate as admin so all items are visible
  await page.goto('/app');
  const isLoginVisible = await page.locator('#login-view').isVisible();
  if (isLoginVisible) {
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'admin123');
    await page.click('#login-btn');
  }
  await expect(page.locator('#app-sidebar')).toBeVisible({ timeout: 12000 });
  await page.waitForTimeout(1000);

  const artifactDir = 'C:\\Users\\Diamond Technology\\.gemini\\antigravity\\brain\\7c4b2ecc-173c-4b91-9904-9e4ad41ca616';

  // 1. Full layout with Inbox view
  await page.screenshot({
    path: path.join(artifactDir, 'sidebar_redesign_inbox_full.png')
  });

  // 2. Sidebar Crop
  await page.locator('#app-sidebar').screenshot({
    path: path.join(artifactDir, 'sidebar_redesign_match_reference.png')
  });

  // 3. Isolated Leads View (matching active gradient pill from user screenshot)
  await page.click('#nav-links button[data-nav="leads"]');
  await page.waitForTimeout(600);
  await page.locator('#app-sidebar').screenshot({
    path: path.join(artifactDir, 'sidebar_leads_active_exact_pill.png')
  });

  // 4. Isolated Orders View
  await page.click('#nav-links button[data-nav="orders"]');
  await page.waitForTimeout(600);
  await page.screenshot({
    path: path.join(artifactDir, 'sidebar_isolated_orders_screen.png')
  });

  // 5. Isolated Teach the AI View
  await page.click('#nav-links button[data-nav="kb"]');
  await page.waitForTimeout(600);
  await page.screenshot({
    path: path.join(artifactDir, 'sidebar_isolated_teach_ai_screen.png')
  });

  // 6. Isolated Chat Widget Style View
  await page.click('#nav-links button[data-nav="webchat"]');
  await page.waitForTimeout(600);
  await page.screenshot({
    path: path.join(artifactDir, 'sidebar_isolated_webchat_screen.png')
  });
});
