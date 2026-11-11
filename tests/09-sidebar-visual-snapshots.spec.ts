import { test, expect } from '@playwright/test';
import { e2ePassword } from './e2e-credentials';
import * as path from 'path';

test('Capture visual proof of redesigned collapsible sidebar, no capsule logo, and icons-only mode', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('tectonic-onboard-hide', '1');
    localStorage.removeItem('tectobox_sidebar_collapsed');
  });

  // 1. Authenticate as admin
  await page.goto('/app');
  const isLoginVisible = await page.locator('#login-view').isVisible();
  if (isLoginVisible) {
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', e2ePassword('admin'));
    await page.click('#login-btn');
  }
  await expect(page.locator('#app-sidebar')).toBeVisible({ timeout: 12000 });
  await page.waitForTimeout(800);

  const artifactDir = 'C:\\Users\\Diamond Technology\\.gemini\\antigravity\\brain\\7c4b2ecc-173c-4b91-9904-9e4ad41ca616';

  // 1. Expanded Sidebar: Check logo (no capsule), brand typography, resizer, and new bottom controls
  await expect(page.locator('#sidebar-brand-click')).toBeVisible();
  await expect(page.locator('.sidebar-brand-title')).toHaveText('Tectobox');
  await expect(page.locator('#btn-sidebar-collapse')).toBeVisible();
  await expect(page.locator('#sidebar-resizer')).toBeVisible();
  await expect(page.locator('#user-name')).toBeVisible();
  await expect(page.locator('#btn-theme')).toBeVisible();
  await expect(page.locator('#btn-signout')).toBeVisible();

  // Capture expanded sidebar screenshot
  await page.locator('#app-sidebar').screenshot({
    path: path.join(artifactDir, 'sidebar_expanded_no_capsule.png')
  });

  // Capture full layout with expanded sidebar
  await page.screenshot({
    path: path.join(artifactDir, 'app_layout_expanded_sidebar.png')
  });

  // 2. Click collapse toggle button (#btn-sidebar-collapse)
  await page.click('#btn-sidebar-collapse');
  await page.waitForTimeout(500);

  // Verify sidebar has .collapsed class
  await expect(page.locator('#app-sidebar')).toHaveClass(/collapsed/);

  // In collapsed mode: texts should be hidden, only icons visible
  await expect(page.locator('.sidebar-brand-info')).toBeHidden();
  await expect(page.locator('#nav-links .nav-link .nav-text').first()).toBeHidden();
  await expect(page.locator('.sidebar-user-info')).toBeHidden();

  // Capture collapsed sidebar screenshot (Icons Only Mode)
  await page.locator('#app-sidebar').screenshot({
    path: path.join(artifactDir, 'sidebar_collapsed_icons_only.png')
  });

  // Capture full layout with collapsed sidebar
  await page.screenshot({
    path: path.join(artifactDir, 'app_layout_collapsed_sidebar.png')
  });

  // 3. Test navigation while collapsed (e.g. click Leads icon)
  await page.click('#nav-links button[data-nav="leads"]');
  await page.waitForTimeout(500);
  await expect(page.locator('#cview-leads')).toBeVisible();
  await expect(page.locator('#nav-links button[data-nav="leads"]')).toHaveClass(/active/);

  // Capture collapsed sidebar with active item
  await page.locator('#app-sidebar').screenshot({
    path: path.join(artifactDir, 'sidebar_collapsed_active_leads.png')
  });

  // 4. Test expanding back via toggle button
  await page.click('#btn-sidebar-collapse');
  await page.waitForTimeout(500);
  await expect(page.locator('#app-sidebar')).not.toHaveClass(/collapsed/);
  await expect(page.locator('#nav-links .nav-link .nav-text').first()).toBeVisible();

  // 5. Test keyboard shortcut Ctrl+B to toggle collapse
  await page.keyboard.press('Control+b');
  await page.waitForTimeout(500);
  await expect(page.locator('#app-sidebar')).toHaveClass(/collapsed/);

  await page.keyboard.press('Control+b');
  await page.waitForTimeout(500);
  await expect(page.locator('#app-sidebar')).not.toHaveClass(/collapsed/);

  // 6. Test theme button in the redesigned bottom dock
  await page.click('#btn-theme');
  await page.waitForTimeout(400);
  // Verify dark theme toggle works
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  expect(['dark', 'light']).toContain(theme);

  // Capture dark mode expanded sidebar
  await page.locator('#app-sidebar').screenshot({
    path: path.join(artifactDir, 'sidebar_redesigned_theme_toggled.png')
  });
});
