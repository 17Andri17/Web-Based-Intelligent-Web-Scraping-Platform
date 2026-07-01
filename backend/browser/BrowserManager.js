const { executablePath } = require('puppeteer');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// ==================== ANTI-DETECTION CONFIG ====================
const STEALTH_CONFIG = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'Win32',
    vendor: 'Google Inc.',
    languages: ['en-US', 'en'],
    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 0,
    webglVendor: 'Google Inc. (NVIDIA)',
    webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    screenResolution: { width: 1920, height: 1080 },
    colorDepth: 24
};

// ==================== NAVIGATOR OVERRIDE SCRIPT ====================
// This script will be injected into ALL contexts (main, workers, iframes)
const getNavigatorOverrideScript = (config) => `
(function() {
  'use strict';
  
  const config = ${JSON.stringify(config)};
  
  // Helper to safely override property
  const overrideProperty = (obj, prop, value) => {
    try {
      Object.defineProperty(obj, prop, {
        get: () => value,
        configurable: true,
        enumerable: true
      });
    } catch (e) {}
  };
  
  // Helper to override getter
  const overrideGetter = (obj, prop, getter) => {
    try {
      Object.defineProperty(obj, prop, {
        get: getter,
        configurable: true,
        enumerable: true
      });
    } catch (e) {}
  };
  
  // Detect context type
  const isWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
  const isServiceWorker = typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope;
  const isSharedWorker = typeof SharedWorkerGlobalScope !== 'undefined' && self instanceof SharedWorkerGlobalScope;
  const isDedicatedWorker = typeof DedicatedWorkerGlobalScope !== 'undefined' && self instanceof DedicatedWorkerGlobalScope;
  
  // Get the navigator object for current context
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  
  if (nav) {
    // Core navigator properties - MUST be consistent across all contexts
    overrideProperty(nav, 'userAgent', config.userAgent);
    overrideProperty(nav, 'platform', config.platform);
    overrideProperty(nav, 'vendor', config.vendor);
    overrideProperty(nav, 'language', config.languages[0]);
    overrideProperty(nav, 'languages', Object.freeze([...config.languages]));
    overrideProperty(nav, 'hardwareConcurrency', config.hardwareConcurrency);
    overrideProperty(nav, 'deviceMemory', config.deviceMemory);
    overrideProperty(nav, 'maxTouchPoints', config.maxTouchPoints);
    
    // webdriver detection
    overrideProperty(nav, 'webdriver', false);
    
    // Connection info
    if (nav.connection) {
      overrideProperty(nav.connection, 'rtt', 50);
      overrideProperty(nav.connection, 'downlink', 10);
      overrideProperty(nav.connection, 'effectiveType', '4g');
      overrideProperty(nav.connection, 'saveData', false);
    }
    
    // UserAgentData (Client Hints)
    if ('userAgentData' in nav || !isWorker) {
      const userAgentData = {
        brands: [
          { brand: 'Chromium', version: '131' },
          { brand: 'Google Chrome', version: '131' },
          { brand: 'Not_A Brand', version: '24' }
        ],
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: async function(hints) {
          const values = {
            architecture: 'x86',
            bitness: '64',
            brands: this.brands,
            fullVersionList: [
              { brand: 'Chromium', version: '131.0.6778.85' },
              { brand: 'Google Chrome', version: '131.0.6778.85' },
              { brand: 'Not_A Brand', version: '24.0.0.0' }
            ],
            mobile: false,
            model: '',
            platform: 'Windows',
            platformVersion: '15.0.0',
            uaFullVersion: '131.0.6778.85',
            wow64: false
          };
          const result = {};
          for (const hint of hints) {
            if (hint in values) result[hint] = values[hint];
          }
          return result;
        },
        toJSON: function() {
          return { brands: this.brands, mobile: this.mobile, platform: this.platform };
        }
      };
      overrideProperty(nav, 'userAgentData', userAgentData);
    }
    
    // Plugins (empty in workers, but consistent)
    if (!isWorker) {
      const pluginArray = {
        length: 5,
        item: (i) => pluginArray[i],
        namedItem: (name) => {
          for (let i = 0; i < pluginArray.length; i++) {
            if (pluginArray[i]?.name === name) return pluginArray[i];
          }
          return null;
        },
        refresh: () => {},
        0: { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 2 },
        1: { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 2 },
        2: { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 2 },
        3: { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 2 },
        4: { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 2 },
        [Symbol.iterator]: function* () { for (let i = 0; i < this.length; i++) yield this[i]; }
      };
      overrideProperty(nav, 'plugins', pluginArray);
      
      // MimeTypes
      const mimeTypeArray = {
        length: 2,
        item: (i) => mimeTypeArray[i],
        namedItem: (name) => {
          for (let i = 0; i < mimeTypeArray.length; i++) {
            if (mimeTypeArray[i]?.type === name) return mimeTypeArray[i];
          }
          return null;
        },
        0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: pluginArray[0] },
        1: { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: pluginArray[0] },
        [Symbol.iterator]: function* () { for (let i = 0; i < this.length; i++) yield this[i]; }
      };
      overrideProperty(nav, 'mimeTypes', mimeTypeArray);
      overrideProperty(nav, 'pdfViewerEnabled', true);
    }
  }
  
  // Screen properties (main context only)
  if (!isWorker && typeof screen !== 'undefined') {
    overrideProperty(screen, 'width', config.screenResolution.width);
    overrideProperty(screen, 'height', config.screenResolution.height);
    overrideProperty(screen, 'availWidth', config.screenResolution.width);
    overrideProperty(screen, 'availHeight', config.screenResolution.height - 40);
    overrideProperty(screen, 'colorDepth', config.colorDepth);
    overrideProperty(screen, 'pixelDepth', config.colorDepth);
  }
  
  // WebGL overrides (main context AND workers — OffscreenCanvas lets workers
  // open their own WebGL context, and a real GPU renderer leaking there while
  // the main thread reports a spoofed one is itself a cross-context mismatch)
  if (typeof WebGLRenderingContext !== 'undefined') {
    const getParameterProxy = function(target) {
      return new Proxy(target, {
        apply: function(target, thisArg, args) {
          const param = args[0];
          // UNMASKED_VENDOR_WEBGL
          if (param === 37445) return config.webglVendor;
          // UNMASKED_RENDERER_WEBGL
          if (param === 37446) return config.webglRenderer;
          return Reflect.apply(target, thisArg, args);
        }
      });
    };
    
    const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = getParameterProxy(originalGetParameter);
    
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const originalGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = getParameterProxy(originalGetParameter2);
    }
  }
  
  // Chrome object (main context only)
  if (!isWorker && typeof window !== 'undefined') {
    if (!window.chrome) window.chrome = {};
    window.chrome.runtime = {};
    window.chrome.loadTimes = function() {
      return {
        commitLoadTime: Date.now() / 1000 - Math.random() * 2,
        connectionInfo: 'h2',
        finishDocumentLoadTime: Date.now() / 1000 - Math.random(),
        finishLoadTime: Date.now() / 1000 - Math.random() * 0.5,
        firstPaintAfterLoadTime: 0,
        firstPaintTime: Date.now() / 1000 - Math.random() * 2,
        navigationType: 'Other',
        npnNegotiatedProtocol: 'h2',
        requestTime: Date.now() / 1000 - Math.random() * 3,
        startLoadTime: Date.now() / 1000 - Math.random() * 2.5,
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true
      };
    };
    window.chrome.csi = function() {
      return {
        onloadT: Date.now(),
        pageT: Math.random() * 1000 + 500,
        startE: Date.now() - Math.random() * 3000,
        tran: 15
      };
    };
    
    // Remove automation-specific properties
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
    delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
    delete window.__webdriver_evaluate;
    delete window.__selenium_evaluate;
    delete window.__webdriver_script_function;
    delete window.__webdriver_script_func;
    delete window.__webdriver_script_fn;
    delete window.__fxdriver_evaluate;
    delete window.__driver_unwrapped;
    delete window.__webdriver_unwrapped;
    delete window.__driver_evaluate;
    delete window.__selenium_unwrapped;
    delete window.__fxdriver_unwrapped;
    delete window._Selenium_IDE_Recorder;
    delete window._selenium;
    delete window.calledSelenium;
    delete window.$cdc_asdjflasutopfhvcZLmcfl_;
    delete window.$chrome_asyncScriptInfo;
    delete window.__$webdriverAsyncExecutor;
    
    // Permissions API
    if (navigator.permissions) {
      const originalQuery = navigator.permissions.query;
      navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
    }
  }
  
  // Mark as initialized to prevent double injection
  if (typeof self !== 'undefined') {
    self.__stealthInitialized = true;
  }
})();
`;

class BrowserManager {
    constructor() {
        this.browser = null;
        this.contexts = new Map();
        this.pages = new Map();
        this.pagePromises = new Map();
        this.exposedBindings = new Map();
        this.workerListeners = new Map();
    }

    async initBrowser() {
        if (this.browser) return;

        if (this.browserLaunching) {
            await this.browserLaunching;
            return;
        }

        this.browserLaunching = (async() => {
            this.browser = await puppeteer.launch({
                executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
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
                    '--font-render-hinting=medium',

                    // Anti-detection flags
                    '--disable-blink-features=AutomationControlled',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--disable-web-security',
                    '--disable-features=BlockInsecurePrivateNetworkRequests',
                    '--disable-features=WebRtcHideLocalIpsWithMdns',

                    // Consistent User-Agent
                    `--user-agent=${STEALTH_CONFIG.userAgent}`,

                    // Window size for consistency
                    '--window-size=1920,1080',

                    // Disable automation extensions
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

                    // Memory/performance
                    '--disable-background-networking',
                    '--disable-client-side-phishing-detection',
                    '--disable-component-update'
                ],
                ignoreDefaultArgs: ['--enable-automation', '--hide-scrollbars']
            });

            // Set up worker interception at browser level
            await this._setupWorkerInterception();

            console.log('✅ Browser launched with enhanced anti-detection');
        })();

        await this.browserLaunching;
        this.browserLaunching = null;
    }

    // ==================== WORKER INTERCEPTION (fallback) ====================
    // Dedicated/shared workers created by `new Worker(...)` are primarily
    // covered by the Blob-URL source rewrite installed in
    // _applyStealthToPage — that's synchronous and race-free. This CDP path
    // is a fallback for what source rewriting can't reach: service workers
    // (registered via navigator.serviceWorker.register, never go through a
    // Worker constructor) and cross-origin worker scripts the page's XHR
    // can't read. It's still inherently reactive/racy for those cases —
    // there's no reliable way in Puppeteer to pause a target before its
    // first line of JS without risking it fighting Puppeteer's own
    // auto-attach — so treat it as best-effort, not a guarantee.
    async _setupWorkerInterception() {
        if (!this.browser) return;

        this.browser.on('targetcreated', async(target) => {
            const type = target.type();

            // Handle all worker types
            if (type === 'worker' || type === 'service_worker' || type === 'shared_worker') {
                await this._injectIntoWorker(target);
            }
        });
    }

    async _injectIntoWorker(target) {
        try {
            const client = await target.createCDPSession();

            // Inject the navigator override script. Runtime.evaluate works
            // without a prior Runtime.enable, so skip that extra round trip
            // to shave whatever latency we can off this race.
            await client.send('Runtime.evaluate', {
                expression: getNavigatorOverrideScript(STEALTH_CONFIG),
                awaitPromise: true
            });

            console.log(`✅ Injected stealth into ${target.type()}`);
        } catch (err) {
            // Worker might have already closed or not support CDP
            if (!err.message.includes('Target closed') && !err.message.includes('Session closed')) {
                console.warn(`⚠️ Could not inject into worker: ${err.message}`);
            }
        }
    }

    async getContext(userId) {
        await this.initBrowser();
        if (!this.contexts.has(userId)) {
            let context;
            if (typeof this.browser.createBrowserContext === 'function') {
                context = await this.browser.createBrowserContext();
            } else if (typeof this.browser.createIncognitoBrowserContext === 'function') {
                context = await this.browser.createIncognitoBrowserContext();
            } else {
                context = this.browser.defaultBrowserContext();
                console.warn('Incognito context not supported, using default context.');
            }
            this.contexts.set(userId, context);
        }
        return this.contexts.get(userId);
    }

    hasPage(userId) {
        return this.pages.has(userId);
    }

    async getPage(userId) {
        if (this.pages.has(userId)) {
            return this.pages.get(userId);
        }

        if (this.pagePromises.has(userId)) {
            return this.pagePromises.get(userId);
        }

        const promise = (async() => {
            const context = await this.getContext(userId);
            const page = await context.newPage();

            // Apply comprehensive stealth before any navigation
            await this._applyStealthToPage(page);

            this.pages.set(userId, page);
            this.pagePromises.delete(userId);

            page.on('close', () => this.pages.delete(userId));

            // Handle new frames (iframes)
            page.on('frameattached', async(frame) => {
                try {
                    await frame.evaluate(getNavigatorOverrideScript(STEALTH_CONFIG));
                } catch (e) {}
            });

            return page;
        })();

        this.pagePromises.set(userId, promise);

        return promise;
    }

    // ==================== STEALTH APPLICATION ====================
    async _applyStealthToPage(page) {
        // Set user agent via CDP for consistency
        const client = await page.target().createCDPSession();

        // Set User-Agent Override (affects main context AND workers)
        await client.send('Emulation.setUserAgentOverride', {
            userAgent: STEALTH_CONFIG.userAgent,
            platform: STEALTH_CONFIG.platform,
            userAgentMetadata: {
                brands: [
                    { brand: 'Chromium', version: '131' },
                    { brand: 'Google Chrome', version: '131' },
                    { brand: 'Not_A Brand', version: '24' }
                ],
                fullVersionList: [
                    { brand: 'Chromium', version: '131.0.6778.85' },
                    { brand: 'Google Chrome', version: '131.0.6778.85' },
                    { brand: 'Not_A Brand', version: '24.0.0.0' }
                ],
                platform: 'Windows',
                platformVersion: '15.0.0',
                architecture: 'x86',
                model: '',
                mobile: false,
                bitness: '64',
                wow64: false
            }
        });

        // Inject stealth script on every new document. Note: CDP's
        // addScriptToEvaluateOnNewDocument only reaches the page's own
        // frames/iframes — it does NOT run inside Worker/SharedWorker
        // execution contexts, those are separate CDP targets. Workers are
        // handled below via source rewriting (primary) and CDP injection
        // (fallback, see _injectIntoWorker).
        await page.evaluateOnNewDocument(getNavigatorOverrideScript(STEALTH_CONFIG));

        // Additional CDP configurations for stealth
        try {
            // Set locale
            await client.send('Emulation.setLocaleOverride', {
                locale: 'en-US'
            });
        } catch (e) {}

        try {
            // Set timezone
            await client.send('Emulation.setTimezoneOverride', {
                timezoneId: 'America/New_York'
            });
        } catch (e) {}

        // Override navigator.webdriver at the earliest opportunity
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
                configurable: true
            });
        });

        // Intercept Worker/SharedWorker construction and rewrite the target
        // script so our override script becomes the literal first statement
        // of the worker's own source. This is the fix for
        // "hasInconsistentWorkerValues": the previous approach relied on a
        // CDP Runtime.evaluate injected reactively after the worker target
        // was created (see _injectIntoWorker below), racing against the
        // worker's own top-level code — a fingerprint script that reads
        // navigator.userAgent/hardwareConcurrency/platform and posts it back
        // immediately always won that race, so the real (unspoofed) values
        // leaked out of the worker while the main thread showed spoofed
        // ones. Rewriting the source removes the race entirely: there is no
        // way for the worker's real code to run before our override, because
        // it IS the first code in the file. CDP injection is kept as a
        // fallback for cases source rewriting can't cover (cross-origin
        // scripts blocked by CORS, and service workers, which aren't created
        // via `new Worker()` at all).
        await page.evaluateOnNewDocument((overrideSource) => {
            function buildPatchedURL(originalURL) {
                try {
                    const abs = new URL(originalURL, location.href).href;
                    const xhr = new XMLHttpRequest();
                    // Synchronous on purpose: the patched source must be
                    // ready before we hand a URL back to the real
                    // Worker/SharedWorker constructor.
                    xhr.open('GET', abs, false);
                    xhr.send(null);
                    if (xhr.status !== 200 && xhr.status !== 0) return null;

                    // Once the worker runs from a blob: URL its own
                    // self.location is that blob: URL, not `abs` — and
                    // Chrome's URL resolver rejects root-relative paths
                    // (e.g. importScripts('/chunk.js')) resolved against a
                    // blob: base ("The URL '...' is invalid"). Real worker
                    // scripts commonly use root-relative importScripts/fetch/
                    // XHR calls, so without this fixup rewriting would break
                    // the target site's own worker instead of just patching
                    // its fingerprint surface. Rebase those calls onto the
                    // worker's true absolute URL before the site's code runs.
                    const baseFix = `
            (function() {
              var __trueBase = ${JSON.stringify(abs)};
              function __resolve(u) { try { return new URL(u, __trueBase).href; } catch (e) { return u; } }
              if (typeof importScripts === 'function') {
                var __origImportScripts = importScripts;
                self.importScripts = function() {
                  var args = [];
                  for (var i = 0; i < arguments.length; i++) args.push(__resolve(arguments[i]));
                  return __origImportScripts.apply(self, args);
                };
              }
              if (typeof fetch === 'function') {
                var __origFetch = fetch;
                self.fetch = function(input, init) {
                  return __origFetch.call(self, typeof input === 'string' ? __resolve(input) : input, init);
                };
              }
              if (typeof XMLHttpRequest !== 'undefined') {
                var __origOpen = XMLHttpRequest.prototype.open;
                XMLHttpRequest.prototype.open = function(method, url) {
                  var rest = Array.prototype.slice.call(arguments, 2);
                  return __origOpen.apply(this, [method, __resolve(url)].concat(rest));
                };
              }
            })();
          `;

                    const blob = new Blob([baseFix, '\n', overrideSource, '\n', xhr.responseText], { type: 'text/javascript' });
                    return URL.createObjectURL(blob);
                } catch (e) {
                    // Cross-origin script (CORS blocks the sync read), or a
                    // Trusted Types / CSP restriction — fall back silently,
                    // the CDP path will try to cover this worker instead.
                    return null;
                }
            }

            function patchWorkerClass(OriginalClass) {
                if (!OriginalClass) return OriginalClass;
                const Patched = new Proxy(OriginalClass, {
                    construct(target, args) {
                        const [scriptURL, options] = args;
                        const isURLLike = typeof scriptURL === 'string' || (typeof URL !== 'undefined' && scriptURL instanceof URL);
                        if (isURLLike) {
                            const patchedURL = buildPatchedURL(String(scriptURL));
                            if (patchedURL) {
                                try {
                                    return Reflect.construct(target, [patchedURL, options]);
                                } catch (e) {
                                    // e.g. CSP's worker-src doesn't allow blob: —
                                    // fall through to the untouched original so we
                                    // don't break the page's own functionality.
                                }
                            }
                        }
                        return Reflect.construct(target, args);
                    }
                });
                try { Object.defineProperty(Patched, 'name', { value: OriginalClass.name }); } catch (e) {}
                return Patched;
            }

            window.Worker = patchWorkerClass(window.Worker);
            if (window.SharedWorker) window.SharedWorker = patchWorkerClass(window.SharedWorker);
        }, getNavigatorOverrideScript(STEALTH_CONFIG));

        // Set viewport
        await page.setViewport({
            width: 1920,
            height: 1080,
            deviceScaleFactor: 1,
            hasTouch: false,
            isMobile: false
        });

        console.log('✅ Stealth applied to page');
    }

    async ensureBinding(userId, name, fn) {
        const page = await this.getPage(userId);
        let perUser = this.exposedBindings.get(userId);
        if (!perUser || perUser instanceof Set) {
            // Legacy Set → upgrade to Map. The legacy Set only tracked names
            // so we can't recover the old fn — but we're about to overwrite
            // anyway with the fresh one from the caller.
            perUser = new Map();
            this.exposedBindings.set(userId, perUser);
        }

        const existing = perUser.get(name);
        if (existing) {
            // Binding already registered with puppeteer. Swap in the fresh
            // callback so events route to the *current* socket instead of
            // the stale closure from a previous SPA session. (page.exposeFunction
            // throws on duplicates and there's no clean way to remove a
            // function binding, so we route everything through a holder.)
            existing.fn = fn;
            return;
        }

        const holder = { fn };
        await page.exposeFunction(name, (...args) => {
            try { return holder.fn(...args); } catch (_) {}
        });
        perUser.set(name, holder);
    }

    async closeContext(userId) {
        if (this.pages.has(userId)) {
            try {
                await this.pages.get(userId).close();
            } catch (err) {
                console.warn(`Error closing page for user ${userId}:`, err);
            }
            this.exposedBindings.delete(userId);
            this.pages.delete(userId);
        }

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
            this.exposedBindings.clear();
        }
    }
}

module.exports = new BrowserManager();