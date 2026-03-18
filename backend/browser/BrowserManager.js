const puppeteer = require('puppeteer');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

class BrowserManager {
  constructor() {
    this.browser = null;
    this.contexts = new Map(); // userId -> context
    this.pages = new Map();    // userId -> page
  }

  async initBrowser() {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: 'new', // set true for production
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
      console.log('Browser launched');
    }
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
    // If the page already exists for the user, return it
    if (this.pages.has(userId)) {
      return this.pages.get(userId);
    }
    // Otherwise, create a new page in the correct context
    const context = await this.getContext(userId);
    const page = await context.newPage();
    this.pages.set(userId, page);

    // Optional: attach error/close handlers for cleanup
    page.on('close', () => {
      this.pages.delete(userId);
    });
    page.on('error', (err) => {
      console.warn(`Page error for user ${userId}:`, err);
      this.pages.delete(userId);
    });

    return page;
  }

  async closeContext(userId) {
    // Close and remove persistent page
    if (this.pages.has(userId)) {
      try {
        await this.pages.get(userId).close();
      } catch (err) {
        console.warn(`Error closing page for user ${userId}:`, err);
      }
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
    }
  }
}

module.exports = new BrowserManager();
