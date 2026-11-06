import { test, expect } from '@playwright/test';

test.describe('14. Profile Credentials, Role-Based Restrictions, 2FA & Welcome Page', () => {

  test('Welcome page renders bilingual switcher and interactive AI chat simulator', async ({ page }) => {
    await page.goto('/welcome');
    await expect(page).toHaveTitle(/Tectobox/i);

    // Verify bilingual switcher
    const langBtnBn = page.locator('#btn-lang-bn');
    const langBtnEn = page.locator('#btn-lang-en');
    await expect(langBtnBn).toBeVisible();
    await expect(langBtnEn).toBeVisible();

    // Toggle to Bengali
    await langBtnBn.click();
    const heroTitle = page.locator('#hero-title');
    await expect(heroTitle).toContainText('সব কাস্টমার চ্যাট এক ইনবক্সে');

    // Toggle to English
    await langBtnEn.click();
    await expect(heroTitle).toContainText('All Customer Chats');

    // Test Interactive AI Chat Simulator
    const simPromptBtn = page.locator('.sim-prompt-btn').first();
    await expect(simPromptBtn).toBeVisible();
    await simPromptBtn.click();

    // AI simulated response should appear
    const aiBubble = page.locator('.sim-msg.bot').first();
    await expect(aiBubble).toBeVisible({ timeout: 4000 });
  });

  test('Login view renders password visibility toggle and bilingual switch', async ({ page }) => {
    await page.goto('/app');
    await expect(page.locator('#login-view')).toBeVisible();

    // Eye toggle
    const eyeBtn = page.locator('#btn-toggle-login-pwd');
    await expect(eyeBtn).toBeVisible();
    const pwdInput = page.locator('#login-password');
    await expect(pwdInput).toHaveAttribute('type', 'password');

    await eyeBtn.click();
    await expect(pwdInput).toHaveAttribute('type', 'text');
    await eyeBtn.click();
    await expect(pwdInput).toHaveAttribute('type', 'password');

    // Bilingual switch on login
    const btnBn = page.locator('#btn-login-lang-bn');
    const btnEn = page.locator('#btn-login-lang-en');
    await expect(btnBn).toBeVisible();
    await btnBn.click();
    await expect(page.locator('#txt-login-btn')).toHaveText('লগইন করুন');
    await btnEn.click();
    await expect(page.locator('#txt-login-btn')).toHaveText('Sign in');
  });

});
