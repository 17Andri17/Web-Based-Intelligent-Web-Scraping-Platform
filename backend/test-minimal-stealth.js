// Same as test-minimal-cdp.js, but with ONLY puppeteer-extra-plugin-stealth
// added on top — still none of BrowserManager's custom navigator/canvas/
// audio/WebGL/toString/worker injections. If this crashes where
// test-minimal-cdp.js didn't, the stealth plugin itself is confirmed as the
// cause, isolated from our own code and from CDP/flags alone.
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: false,
    defaultViewport: null,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu-sandbox',
      '--enable-gpu-rasterization',
      '--enable-accelerated-2d-canvas',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--force-color-profile=srgb',
      '--enable-font-antialiasing',
      '--font-render-hinting=medium',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-web-security',
      '--disable-features=BlockInsecurePrivateNetworkRequests',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-default-apps',
      '--disable-hang-monitor',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-sync',
      '--disable-translate',
      '--metrics-recording-only',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',
      '--disable-background-networking',
      '--disable-client-side-phishing-detection',
      '--disable-component-update'
    ],
    ignoreDefaultArgs: ['--enable-automation', '--hide-scrollbars']
  });

  const page = await browser.newPage();
  console.log('Navigating with puppeteer-extra + StealthPlugin (no custom BrowserManager injections)...');
  try {
    await page.goto('https://deviceandbrowserinfo.com/are_you_a_bot', { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('✅ Navigation completed without crashing.');
  } catch (err) {
    console.log('❌ Navigation error:', err.message);
  }

  console.log('Leaving the browser open for 60s so you can see whether it crashed — check the tab.');
  await new Promise((r) => setTimeout(r, 60000));
  await browser.close().catch(() => {});
})();
