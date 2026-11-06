import { chromium } from 'playwright';

async function captureAll() {
  const browser = await chromium.launch({ headless: true });
  const artifactDir = 'C:/Users/Diamond Technology/.gemini/antigravity/brain/7c4b2ecc-173c-4b91-9904-9e4ad41ca616';
  
  // 1. DESKTOP VIEWPORT
  const dContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const dPage = await dContext.newPage();
  
  // Desktop Welcome / Home
  console.log('Capturing Desktop Welcome...');
  await dPage.goto('http://160.25.5.64/', { waitUntil: 'networkidle' });
  await dPage.screenshot({ path: `${artifactDir}/screen_audit_1_welcome_desktop_fixed.png`, fullPage: false });
  
  // Desktop Login - test user friendly error
  console.log('Testing invalid login friendly error...');
  await dPage.goto('http://160.25.5.64/index.html', { waitUntil: 'networkidle' });
  await dPage.fill('#login-username', 'operator');
  await dPage.fill('#login-password', 'wrongpassword999');
  await dPage.click('#login-btn');
  await dPage.waitForSelector('#login-err.show', { timeout: 5000 });
  const errText = await dPage.textContent('#login-err');
  console.log('Friendly Login Error:', errText);
  await dPage.screenshot({ path: `${artifactDir}/screen_audit_2_login_error_friendly.png` });
  
  // Desktop Profile / Security Modal with operator
  console.log('Testing operator login and profile modal...');
  await dPage.evaluate(() => localStorage.setItem('tectonic-onboard-hide', '1'));
  await dPage.fill('#login-username', 'operator');
  await dPage.fill('#login-password', 'operator123');
  await dPage.click('#login-btn');
  await dPage.waitForSelector('#cview-inbox:not(.hidden)', { timeout: 15000 });
  
  await dPage.click('#sidebar-user-card');
  await dPage.waitForSelector('#profile-modal:not(.hidden)', { timeout: 5000 });
  const profileUsername = await dPage.inputValue('#prof-username');
  console.log('Profile username value in modal:', profileUsername);
  await dPage.screenshot({ path: `${artifactDir}/screen_audit_4_profile_fixed.png` });
  await dPage.click('#btn-close-profile');
  
  // Test xyz account login
  console.log('Testing xyz login with xyz123...');
  await dPage.click('#btn-signout');
  await dPage.waitForSelector('#login-view:not(.hidden)', { timeout: 5000 });
  await dPage.fill('#login-username', 'xyz');
  await dPage.fill('#login-password', 'xyz123');
  await dPage.click('#login-btn');
  await dPage.waitForSelector('#cview-inbox:not(.hidden)', { timeout: 15000 });
  console.log('xyz logged in successfully with active inbox!');
  await dPage.screenshot({ path: `${artifactDir}/screen_audit_xyz_logged_in.png` });

  // 2. MOBILE VIEWPORT (390x844 - iPhone)
  const mContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true
  });
  const mPage = await mContext.newPage();
  
  // Mobile Welcome / Home
  console.log('Capturing Mobile Welcome...');
  await mPage.goto('http://160.25.5.64/', { waitUntil: 'networkidle' });
  await mPage.screenshot({ path: `${artifactDir}/screen_audit_6_welcome_mobile_fixed.png`, fullPage: false });

  await browser.close();
  console.log('All verification captures completed successfully!');
}

captureAll().catch(err => {
  console.error('Audit capture error:', err);
  process.exit(1);
});
