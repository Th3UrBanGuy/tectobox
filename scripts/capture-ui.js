const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto('http://localhost:3000/app');
  await page.fill('#login-username', 'admin');
  await page.fill('#login-password', 'admin123');
  await page.click('#login-btn');
  await page.waitForSelector('#app-view:not(.hidden)', { timeout: 8000 });

  const artifactDir = 'C:/Users/Diamond Technology/.gemini/antigravity/brain/7c4b2ecc-173c-4b91-9904-9e4ad41ca616';

  // 1. Capture platform panel with restored topbar
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(artifactDir, 'topbar_platform_panel.png') });
  console.log('Saved topbar_platform_panel.png');

  // 2. Switch to Inbox
  await page.click('#nav-links button[data-nav="inbox"]');
  await page.waitForSelector('#cview-inbox:not(.hidden)', { timeout: 8000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(artifactDir, 'topbar_inbox_view.png') });
  console.log('Saved topbar_inbox_view.png');

  // 3. Click first conversation if available
  const conv = page.locator('#conv-list .conv-item').first();
  if (await conv.isVisible()) {
    await conv.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(artifactDir, 'topbar_active_chat.png') });
    console.log('Saved topbar_active_chat.png');
  }

  // 4. Switch to More (Workspace Hub)
  await page.click('#nav-links button[data-nav="more"]');
  await page.waitForSelector('#cview-more:not(.hidden)', { timeout: 8000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(artifactDir, 'topbar_more_hub.png') });
  console.log('Saved topbar_more_hub.png');

  await browser.close();
  console.log('Done capturing topbar UI!');
})();
