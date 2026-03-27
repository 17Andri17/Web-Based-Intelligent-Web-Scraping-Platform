// const puppeteer = require('puppeteer');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

class BrowserManager {
  constructor() {
    this.browser = null;
    this.contexts = new Map(); // userId -> context
    this.pages = new Map();    // userId -> page
    this.pagePromises = new Map();
    this.exposedBindings = new Map();
  }

  async initBrowser() {
    if (this.browser) return;

    // 🔥 Prevent multiple launches
    if (this.browserLaunching) {
      await this.browserLaunching;
      return;
    }

    this.browserLaunching = (async () => {
      this.browser = await puppeteer.launch({
        headless: true,
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

          // 🚀 Anti-detection flags
          '--disable-blink-features=AutomationControlled',          // hides "navigator.webdriver"
          '--disable-features=IsolateOrigins,site-per-process',     // mimics a normal user session
          '--disable-web-security',                                 // sometimes helps with cross-origin issues
          '--disable-features=BlockInsecurePrivateNetworkRequests',
          '--disable-features=OutOfBlinkCors',
          '--disable-features=AudioServiceOutOfProcess',
          '--disable-features=UseOzonePlatform',
          '--disable-features=WebRtcHideLocalIpsWithMdns',
          '--disable-features=WebUSB',
          '--disable-features=WebXR',
          '--disable-features=TranslateUI',
          '--disable-features=OptimizationGuideModelDownloading',
          '--disable-features=OptimizationHints',
          '--disable-features=MediaRouter',
          '--disable-features=NetworkServiceInProcess',
          '--disable-features=BackgroundFetch',
          '--disable-features=BackgroundSync',
          '--disable-features=PaymentRequest',
          '--disable-features=SubresourceFilter',
          '--disable-features=PrefetchPrivacyChanges',
          '--disable-features=SSLVersionFallback',
          '--disable-features=AllowPopupsDuringPageUnload',
          '--disable-features=AppBannerTriggering',
          '--disable-features=AutofillServerCommunication',
          '--disable-features=PasswordImport',
          '--disable-features=SupervisedUser',
          '--disable-features=Sync',
          '--disable-features=WebPayments',
          '--disable-features=WebBluetooth',
          '--disable-features=WebNfc',
          '--disable-features=WebHid',
          '--disable-features=WebUsb',
          '--disable-features=Serial',
          '--disable-features=WebXr',
          '--disable-features=WebAuthn',
          '--disable-features=WebAuthentication',
          '--disable-features=WebAuthenticationProxy',
          '--disable-features=WebAuthenticationTouchId',
          '--disable-features=WebAuthenticationAndroid',
          '--disable-features=WebAuthenticationMac',
          '--disable-features=WebAuthenticationWindows',
          '--disable-features=WebAuthenticationLinux',
          '--disable-features=WebAuthenticationChromeOS',
          '--disable-features=WebAuthenticationFido2',
          '--disable-features=WebAuthenticationU2f',
          '--disable-features=WebAuthenticationCable',
          '--disable-features=WebAuthenticationCableV2',
          '--disable-features=WebAuthenticationPhone',
          '--disable-features=WebAuthenticationSecurityKey',
          '--disable-features=WebAuthenticationTouchId',
          '--disable-features=WebAuthenticationAndroidCable',
          '--disable-features=WebAuthenticationAndroidUsb',
          '--disable-features=WebAuthenticationAndroidNfc',
          '--disable-features=WebAuthenticationAndroidBluetooth',
          '--disable-features=WebAuthenticationAndroidU2f',
          '--disable-features=WebAuthenticationAndroidFido2',
          '--disable-features=WebAuthenticationAndroidCableV2',
          '--disable-features=WebAuthenticationAndroidPhone',
          '--disable-features=WebAuthenticationAndroidSecurityKey',
          '--disable-features=WebAuthenticationAndroidTouchId',
          '--disable-features=WebAuthenticationAndroidMac',
          '--disable-features=WebAuthenticationAndroidWindows',
          '--disable-features=WebAuthenticationAndroidLinux',
          '--disable-features=WebAuthenticationAndroidChromeOS',
          '--disable-features=WebAuthenticationAndroidWebView',
          '--disable-features=WebAuthenticationAndroidWebViewCable',
          '--disable-features=WebAuthenticationAndroidWebViewPhone',
          '--disable-features=WebAuthenticationAndroidWebViewSecurityKey',
          '--disable-features=WebAuthenticationAndroidWebViewTouchId',
          '--disable-features=WebAuthenticationAndroidWebViewMac',
          '--disable-features=WebAuthenticationAndroidWebViewWindows',
          '--disable-features=WebAuthenticationAndroidWebViewLinux',
          '--disable-features=WebAuthenticationAndroidWebViewChromeOS',
          '--disable-features=WebAuthenticationAndroidWebViewWebView',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewCable',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewPhone',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewSecurityKey',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewTouchId',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewMac',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWindows',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewLinux',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewChromeOS',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebView',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewCable',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewPhone',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewSecurityKey',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewTouchId',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewMac',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWindows',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewLinux',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewChromeOS',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebView',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewCable',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewPhone',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewSecurityKey',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewTouchId',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewMac',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewWindows',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewLinux',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewChromeOS',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewWebView',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewWebViewCable',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewWebViewPhone',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewWebViewSecurityKey',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewWebViewTouchId',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewWebViewMac',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewWebViewWindows',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewWebViewLinux',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewWebViewChromeOS',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewWebViewWebView',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewWebViewWebViewCable',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewWebViewWebViewPhone',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewWebViewWebViewSecurityKey',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewWebViewWebViewTouchId',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewWebViewWebViewMac',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewWebViewWebViewWindows',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewWebViewWebViewLinux',
          '--disable-features=WebAuthenticationAndroidWebViewWebViewWebViewWebViewWebViewWebViewChromeOS'
        ],
        ignoreDefaultArgs: ['--hide-scrollbars', '--enable-automation']
      });

      console.log('✅ Browser launched');
    })();

    await this.browserLaunching;
    this.browserLaunching = null;
  }

  async getContext(userId) {
    await this.initBrowser();
    if (!this.contexts.has(userId)) {
      let context;
      if (typeof this.browser.createIncognitoBrowserContext === 'function') {
        context = await this.browser.createIncognitoBrowserContext();
      } else {
        context = this.browser.defaultBrowserContext();
        console.warn('Incognito context not supported, using default context.');
      }
      this.contexts.set(userId, context);
    }
    return this.contexts.get(userId);
  }
  
  async getPage(userId) {
  if (this.pages.has(userId)) {
    return this.pages.get(userId);
  }

  if (this.pagePromises.has(userId)) {
    return this.pagePromises.get(userId);
  }

  const promise = (async () => {
    const context = await this.getContext(userId);
    const page = await context.newPage();

    this.pages.set(userId, page);
    this.pagePromises.delete(userId);

    page.on('close', () => this.pages.delete(userId));

    return page;
  })();

  this.pagePromises.set(userId, promise);

  return promise;
}

async ensureBinding(userId, name, fn) {
    const page = await this.getPage(userId);
    const bindings = this.exposedBindings.get(userId) || new Set();

    if (!bindings.has(name)) {
      await page.exposeFunction(name, fn);
      bindings.add(name);
      this.exposedBindings.set(userId, bindings);
    }
  }

  async closeContext(userId) {
    // Close and remove persistent page
    if (this.pages.has(userId)) {
      try {
        await this.pages.get(userId).close();
      } catch (err) {
        console.warn(`Error closing page for user ${userId}:`, err);
      }
      this.exposedBindings.delete(userId);
      this.pages.delete(userId);
    }

    // Close and remove context
    const context = this.contexts.get(userId);
    if (context) {
      try {
        await context.close();
      } catch (err) {
        console.warn(`Error closing context for user ${userId}:`, err);
      }
      this.contexts.delete(userId);
    }
  }

  async closeBrowser() {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (err) {
        console.warn('Error closing browser:', err);
      }
      this.browser = null;
      this.contexts.clear();
      this.pages.clear();
      this.exposedBindings.clear()
    }
  }
}

module.exports = new BrowserManager();
