import { chromium } from 'playwright';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
  await page.goto('http://160.25.5.64/index.html');
  await page.fill('#login-username', 'admin');
  await page.fill('#login-password', 'admin123');
  await page.click('#login-btn');
  await page.waitForSelector('#view-admin:not(.hidden)', { timeout: 10000 });
  console.log('Logged into Admin!');
  
  const btn = await page.$('button[data-at="watchdog"]');
  console.log('Is watchdog button found?', !!btn);
  if (btn) {
    await btn.click();
    await page.waitForTimeout(2000);
    const hudHtml = await page.$eval('#watchdog-hud', el => el.innerHTML);
    console.log('HUD HTML:', hudHtml);
  }
  await page.screenshot({ path: 'C:/Users/Diamond Technology/.gemini/antigravity/brain/7c4b2ecc-173c-4b91-9904-9e4ad41ca616/admin_watchdog_live.png' });
  console.log('Saved admin_watchdog_live.png');
  await browser.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
