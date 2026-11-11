import { test, expect } from '@playwright/test';
import { e2ePassword } from './e2e-credentials';

test.describe('1. Welcome Landing & Authentication Interfaces', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('tectonic-onboard-hide', '1');
    });
  });

  test('should render welcome page with branding, hero, and theme toggle', async ({ page }) => {
    await page.goto('/welcome');
    await expect(page).toHaveTitle(/Tectobox/i);

    // Verify main hero title / branding
    const brand = page.locator('.brand-pill, .hero h1, h1, .brand');
    await expect(brand.first()).toBeVisible();

    // Verify theme toggle button works
    const themeBtn = page.locator('#btn-theme, button[title*="theme"], .theme-toggle').first();
    if (await themeBtn.isVisible()) {
      const initialTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      await themeBtn.click();
      const newTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      expect(newTheme).not.toBe(initialTheme);
      // Toggle back
      await themeBtn.click();
    }

    // Verify CTA / Open App link leads to login or app
    const cta = page.locator('a[href="/app"], a[href="/"], .btn-primary').first();
    await expect(cta).toBeVisible();
  });

  test('should reject invalid credentials with error message', async ({ page }) => {
    await page.goto('/app');
    
    // Check login view is present
    await expect(page.locator('#login-view')).toBeVisible();
    await expect(page.locator('#login-username')).toBeVisible();
    await expect(page.locator('#login-password')).toBeVisible();

    // Fill incorrect credentials
    await page.fill('#login-username', 'invalid_user');
    await page.fill('#login-password', 'wrong_pass_123');
    await page.click('#login-btn');

    // Verify error text is displayed
    const errBox = page.locator('#login-err');
    await expect(errBox).toBeVisible({ timeout: 5000 });
    const errText = await errBox.textContent();
    expect(errText?.length).toBeGreaterThan(0);
  });

  test('should sign in successfully as admin and enter Platform Admin Panel', async ({ page }) => {
    await page.goto('/app');

    // Fill admin credentials
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', e2ePassword('admin'));
    await page.click('#login-btn');

    // Verify app-view opens and login-view hides
    await expect(page.locator('#app-view')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#login-view')).toBeHidden();

    // Verify User chips
    await expect(page.locator('#user-name')).toHaveText('admin');

    // Verify Platform Admin Panel is open by default
    await expect(page.locator('#view-admin')).toBeVisible();
    await expect(page.locator('#view-client')).toBeHidden();
  });

  test('should sign out successfully and return to login screen', async ({ page }) => {
    await page.goto('/app');

    // Sign in first
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', e2ePassword('admin'));
    await page.click('#login-btn');
    await expect(page.locator('#app-view')).toBeVisible();

    // Click Sign out button
    await page.click('#btn-signout');

    // Verify login view returns
    await expect(page.locator('#login-view')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#app-view')).toBeHidden();
  });

  test('should sign in as operator and see workspace user panel (not platform panel)', async ({ page }) => {
    await page.goto('/app');

    // Sign in as operator
    await page.fill('#login-username', 'operator');
    await page.fill('#login-password', e2ePassword('operator'));
    await page.click('#login-btn');
    await expect(page.locator('#app-view')).toBeVisible();

    // Verify user is operator
    await expect(page.locator('#user-name')).toHaveText('operator');

    // Verify Workspace Client View is visible and Platform Admin Panel is hidden
    await expect(page.locator('#view-client')).toBeVisible();
    await expect(page.locator('#view-admin')).toBeHidden();

    // Clean up
    await page.click('#btn-signout');
  });
});
