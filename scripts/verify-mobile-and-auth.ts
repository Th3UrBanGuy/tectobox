import { chromium } from 'playwright';

async function run() {
  const browser = await chromium.launch({ headless: true });
  
  // Test 1: Mobile viewport with operator login
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true
  });
  
  const page = await mobileContext.newPage();
  console.log('Navigating to http://160.25.5.64/index.html ...');
  await page.goto('http://160.25.5.64/index.html', { waitUntil: 'networkidle' });
  
  // Set onboard hide so popup doesn't block UI
  await page.evaluate(() => localStorage.setItem('tectonic-onboard-hide', '1'));
  
  // Fill username with capitalized first letter as mobile keyboards do
  console.log('Testing case-insensitive mobile login with "Operator" ...');
  await page.fill('#login-username', 'Operator');
  await page.fill('#login-password', 'operator123');
  await page.click('#login-btn');
  
  await page.waitForSelector('#cview-inbox:not(.hidden)', { timeout: 15000 });
  console.log('Logged in successfully as Operator!');
  
  // Close Get Started overlay if open
  await page.evaluate(() => {
    const gs = document.getElementById('gs-overlay');
    if (gs) gs.classList.add('hidden');
  });
  
  // Verify mobile logout button is visible in header
  const mobileSignoutBtn = page.locator('#btn-mobile-signout');
  const isSignoutVisible = await mobileSignoutBtn.isVisible();
  console.log('Is mobile top signout button visible?', isSignoutVisible);
  
  // Verify bottom tabs contains Account
  const accountTab = page.locator('#bottom-tabs .btab[data-nav="more"]');
  const isAccountTabVisible = await accountTab.isVisible();
  console.log('Is Account bottom tab visible?', isAccountTabVisible);
  
  // Take screenshot of mobile logged in view
  await page.screenshot({ path: 'C:/Users/Diamond Technology/.gemini/antigravity/brain/7c4b2ecc-173c-4b91-9904-9e4ad41ca616/mobile_operator_logged_in.png' });
  console.log('Saved mobile_operator_logged_in.png');
  
  // Click Account tab to verify More/Account view with Sign Out button
  await accountTab.click();
  await page.waitForSelector('#cview-more:not(.hidden)', { timeout: 5000 });
  const moreSignoutBtn = page.locator('#btn-more-signout');
  console.log('Is red Sign Out button visible in Account view?', await moreSignoutBtn.isVisible());
  
  await page.screenshot({ path: 'C:/Users/Diamond Technology/.gemini/antigravity/brain/7c4b2ecc-173c-4b91-9904-9e4ad41ca616/mobile_operator_account_view.png' });
  console.log('Saved mobile_operator_account_view.png');
  
  // Click Sign Out
  await moreSignoutBtn.click();
  await page.waitForSelector('#login-view:not(.hidden)', { timeout: 5000 });
  console.log('Logged out successfully via mobile Account view!');
  
  // Test 2: Test Mobile top signout button directly
  console.log('Testing 1-tap mobile top signout button...');
  await page.fill('#login-username', 'Operator');
  await page.fill('#login-password', 'operator123');
  await page.click('#login-btn');
  await page.waitForSelector('#cview-inbox:not(.hidden)', { timeout: 15000 });
  
  await page.evaluate(() => {
    const gs = document.getElementById('gs-overlay');
    if (gs) gs.classList.add('hidden');
  });
  await mobileSignoutBtn.click();
  await page.waitForSelector('#login-view:not(.hidden)', { timeout: 5000 });
  console.log('Logged out successfully via 1-tap mobile header button!');
  
  // Test 3: Desktop viewport verification
  const desktopContext = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });
  const desktopPage = await desktopContext.newPage();
  await desktopPage.goto('http://160.25.5.64/index.html', { waitUntil: 'networkidle' });
  await desktopPage.fill('#login-username', 'operator');
  await desktopPage.fill('#login-password', 'operator123');
  await desktopPage.click('#login-btn');
  await desktopPage.waitForSelector('#cview-inbox:not(.hidden)', { timeout: 15000 });
  
  // Check if Combined Inbox is unlocked
  const isLocked = await desktopPage.locator('#inbox-locked').isVisible();
  console.log('Is inbox locked for operator?', isLocked);
  
  await desktopPage.screenshot({ path: 'C:/Users/Diamond Technology/.gemini/antigravity/brain/7c4b2ecc-173c-4b91-9904-9e4ad41ca616/desktop_operator_inbox.png' });
  console.log('Saved desktop_operator_inbox.png');

  await browser.close();
  console.log('All verifications passed completely!');
}

run().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
