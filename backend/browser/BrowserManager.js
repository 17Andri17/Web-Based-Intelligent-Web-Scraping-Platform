const { executablePath } = require('puppeteer');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const {
    DEVICE_PROFILES,
    pickRandomProfile,
    getLaunchArgs,
    getUserAgentMetadata,
    getNavigatorOverrideScript,
    workerConstructorPatchFn,
    PROXY_WEBRTC_GUARD_SCRIPT
} = require('./stealthCore');

class BrowserManager {
    constructor() {
        this.browser = null;
        this.contexts = new Map();
        this.pages = new Map();
        this.pagePromises = new Map();
        this.exposedBindings = new Map();
        this.workerListeners = new Map();
        this.userProfiles = new Map();
        this.userProxies = new Map();
    }

    // Called by server.js (which owns the DB lookup — this class has no DB
    // access) before a user's first getPage()/getContext() call, with either
    // a plain { protocol, host, port, username?, password? } object or null.
    // The browser is a single shared process serving every user through
    // per-user BrowserContexts, so proxy has to be a per-context setting
    // (see getContext) rather than a launch flag — unlike
    // workflowCodegen.js's generated scripts, which each get a dedicated
    // process and can just pass --proxy-server at launch.
    //
    // If a context already exists for this user and the proxy actually
    // changed, tear it down so the next getPage()/getContext() call creates
    // a fresh one with the new proxy — Chrome has no way to change a
    // BrowserContext's proxy after creation.
    async setUserProxy(userId, proxyConfig) {
        const prev = this.userProxies.get(userId) || null;
        const next = proxyConfig || null;
        const changed = JSON.stringify(prev) !== JSON.stringify(next);
        this.userProxies.set(userId, next);
        if (changed && this.contexts.has(userId)) {
            await this.closeContext(userId);
        }
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
            this.userProfiles.set(userId, pickRandomProfile());
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
            // Blank-page default before any page's own profile-accurate
            // override applies (see _applyStealthToPage) — args come from
            // stealthCore.js, shared with the generated workflow scripts.
            const defaultProfile = DEVICE_PROFILES[0];
            this.browser = await puppeteer.launch({
                executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                headless: 'new',
                defaultViewport: null,
                args: getLaunchArgs(defaultProfile),
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
            const proxy = this.userProxies.get(userId);
            const contextOptions = {};
            if (proxy && proxy.host && proxy.port) {
                contextOptions.proxyServer = `${(proxy.protocol || 'http').toLowerCase()}://${proxy.host}:${proxy.port}`;
            }

            let context;
            if (typeof this.browser.createBrowserContext === 'function') {
                context = await this.browser.createBrowserContext(contextOptions);
            } else if (typeof this.browser.createIncognitoBrowserContext === 'function') {
                if (contextOptions.proxyServer) {
                    console.warn(`⚠️ Proxy requested for user ${userId} but this Puppeteer version's createIncognitoBrowserContext() doesn't support per-context proxies — ignoring.`);
                }
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
            const proxy = this.userProxies.get(userId);

            // Apply comprehensive stealth before any navigation
            await this._applyStealthToPage(page, profile, proxy);

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
    async _applyStealthToPage(page, config, proxy) {
        // Set user agent via CDP for consistency
        const client = await page.target().createCDPSession();

        // Proxy auth: the proxyServer set on the BrowserContext (see
        // getContext) only carries scheme://host:port — Chrome doesn't
        // accept embedded credentials there, it challenges via
        // Proxy-Authentication and Puppeteer answers through this handler.
        if (proxy && proxy.username) {
            try {
                await page.authenticate({ username: proxy.username, password: proxy.password || '' });
            } catch (e) {}
        }

        // WebRTC can leak the real IP around the proxy via its own STUN-based
        // candidate gathering, which --proxy-server doesn't cover — see the
        // comment on PROXY_WEBRTC_GUARD_SCRIPT in stealthCore.js for why this
        // (rather than a launch flag) is what BrowserManager's shared browser
        // process has to use.
        if (proxy && proxy.host) {
            await page.evaluateOnNewDocument(PROXY_WEBRTC_GUARD_SCRIPT);
        }

        // Set User-Agent Override (affects main context AND workers). Every
        // field here comes from the same device profile as the JS-level
        // navigator overrides below, so the network-visible UA header and
        // Client Hints can't disagree with what the page's own JS reports.
        await client.send('Emulation.setUserAgentOverride', {
            userAgent: config.userAgent,
            platform: config.platform,
            userAgentMetadata: getUserAgentMetadata(config)
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
        await page.evaluateOnNewDocument(workerConstructorPatchFn, getNavigatorOverrideScript(config), true);

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
        this.userProxies.delete(userId);
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
            this.userProxies.clear();
        }
    }
}

module.exports = new BrowserManager();
