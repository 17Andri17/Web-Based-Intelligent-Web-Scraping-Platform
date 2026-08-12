'use strict';

// Load .env (e.g. GROQ_API_KEY) from backend/.env if present. Optional —
// env vars set in the shell still take precedence.
require('dotenv').config();

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app                = require('./app');
const scraperServiceFactory = require('./services/scraper.service');
const browserManager     = require('./browser/BrowserManager');
const { executeWorkflow } = require('./workflow/WorkflowExecutor');
const { generateCode, generateReadme } = require('./workflow/workflowCodegen');
const { __ftMaterializeRow, __ftCleanAny } = require('./workflow/fieldTransforms');
const { verifyToken }    = require('./middleware/auth');
const workflows          = require('./db/repositories/workflows.repo');
const { resolveWorkflowProxy } = require('./services/proxyResolver.service');
const { resolveCustomActions, resolveSubflows } = require('./workflow/dependencyResolver');
const { buildFlowTree } = require('./workflow/workflowUtils');
const extractListAI      = require('./services/extractListAI.service');
const extractListHeuristics = require('./services/extractListHeuristics.service');
const { cssRelaxations, buildDiagnosis } = require('./services/selectorDebug');
// API discovery: passively capture the page's own XHR/fetch traffic while the
// user browses, then propose the underlying data API instead of scraping the
// DOM. See browser/networkCapture.js + services/apiDiscovery.service.js and
// docs/API_DISCOVERY.md.
const networkCapture     = require('./browser/networkCapture');
const { createScreencastPacer } = require('./browser/screencastPacer');
const apiDiscovery       = require('./services/apiDiscovery.service');
const apiReplay          = require('./services/apiReplay.service');
const apiDiscoveryAI     = require('./services/apiDiscoveryAI.service');
const runEvents          = require('./services/runEvents.service');
const runStoreSvc        = require('./services/runStore.service');
const runReaper          = require('./services/runReaper.service');

// Codegen-time dependency resolution (custom actions + subflows) lives in
// workflow/dependencyResolver.js and is shared with the scheduler.

const PORT = process.env.PORT || 3001;

// Device scale the editor browser renders at (see BrowserManager's
// --force-device-scale-factor). The live-preview screencast is captured from
// this 2x surface and downscaled per client, so retina clients get a stream
// as sharp as a real browser. JPEG quality for that stream — at 2x resolution
// q80 is visually lossless while keeping frames light enough to stay smooth.
const EDITOR_DEVICE_SCALE       = Number(process.env.EDITOR_DEVICE_SCALE) || 2;
const SCREENCAST_JPEG_QUALITY   = Number(process.env.SCREENCAST_JPEG_QUALITY) || 80;

// Stream pacing (see browser/screencastPacer.js). Frames are delivered against
// client acks rather than fire-and-forget, so latency stays bounded when the
// link is narrower than the stream — over a tunnel or any remote connection it
// is the difference between a lower frame rate and lag that grows without end.
// SCREENCAST_JPEG_QUALITY above is the ceiling; quality is lowered toward
// SCREENCAST_MIN_QUALITY only while the connection can't keep up, and restored
// automatically. Set SCREENCAST_MAX_IN_FLIGHT=1 for the lowest possible latency
// at a lower frame rate.
const SCREENCAST_MAX_IN_FLIGHT  = Number(process.env.SCREENCAST_MAX_IN_FLIGHT) || 2;
const SCREENCAST_MIN_QUALITY    = Number(process.env.SCREENCAST_MIN_QUALITY) || 30;
// Set false to pin quality at SCREENCAST_JPEG_QUALITY. Pacing still applies, so
// latency stays bounded either way — this only stops the quality from moving.
const SCREENCAST_ADAPTIVE = String(process.env.SCREENCAST_ADAPTIVE || 'true').toLowerCase() !== 'false';

const server     = http.createServer(app);
const io         = new Server(server, { cors: { origin: '*' }, transports: ['websocket'] });
const scraperService = scraperServiceFactory(io);

// Authenticate every socket connection. The client must send a JWT either
// via auth.token (preferred) or the legacy query.token field.
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('Missing auth token'));
  try {
    const payload = verifyToken(token);
    socket.user = { id: payload.sub, username: payload.username };
    next();
  } catch (_) {
    next(new Error('Invalid or expired token'));
  }
});

const injectedScript   = fs.readFileSync(path.join(__dirname, './browser/inject/SelectorTool.js'), 'utf8');
const injectedSelectors = fs.readFileSync(path.join(__dirname, './browser/selectors.js'), 'utf8');
// Keep link/window.open navigation inside the single streamed tab — the CDP
// screencast follows only one page, so target="_blank" / window.open() would
// open an invisible new tab and look like a dead click (see ForceSameTab.js).
const injectedForceSameTab = fs.readFileSync(path.join(__dirname, './browser/inject/ForceSameTab.js'), 'utf8');
// CMP / cookie-consent auto-dismiss — injected alongside the selector tool so
// banners are accepted automatically right after navigation, in every frame.
const { buildInjectedConsentScript } = require('./browser/consent');
const injectedConsent  = buildInjectedConsentScript();
const CONSENT_PREF     = process.env.SCRAPER_CONSENT || 'accept';
// CAPTCHA detection — injected alongside consent so the editor can tell the
// user (or auto-solve) when an anti-bot challenge appears while they build a
// scraper. Detection is free/always-on; solving is opt-in (see
// services/captchaSolver.service.js).
const { buildInjectedCaptchaScript } = require('./browser/captcha');
const captchaSolver    = require('./services/captchaSolver.service');
const injectedCaptcha  = buildInjectedCaptchaScript();

// Active CDP sessions per user
const userSessions = new Map();

// Track last-known session config per user (startUrl, viewport) for code generation
const userSessionMeta = new Map();

// Per-user `framenavigated` listener so we can detach the previous one
// before attaching a new one (e.g. across SPA reconnects on the same page).
// Without this, every call to navigate would stack another listener.
const modeReapplyListeners = new Map();

// Same idea but for the puppeteer page's 'load' event — used to tell the
// frontend that the DOM has finished loading so it can re-fire its preview
// queries against a settled page (e.g. after opening a saved workflow).
const pageLoadListeners = new Map();

/* ── Live run progress → socket rooms ──────────────────────────────────────
   Every run publishes to runEvents regardless of what started it; this relays
   those events to everyone watching that run. One room per run, so a viewer
   subscribes to a RUN rather than depending on having been the connection that
   launched it — which is what makes progress visible from a second tab, after
   a reload, and for scheduled / API runs that have no socket at all.

   The event names match what the frontend already listens for, so a watching
   tab and the launching tab render through exactly the same path. */
const runRoom = (runId) => `run:${runId}`;
const RUN_EVENT_CHANNEL = {
  started:   'executionStarted',
  log:       'executionLog',
  stepBegin: 'executionStepBegin',
  stepError: 'executionStepError',
  iteration: 'executionIteration',
  workers:   'executionWorkers',
  partial:   'executionPartial',
  results:   'executionResults',
  done:      'executionDone',
};
runEvents.bus.on('event', ({ runId, event, payload }) => {
  const channel = RUN_EVENT_CHANNEL[event];
  if (!channel) return;
  try { io.to(runRoom(runId)).emit(channel, payload); } catch (_) {}
});

io.on('connection', async (socket) => {
  const userId = `u${socket.user.id}`;
  console.log(`🔌 User connected: ${socket.user.username} (${userId})`);
  socket.join(userId);

  // Re-route puppeteer → frontend event channels to THIS socket if the user
  // already has a page open from a previous SPA session (e.g. they hit F5).
  // Without this, inspector selections still reach the backend but bubble
  // out through the old, disconnected socket and the sidebar stays empty.
  if (browserManager.hasPage(userId)) {
    try {
      await browserManager.ensureBinding(userId, 'sendToNode', (event) => {
        // Cookie-consent auto-dismiss status (see browser/consent.js) rides
        // this same binding rather than its own page.on('console', ...)
        // listener — see the comment there for why. Besides the status
        // message, a dedicated event lets the frontend record the dismissal
        // as a workflow step so unattended runs repeat it.
        if (event && event.type === 'consent') {
          socket.emit('message', event.text);
          socket.emit('consentAutoHandled', { name: event.name || null });
          return;
        }
        // CAPTCHA detection (see browser/captcha.js) rides the same binding.
        if (event && event.type === 'captcha') { socket.emit('captchaDetected', { ...event, solverConfigured: captchaSolver.isConfigured(), provider: captchaSolver.getProviderName() }); return; }
        socket.emit('browserEvent', event);
      });
      await browserManager.ensureBinding(userId, 'sendCursorType', (cursorType) => {
        socket.emit('cursorType', { cursor: cursorType });
      });
      // Replay the current page URL so the URL bar reflects where we are
      // after an SPA refresh (otherwise it stays empty until the next nav).
      try {
        const page = await browserManager.getPage(userId);
        const url = page.url && page.url();
        if (url) socket.emit('pageUrlChanged', { url });
        // The page is already past its load event, so it's a "ready" state
        // for our purposes — let the frontend re-fire any previews.
        socket.emit('pageReady');
      } catch (_) {}
      socket.emit('message', '✅ Reconnected to existing browser session');
    } catch (err) {
      console.warn('Failed to rebind existing page for', userId, err.message);
    }
  }

  // The inspector / selection handlers below need the puppeteer page but
  // not the screencast session (which only exists between navigate and
  // stopStreaming). Reading from browserManager directly keeps them
  // working after a SPA refresh, where userSessions has already been
  // torn down but the page is still alive.
  const getActivePage = async () => {
    if (!browserManager.hasPage(userId)) return null;
    try { return await browserManager.getPage(userId); } catch (_) { return null; }
  };

  // Current screencast teardown for THIS connection. `navigate` reassigns it
  // on every call; a single 'stopStreaming' listener (below) and the
  // 'disconnect' handler at the bottom invoke whatever the latest one is.
  // Registering the listeners once — instead of once per navigate — is what
  // prevents the per-navigation listener stacking (MaxListenersExceeded +
  // stale-closure leak) that the previous code caused.
  let stopStreaming = null;
  socket.on('stopStreaming', () => { if (stopStreaming) stopStreaming(); });

  // ── ForEach scope ────────────────────────────────────────────────────────
  socket.on('setForEachScope', async ({ iteratorSelector }) => {
    try {
      const page = await getActivePage();
      if (page) await page.evaluate((sel) => {
        if (typeof window.__setForEachScope__ === 'function') window.__setForEachScope__(sel);
      }, iteratorSelector);
    } catch (_) {}
  });

  socket.on('clearForEachScope', async () => {
    try {
      const page = await getActivePage();
      if (page) await page.evaluate(() => {
        if (typeof window.__clearForEachScope__ === 'function') window.__clearForEachScope__();
      });
    } catch (_) {}
  });

  // ── List-field pick mode ──────────────────────────────────────────────────
  socket.on('startListFieldPick', async ({ containerSelector, fields }) => {
    try {
      const page = await getActivePage();
      if (page) await page.evaluate((sel, flds) => {
        if (typeof window.__startListFieldPick__ === 'function') window.__startListFieldPick__(sel, flds);
      }, containerSelector || '', Array.isArray(fields) ? fields : []);
    } catch (_) {}
  });

  // Refresh the "already captured" field markers while pick mode is active
  // (fires whenever the step's fields change — add/remove/rename/confirm).
  socket.on('updateListFieldMarkers', async ({ fields }) => {
    try {
      const page = await getActivePage();
      if (page) await page.evaluate((flds) => {
        if (typeof window.__updateListFieldMarkers__ === 'function') window.__updateListFieldMarkers__(flds);
      }, Array.isArray(fields) ? fields : []);
    } catch (_) {}
  });

  // Passive marker preview: show the captured-field markers on every similar
  // item while the EXTRACT_LIST editor is open (no dim, no click interception).
  socket.on('showListFieldMarkers', async ({ containerSelector, fields }) => {
    try {
      const page = await getActivePage();
      if (page) await page.evaluate((sel, flds) => {
        if (typeof window.__showListFieldMarkers__ === 'function') window.__showListFieldMarkers__(sel, flds);
      }, containerSelector || '', Array.isArray(fields) ? fields : []);
    } catch (_) {}
  });

  socket.on('hideListFieldMarkers', async () => {
    try {
      const page = await getActivePage();
      if (page) await page.evaluate(() => {
        if (typeof window.__hideListFieldMarkers__ === 'function') window.__hideListFieldMarkers__();
      });
    } catch (_) {}
  });

  // Move the pending-pick spotlight to the element the currently selected
  // "Extract:" option targets (e.g. the enclosing <a> for its href).
  socket.on('previewListPickOption', async ({ selector }) => {
    try {
      const page = await getActivePage();
      if (page) await page.evaluate((sel) => {
        if (typeof window.__previewListPickOption__ === 'function') window.__previewListPickOption__(sel);
      }, typeof selector === 'string' ? selector : '');
    } catch (_) {}
  });

  socket.on('stopListFieldPick', async () => {
    try {
      const page = await getActivePage();
      if (page) await page.evaluate(() => {
        if (typeof window.__stopListFieldPick__ === 'function') window.__stopListFieldPick__();
      });
    } catch (_) {}
  });

  // ── HTML tab: full-page source + click/hover-by-path selection ───────────
  socket.on('getPageHtml', async () => {
    const page = await getActivePage();
    if (!page) { socket.emit('pageHtml', { html: '', error: 'No active page' }); return; }
    try {
      const html = await page.content();
      socket.emit('pageHtml', { html });
    } catch (err) {
      socket.emit('pageHtml', { html: '', error: err.message });
    }
  });

  socket.on('selectElementByPath', async ({ path }) => {
    const page = await getActivePage();
    if (!page || !Array.isArray(path)) return;
    try {
      await page.evaluate((p) => {
        if (typeof window.__selectByPath__ === 'function') window.__selectByPath__(p);
      }, path);
    } catch (_) {}
  });

  socket.on('highlightElementByPath', async ({ path }) => {
    const page = await getActivePage();
    if (!page || !Array.isArray(path)) return;
    try {
      await page.evaluate((p) => {
        if (typeof window.__highlightByPath__ === 'function') window.__highlightByPath__(p);
      }, path);
    } catch (_) {}
  });

  // ── Reset selection ───────────────────────────────────────────────────────
  socket.on('resetSelection', async () => {
    try {
      const page = await getActivePage();
      if (page) await page.evaluate(() => { if (typeof window.__resetSelection__ === 'function') window.__resetSelection__(); });
    } catch (_) {}
  });

  // ── Manual multi-element add ──────────────────────────────────────────────
  // Enter/leave the "select more similar elements yourself" mode. While active,
  // page clicks toggle the picked set and the injected tool streams back
  // `multiElementSelected` events with manualAdd=true (via the sendToNode
  // binding, same channel as the tier flow).
  socket.on('startMultiElementAdd', async () => {
    try {
      const page = await getActivePage();
      if (page) await page.evaluate(() => {
        if (typeof window.__startMultiAdd__ === 'function') window.__startMultiAdd__();
      });
    } catch (_) {}
  });

  socket.on('stopMultiElementAdd', async () => {
    try {
      const page = await getActivePage();
      if (page) await page.evaluate(() => {
        if (typeof window.__stopMultiAdd__ === 'function') window.__stopMultiAdd__();
      });
    } catch (_) {}
  });

  // ── Adjust selector (power-user) ──────────────────────────────────────────
  // Apply a hand-edited primary selector: highlight its matches and regenerate
  // fresh fallbacks for the resulting set. Answered on `manualSelectorResult`.
  socket.on('applyManualSelector', async ({ selector, selectorType }) => {
    const page = await getActivePage();
    if (!page) { socket.emit('manualSelectorResult', { ok: false, error: 'No active page' }); return; }
    try {
      const res = await page.evaluate((sel, t) => {
        if (typeof window.__applyManualSelector__ === 'function') return window.__applyManualSelector__(sel, t);
        return { ok: false, error: 'Selector tool not ready' };
      }, String(selector || ''), selectorType || '');
      socket.emit('manualSelectorResult', res || { ok: false, error: 'No result' });
    } catch (err) {
      socket.emit('manualSelectorResult', { ok: false, error: err.message });
    }
  });

  // ── Guided tour: element rect on the live page ───────────────────────────
  // Returns a demo element's bounding box (in the page's own CSS pixels) so the
  // guided tour can draw a spotlight over it on the streamed canvas. Best-effort.
  socket.on('getElementRect', async ({ selector, selectorType }) => {
    const sel = String(selector || '').trim();
    const type = selectorType === 'xpath' ? 'xpath' : 'css';
    const page = await getActivePage();
    if (!page || !sel) { socket.emit('elementRect', { ok: false, selector: sel }); return; }
    try {
      const rect = await page.evaluate((s, t) => {
        let el = null;
        try {
          if (t === 'xpath') el = document.evaluate(s, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          else el = document.querySelector(s);
        } catch (_) { return null; }
        if (!el || !el.getBoundingClientRect) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height, vw: window.innerWidth, vh: window.innerHeight };
      }, sel, type);
      socket.emit('elementRect', rect ? { ok: true, selector: sel, rect } : { ok: false, selector: sel });
    } catch (err) {
      socket.emit('elementRect', { ok: false, selector: sel, error: err.message });
    }
  });

  // ── Selector debugger ────────────────────────────────────────────────────
  // "Why does this selector match 0 elements?" — test a CSS/XPath selector
  // against the live page and return a plain-language diagnosis. One
  // page.evaluate gathers the full-selector counts + a sample + the counts for
  // each progressively-looser variant (built on the backend by cssRelaxations);
  // buildDiagnosis turns those raw numbers into a verdict + suggestions. When
  // the top page has 0 matches we also probe iframes.
  socket.on('debugSelector', async ({ selector, selectorType }) => {
    const sel = String(selector || '').trim();
    const type = selectorType === 'xpath' ? 'xpath' : 'css';
    if (!sel) { socket.emit('debugSelectorResult', { ok: false, error: 'Enter a selector to test.' }); return; }
    const page = await getActivePage();
    if (!page) { socket.emit('debugSelectorResult', { ok: false, error: 'No page is loaded — navigate to a page first.' }); return; }

    const relaxations = type === 'css' ? cssRelaxations(sel) : [];
    try {
      const raw = await page.evaluate((sel, type, relaxations) => {
        const isVisible = (el) => {
          if (!el || !el.getClientRects) return false;
          const rects = el.getClientRects();
          if (!rects || rects.length === 0) return false;
          const cs = window.getComputedStyle(el);
          return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
        };
        const queryAll = (s) => {
          try {
            if (type === 'xpath') {
              const r = document.evaluate(s, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
              return Array.from({ length: r.snapshotLength }, (_, i) => r.snapshotItem(i));
            }
            return Array.from(document.querySelectorAll(s));
          } catch (_) { return null; } // invalid selector
        };
        const els = queryAll(sel);
        if (els === null) return { invalid: true };
        const samples = els.slice(0, 5).map(el => ({
          tag: el.tagName ? el.tagName.toLowerCase() : '?',
          id: el.id || null,
          classes: el.classList ? Array.from(el.classList).slice(0, 6) : [],
          text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 90),
          href: (el.getAttribute && el.getAttribute('href')) || null,
          visible: isVisible(el),
        }));
        const rel = (relaxations || []).map(rs => {
          const m = queryAll(rs);
          return { selector: rs, count: m === null ? 0 : m.length };
        });
        return { matchCount: els.length, visibleCount: els.filter(isVisible).length, samples, relaxations: rel };
      }, sel, type, relaxations);

      if (raw && raw.invalid) {
        socket.emit('debugSelectorResult', { ok: false, error: `That ${type === 'xpath' ? 'XPath' : 'CSS selector'} isn't valid.` });
        return;
      }

      // Probe iframes only when the top document had no matches.
      let iframeMatches = 0;
      if ((raw.matchCount || 0) === 0) {
        try {
          for (const fr of page.frames()) {
            if (fr === page.mainFrame()) continue;
            const c = await fr.evaluate((s, t) => {
              try {
                if (t === 'xpath') { const r = document.evaluate(s, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); return r.snapshotLength; }
                return document.querySelectorAll(s).length;
              } catch (_) { return 0; }
            }, sel, type).catch(() => 0);
            iframeMatches += c || 0;
          }
        } catch (_) {}
      }

      const diagnosis = buildDiagnosis({
        selectorType: type,
        matchCount: raw.matchCount,
        visibleCount: raw.visibleCount,
        samples: raw.samples,
        relaxations: raw.relaxations,
        iframeMatches,
      });
      socket.emit('debugSelectorResult', { ok: true, selector: sel, selectorType: type, ...diagnosis });
    } catch (err) {
      socket.emit('debugSelectorResult', { ok: false, error: err.message });
    }
  });

  // ── Copy: read the remote page's current text selection ──────────────────
  // The user only ever sees a pixel stream, so Ctrl+C in the host browser
  // can't reach the remote page's selection by itself. The frontend
  // intercepts the copy shortcut, asks for the selection here, and writes
  // the reply into the LOCAL clipboard. Checked across all frames since the
  // selection may live inside an iframe.
  socket.on('getSelection', async () => {
    const page = await getActivePage();
    if (!page) { socket.emit('selectionText', { text: '' }); return; }
    let text = '';
    let frames = [];
    try { frames = page.frames(); } catch (_) { try { frames = [page.mainFrame()]; } catch (_) { frames = []; } }
    for (const fr of frames) {
      try {
        const t = await fr.evaluate(() => {
          const sel = window.getSelection && window.getSelection();
          let out = sel ? sel.toString() : '';
          // Text selected inside a focused <input>/<textarea> doesn't show
          // up in window.getSelection() — read the field's range instead.
          if (!out) {
            const el = document.activeElement;
            if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') &&
                typeof el.selectionStart === 'number' && el.selectionEnd > el.selectionStart) {
              out = String(el.value).slice(el.selectionStart, el.selectionEnd);
            }
          }
          return out || '';
        });
        if (t) { text = t; break; }
      } catch (_) {}
    }
    socket.emit('selectionText', { text });
  });

  // ── Breadcrumb: navigate to ancestor ─────────────────────────────────────
  socket.on('navigateAncestor', async ({ levelsUp }) => {
    try {
      const page = await getActivePage();
      if (page) await page.evaluate((levels) => {
        if (typeof window.__selectAncestor__ === 'function') window.__selectAncestor__(levels);
      }, levelsUp);
    } catch (_) {}
  });

  // ── Breadcrumb: get children of ancestor for picker ───────────────────────
  socket.on('getChildrenOf', async ({ levelsUp }) => {
    try {
      const page = await getActivePage();
      if (!page) { socket.emit('childrenList', { levelsUp, children: [] }); return; }
      const children = await page.evaluate((levels) => {
        if (typeof window.__getChildrenOf__ === 'function') return window.__getChildrenOf__(levels);
        return [];
      }, levelsUp);
      socket.emit('childrenList', { levelsUp, children: children || [] });
    } catch (err) {
      socket.emit('childrenList', { levelsUp, children: [] });
    }
  });

  // ── Breadcrumb: select a specific child by index ──────────────────────────
  socket.on('selectChildByIndex', async ({ levelsUp, childIndex }) => {
    try {
      const page = await getActivePage();
      if (page) await page.evaluate((levels, idx) => {
        if (typeof window.__selectChildByIndex__ === 'function') window.__selectChildByIndex__(levels, idx);
      }, levelsUp, childIndex);
    } catch (_) {}
  });

  // ── Picker hover highlight ───────────────────────────────────────────────
  socket.on('hoverAncestor', async ({ levelsUp }) => {
    try {
      const page = await getActivePage();
      if (page) await page.evaluate((lvl) => {
        if (typeof window.__highlightAncestor__ === 'function') window.__highlightAncestor__(lvl);
      }, levelsUp);
    } catch (_) {}
  });

  socket.on('hoverPickerChild', async ({ levelsUp, childIndex }) => {
    try {
      const page = await getActivePage();
      if (page) await page.evaluate((lvl, idx) => {
        if (typeof window.__highlightPickerChild__ === 'function') window.__highlightPickerChild__(lvl, idx);
      }, levelsUp, childIndex);
    } catch (_) {}
  });

  socket.on('unhoverPickerChild', async () => {
    try {
      const page = await getActivePage();
      if (page) await page.evaluate(() => {
        if (typeof window.__clearHoverHighlight__ === 'function') window.__clearHoverHighlight__();
      });
    } catch (_) {}
  });
 
  // ── Navigate ────────────────────────────────────────────────────────────
  socket.on('navigate', async (data) => {
    try {
      // Resolve + apply the workflow's configured proxy BEFORE the page is
      // created/reused below — BrowserManager can only set a proxy at
      // BrowserContext-creation time (see setUserProxy's comment in
      // BrowserManager.js), so this has to run before getPage(). Always
      // called (even with null) so a proxy from a previously-edited
      // workflow doesn't leak into a session for one that has none.
      // resolveWorkflowProxy scopes to proxies/pools this user owns or that
      // are platform-shared, so data.proxy can't be used to preview through
      // someone else's private proxy or pool. A "pool"/"platform" mode
      // advances that pool's rotation on every navigate — acceptable for
      // the live editor since navigating is already an infrequent, explicit
      // user action, not a tight loop.
      const proxy = await resolveWorkflowProxy({ proxy: data.proxy, proxyId: data.proxyId }, socket.user.id).catch(() => null);
      await browserManager.setUserProxy(userId, proxy);

      const page = await browserManager.getPage(userId);

      // Begin (or keep) passively capturing this page's XHR/fetch traffic so
      // the API-discovery panel has data to analyze. clear() resets the buffer
      // on each explicit navigation so analysis reflects the current page —
      // attach() runs before goto() below, so the page's load-time API calls
      // are captured too. Best-effort: capture failure never blocks browsing.
      try { await networkCapture.attach(page, userId); networkCapture.clear(userId); } catch (_) {}

      // Re-apply the user's last-set mode whenever the page navigates
      // (link click, redirect, history nav). evaluateOnNewDocument resets
      // window.__SELECTION_MODE__ to false on every new document, so without
      // this hook the user would have to toggle Select → Navigate → Select
      // to recover their mode after each page change.
      const prevHook = modeReapplyListeners.get(userId);
      if (prevHook) { try { page.off('framenavigated', prevHook); } catch (_) {} }
      const hook = async (frame) => {
        if (frame !== page.mainFrame()) return;
        // 1. Tell the frontend where we just landed so the URL bar can
        //    track navigations the user made by clicking page links.
        try { socket.emit('pageUrlChanged', { url: frame.url() }); } catch (_) {}
        // 2. Re-apply the user's last-chosen mode — evaluateOnNewDocument
        //    resets window.__SELECTION_MODE__ to false on every new document.
        const mode = scraperService.getMode(userId);
        try {
          await page.evaluate((m) => { window.__SELECTION_MODE__ = m === 'selection'; }, mode);
        } catch (_) {}
      };
      modeReapplyListeners.set(userId, hook);
      page.on('framenavigated', hook);

      // Page's `load` event = full DOM is parsed and ready. The frontend
      // uses this to re-fire previewStep against a settled page after the
      // user opens a saved workflow (otherwise the preview queries race
      // the still-loading page and return nothing).
      const prevLoadHook = pageLoadListeners.get(userId);
      if (prevLoadHook) { try { page.off('load', prevLoadHook); } catch (_) {} }
      const loadHook = () => {
        try { socket.emit('pageReady'); } catch (_) {}
      };
      pageLoadListeners.set(userId, loadHook);
      page.on('load', loadHook);

      // ─────────────────────────────────────────────────────────────
      // BYPASS CSP (must happen BEFORE goto)
      // ─────────────────────────────────────────────────────────────
      await page.setBypassCSP(true);

      // ─────────────────────────────────────────────────────────────
      // Node bindings
      // ─────────────────────────────────────────────────────────────
      await browserManager.ensureBinding(userId, 'sendToNode', (event) => {
        // Cookie-consent auto-dismiss status (see browser/consent.js) rides
        // this same binding rather than its own page.on('console', ...)
        // listener — see the comment there for why. The dedicated event lets
        // the frontend record the dismissal as a workflow step.
        if (event && event.type === 'consent') {
          socket.emit('message', event.text);
          socket.emit('consentAutoHandled', { name: event.name || null });
          return;
        }
        // CAPTCHA detection (see browser/captcha.js) rides the same binding.
        // We tag whether a solver is configured so the frontend can decide
        // between offering "auto-solve" and "solve it yourself in the preview".
        if (event && event.type === 'captcha') { socket.emit('captchaDetected', { ...event, solverConfigured: captchaSolver.isConfigured(), provider: captchaSolver.getProviderName() }); return; }
        socket.emit('browserEvent', event);
      });

      await browserManager.ensureBinding(userId, 'sendCursorType', (cursorType) => {
        socket.emit('cursorType', { cursor: cursorType });
      });

      const viewportWidth  = data.viewportWidth  || 1280;
      const viewportHeight = data.viewportHeight || 720;
      // The browser renders at 2x device pixels (EDITOR_DEVICE_SCALE, forced
      // via --force-device-scale-factor in BrowserManager). The screencast is
      // then downscaled per client to their own devicePixelRatio: a retina
      // client gets full 2x frames (matching a real browser), a 1x client gets
      // frames downsampled from the 2x render (supersampled — a touch crisper
      // than a native 1x capture) at their normal bandwidth. One uniform
      // stream at one resolution, so the quality never visibly changes.
      const clientDpr = Math.min(Math.max(Number(data.devicePixelRatio) || 1, 1), EDITOR_DEVICE_SCALE);

      await page.setViewport({
        width: viewportWidth,
        height: viewportHeight,
        deviceScaleFactor: EDITOR_DEVICE_SCALE,
        hasTouch: false,
        isMobile: false,
      });

      // ─────────────────────────────────────────────────────────────
      // Inject BEFORE page scripts run
      // This bypasses CSP entirely
      // ─────────────────────────────────────────────────────────────
      // Per-navigation cookie-consent preference (from the workflow's start
      // NAVIGATE step), so the live editor matches what the workflow will do.
      const navConsentPref = ['accept', 'reject', 'off'].includes(data.consent)
        ? data.consent
        : CONSENT_PREF;

      await page.evaluateOnNewDocument(
        (selectorsCode, toolCode, consentCode, forceSameTabCode, captchaCode, consentPref) => {

          // Always refresh the consent preference (latest navigation wins),
          // even when the heavy injection below is skipped on a stacked run —
          // this is what lets the user change "Accept / Reject / Leave visible"
          // and have it take effect on the next navigation.
          window.__CONSENT_PREF__ = consentPref;

          // CAPTCHA detection always runs in the editor (it never blocks the
          // page or the user's clicks) so the user is told the moment a
          // challenge appears and can solve it — or auto-solve it — in place.
          window.__CAPTCHA_PREF__ = 'notify';

          // The captcha runner installs its OWN idempotency guard, so it must
          // run even on stacked SPA navigations where the selector-tool block
          // below early-returns.
          try { if (typeof eval === 'function') eval(captchaCode); } catch (e) { console.error('Captcha inject failed:', e); }

          // Prevent double injection on SPA navigations
          if (window.__SCRAPER_TOOL_ALREADY_INJECTED__) return;

          window.__SCRAPER_TOOL_ALREADY_INJECTED__ = true;

          try {
            eval(selectorsCode);
            eval(toolCode);

            window.__SELECTION_MODE__ = false;

            // Keep navigation inside the single streamed tab (rewrites
            // target="_blank" / overrides window.open). Wrapped separately so a
            // failure here can never block the selector tool.
            try { eval(forceSameTabCode); } catch (e) { console.error('ForceSameTab inject failed:', e); }

            // Cookie-consent auto-dismiss. Wrapped separately so a failure
            // here can never block the selector tool from working.
            try { eval(consentCode); } catch (e) { console.error('Consent inject failed:', e); }

            console.log('✅ Injection successful');
          } catch (err) {
            console.error('❌ Injection failed:', err);
          }
        },
        injectedSelectors,
        injectedScript,
        injectedConsent,
        injectedForceSameTab,
        injectedCaptcha,
        navConsentPref
      );

      // ─────────────────────────────────────────────────────────────
      // Navigate
      // ─────────────────────────────────────────────────────────────
      await page.goto(data.url, {
        waitUntil: 'networkidle2',
      });

      // ─────────────────────────────────────────────────────────────
      // Ensure selection mode exists after load
      // ─────────────────────────────────────────────────────────────
      await page.evaluate(() => {
        if (typeof window.__SELECTION_MODE__ === 'undefined') {
          window.__SELECTION_MODE__ = false;
        }
      });

      // ─────────────────────────────────────────────────────────────
      // Remember session meta
      // ─────────────────────────────────────────────────────────────
      userSessionMeta.set(userId, {
        startUrl: data.url,
        viewportWidth,
        viewportHeight,
      });

      // ─────────────────────────────────────────────────────────────
      // CDP Screencast
      // ─────────────────────────────────────────────────────────────
      const client = await page.target().createCDPSession();

      userSessions.set(userId, {
        session: client,
        page,
        streaming: true,
        currentWidth: viewportWidth,
        currentHeight: viewportHeight,
        currentDpr: clientDpr,
      });

      // Single stream. The page renders at 2x; maxWidth caps the frame at the
      // client's own resolution (cssWidth × clientDpr), so a retina client
      // gets full-resolution frames and a 1x client gets them downsampled from
      // the 2x render. JPEG (not PNG) keeps the 2x frames light enough to stay
      // smooth — at 2x resolution the compression is visually lossless.
      //
      // Built in one place because the adaptive-quality restart below and
      // resizeViewport both have to reproduce these parameters exactly.
      const screencastParams = (quality, width, height, dpr) => ({
        format: 'jpeg',
        quality,
        maxWidth: Math.round(width * dpr),
        maxHeight: Math.round(height * dpr),
        everyNthFrame: 1,
      });

      await client.send('Page.startScreencast',
        screencastParams(SCREENCAST_JPEG_QUALITY, viewportWidth, viewportHeight, clientDpr));

      socket.emit('viewportUpdated', {
        width: viewportWidth,
        height: viewportHeight,
        dpr: clientDpr,
      });

      /* Pace the stream against the connection instead of firing frames at it.
         See browser/screencastPacer.js — in short: never more than N frames on
         the wire, a frame waiting behind them is replaced rather than queued,
         and Chrome is throttled to our drain rate. A slow link costs frame
         rate; it no longer accumulates delay. */
      const pacer = createScreencastPacer({
        baseQuality: SCREENCAST_JPEG_QUALITY,
        options: {
          maxInFlight: SCREENCAST_MAX_IN_FLIGHT,
          minQuality:  SCREENCAST_MIN_QUALITY,
          adaptive:    SCREENCAST_ADAPTIVE,
        },
        emitFrame: (buf, onDelivered) => { socket.emit('frame', buf, onDelivered); },
        ackChrome: (sessionId) => {
          client.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
        },
        // Quality is a screencast start parameter, so changing it means
        // restarting the capture. Uses the session's CURRENT geometry, which
        // resizeViewport may have changed since this stream began.
        onQualityChange: async (quality) => {
          const s = userSessions.get(userId);
          if (!s?.streaming) return;
          try {
            await client.send('Page.stopScreencast');
            await client.send('Page.startScreencast',
              screencastParams(quality, s.currentWidth, s.currentHeight, s.currentDpr));
          } catch (_) {}
        },
      });

      const session = userSessions.get(userId);
      if (session) {
        session.pacer = pacer;
        session.screencastParams = screencastParams;
      }

      const onFrame = (frame) => {
        const s = userSessions.get(userId);
        if (!s?.streaming) return;
        pacer.handleFrame(frame);
      };

      client.on('Page.screencastFrame', onFrame);

      // ─────────────────────────────────────────────────────────────
      // Stop streaming
      // ─────────────────────────────────────────────────────────────
      // Reassign the connection-scoped handler (declared once at the top of
      // the connection). The single 'stopStreaming' listener + the
      // 'disconnect' handler call through to this latest closure, so no new
      // socket listeners are added per navigation.
      stopStreaming = async () => {
        const s = userSessions.get(userId);

        if (!s?.streaming) return;

        s.streaming = false;

        // Drop any queued frame and stop the ack timers before the transport
        // goes away, so a pending delivery can't resurrect the pump.
        try { pacer.stop(); } catch (_) {}

        try {
          await client.send('Page.stopScreencast');
        } catch (_) {}

        // Puppeteer's CDPSession exposes .off() — older Node EventEmitter
        // semantics (removeListener) aren't guaranteed on this object.
        try {
          if (typeof client.off === 'function') client.off('Page.screencastFrame', onFrame);
          else if (typeof client.removeListener === 'function') client.removeListener('Page.screencastFrame', onFrame);
        } catch (_) {}

        userSessions.delete(userId);
      };

      socket.emit('message', '✅ Navigation + streaming started');

    } catch (err) {
      console.error(err);

      socket.emit('message', `❌ Navigation error: ${err.message}`);
    }
  });

  // ── Resize viewport ──────────────────────────────────────────────────────
  socket.on('resizeViewport', async ({ width, height, devicePixelRatio }) => {
    const s = userSessions.get(userId);
    if (!s?.streaming) return;
    if (Math.abs(s.currentWidth - width) < 10 && Math.abs(s.currentHeight - height) < 10) return;
    try {
      const clientDpr = Math.min(Math.max(Number(devicePixelRatio) || s.currentDpr || 1, 1), EDITOR_DEVICE_SCALE);
      await s.session.send('Page.stopScreencast').catch(() => {});
      await s.page.setViewport({ width, height, deviceScaleFactor: EDITOR_DEVICE_SCALE, hasTouch: false, isMobile: false });
      s.currentWidth  = width;
      s.currentHeight = height;
      s.currentDpr    = clientDpr;
      const meta = userSessionMeta.get(userId);
      if (meta) { meta.viewportWidth = width; meta.viewportHeight = height; }
      // Keep whatever quality the pacer has settled on — restarting at the
      // configured ceiling would undo its adaptation on every panel resize.
      await s.session.send('Page.startScreencast', {
        format: 'jpeg', quality: s.pacer ? s.pacer.quality : SCREENCAST_JPEG_QUALITY,
        maxWidth: Math.round(width * clientDpr), maxHeight: Math.round(height * clientDpr),
        everyNthFrame: 1,
      });
      socket.emit('viewportUpdated', { width, height, dpr: clientDpr });
    } catch (err) {
      socket.emit('message', `❌ Resize error: ${err.message}`);
    }
  });

  // ── Set selection mode ───────────────────────────────────────────────────
  socket.on('setMode', async ({ mode }) => {
    try {
      // Persist the user's preference. The page may navigate at any time
      // (link click, JS-driven redirect) which causes evaluateOnNewDocument
      // to reset window.__SELECTION_MODE__ back to false — the framenavigated
      // hook in navigate() reads scraperService.getMode(userId) and re-applies
      // this value on every page load so the in-page flag stays in sync.
      scraperService.setMode(userId, mode);
      const page = await browserManager.getPage(userId);
      await page.evaluate((m) => { window.__SELECTION_MODE__ = m === 'selection'; }, mode);
      socket.emit('message', `Mode: ${mode}`);
    } catch (_) {}
  });

  // ── CAPTCHA: auto-solve in the live editor ────────────────────────────────
  // Only meaningful when a solving provider is configured (CAPTCHA_PROVIDER +
  // CAPTCHA_API_KEY). Without one the user simply solves the challenge by hand
  // in the streamed browser — the CDP input forwarding makes that free. The
  // frontend sends back the detection payload it received via 'captchaDetected'.
  socket.on('solveCaptcha', async (payload = {}) => {
    try {
      if (!captchaSolver.isConfigured()) {
        socket.emit('captchaSolveResult', { ok: false, code: 'NO_PROVIDER',
          error: 'No solver configured. Solve the CAPTCHA directly in the preview, or set CAPTCHA_PROVIDER + CAPTCHA_API_KEY to enable auto-solve.' });
        return;
      }
      const page = await getActivePage();
      if (!page) { socket.emit('captchaSolveResult', { ok: false, code: 'NO_PAGE', error: 'No active page.' }); return; }

      const type = payload.captchaType || payload.type;
      const sitekey = payload.sitekey;
      const url = payload.url || (page.url && page.url()) || '';
      if (!captchaSolver.isSupportedType(type) || !sitekey) {
        socket.emit('captchaSolveResult', { ok: false, code: 'UNSUPPORTED',
          error: `This challenge (${type || 'unknown'}${sitekey ? '' : ', no sitekey'}) can't be auto-solved — please solve it in the preview.` });
        return;
      }

      socket.emit('message', `🧩 Requesting a CAPTCHA solution from ${captchaSolver.getProviderName()}…`);
      const out = await captchaSolver.solveToken({ type, sitekey, url, action: payload.action || null });
      if (!out.ok || !out.token) {
        socket.emit('captchaSolveResult', { ok: false, code: out.code || 'SOLVE_FAILED', error: out.error || 'Solver failed.' });
        return;
      }

      // Inject the token into every frame (widget lives in a cross-origin one).
      let injected = false;
      let frames = [];
      try { frames = page.frames(); } catch (_) { frames = [page.mainFrame()]; }
      for (const fr of frames) {
        try {
          const ok = await fr.evaluate((t, tok) => {
            return typeof window.__injectCaptchaToken__ === 'function' ? window.__injectCaptchaToken__(t, tok) : false;
          }, type, out.token);
          if (ok) injected = true;
        } catch (_) {}
      }
      socket.emit('captchaSolveResult', { ok: true, injected, type });
      socket.emit('message', injected ? '🧩 CAPTCHA solved and token injected.' : '🧩 CAPTCHA token obtained — submit the form to continue.');
    } catch (err) {
      socket.emit('captchaSolveResult', { ok: false, code: 'EXCEPTION', error: err.message });
    }
  });

  // ── User actions (mouse/keyboard forwarding) ─────────────────────────────
  socket.on('userAction', async (action) => {
    try {
      await scraperService.performAction(userId, action, socket);
    } catch (err) {
      socket.emit('message', `Error: ${err.message}`);
    }
  });

  // ── Execute workflow ─────────────────────────────────────────────────────
  socket.on('executeWorkflow', async (data) => {
    /*
      data = {
        steps:    [...],          // the full workflow step tree
        meta?:    { startUrl, viewportWidth, viewportHeight }
        workflowId?: number        // required for run history; if missing
                                   // we create an "Untitled" workflow to
                                   // give the run a home
        workflowName?: string      // used when auto-creating
      }
    */
    const meta = data.meta || userSessionMeta.get(userId) || {};
    const steps = data.steps || [];
    const customActions = await resolveCustomActions(steps, socket.user.id);

    // Resolve or create the persisted workflow this run belongs to. We
    // intentionally never run ephemerally — every execution gets a run row
    // so the history feature works for ad-hoc tests too.
    let workflowId = data.workflowId || null;
    if (workflowId) {
      const owned = await workflows.existsForUser(workflowId, socket.user.id);
      if (!owned) workflowId = null;
    }
    if (!workflowId) {
      const name = (data.workflowName && String(data.workflowName).trim()) || 'Untitled draft';
      const created = await workflows.create({
        userId: socket.user.id, name,
        stepsJson: JSON.stringify(steps),
        metaJson: meta ? JSON.stringify(meta) : null,
      });
      workflowId = created.id;
      socket.emit('workflowAutoCreated', { id: workflowId, name });
    } else {
      // Persist the latest steps so re-runs of the same workflow id use
      // the user's most-recent edits even if they didn't hit Save.
      await workflows.updateStepsAndMeta({
        id: workflowId, userId: socket.user.id,
        stepsJson: JSON.stringify(steps),
        metaJson: meta ? JSON.stringify(meta) : null,
      });
    }

    const subflows = await resolveSubflows(steps, socket.user.id, workflowId);
    const workflow = { id: workflowId, steps, meta, customActions, subflows };
    // Send the live "Flow" tab a tree with each RUN_SUBFLOW's steps inlined,
    // so it can show the exact steps a subflow runs (and mark iterations when
    // it runs per-row). Best-effort — never block the run over it.
    try {
      socket.emit('executionFlowTree', { steps: buildFlowTree(steps, subflows, workflowId) });
    } catch (_) {}
    try {
      await executeWorkflow(workflow, socket, {
        userId: socket.user.id,
        workflowId,
        workflowName: data.workflowName || null,
        // Put the launching tab in the run's room the moment the run row
        // exists, so it receives progress through the same path as any other
        // watcher — and keeps receiving it after a reload, by re-watching.
        onRunId: (runId) => { try { socket.join(runRoom(runId)); } catch (_) {} },
      });
    } catch (err) {
      socket.emit('executionLog', { line: `❌ Executor error: ${err.message}`, level: 'error' });
      socket.emit('executionDone', { success: false, results: null, error: err.message });
    }
  });

  /* ── Watch a run this socket didn't start ────────────────────────────────
     Answers with a snapshot so the panel can be drawn as though this tab had
     been watching all along — flow tree, which steps have run, loop counters,
     the recent log tail — then joins the room for everything that follows.

     A finished run isn't an error: its snapshot is briefly retained, and past
     that the client falls back to the REST endpoints (/api/runs/:id and
     /logs), which is the same data from the durable record. */
  socket.on('watchRun', async (payload, ack) => {
    const runId = Number(payload && payload.runId);
    const reply = (v) => { if (typeof ack === 'function') { try { ack(v); } catch (_) {} } };
    if (!Number.isFinite(runId)) return reply({ ok: false, error: 'runId required' });
    try {
      // Ownership from the durable record, never from the in-memory snapshot
      // alone — a snapshot can have expired, and a run row is authoritative.
      const row = await runStoreSvc.getRunForUser(runId, socket.user.id);
      if (!row) return reply({ ok: false, error: 'Run not found' });
      socket.join(runRoom(runId));
      const snap = runEvents.viewerSnapshot(runId);
      reply({
        ok: true,
        live: !!snap,
        snapshot: snap,
        // Present for a run that already ended (or whose snapshot expired), so
        // the client can render the final state without a second round-trip.
        status: row.status,
        workflowId: row.workflow_id,
        rowsCaptured: row.rows_captured || 0,
      });
    } catch (err) {
      reply({ ok: false, error: err.message });
    }
  });

  socket.on('unwatchRun', ({ runId } = {}) => {
    if (Number.isFinite(Number(runId))) { try { socket.leave(runRoom(Number(runId))); } catch (_) {} }
  });

  /* Stop a run by id — from any tab, and never a dead end.

     Cancel used to fail silently whenever this process didn't hold the run's
     canceller, which is exactly the case for a run orphaned by a server
     restart: the row says running, nothing is alive to stop, and the button
     did nothing forever. Every case now resolves to something real. */
  socket.on('cancelRun', async ({ runId } = {}, ack) => {
    const reply = (v) => { if (typeof ack === 'function') { try { ack(v); } catch (_) {} } };
    const id = Number(runId);
    if (!Number.isFinite(id)) return reply({ ok: false, error: 'runId required' });

    const row = await runStoreSvc.getRunForUser(id, socket.user.id);
    if (!row) return reply({ ok: false, error: 'Run not found' });

    // Already finished — say so rather than reporting a failure.
    if (row.status !== 'running' && row.status !== 'queued') {
      return reply({ ok: true, alreadyFinished: true, status: row.status });
    }

    // Queued: no child process yet, so it is cancelled on the row and the
    // worker simply never claims it.
    if (row.status === 'queued') {
      const done = await runStoreSvc.cancelQueuedRun(id, socket.user.id);
      return reply({ ok: done, queued: true });
    }

    // Owned by this process — abort it directly.
    if (runEvents.cancel(id)) return reply({ ok: true, stopping: true });

    // Not ours. Either its owner is gone (orphan), or another instance holds
    // it. Distinguished by the heartbeat, so neither case leaves the user
    // stuck: an orphan is finalised now, a live one is asked to stop.
    const beat = row.heartbeat_at ? Date.parse(String(row.heartbeat_at).replace(' ', 'T') + 'Z') : NaN;
    const stale = !Number.isFinite(beat) || (Date.now() - beat) > runReaper.STALE_MS;
    if (stale) {
      const status = await runReaper.reap(row, 'Stopped — this run was no longer reporting progress.');
      return reply({ ok: true, orphaned: true, status });
    }
    const asked = await runStoreSvc.requestCancel(id, socket.user.id);
    reply({ ok: asked, requested: true });
  });

  /* The Flow tab needs the step tree for a workflow this tab may never have
     opened (watching someone else's scheduled run). Serving it from the saved
     workflow means a watcher gets the same tree the run is executing. */
  socket.on('requestFlowTree', async ({ workflowId } = {}, ack) => {
    const reply = (v) => { if (typeof ack === 'function') { try { ack(v); } catch (_) {} } };
    try {
      const wf = await workflows.getForUser(Number(workflowId), socket.user.id);
      if (!wf) return reply({ ok: false });
      const steps = JSON.parse(wf.steps_json || '[]');
      const subflows = await resolveSubflows(steps, socket.user.id, Number(workflowId));
      reply({ ok: true, steps: buildFlowTree(steps, subflows, Number(workflowId)) });
    } catch (_) { reply({ ok: false }); }
  });

  // ── Highlight elements for compact workflow hover ────────
  socket.on('detectPagination', async () => {
    const page = await getActivePage();
    if (!page) { socket.emit('paginationDetected', { suggestions: [] }); return; }
    try {
      // ── Phase 1: high-confidence static DOM scan ───────────────────
      const staticResults = await page.evaluate(() => {
        const results = [];

        // ─── Helpers ──────────────────────────────────────────────
        const vis = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return false;
          const s = getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.05) return false;
          if (el.offsetParent === null && s.position !== 'fixed') return false;
          if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
          return true;
        };
        const txt = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        const stableSelector = (el) => {
          if (!el) return null;
          if (el.id) return '#' + CSS.escape(el.id);
          const safe = Array.from(el.classList).filter(c => !/\b(active|current|disabled|selected|focus|hover)\b/.test(c));
          if (safe.length) return el.tagName.toLowerCase() + '.' + safe[0];
          const rel = el.getAttribute('rel');
          if (rel) return `${el.tagName.toLowerCase()}[rel="${rel}"]`;
          const ariaLabel = el.getAttribute('aria-label');
          if (ariaLabel) return `[aria-label="${CSS.escape(ariaLabel)}"]`;
          return el.tagName.toLowerCase();
        };

        // Match "Next", "Next →", "Next page" — but NOT bare ">" (used everywhere
        // for breadcrumbs/expanders). Arrows ›»→ and ">>" are pagination-specific.
        const NEXT_TEXT_RE  = /^(?:next\b|forward\s*$|load\s+next\s*$|next\s+page\s*$)/i;
        const NEXT_ARROW_RE = /^(?:[›»→]+|>>+)\s*$/;
        // Non-English pagination labels, matched by CONTAINMENT rather than
        // anchored: most languages put the verb first ("Pokaż następne",
        // "Mehr laden", "Ver más"). Without these the detector finds no
        // next-link on an ordinary paginated page and falls back to guessing
        // infinite scroll — which then only ever collects the first page.
        const NEXT_I18N_RE = /(nast[eę]pn|dalej|weiter|n[aä]chste|siguiente|suivant|successiv|pr[oó]xim|volgende|dal[sš][ií]|след|дал[еі]|sonraki|次のページ|下一)/i;
        const isNextLike    = (s) => NEXT_TEXT_RE.test(s) || NEXT_ARROW_RE.test(s) || NEXT_I18N_RE.test(s);
        // Allow trailing words like "Load more posts" / "Show more results"
        const LOAD_MORE_RE  = /^(?:load|show|see|view)\s+(?:more|additional|all)(?:\s+\w+){0,3}\s*$|^more\s+(?:results?|items?|posts?)\s*$/i;
        const MORE_I18N_RE  = /(poka[zż]\s+wi[eę]cej|za[lł]aduj\s+wi[eę]cej|mehr\s+(?:laden|anzeigen)|ver\s+m[aá]s|cargar\s+m[aá]s|voir\s+plus|charger\s+plus|mostra\s+altri|carica\s+altri|meer\s+laden|показать\s+ещ[её]|zobrazit\s+dal[sš][ií])/i;

        // Verified pagination containers — strict enough to avoid "pagerduty",
        // "swiper-pagination" (carousel), or random nav menus.
        const PAGINATION_CONTAINER_SELECTOR = [
          'nav[aria-label*="page" i]:not([aria-label*="single" i])',
          'nav[aria-label*="paginat" i]',
          '[role="navigation"][aria-label*="page" i]',
          '[role="navigation"][aria-label*="paginat" i]',
          '[class~="pagination"]',
          '[class*="pagination" i]:not([class*="swiper" i]):not([class*="slider" i]):not([class*="carousel" i])',
          '[class~="pager"]',
          '[class~="page-numbers"]',
          '[class~="page-nav"]',
          '[class~="pagenav"]',
          // PrimeFaces/JSF-style widgets (e.g. "ui-paginator") — "paginator"
          // doesn't share the "pagination" substring so it needs its own rule.
          '[class*="paginator" i]:not([class*="carousel" i]):not([class*="slider" i])',
          'ul.pagination, ol.pagination, div.pagination',
        ].join(',');

        // Contexts where Next/Prev/More buttons are NOT pagination.
        const EXCLUDED_CONTEXT_SELECTOR = [
          '[class*="carousel" i]',
          '[class*="slider" i]:not([class*="page-slider" i])',
          '[class*="slideshow" i]',
          '[class*="gallery" i]',
          '[class*="lightbox" i]',
          '[class*="modal" i]',
          '[class*="dialog" i]',
          '[class*="popup" i]',
          '[class*="dropdown" i]',
          '[class*="megamenu" i], [class*="mega-menu" i]',
          '[class*="breadcrumb" i]',
          '[class*="accordion" i]',
          '[class*="swiper" i]',
          '[class*="splide" i]',
          '[class*="glide" i]',
          '[class*="owl-carousel" i], [class*="owl-nav" i]',
          '[class*="flickity" i]',
          '[class*="tns-" i]',
          '[class*="hero-" i], [class*="-hero" i]',
          '[class*="banner" i]',
          '[class*="testimonial" i]',
          '[role="tablist"]',
          '[role="dialog"]',
          '[role="alertdialog"]',
          '[role="menu"]',
          '[role="menubar"]',
          '[aria-roledescription*="carousel" i]',
          '[aria-roledescription*="slide" i]',
          'header',
          'footer',
          'aside',
        ].join(',');

        // True iff `el`'s nearest matching ancestor is an excluded context
        // (and no verified pagination container sits between).
        const isInExcludedContext = (el) => {
          if (!el) return true;
          let node = el.parentElement;
          while (node && node !== document.body && node !== document.documentElement) {
            if (node.matches && node.matches(PAGINATION_CONTAINER_SELECTOR)) return false;
            if (node.matches && node.matches(EXCLUDED_CONTEXT_SELECTOR))     return true;
            node = node.parentElement;
          }
          return false;
        };

        // A candidate must be visible AND not in an excluded context.
        const valid = (el) => vis(el) && !isInExcludedContext(el);

        // Does this container actually look like pagination? Rejects e.g.
        // <nav aria-label="single page"> with one stray link, or a year-filter list.
        const looksLikePagination = (container) => {
          if (!container) return false;
          const links = container.querySelectorAll('a,button,[role="button"]');
          if (links.length < 2) return false;
          let numeric = 0, nextish = 0;
          for (const a of links) {
            const t = txt(a);
            if (/^\d+$/.test(t))     numeric++;
            else if (isNextLike(t))  nextish++;
            else if (/^(?:prev|previous|back|‹|«|←)\b/i.test(t)) nextish++;
          }
          return numeric >= 2 || (numeric >= 1 && nextish >= 1) || nextish >= 2;
        };

        // 1. a[rel="next"] — unambiguous spec-level signal
        for (const el of document.querySelectorAll('a[rel="next"]')) {
          if (valid(el)) {
            results.push({ type: 'next_button', confidence: 0.97,
              selector: 'a[rel="next"]',
              previewText: txt(el) || 'Next',
              description: 'Explicit <a rel="next"> link found.' });
            break;
          }
        }

        // 2. Exact aria-label "Next" / "Next page" — filter out carousel/slider
        //    arrows (the most common false positive for this rule).
        if (!results.find(r => r.type === 'next_button')) {
          const candidates = document.querySelectorAll(
            '[aria-label="Next" i],[aria-label="Next page" i],[aria-label="Go to next page" i]'
          );
          for (const el of candidates) {
            if (!valid(el)) continue;
            results.push({ type: 'next_button', confidence: 0.93,
              selector: stableSelector(el),
              previewText: txt(el) || 'Next',
              description: 'Found an exact aria-label "Next" button.' });
            break;
          }
        }

        // 3. "Next*" text ONLY inside a verified pagination container
        if (!results.find(r => r.type === 'next_button')) {
          for (const container of document.querySelectorAll(PAGINATION_CONTAINER_SELECTOR)) {
            if (isInExcludedContext(container))   continue;
            if (!looksLikePagination(container))  continue;
            const el = Array.from(container.querySelectorAll('a,button,[role="button"]'))
              .find(e => isNextLike(txt(e)) && vis(e));
            if (el) {
              results.push({ type: 'next_button', confidence: 0.88,
                selector: stableSelector(el),
                previewText: txt(el),
                description: 'Found "Next" inside a confirmed pagination container.' });
              break;
            }
          }
        }

        // 3a. Class-name-only "next" indicator — covers icon-only buttons with
        //     no text and no aria-label, e.g. PrimeFaces/JSF
        //     `<a class="ui-paginator-next ...">` wrapping just a font-icon
        //     `<span>`. Requires the class itself to carry a pagination-y
        //     token ("pagin"/"pager"/"page-nav"), OR the element to sit
        //     inside a verified pagination container — either way a bare
        //     "next" class on its own (e.g. a carousel arrow) won't qualify.
        if (!results.find(r => r.type === 'next_button')) {
          const NEXT_CLASS_RE = /(?:^|[\s_-])next(?:[\s_-]|$)/i;
          const PAGY_CLASS_RE = /pagin|pager|page-?nav/i;
          const el = Array.from(document.querySelectorAll('a,button,[role="button"]')).find(e => {
            const cls = e.className && e.className.toString();
            if (!cls || !NEXT_CLASS_RE.test(cls)) return false;
            if (!PAGY_CLASS_RE.test(cls) && !e.closest(PAGINATION_CONTAINER_SELECTOR)) return false;
            return valid(e);
          });
          if (el) {
            results.push({ type: 'next_button', confidence: 0.85,
              selector: stableSelector(el),
              previewText: txt(el) || 'Next',
              description: 'Found a "next" pagination control identified by its class name.' });
          }
        }

        // 3b. URL-based pagination → NAVIGATION strategy. When the next page
        //     is just the current URL with a pagination number/param changed
        //     (…?page=2, ?p=2, /page/2, …/2), navigating page-by-page is far
        //     more reliable than chasing a "Next" button that may move or
        //     re-render. We build a URL TEMPLATE (the next-page URL split
        //     around the page number) and surface a dedicated `url_param`
        //     suggestion. Runs independently of the next-button blocks so the
        //     navigation option is offered even when a Next link also exists.
        {
          const here        = new URL(location.href);
          const pathMatch   = here.pathname.match(/\/(\d+)\/?$/);
          const PAGE_PARAMS = ['page','paged','pg','pagenum','pageno','pagenr','pageindex','p'];
          // Compound/cased param names like "i_page", "cur_page", "page_no",
          // "pageNum" — requires an explicit separator before "page" (or a
          // known numeric suffix after it) so it won't match unrelated words
          // like "homepage". Matched case-insensitively since URLSearchParams
          // keys are case-sensitive but real-world param casing varies.
          const COMPOUND_PAGE_PARAM_RE = /^[a-z0-9]+[-_]page(?:[-_]?(?:num|no|nr|index))?$|^page[-_]?(?:num|no|nr|index)$/i;
          const isPageParamKey = (name) => PAGE_PARAMS.includes(name.toLowerCase()) || COMPOUND_PAGE_PARAM_RE.test(name);
          const TOKEN       = '__PAGE__';

          let currentNum    = 1;
          let pageParamUsed = null;
          for (const [key, v] of here.searchParams.entries()) {
            if (isPageParamKey(key) && /^\d+$/.test(v)) { currentNum = parseInt(v, 10); pageParamUsed = key; break; }
          }
          if (pathMatch) currentNum = Math.max(currentNum, parseInt(pathMatch[1], 10));
          const nextNum  = currentNum + 1;
          const basePath = pathMatch ? here.pathname.slice(0, pathMatch.index) : here.pathname.replace(/\/$/, '');

          // Build a { before, after, mode, param } template, or leave null.
          let tmpl = null;
          let firstPageNum = null;   // page number the loop should start at

          // (1) Strongest signal: an anchor pointing at page N+1. Learn the
          //     param name / path style from it so the template is exact.
          const anchor = Array.from(document.querySelectorAll('a[href]')).find(el => {
            if (!valid(el)) return false;
            let u;
            try { u = new URL(el.getAttribute('href'), location.href); } catch { return false; }
            if (u.origin !== here.origin) return false;
            if (u.pathname === `${basePath}/${nextNum}` || u.pathname === `${basePath}/${nextNum}/`) return true;
            for (const [key, v] of u.searchParams.entries()) {
              if (!isPageParamKey(key) || parseInt(v, 10) !== nextNum) continue;
              // Bare `p=` is too generic — require pagination-like link text
              // unless the current URL is already using `p=` for paging.
              if (key.toLowerCase() === 'p' && (pageParamUsed || '').toLowerCase() !== 'p') {
                const t = txt(el);
                if (!isNextLike(t) && !/^\d+$/.test(t)) continue;
              }
              return true;
            }
            return false;
          });
          if (anchor) {
            const u = new URL(anchor.getAttribute('href'), location.href);
            let pname = null;
            for (const [key, v] of u.searchParams.entries()) {
              if (isPageParamKey(key) && parseInt(v, 10) === nextNum) { pname = key; break; }
            }
            if (pname) {
              u.searchParams.set(pname, TOKEN);
              const parts = u.href.split(TOKEN);
              tmpl = { before: parts[0], after: parts[1] || '', mode: 'query', param: pname };
            } else {
              tmpl = { before: here.origin + basePath + '/', after: (u.search || '') + (u.hash || ''), mode: 'path', param: null };
            }
          }

          // (1b) Any same-origin link carrying a page-like param with a HIGHER
          //      number than we're on — not just an exact next-page link. A site
          //      whose only visible page link is "?page=7", or whose next link
          //      is worded in a language the text matcher doesn't know, is still
          //      unambiguously paginated: the URL pattern is the proof. Without
          //      this the detector reported only "infinite scroll" on pages that
          //      plainly navigate by URL, and the scrape silently got page one.
          if (!tmpl) {
            // When the current URL carries NO page param we cannot assume we are
            // on page 1: plenty of sites treat the bare URL as page zero and
            // link onward to "?page=1" (lock.me does exactly this). Requiring
            // num > currentNum would reject that link and leave the page looking
            // unpaginated. With no param present, ANY page-numbered link proves
            // the pattern, so accept from 1 upward.
            const minNum = pageParamUsed ? currentNum + 1 : 1;
            let best = null, bestNum = Infinity;
            for (const el of document.querySelectorAll('a[href]')) {
              let u;
              try { u = new URL(el.getAttribute('href'), location.href); } catch { continue; }
              if (u.origin !== here.origin) continue;
              // Same document, different page number only.
              const samePath = u.pathname === here.pathname;
              for (const [key, v] of u.searchParams.entries()) {
                if (!isPageParamKey(key) || !/^\d+$/.test(v)) continue;
                const num = parseInt(v, 10);
                if (num < minNum) continue;
                // Bare `p=` stays restricted — too generic to trust on its own.
                if (key.toLowerCase() === 'p' && (pageParamUsed || '').toLowerCase() !== 'p') continue;
                if (!samePath && !isNextLike(txt(el)) && !/^\d+$/.test(txt(el))) continue;
                if (num < bestNum) { bestNum = num; best = { el, u, key, num }; }
              }
            }
            if (best) {
              const u = new URL(best.u.href);
              u.searchParams.set(best.key, TOKEN);
              const parts = u.href.split(TOKEN);
              tmpl = { before: parts[0], after: parts[1] || '', mode: 'query', param: best.key };
              // Loop from the number we actually found, not an assumed
              // currentNum + 1 — on an un-numbered base URL that is page 1.
              firstPageNum = best.num;
            }
          }

          // (2) Fallback: the current URL itself already carries an explicit
          //     page param (e.g. you're on ?page=1). Bare `p` only counts when
          //     we're already past page 1, to avoid hijacking unrelated `?p=`.
          if (!tmpl && pageParamUsed && (pageParamUsed.toLowerCase() !== 'p' || currentNum > 1)) {
            const u = new URL(here.href);
            u.searchParams.set(pageParamUsed, TOKEN);
            const parts = u.href.split(TOKEN);
            tmpl = { before: parts[0], after: parts[1] || '', mode: 'query', param: pageParamUsed };
          }

          if (tmpl) {
            const loopFrom = firstPageNum != null ? firstPageNum : nextNum;
            const sampleNextUrl = tmpl.before + loopFrom + tmpl.after;
            results.push({
              type: 'url_param', confidence: 0.96, selector: null,
              urlBefore: tmpl.before, urlAfter: tmpl.after,
              startPage: firstPageNum != null ? firstPageNum : currentNum,
              nextPage: loopFrom,
              paramName: tmpl.param, urlMode: tmpl.mode,
              previewText: sampleNextUrl,
              description: tmpl.param
                ? `Pages change "?${tmpl.param}=" in the URL — navigating ?${tmpl.param}=${loopFrom}, ${loopFrom + 1}, … is the most reliable strategy.`
                : `Pages change the URL path (…/${loopFrom}) — navigating page-by-page is the most reliable strategy.`,
            });
          }
        }

        // 4. Numbered pages inside a verified pagination container
        for (const container of document.querySelectorAll(PAGINATION_CONTAINER_SELECTOR)) {
          if (isInExcludedContext(container)) continue;
          const numLinks = Array.from(container.querySelectorAll('a,button'))
            .filter(e => /^\d+$/.test(txt(e)) && vis(e));
          if (numLinks.length < 2) continue;
          // Reject year-filter lists like "2018 / 2020 / 2024" and other
          // sparse non-pagination number runs.
          const nums = numLinks.map(e => parseInt(txt(e), 10)).sort((a, b) => a - b);
          const span = nums[nums.length - 1] - nums[0];
          if (nums[0] >= 1900 && nums[0] <= 2100) continue;   // years
          if (span > nums.length * 3) continue;               // too sparse

          const nextInNav = container.querySelector('a[rel="next"],[aria-label*="Next" i]')
            || Array.from(container.querySelectorAll('a,button,[role="button"]'))
                 .find(e => isNextLike(txt(e)) && vis(e));
          // When the visible page numbers don't start at 1 ("2, 3, 4, \u2026"),
          // we can't directly verify the current page from the numbers
          // alone \u2014 drop confidence slightly to flag the extra ambiguity.
          const startsAtOne = nums[0] === 1;
          results.push({ type: 'page_numbers', confidence: startsAtOne ? 0.91 : 0.85,
            selector: nextInNav ? stableSelector(nextInNav) : stableSelector(container),
            containerSelector: stableSelector(container),
            hasNextButton: !!nextInNav,
            previewText: numLinks.map(e => txt(e)).slice(0,5).join(', ') + '\u2026',
            description: `Found numbered pagination with ${numLinks.length} page links${startsAtOne ? '' : ` (visible starts at ${nums[0]})`}.` });
          break;
        }

        // 5. Load-more button — context-filtered AND located at/below the median
        //    repeating item. Real load-mores sit below a list, not in a sidebar
        //    widget, header banner, dropdown, or comment thread.
        const itemSel = 'li,article,[class*="item"],[class*="card"],[class*="result"],[class*="product"],[class*="post"]';
        const items   = Array.from(document.querySelectorAll(itemSel)).filter(vis);
        const itemMedianY = items.length
          ? items.map(e => e.getBoundingClientRect().top + window.scrollY).sort((a, b) => a - b)[Math.floor(items.length / 2)]
          : 0;

        const loadMoreEl = Array.from(document.querySelectorAll('a,button,[role="button"]'))
          .find(el => {
            if (!valid(el)) return false;
            if (!LOAD_MORE_RE.test(txt(el)) && !MORE_I18N_RE.test(txt(el))) return false;
            const y = el.getBoundingClientRect().top + window.scrollY;
            if (items.length > 2 && y < itemMedianY) return false;
            return true;
          });
        if (loadMoreEl) {
          results.push({ type: 'load_more', confidence: 0.90,
            selector: stableSelector(loadMoreEl),
            previewText: txt(loadMoreEl),
            description: 'Found a "Load More" button below the content.' });
        }

        // 6. Infinite-scroll library class/data markers — also context-filtered.
        const infScrollEl = Array.from(document.querySelectorAll(
          '[class*="infinite-scroll" i],[data-infinite],[data-infinite-scroll],[class*="endless-scroll" i],[data-infinite-loader],[class*="auto-pager" i]'
        )).find(el => !isInExcludedContext(el));
        if (infScrollEl) {
          results.push({ type: 'infinite_scroll', confidence: 0.88, selector: null,
            previewText: (infScrollEl.className || infScrollEl.tagName).toString().slice(0, 80),
            description: 'Found infinite-scroll library markers in the page DOM.' });
        }

        return results.sort((a, b) => b.confidence - a.confidence);
      });

      // ── Phase 2: empirical scroll test ─────────────────────────
      //   Require BOTH a substantial height increase AND more list items
      //   afterwards — lazy-loaded hero images alone shouldn't trigger this.
      const alreadyHasInfScroll = staticResults.some(r => r.type === 'infinite_scroll');
      if (!alreadyHasInfScroll) {
        const ITEM_SEL = 'li,article,[class*="item"],[class*="card"],[class*="result"],[class*="product"],[class*="post"]';
        const before = await page.evaluate((sel) => ({
          h: document.body.scrollHeight,
          n: document.querySelectorAll(sel).length,
        }), ITEM_SEL);
        await page.evaluate((sel) => {
          window.scrollTo(0, document.body.scrollHeight);
          const items = document.querySelectorAll(sel);
          if (items.length) items[items.length - 1].scrollIntoView({ block: 'end', behavior: 'instant' });
        }, ITEM_SEL);
        await new Promise(r => setTimeout(r, 2500));
        const after = await page.evaluate((sel) => ({
          h: document.body.scrollHeight,
          n: document.querySelectorAll(sel).length,
        }), ITEM_SEL);
        await page.evaluate(() => window.scrollTo(0, 0));
        const grew      = after.h - before.h > 300;
        const moreItems = after.n - before.n >= 3;
        if (grew && (moreItems || before.n === 0)) {
          staticResults.push({ type: 'infinite_scroll', confidence: 0.92, selector: null,
            previewText: `Page grew ${after.h - before.h}px and gained ${after.n - before.n} items`,
            description: 'Confirmed: new content loaded after scrolling to the bottom.' });
          staticResults.sort((a, b) => b.confidence - a.confidence);
        }
      }

      socket.emit('paginationDetected', { suggestions: staticResults });
    } catch(e) {
      socket.emit('paginationDetected', { suggestions: [], error: e.message });
    }
  });

  // ── Highlight elements for compact workflow hover ─────────────────────────
  // Stash the element's existing inline outline / box-shadow (value AND
  // priority — `!important` is lost otherwise) before overwriting, and
  // restore them on clear. This is what keeps a hovered-and-selected
  // element's selection border from vanishing when the hover ends.
  socket.on('highlightSelector', async ({ selector }) => {
    if (!selector) return;
    const page = await getActivePage();
    if (!page) return;
    try {
      await page.evaluate((sel) => {
        function restore(el) {
          const props = ['outline', 'outline-offset', 'box-shadow'];
          for (const p of props) {
            const key = 'scraperHl_' + p.replace(/-/g, '_');
            const prioKey = key + '_prio';
            if (el.dataset[key] !== undefined) {
              const v = el.dataset[key];
              const prio = el.dataset[prioKey] || '';
              if (v) el.style.setProperty(p, v, prio);
              else   el.style.removeProperty(p);
              delete el.dataset[key];
              delete el.dataset[prioKey];
            }
          }
          delete el.dataset.scraperHl;
        }
        document.querySelectorAll('[data-scraper-hl]').forEach(restore);

        const isXPath = sel.startsWith('/') || sel.startsWith('(');
        const getEls = (s) => isXPath
          ? (() => { const r = document.evaluate(s, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); return Array.from({length: r.snapshotLength}, (_, i) => r.snapshotItem(i)); })()
          : Array.from(document.querySelectorAll(s));
        try {
          getEls(sel).forEach(el => {
            // Save originals
            const save = (prop) => {
              const key = 'scraperHl_' + prop.replace(/-/g, '_');
              el.dataset[key]          = el.style.getPropertyValue(prop) || '';
              el.dataset[key + '_prio'] = el.style.getPropertyPriority(prop) || '';
            };
            save('outline'); save('outline-offset'); save('box-shadow');
            // Apply with !important so we visibly win even when the
            // selection tool has set its own !important outline.
            el.style.setProperty('outline', '2px solid #4f9cf9', 'important');
            el.style.setProperty('outline-offset', '1px', 'important');
            el.style.setProperty('box-shadow', '0 0 0 4px rgba(79,156,249,0.18)', 'important');
            el.dataset.scraperHl = '1';
          });
        } catch(e) {}
      }, selector);
    } catch(e) {}
  });

  socket.on('clearHighlight', async () => {
    const page = await getActivePage();
    if (!page) return;
    try {
      await page.evaluate(() => {
        const props = ['outline', 'outline-offset', 'box-shadow'];
        document.querySelectorAll('[data-scraper-hl]').forEach(el => {
          for (const p of props) {
            const key = 'scraperHl_' + p.replace(/-/g, '_');
            const prioKey = key + '_prio';
            if (el.dataset[key] !== undefined) {
              const v = el.dataset[key];
              const prio = el.dataset[prioKey] || '';
              if (v) el.style.setProperty(p, v, prio);
              else   el.style.removeProperty(p);
              delete el.dataset[key];
              delete el.dataset[prioKey];
            }
          }
          delete el.dataset.scraperHl;
        });
      });
    } catch(e) {}
  });

  // ── AI: propose EXTRACT_LIST fields from a sample container ──────────────
  // Captures the first matching container's cleaned outerHTML, asks the LLM
  // for structured field mappings, validates EVERY proposed selector
  // against the live DOM, and — for any gap (LLM unreachable, returned
  // junk, or didn't cover the obvious link/image/price fields) — runs an
  // in-browser heuristic detector so the user always gets at least
  // something usable.
  socket.on('aiExtractListFields', async ({ containerSelector, selectorType, hint, existingFields, requestId }) => {
    const tag = `[aiExtractListFields ${requestId || '?'}]`;
    const reply = (payload) => {
      // Log a one-line summary of every response so the dev can trace what
      // the user sees back to what we sent.
      const summary = payload.ok
        ? `ok fields=${(payload.fields || []).length} source=${payload.source || 'ai'} rejected=${(payload.rejected || []).length}`
        : `error code=${payload.code} msg=${(payload.error || '').slice(0, 200)}`;
      console.log(`${tag} replying → ${summary}`);
      socket.emit('aiExtractListFieldsResult', { requestId, ...payload });
    };

    if (!containerSelector || typeof containerSelector !== 'string') {
      return reply({ ok: false, error: 'containerSelector is required', code: 'NO_SELECTOR' });
    }

    const page = await getActivePage();
    if (!page) return reply({ ok: false, error: 'No active page — navigate to a URL first.', code: 'NO_PAGE' });

    // Guided-tour determinism: on the bundled DemoMart page, return a fixed,
    // instant "AI" result so the tour's Extract-with-AI step always works and
    // shows the same columns — no API key or live LLM needed.
    try {
      if (String(page.url() || '').includes('/demo/shop.html')) {
        return reply({
          ok: true, source: 'demo', name: 'Products',
          fields: [
            { name: 'title',  selector: '.title',       kind: 'text' },
            { name: 'price',  selector: '.price',       kind: 'text' },
            { name: 'rating', selector: '.rating',      kind: 'text' },
            { name: 'link',   selector: 'a.detail',     kind: 'attr', attribute: 'href' },
          ],
          rejected: [],
        });
      }
    } catch (_) { /* fall through to the real path */ }

    console.log(`${tag} container="${containerSelector}" type=${selectorType || 'css'} hint=${(hint || '').length}b existing=${Object.keys(existingFields || {}).length}`);

    // 1. Capture cleaned sample HTML for the first TWO containers. Showing the
    //    model two consecutive items makes the repeating structure obvious —
    //    it can tell which parts vary per item from the fixed template.
    let sample;
    try {
      sample = await page.evaluate((sel, type) => {
        const isXPath = type === 'xpath' || sel.startsWith('/') || sel.startsWith('(');
        const nodes = [];
        let count = 0;
        if (isXPath) {
          const all = document.evaluate(sel, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          count = all.snapshotLength;
          for (let i = 0; i < all.snapshotLength && nodes.length < 2; i++) nodes.push(all.snapshotItem(i));
        } else {
          const all = document.querySelectorAll(sel);
          count = all.length;
          for (let i = 0; i < all.length && nodes.length < 2; i++) nodes.push(all[i]);
        }
        if (!nodes.length) return { error: 'No element matched the container selector', count: 0 };

        const cleanOuter = (node) => {
          const clone = node.cloneNode(true);
          clone.querySelectorAll('script, style, noscript, link, meta, template, svg').forEach(n => n.remove());
          clone.querySelectorAll('*').forEach(el => {
            for (const a of Array.from(el.attributes || [])) {
              if (a.name.startsWith('on')) el.removeAttribute(a.name);
              if (a.name === 'src' && /^data:/i.test(a.value)) el.setAttribute('src', '[data-uri-removed]');
            }
          });
          let html = clone.outerHTML || '';
          // Cap each item so two of them still fit comfortably in the prompt.
          if (html.length > 15000) html = html.slice(0, 15000) + '...[truncated]';
          return html;
        };

        const htmls = nodes.map(cleanOuter);
        // Keep `html` (first item) for backward-compatible callers / logging.
        return { html: htmls[0], htmls, count };
      }, containerSelector, selectorType || 'css');
    } catch (err) {
      console.warn(`${tag} failed to capture sample HTML: ${err.message}`);
      return reply({ ok: false, error: `Failed to read sample: ${err.message}`, code: 'EVAL_FAIL' });
    }

    if (!sample || sample.error) {
      return reply({ ok: false, error: sample?.error || 'No sample captured', code: 'NO_SAMPLE' });
    }
    const sampleBytes = (sample.htmls || [sample.html]).reduce((n, h) => n + (h ? h.length : 0), 0);
    console.log(`${tag} captured ${(sample.htmls || [sample.html]).length} sample item(s) (${sampleBytes}b total, ${sample.count} sibling container(s))`);

    // ── Helper: verify a list of proposed fields against the live DOM,
    //    returning surviving ones with sample values + a hitCount across
    //    up to 5 sibling containers.
    //
    //    Self-fallback: when a selector doesn't match any descendant but
    //    the container itself matches it (common for the LLM proposing
    //    "a" as a selector when the container IS the anchor), we accept
    //    the field and rewrite its selector to "" so the saved workflow
    //    uses the correct "container itself" form going forward.
    const verifyOnLivePage = async (fields) => {
      if (!fields || fields.length === 0) return { verified: [], rejected: [], totalMatched: sample.count };
      return page.evaluate((containerSel, type, fieldsIn) => {
        // A field selector may be CSS or a container-relative XPath (leading
        // '/', './', '//', './/' or '('). Resolve either against a root.
        const fieldIsXPath = (s) => { if (typeof s !== 'string') return false; s = s.replace(/^\s+/, ''); return s[0] === '/' || s[0] === '(' || (s[0] === '.' && s[1] === '/'); };
        const relTarget = (root, s) => {
          if (!s) return root;
          if (fieldIsXPath(s)) return document.evaluate(s, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          return root.querySelector(s);
        };
        const isXPath = type === 'xpath' || containerSel.startsWith('/') || containerSel.startsWith('(');
        let containers = [];
        if (isXPath) {
          const r = document.evaluate(containerSel, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let i = 0; i < r.snapshotLength; i++) containers.push(r.snapshotItem(i));
        } else {
          containers = Array.from(document.querySelectorAll(containerSel));
        }
        const c0 = containers[0];
        const verified = [], rejected = [];
        for (const fOrig of fieldsIn) {
          let f = fOrig;
          let target0 = null;
          let rescuedToSelf = false;
          try {
            if (!f.selector) {
              target0 = c0;
            } else {
              target0 = relTarget(c0, f.selector);
              // The "container is itself the target" rescue only applies to CSS
              // (an XPath is already free to select the container via `.`).
              if (!target0 && !fieldIsXPath(f.selector) && c0.matches && c0.matches(f.selector)) {
                // Selector targets a descendant of the same shape as the
                // container itself — rescue by treating the container as
                // the target. Common with anchor-container scrape lists.
                target0 = c0;
                rescuedToSelf = true;
              }
            }
          } catch (e) {
            rejected.push({ ...f, reason: 'invalid selector: ' + e.message });
            continue;
          }
          if (!target0) {
            rejected.push({ ...f, reason: 'selector did not match in the first container' });
            continue;
          }
          if (rescuedToSelf) {
            // Rewrite the selector to the canonical "" so the saved step
            // matches what the codegen / preview do.
            f = { ...f, selector: '', rescuedToSelf: true };
          }
          let sampleValue = null;
          try {
            if (f.kind === 'attr' && f.attribute) sampleValue = target0.getAttribute(f.attribute);
            else if (f.kind === 'html') sampleValue = (target0.innerHTML || '').slice(0, 400);
            else sampleValue = (target0.textContent || '').trim().slice(0, 400);
          } catch (_) {}
          let hitCount = 0;
          for (const c of containers.slice(0, 5)) {
            try {
              const candidate = f.selector
                ? (relTarget(c, f.selector) || (!fieldIsXPath(f.selector) && c.matches && c.matches(f.selector) ? c : null))
                : c;
              if (candidate) hitCount++;
            } catch (_) {}
          }
          verified.push({ ...f, sampleValue, hitCount, surveyed: Math.min(containers.length, 5) });
        }
        return { verified, rejected, totalMatched: containers.length };
      }, containerSelector, selectorType || 'css', fields).catch(err => ({ error: err.message }));
    };

    // 2. Call the LLM.
    const aiResult = await extractListAI.proposeFields({
      sampleHtml: sample.html,
      sampleHtmls: Array.isArray(sample.htmls) ? sample.htmls : undefined,
      userHint: typeof hint === 'string' ? hint : '',
      existingFields: existingFields && typeof existingFields === 'object' ? existingFields : null,
      requestId: requestId || '?',
    });

    // 3. Verify LLM proposals (if any) against the live page.
    let aiVerified = [];
    let aiRejected = [];
    let aiExplanation = aiResult.explanation || '';
    let aiCode = null;
    let aiError = null;
    if (aiResult.ok) {
      const v = await verifyOnLivePage(aiResult.fields);
      if (v && !v.error) {
        aiVerified = v.verified || [];
        aiRejected = v.rejected || [];
        console.log(`${tag} AI: ${aiVerified.length} verified, ${aiRejected.length} rejected after live check`);
      } else {
        console.warn(`${tag} live verification of AI fields failed: ${v?.error}`);
        aiVerified = aiResult.fields.map(f => ({ ...f, sampleValue: null, hitCount: 0, surveyed: 0, source: 'ai' }));
      }
      // Tag survivors as coming from the AI
      aiVerified = aiVerified.map(f => ({ ...f, source: f.source || 'ai' }));
    } else {
      aiCode  = aiResult.code;
      aiError = aiResult.error;
      console.warn(`${tag} AI call did not produce fields: ${aiCode} — ${aiError}`);
    }

    // 4. ALWAYS run the heuristic detector. Even when the AI succeeds, it
    //    may have missed the obvious link / image / price. We then merge
    //    AI + heuristic with two pieces of cleverness:
    //
    //    a) Intent rescue. If an AI field was REJECTED (its selector
    //       didn't match) and a heuristic field exists with the same
    //       kind+attribute (e.g. AI wanted `exam_url` with selector "a"
    //       and attr=href, heuristic found `link` with selector="" attr=
    //       href), we move the heuristic's selector under the AI's name.
    //       Net effect: the user keeps the better name they implied, but
    //       it actually works.
    //
    //    b) Sample-value dedup. After verification we know what value
    //       each field would return. If a heuristic field's
    //       (kind, attribute, sampleValue) is identical to an AI field's,
    //       it's the same data — drop the heuristic version so we don't
    //       end up with both `exam_code` and `code` returning the same
    //       text.
    const heuristic = await extractListHeuristics.proposeFromContainer(
      page, containerSelector, selectorType || 'css',
      { requestId, maxFields: 10 }
    );

    // ── (a) Intent rescue ─────────────────────────────────────────────
    const heuristicByIntent = new Map();   // 'kind|attribute' → field
    for (const h of heuristic.fields || []) {
      heuristicByIntent.set(`${h.kind}|${h.attribute || ''}`, h);
    }
    const rescuedFromHeuristics = new Set();   // field names taken over
    const stillRejected = [];
    for (const r of aiRejected) {
      const key = `${r.kind}|${r.attribute || ''}`;
      const h = heuristicByIntent.get(key);
      if (h && !aiVerified.some(v => v.name === r.name)) {
        const rescued = {
          ...r,
          selector: h.selector,
          sampleValue: h.sampleValue,
          hitCount:   h.hitCount,
          surveyed:   h.surveyed,
          source:     'ai+heuristic',
          rescueNote: `Used the heuristic's working selector under the AI's name (original AI selector "${r.selector}" matched no descendant).`,
        };
        aiVerified.push(rescued);
        rescuedFromHeuristics.add(h.name);
        console.log(`${tag} rescued AI field "${r.name}" (kind=${r.kind}${r.attribute ? ',attr=' + r.attribute : ''}) by adopting heuristic's selector "${h.selector}"`);
      } else {
        stillRejected.push(r);
      }
    }
    aiRejected = stillRejected;

    // ── (b) Sample-value + selector dedup ────────────────────────────
    const usedNames = new Set(aiVerified.map(f => f.name));
    if (existingFields && typeof existingFields === 'object') {
      for (const n of Object.keys(existingFields)) usedNames.add(n);
    }
    // Sample-value fingerprint: kind + attribute + first-200-chars of sample
    const sigOf = (f) => `${f.kind}|${f.attribute || ''}|${(f.sampleValue || '').slice(0, 200)}`;
    const usedSignatures = new Set(aiVerified.map(sigOf));
    // Also dedupe heuristic results vs themselves (already done inside the
    // service, but cheap to repeat here when intent rescue pulled one out).

    const heuristicAdditions = [];
    const droppedHeuristics = [];
    for (const f of heuristic.fields || []) {
      if (rescuedFromHeuristics.has(f.name)) continue;       // already adopted under an AI name
      if (usedNames.has(f.name)) {
        droppedHeuristics.push({ name: f.name, reason: 'name already used by an AI field or existing one' });
        continue;
      }
      const sig = sigOf(f);
      if (usedSignatures.has(sig)) {
        droppedHeuristics.push({ name: f.name, reason: 'same value already extracted by another field' });
        continue;
      }
      usedNames.add(f.name);
      usedSignatures.add(sig);
      heuristicAdditions.push({ ...f, source: 'heuristic' });
    }
    if (droppedHeuristics.length) {
      console.log(`${tag} dropped ${droppedHeuristics.length} heuristic field(s): ${droppedHeuristics.map(d => `${d.name} (${d.reason})`).join('; ')}`);
    }

    const combined = [...aiVerified, ...heuristicAdditions];

    if (combined.length === 0) {
      // Nothing from AI, nothing from heuristics. Surface AI's error to
      // the user — that's the most useful signal.
      if (aiCode) {
        return reply({ ok: false, error: aiError, code: aiCode, sampleCount: sample.count });
      }
      return reply({
        ok: false,
        error: 'No fields could be identified on this page. Open the step editor and add fields manually.',
        code: 'NO_FIELDS',
        sampleCount: sample.count,
      });
    }

    // Build a one-liner of where each field came from. ai+heuristic =
    // an AI-named field whose selector was broken and got rescued by
    // adopting the heuristic detector's selector.
    const pureAiCount  = combined.filter(f => f.source === 'ai').length;
    const rescueCount  = combined.filter(f => f.source === 'ai+heuristic').length;
    const heuCount     = combined.filter(f => f.source === 'heuristic').length;
    const aiCount      = pureAiCount + rescueCount;

    let explanation = aiExplanation;
    const parts = [];
    if (!aiResult.ok && heuCount > 0) {
      parts.push(`AI returned no usable fields (${aiCode}: ${aiError}). Using ${heuCount} field${heuCount === 1 ? '' : 's'} from the built-in heuristic detector instead — review and re-run AI with a more specific hint if you want more.`);
    } else {
      if (explanation) parts.push(explanation);
      if (rescueCount > 0) {
        parts.push(`${rescueCount} AI field${rescueCount === 1 ? "'s" : "s'"} selector didn't match the live DOM and was rescued by adopting the heuristic detector's working selector under the AI-suggested name.`);
      }
      if (heuCount > 0 && aiResult.ok) {
        parts.push(`Added ${heuCount} extra field${heuCount === 1 ? '' : 's'} from the heuristic detector that the AI didn't cover.`);
      }
    }
    explanation = parts.join(' ');

    return reply({
      ok: true,
      fields: combined,
      rejected: aiRejected,
      explanation,
      // Title Case name for the whole list/table — the frontend applies it as
      // the step label automatically so the user doesn't have to name it.
      name: (aiResult && aiResult.ok && aiResult.name) ? aiResult.name : '',
      sampleCount: sample.count,
      source: aiCount > 0 && heuCount > 0 ? 'mixed' : (heuCount > 0 ? 'heuristic' : 'ai'),
      aiOk: aiResult.ok,
      aiError: aiResult.ok ? null : aiError,
      aiCode: aiResult.ok ? null : aiCode,
    });
  });

  socket.on('downloadCode', async (data) => {
    /*
      data = { steps, meta? }
      Response: codeReady { code: string }
    */
    try {
      const meta = data.meta || userSessionMeta.get(userId) || {};
      const steps = data.steps || [];
      // resolveCustomActions / resolveSubflows are async (DB-backed) — they
      // MUST be awaited. Passing the unresolved Promises to generateCode made
      // every custom-action step emit a "not available" throw and silently
      // dropped subflows from the downloaded script.
      const customActions = await resolveCustomActions(steps, socket.user.id);
      const subflows = await resolveSubflows(steps, socket.user.id, data.workflowId || null);
      // clean: true → strip platform-only instrumentation (step/iteration
      // log markers + self-healing snapshots) so the downloaded script is
      // short and readable.
      const workflow = { id: data.workflowId, steps, meta, customActions, subflows };
      const code = generateCode(workflow, { clean: true });
      // Ship a tailored README alongside the script so a downloaded workflow
      // is self-explanatory (how to run it, where to make changes).
      let readme = null;
      try { readme = generateReadme(workflow); } catch (_) {}
      socket.emit('codeReady', { code, readme });
    } catch (err) {
      socket.emit('message', `❌ Code generation error: ${err.message}`);
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────────

  // ── Preview step ─────────────────────────────────────────────────────────
  socket.on('previewStep', async ({ stepId, type, params, containerSelector }) => {
    const page = await getActivePage();
    if (!page) return;
    try {
      const selector = params?.selector || params?.containerSelector || '';

      // ── EXTRACT_LIST: run the configured fields against the first N
      //    matched containers and return tabular rows. This is what the
      //    Data Preview tab shows live as the user edits fields.
      if (type === 'EXTRACT_LIST') {
        const sel = params?.containerSelector || '';
        if (!sel) return;
        const fields = params?.fields && typeof params.fields === 'object' ? params.fields : {};
        const rows = await page.evaluate((containerSel, fieldsObj) => {
          // Field selectors (and the container) may be CSS or XPath. XPath is
          // recognised by a leading '/', './', '//', './/' or '('.
          const fieldIsXPath = (s) => { if (typeof s !== 'string') return false; s = s.replace(/^\s+/, ''); return s[0] === '/' || s[0] === '(' || (s[0] === '.' && s[1] === '/'); };
          const relTarget = (root, s) => {
            if (!s) return root;
            if (fieldIsXPath(s)) return document.evaluate(s, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            return root.querySelector(s);
          };
          const isXPath = containerSel.startsWith('/') || containerSel.startsWith('(');
          const getEls = (s) => {
            if (isXPath) {
              const r = document.evaluate(s, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
              return Array.from({ length: r.snapshotLength }, (_, i) => r.snapshotItem(i));
            }
            return Array.from(document.querySelectorAll(s));
          };
          let containers = [];
          try { containers = getEls(containerSel); } catch (_) { return { error: 'invalid container selector' }; }
          const rows = containers.slice(0, 25).map(c => {
            const row = {};
            for (const [name, spec] of Object.entries(fieldsObj)) {
              try {
                const normalized = typeof spec === 'string'
                  ? { selector: spec, kind: 'text', attribute: null }
                  : { selector: spec.selector || '', kind: spec.kind || 'text', attribute: spec.attribute || null };
                const childSel = normalized.selector;
                const target = relTarget(c, childSel);
                if (!target) { row[name] = null; continue; }
                if (normalized.kind === 'attr' && normalized.attribute) {
                  row[name] = target.getAttribute(normalized.attribute);
                } else if (normalized.kind === 'html') {
                  row[name] = (target.innerHTML || '').trim();
                } else {
                  row[name] = (target.textContent || '').trim();
                }
              } catch (_) {
                row[name] = null;
              }
            }
            return row;
          });
          return { rows, totalMatched: containers.length };
        }, sel, fields).catch(() => ({ error: 'preview failed' }));
        // Apply each field's clean/split pipeline so the live preview shows
        // exactly what the executed workflow will produce (cleaned values and
        // any columns a field was split into).
        let previewRows = rows?.rows || [];
        try { previewRows = previewRows.map(r => __ftMaterializeRow(r, fields)); } catch (_) {}
        socket.emit('previewResult', {
          stepId,
          previewRows,
          totalMatched: rows?.totalMatched || 0,
          previewError: rows?.error || null,
        });
        return;
      }

      // ── EXTRACT_TABLE: parse the targeted <table> into headers + rows so the
      //    Data Preview tab can render it as a real grid (matching the final
      //    extracted shape) instead of mashing every cell into one string.
      if (type === 'EXTRACT_TABLE') {
        const tableSel  = params?.selector || 'table';
        const hasHeader = params?.hasHeader !== false;
        const data = await page.evaluate((sel, hasHeaderFlag) => {
          const isXPath = sel.startsWith('/') || sel.startsWith('(');
          let table = null;
          try {
            if (isXPath) {
              const r = document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
              table = r.singleNodeValue;
            } else {
              table = document.querySelector(sel);
            }
          } catch (_) { return { error: 'invalid table selector' }; }
          if (!table) return { error: 'no element matched' };
          // The selector may point at a cell/wrapper rather than the <table>.
          // Resolve to the nearest enclosing table, or the first descendant.
          if (table.tagName !== 'TABLE') {
            table = (table.closest && table.closest('table')) || table.querySelector('table');
          }
          if (!table) return { error: 'no table found' };
          const allRows = Array.from(table.querySelectorAll('tr'));
          let headers = [];
          let bodyRows = allRows;
          if (hasHeaderFlag && allRows.length > 0) {
            headers = Array.from(allRows[0].querySelectorAll('th,td')).map(c => (c.textContent || '').trim());
            bodyRows = allRows.slice(1);
          }
          const cells = bodyRows.slice(0, 50).map(row =>
            Array.from(row.querySelectorAll('td,th')).map(c => (c.textContent || '').trim())
          );
          return { headers, rows: cells, totalRows: bodyRows.length, hasHeader: hasHeaderFlag };
        }, tableSel, hasHeader).catch(() => ({ error: 'preview failed' }));
        socket.emit('previewResult', {
          stepId,
          previewTable: data && !data.error ? data : null,
          previewError: data?.error || null,
        });
        return;
      }

      // ── Shared helpers (serialisable — passed into page.evaluate) ──────────
      // Detect XPath: starts with / or ( (e.g. (//div...)[1] pattern)
      // queryAll: returns array of elements using CSS or XPath as appropriate
      // extractValue: extracts the right value from an element given action type

      // FOR_EACH — return all matched container elements
      if (type === 'FOR_EACH_ELEMENTS' || type === 'FOR_EACH') {
        if (!selector) return;
        const elements = await page.evaluate((sel) => {
          const isXPath = sel.startsWith('/') || sel.startsWith('(');
          const getEls = (s, ctx) => {
            if (isXPath) {
              const result = document.evaluate(s, ctx || document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
              return Array.from({ length: result.snapshotLength }, (_, i) => result.snapshotItem(i));
            }
            return Array.from((ctx || document).querySelectorAll(s));
          };
          try {
            return getEls(sel).map(el => ({
              text:  el.innerText?.trim() || el.textContent?.trim() || '',
              href:  el.href   || el.getAttribute('href')  || '',
              src:   el.src    || el.getAttribute('src')   || '',
              alt:   el.alt    || el.getAttribute('alt')   || '',
              value: el.value  || el.getAttribute('value') || '',
            }));
          } catch(e) { return []; }
        }, selector);
        socket.emit('previewResult', { stepId, previewElements: elements });
        return;
      }

      if (!selector) return;
      const multiple  = !!(params && params.multiple);
      const attribute = (params && params.attribute) || '';

      // Scoped sub-query within each container row
      if (containerSelector) {
        const values = await page.evaluate((containerSel, subSel, type, attribute) => {
          const isXPathContainer = containerSel.startsWith('/') || containerSel.startsWith('(');
          const isXPathSub       = subSel.startsWith('/') || subSel.startsWith('(');
          const getEls = (sel, ctx, isXP) => {
            if (isXP) {
              const r = document.evaluate(sel, ctx || document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
              return Array.from({ length: r.snapshotLength }, (_, i) => r.snapshotItem(i));
            }
            return Array.from((ctx || document).querySelectorAll(sel));
          };
          const extract = (el) => {
            switch (type) {
              case 'EXTRACT_ATTRIBUTE': return attribute ? el.getAttribute(attribute) : (el.href || el.src || el.getAttribute('href') || '');
              case 'EXTRACT_HTML':      return el.innerHTML?.trim() || '';
              case 'EXTRACT_LIST':      return Array.from(el.querySelectorAll('li,option')).map(i => i.innerText?.trim()).filter(Boolean).join(' | ');
              default:                  return el.innerText?.trim() || el.textContent?.trim() || '';
            }
          };
          try {
            const containers = getEls(containerSel, null, isXPathContainer);
            return containers.map(container => {
              const candidates = getEls(subSel, isXPathSub ? document : container, isXPathSub);
              // For XPath sub-selectors the query runs on document; filter to descendants
              const el = isXPathSub
                ? candidates.find(c => container.contains(c)) || null
                : (container.matches(subSel) ? container : candidates[0] || null);
              return el ? extract(el) : null;
            });
          } catch(e) { return []; }
        }, containerSelector, selector, type, attribute);
        if (values && values.length > 0) {
          socket.emit('previewResult', { stepId, previewValues: __ftCleanAny(values, params?.transforms) });
          return;
        }
      }

      // Full-page query — standalone extraction steps
      const result = await page.evaluate((sel, type, multiple, attribute) => {
        const isXPath = sel.startsWith('/') || sel.startsWith('(');
        const getEls = (s) => {
          if (isXPath) {
            const r = document.evaluate(s, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            return Array.from({ length: r.snapshotLength }, (_, i) => r.snapshotItem(i));
          }
          return Array.from(document.querySelectorAll(s));
        };
        const extract = (el) => {
          switch (type) {
            case 'EXTRACT_ATTRIBUTE': return attribute ? el.getAttribute(attribute) : (el.href || el.src || el.getAttribute('href') || '');
            case 'EXTRACT_HTML':      return el.innerHTML?.trim() || '';
            case 'EXTRACT_LIST':      return Array.from(el.querySelectorAll('li,option')).map(i => i.innerText?.trim()).filter(Boolean).join(' | ');
            default:                  return el.innerText?.trim() || el.textContent?.trim() || '';
          }
        };
        try {
          const els = getEls(sel);
          if (!els.length) return null;
          const targets = multiple ? els : [els[0]];
          // Values are joined for display AFTER cleaning (below), so return
          // the raw list here rather than a pre-joined string.
          return multiple ? targets.map(extract) : extract(targets[0]);
        } catch(e) { return null; }
      }, selector, type, multiple, attribute);

      if (result !== null) {
        // Apply the step's clean pipeline so the preview shows exactly what
        // the executed workflow will store — the single-value counterpart of
        // the __ftMaterializeRow call on the EXTRACT_LIST branch above.
        const cleaned = __ftCleanAny(result, params?.transforms);
        const display = Array.isArray(cleaned)
          ? cleaned.map(v => (v == null ? '' : String(v))).join(' | ')
          : String(cleaned == null ? '' : cleaned);
        socket.emit('previewResult', { stepId, previewValue: display });
      } else {
        socket.emit('previewResult', { stepId, notFound: true });
      }
    } catch(err) { /* silent — preview is best-effort */ }
  });

  // ── API discovery: analyze captured network traffic ──────────────────────
  // Mirrors the detectPagination flow: run heuristics over the passively
  // captured XHR/fetch records, verify the top candidates by replay, and emit
  // ranked "API sources" the user could use instead of scraping the DOM.
  //   data.sampleValues : string[]  values the user is scraping (from previews /
  //                                  selection). Empty → structure-only scoring.
  //   data.verify       : boolean    replay-verify the top sources (default on).
  socket.on('analyzeApiSources', async (data = {}) => {
    try {
      const records = networkCapture.getRecords(userId);
      const sampleValues = Array.isArray(data.sampleValues)
        ? data.sampleValues.filter((v) => typeof v === 'string' && v.trim()).slice(0, 60)
        : [];
      const { sources, capturedCount, consideredCount } = apiDiscovery.analyze(records, { sampleValues });

      // Replay-verify the top few. The session probe needs the browser's
      // cookies for the current page; verifyMany is time-boxed and best-effort.
      if (data.verify !== false && sources.length) {
        let cookies = [];
        const page = await getActivePage();
        if (page) { try { cookies = await page.cookies(); } catch (_) {} }
        await apiReplay.verifyMany(sources, { sampleValues, cookies }).catch(() => {});
      }

      socket.emit('apiSourcesDetected', { sources, capturedCount, consideredCount, aiAvailable: apiDiscoveryAI.isAvailable() });
    } catch (err) {
      socket.emit('apiSourcesDetected', { sources: [], error: err.message, capturedCount: 0, aiAvailable: apiDiscoveryAI.isAvailable() });
    }
  });

  socket.on('clearApiCapture', () => { try { networkCapture.clear(userId); } catch (_) {} });

  // On-demand AI enrichment for one discovered source (friendly name/summary +
  // field labels). Optional — the deterministic detection stands on its own.
  socket.on('enrichApiSource', async (data = {}) => {
    const source = data && data.source;
    if (!source || !source.id) return;
    try {
      const out = await apiDiscoveryAI.enrich(source, { requestId: source.id });
      if (out.ok) socket.emit('apiSourceEnriched', { id: source.id, ai: out.ai });
      else socket.emit('apiSourceEnriched', { id: source.id, error: out.error || out.code });
    } catch (err) {
      socket.emit('apiSourceEnriched', { id: source.id, error: err.message });
    }
  });

  socket.on('disconnect', () => {
    console.log(`🔌 User disconnected: ${userId}`);
    if (stopStreaming) { try { stopStreaming(); } catch (_) {} }
    userSessions.delete(userId);
    scraperService.clearUser(userId);
    // Release the network-capture CDP session. The page can outlive the socket
    // (SPA refresh), but the capture is cheap to re-attach on the next
    // navigate, and detaching here avoids leaking a CDP session per reconnect.
    networkCapture.detach(userId).catch(() => {});
    // Note: we deliberately don't touch modeReapplyListeners here — the
    // puppeteer page can outlive the socket (SPA refresh) and the hook is
    // still useful on the next navigate. The listener gets replaced cleanly
    // when navigate runs again.
  });
});

// Start the schedule dispatcher so any active schedules in the DB fire
// even without an open socket. Polls every 30s; see scheduler.service.js.
const scheduler = require('./services/scheduler.service');
// Background executor for API-triggered runs: picks up runs enqueued by the
// public POST /v1/workflows/:id/runs endpoint. See apiWorker.service.js.
const apiWorker = require('./services/apiWorker.service');
// Periodic retention/pruning so run_logs + results_json don't grow forever.
const maintenance = require('./services/maintenance.service');
const dbClient  = require('./db/client');

// Provision the schema / apply migrations on the async data layer before we
// accept traffic. On SQLite this is a near-instant no-op (tables already
// exist); on Postgres it creates the schema on first boot.
dbClient.init()
  .then(async () => {
    // ADMIN_USERNAMES (comma-separated) is the single source of truth for
    // who can manage the shared/platform proxy pool — see
    // db/repositories/users.repo.js and routes/proxies.routes.js.
    if (process.env.ADMIN_USERNAMES) {
      const users = require('./db/repositories/users.repo');
      await users.syncAdminsFromUsernames(process.env.ADMIN_USERNAMES.split(','));
    }
    // BEFORE the schedulers: recover runs left "running" by a process that is
    // gone, so a restart clears stuck runs immediately rather than leaving
    // them spinning forever with a Cancel button that can't reach anything.
    runReaper.start();
    scheduler.start();
    apiWorker.start();
    maintenance.start();
    // Bind to localhost by default so a fresh local install isn't reachable
    // from the LAN. Set HOST=0.0.0.0 to expose it deliberately.
    const HOST = process.env.HOST || '127.0.0.1';
    server.listen(PORT, HOST, () => console.log(`🚀 Server running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
  })
  .catch((err) => {
    console.error('[db] initialisation failed — server not started:', err);
    process.exit(1);
  });