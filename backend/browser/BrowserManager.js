const puppeteer = require('puppeteer');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

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
        headless: 'new',
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
          '--font-render-hinting=medium'
        ],
        ignoreDefaultArgs: ['--hide-scrollbars']
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
