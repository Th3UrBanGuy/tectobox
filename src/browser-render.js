// Headless-browser fallback for the website importer.
// When ALL hydration-data extractors fail (pure client SPAs, Rust/WASM sites,
// canvas-rendered pages), render the page in real headless Chromium and extract
// the rendered text. This is the universal fallback — works with ANY technology.
//
// Uses playwright-core + chromium headless shell (in .browser/node_modules).
// Lazy-loaded so the importer works fine without it installed.

let _playwright = null;
let _browser = null;

function getPlaywright() {
  if (_playwright) return _playwright;
  try {
    _playwright = require('../browser-deps/node_modules/playwright-core');
    return _playwright;
  } catch { return null; }
}

async function getBrowser() {
  if (_browser) return _browser;
  const pw = getPlaywright();
  if (!pw) return null;
  try {
    _browser = await pw.chromium.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-gpu', '--disable-dev-shm-usage',
        '--disable-quic', // this VM blocks UDP
      ],
    });
    return _browser;
  } catch { return null; }
}

// Render a URL in headless Chromium, return { title, text } or null.
async function renderPage(url, timeoutMs = 25000) {
  const browser = await getBrowser();
  if (!browser) return null;
  let page = null;
  try {
    // This VM reaches the internet via an egress proxy. Prefer the local
    // no-auth relay (127.0.0.1:3129) if up — else use the env proxy with auth.
    // (Headless Chromium struggles with the authed proxy directly.)
    const ctxOpts = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      ignoreHTTPSErrors: true, // egress proxy does selective TLS interception
    };
    const net = require('net');
    const cp = require('child_process');
    // Ensure our no-auth relay (src/relay-for-browser.js) is up for Chromium.
    const relayUp = await new Promise((res) => {
      const s = net.connect(18080, '127.0.0.1');
      s.once('connect', () => { s.destroy(); res(true); });
      s.once('error', () => res(false));
      setTimeout(() => res(false), 1500);
    });
    if (!relayUp) {
      try { cp.spawn('node', [require('path').join(__dirname, 'relay-for-browser.js')], { detached: true, stdio: 'ignore' }).unref(); } catch {}
      await new Promise(r => setTimeout(r, 1200));
    }
    ctxOpts.proxy = { server: 'http://127.0.0.1:18080' };
    const context = await browser.newContext(ctxOpts);
    page = await context.newPage();
    // domcontentloaded is reliable through the relay; networkidle can hang.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // Wait for real content: either network calms down or body gets substance.
    // (SPAs often show a splash/loader first; content arrives via client APIs.)
    try {
      await page.waitForFunction(
        () => {
          const t = (document.body ? document.body.innerText : '').replace(/\s/g, '');
          return t.length > 400;
        },
        { timeout: 15000 }
      );
    } catch {}
    try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch {}
    await page.waitForTimeout(1200);
    const result = await page.evaluate(() => {
      // Remove noise before extracting.
      const noise = document.querySelectorAll('script, style, noscript, nav, footer, header, aside, form, iframe, svg');
      noise.forEach(n => n.remove());
      const main = document.querySelector('main, article, [role="main"]');
      const root = main || document.body;
      const text = (root ? root.innerText : '').split('\n')
        .map(l => l.trim())
        .filter(l => l.split(/\s+/).length >= 2 || l.length > 40)
        .join('\n');
      return { title: document.title || '', text: text.slice(0, 12000) };
    });
    await context.close();
    if (!result.text || result.text.replace(/\s/g, '').length < 200) return null;
    return result;
  } catch {
    return null;
  } finally {
    if (page) { try { await page.close(); } catch {} }
  }
}

async function closeBrowser() {
  if (_browser) { try { await _browser.close(); } catch {} _browser = null; }
}

module.exports = { renderPage, closeBrowser, getPlaywright };
