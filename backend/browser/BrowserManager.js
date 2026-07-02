const { executablePath } = require('puppeteer');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// ==================== ANTI-DETECTION CONFIG ====================
// A pool of internally-consistent device profiles (UA, GPU, screen, core
// count all belong to a plausible real machine) instead of one fixed
// fingerprint. Every session in the platform previously presented the exact
// same UA/GPU/screen/hardwareConcurrency combination, which is itself a
// signal — bot-farm detectors cluster on identical fingerprints appearing
// across many sessions even when any single fingerprint looks "clean". A
// profile is picked once per user/session (see _getProfileForUser) and held
// for that session's lifetime so it stays internally consistent.
const DEVICE_PROFILES = [
    {
        id: 'win-nvidia',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.85 Safari/537.36',
        platform: 'Win32',
        vendor: 'Google Inc.',
        languages: ['en-US', 'en'],
        hardwareConcurrency: 8,
        deviceMemory: 8,
        maxTouchPoints: 0,
        webglVendor: 'Google Inc. (NVIDIA)',
        webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        screenResolution: { width: 1920, height: 1080 },
        colorDepth: 24,
        chromeMajor: '131',
        chromeFullVersion: '131.0.6778.85',
        uaPlatform: 'Windows',
        uaPlatformVersion: '15.0.0',
        architecture: 'x86',
        bitness: '64',
        wow64: false,
        mobile: false
    },
    {
        id: 'win-intel',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.85 Safari/537.36',
        platform: 'Win32',
        vendor: 'Google Inc.',
        languages: ['en-US', 'en'],
        hardwareConcurrency: 4,
        deviceMemory: 8,
        maxTouchPoints: 0,
        webglVendor: 'Google Inc. (Intel)',
        webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00003EA0) Direct3D11 vs_5_0 ps_5_0, D3D11)',
        screenResolution: { width: 1366, height: 768 },
        colorDepth: 24,
        chromeMajor: '131',
        chromeFullVersion: '131.0.6778.85',
        uaPlatform: 'Windows',
        uaPlatformVersion: '15.0.0',
        architecture: 'x86',
        bitness: '64',
        wow64: false,
        mobile: false
    },
    {
        id: 'win-amd',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.85 Safari/537.36',
        platform: 'Win32',
        vendor: 'Google Inc.',
        languages: ['en-US', 'en'],
        hardwareConcurrency: 12,
        deviceMemory: 16,
        maxTouchPoints: 0,
        webglVendor: 'Google Inc. (AMD)',
        webglRenderer: 'ANGLE (AMD, AMD Radeon RX 580 Series (0x00006FDF) Direct3D11 vs_5_0 ps_5_0, D3D11)',
        screenResolution: { width: 2560, height: 1440 },
        colorDepth: 24,
        chromeMajor: '131',
        chromeFullVersion: '131.0.6778.85',
        uaPlatform: 'Windows',
        uaPlatformVersion: '10.0.0',
        architecture: 'x86',
        bitness: '64',
        wow64: false,
        mobile: false
    },
    {
        id: 'mac-m2',
        // Real Chrome reports this exact legacy string on macOS regardless of
        // Intel vs Apple Silicon — matching it is what makes this profile
        // authentic rather than a giveaway.
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.85 Safari/537.36',
        platform: 'MacIntel',
        vendor: 'Google Inc.',
        languages: ['en-US', 'en'],
        hardwareConcurrency: 8,
        deviceMemory: 16,
        maxTouchPoints: 0,
        webglVendor: 'Google Inc. (Apple)',
        webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
        screenResolution: { width: 1512, height: 982 },
        colorDepth: 24,
        chromeMajor: '131',
        chromeFullVersion: '131.0.6778.85',
        uaPlatform: 'macOS',
        uaPlatformVersion: '14.5.0',
        architecture: 'arm',
        bitness: '64',
        wow64: false,
        mobile: false
    }
];

// ==================== NAVIGATOR OVERRIDE SCRIPT ====================
// This script is injected into every context: the page's main world, its
// iframes (both via CDP's addScriptToEvaluateOnNewDocument, which covers
// page/frame documents automatically), and — via source rewriting in
// _applyStealthToPage plus the CDP fallback in _injectIntoWorker — dedicated
// and shared workers.
const getNavigatorOverrideScript = (config) => `
(function() {
  'use strict';

  // Idempotency guard: this same script can legitimately run more than once
  // in one realm (evaluateOnNewDocument + a worker's rewritten source both
  // resolving to the same top frame in edge cases). Redefining everything a
  // second time is harmless on its own, but it would also stack a second
  // Function.prototype.toString proxy on top of the first — wasteful, not
  // incorrect, but easy to just avoid.
  if (typeof self !== 'undefined' && self.__stealthInitialized) return;

  const config = ${JSON.stringify(config)};

  // ---- Function.prototype.toString spoofing ----
  // Every getter/function we inject below must report itself as native code.
  // Calling .toString() on a tampered accessor is a standard "lie detector"
  // check (used by CreepJS and similar tools): a plain arrow function's
  // source is trivially distinguishable from "function get x() { [native
  // code] }". This proxies Function.prototype.toString itself so registered
  // functions return a native-looking string, and registers itself
  // recursively so introspecting the patch mechanism doesn't reveal it.
  var __nativeStrings = new WeakMap();
  var __origFnToString = Function.prototype.toString;
  var __fnToStringProxy = new Proxy(__origFnToString, {
    apply: function(target, thisArg, args) {
      if (__nativeStrings.has(thisArg)) return __nativeStrings.get(thisArg);
      return Reflect.apply(target, thisArg, args);
    }
  });
  try {
    Object.defineProperty(Function.prototype, 'toString', {
      value: __fnToStringProxy,
      writable: true,
      enumerable: false,
      configurable: true
    });
  } catch (e) {}
  function nativeize(fn, name) {
    try { __nativeStrings.set(fn, 'function ' + (name || fn.name || '') + '() { [native code] }'); } catch (e) {}
    return fn;
  }
  nativeize(Function.prototype.toString, 'toString');

  // Helper to safely override property
  const overrideProperty = (obj, prop, value) => {
    try {
      const getter = () => value;
      nativeize(getter, 'get ' + prop);
      Object.defineProperty(obj, prop, {
        get: getter,
        configurable: true,
        enumerable: true
      });
    } catch (e) {}
  };

  // Helper to override getter
  const overrideGetter = (obj, prop, getter) => {
    try {
      nativeize(getter, 'get ' + prop);
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

    // UserAgentData (Client Hints) — brands/platform/architecture all derived
    // from the same device profile as the UA string and the CDP-level
    // Emulation.setUserAgentOverride, so none of these can disagree with
    // each other the way a hardcoded-per-field version could.
    if ('userAgentData' in nav || !isWorker) {
      const brands = [
        { brand: 'Chromium', version: config.chromeMajor },
        { brand: 'Google Chrome', version: config.chromeMajor },
        { brand: 'Not_A Brand', version: '24' }
      ];
      const fullVersionList = [
        { brand: 'Chromium', version: config.chromeFullVersion },
        { brand: 'Google Chrome', version: config.chromeFullVersion },
        { brand: 'Not_A Brand', version: '24.0.0.0' }
      ];
      const userAgentData = {
        brands: brands,
        mobile: !!config.mobile,
        platform: config.uaPlatform,
        getHighEntropyValues: async function(hints) {
          const values = {
            architecture: config.architecture,
            bitness: config.bitness,
            brands: this.brands,
            fullVersionList: fullVersionList,
            mobile: !!config.mobile,
            model: '',
            platform: config.uaPlatform,
            platformVersion: config.uaPlatformVersion,
            uaFullVersion: config.chromeFullVersion,
            wow64: !!config.wow64
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
      nativeize(userAgentData.getHighEntropyValues, 'getHighEntropyValues');
      nativeize(userAgentData.toJSON, 'toJSON');
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
    const getParameterProxy = function(target, name) {
      const proxy = new Proxy(target, {
        apply: function(target, thisArg, args) {
          const param = args[0];
          // UNMASKED_VENDOR_WEBGL
          if (param === 37445) return config.webglVendor;
          // UNMASKED_RENDERER_WEBGL
          if (param === 37446) return config.webglRenderer;
          return Reflect.apply(target, thisArg, args);
        }
      });
      nativeize(proxy, name);
      return proxy;
    };

    const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = getParameterProxy(originalGetParameter, 'getParameter');

    if (typeof WebGL2RenderingContext !== 'undefined') {
      const originalGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = getParameterProxy(originalGetParameter2, 'getParameter');
    }
  }

  // ---- Canvas fingerprint noise ----
  // A tiny, deterministic-per-session perturbation of pixel reads. It has to
  // be deterministic (same coordinates always produce the same delta within
  // one session) because a common detection technique re-renders the same
  // canvas twice and flags the result if the two hashes differ — real
  // hardware always produces identical output for identical draws. What
  // this defeats is exact-hash tracking: two different sessions (or a
  // session vs. a "clean" real browser) now produce different canvas hashes
  // instead of an identical, trivially fingerprint-able one.
  (function() {
    const seed = (config.fingerprintSeed >>> 0) || 1;
    function hash32(a, b) {
      let h = (a ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b)) >>> 0;
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^ (h >>> 16)) >>> 0;
    }
    function noisifyImageData(imageData) {
      // Skip very large canvases (real page rendering, screenshots-ish
      // usage) — fingerprint probes are almost always small, and this keeps
      // the cost of the patch negligible for legitimate large-canvas use.
      if (imageData.width * imageData.height > 500000) return imageData;
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const n = (hash32(seed, i) % 3) - 1; // -1, 0, or +1
        if (n !== 0) {
          data[i] = Math.min(255, Math.max(0, data[i] + n));
          data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + n));
          data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + n));
        }
      }
      return imageData;
    }
    function patchCanvasNoise(CanvasProto, CtxProto, makeCanvas) {
      if (!CtxProto || !CtxProto.getImageData) return;
      const origGetImageData = CtxProto.getImageData;
      CtxProto.getImageData = function(...args) {
        const result = origGetImageData.apply(this, args);
        return noisifyImageData(result);
      };
      nativeize(CtxProto.getImageData, 'getImageData');

      if (CanvasProto && CanvasProto.toDataURL) {
        const origToDataURL = CanvasProto.toDataURL;
        CanvasProto.toDataURL = function(...args) {
          try {
            const w = this.width, h = this.height;
            if (w > 0 && h > 0 && typeof this.getContext === 'function') {
              const copy = makeCanvas(w, h);
              if (copy) {
                const copyCtx = copy.getContext('2d');
                copyCtx.drawImage(this, 0, 0);
                // Use the ORIGINAL getImageData here (not the patched one)
                // so the noise is applied exactly once, then written back
                // onto the disposable copy — the real canvas is never
                // mutated, so screenshots/further drawing on it stay exact.
                const imageData = origGetImageData.call(copyCtx, 0, 0, w, h);
                noisifyImageData(imageData);
                copyCtx.putImageData(imageData, 0, 0);
                return origToDataURL.apply(copy, args);
              }
            }
          } catch (e) {}
          return origToDataURL.apply(this, args);
        };
        nativeize(CanvasProto.toDataURL, 'toDataURL');
      }

      if (CanvasProto && CanvasProto.toBlob) {
        const origToBlob = CanvasProto.toBlob;
        CanvasProto.toBlob = function(callback, ...rest) {
          try {
            const w = this.width, h = this.height;
            if (w > 0 && h > 0 && typeof this.getContext === 'function') {
              const copy = makeCanvas(w, h);
              if (copy) {
                const copyCtx = copy.getContext('2d');
                copyCtx.drawImage(this, 0, 0);
                const imageData = origGetImageData.call(copyCtx, 0, 0, w, h);
                noisifyImageData(imageData);
                copyCtx.putImageData(imageData, 0, 0);
                return origToBlob.call(copy, callback, ...rest);
              }
            }
          } catch (e) {}
          return origToBlob.call(this, callback, ...rest);
        };
        nativeize(CanvasProto.toBlob, 'toBlob');
      }
    }
    if (typeof HTMLCanvasElement !== 'undefined' && typeof document !== 'undefined') {
      patchCanvasNoise(
        HTMLCanvasElement.prototype,
        typeof CanvasRenderingContext2D !== 'undefined' ? CanvasRenderingContext2D.prototype : null,
        (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
      );
    }
    if (typeof OffscreenCanvas !== 'undefined') {
      patchCanvasNoise(
        OffscreenCanvas.prototype,
        typeof OffscreenCanvasRenderingContext2D !== 'undefined' ? OffscreenCanvasRenderingContext2D.prototype : null,
        (w, h) => new OffscreenCanvas(w, h)
      );
    }

    // ---- AudioContext fingerprint noise ----
    // Same deterministic-per-session-seed approach, applied to the two
    // primary audio-fingerprint read paths (OfflineAudioContext rendering
    // read via getChannelData, and analyser-based frequency reads).
    if (typeof AudioBuffer !== 'undefined' && AudioBuffer.prototype.getChannelData) {
      const origGetChannelData = AudioBuffer.prototype.getChannelData;
      AudioBuffer.prototype.getChannelData = function(channel) {
        const data = origGetChannelData.call(this, channel);
        for (let i = 0; i < data.length; i += 97) {
          data[i] += ((hash32(seed, i) % 2000) - 1000) / 10000000;
        }
        return data;
      };
      nativeize(AudioBuffer.prototype.getChannelData, 'getChannelData');
    }
    if (typeof AnalyserNode !== 'undefined' && AnalyserNode.prototype.getFloatFrequencyData) {
      const origGetFloatFrequencyData = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = function(array) {
        origGetFloatFrequencyData.call(this, array);
        for (let i = 0; i < array.length; i++) {
          array[i] += ((hash32(seed, i) % 2000) - 1000) / 100000;
        }
      };
      nativeize(AnalyserNode.prototype.getFloatFrequencyData, 'getFloatFrequencyData');
    }
  })();

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
    nativeize(window.chrome.loadTimes, 'loadTimes');
    nativeize(window.chrome.csi, 'csi');

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
      nativeize(navigator.permissions.query, 'query');
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
        this.userProfiles = new Map();
    }

    // Picks one internally-consistent device profile per user and holds it
    // for the session's lifetime (until closeContext). A fresh, random
    // fingerprintSeed is generated per session even when two sessions land
    // on the same profile, so canvas/audio noise still differs between them
    // — otherwise two sessions sharing a profile would also emit identical
    // canvas hashes, which is exactly the cross-session correlation this is
    // meant to avoid.
    _getProfileForUser(userId) {
        if (!this.userProfiles.has(userId)) {
            const base = DEVICE_PROFILES[Math.floor(Math.random() * DEVICE_PROFILES.length)];
            const profile = { ...base, fingerprintSeed: Math.floor(Math.random() * 2 ** 31) };
            this.userProfiles.set(userId, profile);
        }
        return this.userProfiles.get(userId);
    }

    _getUserIdForContext(browserContext) {
        for (const [userId, ctx] of this.contexts.entries()) {
            if (ctx === browserContext) return userId;
        }
        return null;
    }

    async initBrowser() {
        if (this.browser) return;

        if (this.browserLaunching) {
            await this.browserLaunching;
            return;
        }

        this.browserLaunching = (async() => {
            const defaultProfile = DEVICE_PROFILES[0];
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

                    // Consistent User-Agent (blank-page default; each page
                    // gets its own profile-accurate override before it
                    // navigates anywhere, see _applyStealthToPage)
                    `--user-agent=${defaultProfile.userAgent}`,

                    // Window size for consistency
                    `--window-size=${defaultProfile.screenResolution.width},${defaultProfile.screenResolution.height}`,

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
            // Resolve which user/session this worker belongs to so it gets
            // that session's actual profile, not some arbitrary default —
            // otherwise a fallback injection could contradict the primary
            // source-rewrite injection that already ran for the same worker.
            let profile = DEVICE_PROFILES[0];
            try {
                const browserContext = typeof target.browserContext === 'function' ? target.browserContext() : null;
                const userId = browserContext ? this._getUserIdForContext(browserContext) : null;
                if (userId) profile = this._getProfileForUser(userId);
            } catch (e) {}

            const client = await target.createCDPSession();

            // Inject the navigator override script. Runtime.evaluate works
            // without a prior Runtime.enable, so skip that extra round trip
            // to shave whatever latency we can off this race.
            await client.send('Runtime.evaluate', {
                expression: getNavigatorOverrideScript(profile),
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
            const profile = this._getProfileForUser(userId);

            // Apply comprehensive stealth before any navigation
            await this._applyStealthToPage(page, profile);

            this.pages.set(userId, page);
            this.pagePromises.delete(userId);

            page.on('close', () => this.pages.delete(userId));

            // Handle new frames (iframes)
            page.on('frameattached', async(frame) => {
                try {
                    await frame.evaluate(getNavigatorOverrideScript(profile));
                } catch (e) {}
            });

            return page;
        })();

        this.pagePromises.set(userId, promise);

        return promise;
    }

    // ==================== STEALTH APPLICATION ====================
    async _applyStealthToPage(page, config) {
        // Set user agent via CDP for consistency
        const client = await page.target().createCDPSession();

        // Set User-Agent Override (affects main context AND workers). Every
        // field here comes from the same device profile as the JS-level
        // navigator overrides below, so the network-visible UA header and
        // Client Hints can't disagree with what the page's own JS reports.
        await client.send('Emulation.setUserAgentOverride', {
            userAgent: config.userAgent,
            platform: config.platform,
            userAgentMetadata: {
                brands: [
                    { brand: 'Chromium', version: config.chromeMajor },
                    { brand: 'Google Chrome', version: config.chromeMajor },
                    { brand: 'Not_A Brand', version: '24' }
                ],
                fullVersionList: [
                    { brand: 'Chromium', version: config.chromeFullVersion },
                    { brand: 'Google Chrome', version: config.chromeFullVersion },
                    { brand: 'Not_A Brand', version: '24.0.0.0' }
                ],
                platform: config.uaPlatform,
                platformVersion: config.uaPlatformVersion,
                architecture: config.architecture,
                model: '',
                mobile: !!config.mobile,
                bitness: config.bitness,
                wow64: !!config.wow64
            }
        });

        // Inject stealth script on every new document. Note: CDP's
        // addScriptToEvaluateOnNewDocument only reaches the page's own
        // frames/iframes — it does NOT run inside Worker/SharedWorker
        // execution contexts, those are separate CDP targets. Workers are
        // handled below via source rewriting (primary) and CDP injection
        // (fallback, see _injectIntoWorker).
        await page.evaluateOnNewDocument(getNavigatorOverrideScript(config));

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
            // Small, self-contained toString nativizer for the two
            // constructors patched below — kept independent from the main
            // override script's own nativizer (a separate closure/realm at
            // injection time) rather than trying to share state across the
            // two evaluateOnNewDocument calls.
            const nativeStrings = new WeakMap();
            const origFnToString = Function.prototype.toString;
            const fnToStringProxy = new Proxy(origFnToString, {
                apply(target, thisArg, args) {
                    if (nativeStrings.has(thisArg)) return nativeStrings.get(thisArg);
                    return Reflect.apply(target, thisArg, args);
                }
            });
            try {
                Object.defineProperty(Function.prototype, 'toString', {
                    value: fnToStringProxy, writable: true, enumerable: false, configurable: true
                });
            } catch (e) {}
            function nativeize(fn, name) {
                try { nativeStrings.set(fn, `function ${name}() { [native code] }`); } catch (e) {}
                return fn;
            }
            nativeize(fnToStringProxy, 'toString');

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
                nativeize(Patched, OriginalClass.name);
                try { Object.defineProperty(Patched, 'name', { value: OriginalClass.name }); } catch (e) {}
                return Patched;
            }

            window.Worker = patchWorkerClass(window.Worker);
            if (window.SharedWorker) window.SharedWorker = patchWorkerClass(window.SharedWorker);
        }, getNavigatorOverrideScript(config));

        // Set viewport to match the assigned device profile
        await page.setViewport({
            width: config.screenResolution.width,
            height: config.screenResolution.height,
            deviceScaleFactor: 1,
            hasTouch: config.maxTouchPoints > 0,
            isMobile: !!config.mobile
        });

        console.log(`✅ Stealth applied to page (profile: ${config.id})`);
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

        this.userProfiles.delete(userId);
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
            this.userProfiles.clear();
        }
    }
}

module.exports = new BrowserManager();
