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
const { generateCode }    = require('./workflow/workflowCodegen');
const { verifyToken }    = require('./middleware/auth');
const db                 = require('./db');

// Walk a workflow's step tree and collect referenced custom action ids,
// then fetch the user-owned definitions from the DB and return them as a
// { [id]: { name, inputs, outputs, code } } map for codegen.
function resolveCustomActions(steps, userId) {
  const ids = new Set();
  (function walk(arr) {
    for (const s of arr || []) {
      if (s && s.kind === 'action' && s.type === 'CUSTOM_ACTION') {
        const id = s.params && s.params.actionId;
        if (id != null) ids.add(id);
      }
      ['body', 'then', 'else', 'try', 'catch'].forEach(k => {
        if (Array.isArray(s?.[k])) walk(s[k]);
      });
    }
  })(steps);

  if (ids.size === 0) return {};
  const placeholders = Array.from(ids).map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, name, inputs_json, outputs_json, code
     FROM custom_actions
     WHERE user_id = ? AND id IN (${placeholders})`
  ).all(userId, ...ids);
  const out = {};
  for (const r of rows) {
    out[r.id] = {
      name: r.name,
      inputs:  JSON.parse(r.inputs_json  || '[]'),
      outputs: JSON.parse(r.outputs_json || '[]'),
      code: r.code || '',
    };
  }
  return out;
}

const PORT = process.env.PORT || 3001;

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

// Active CDP sessions per user
const userSessions = new Map();

// Track last-known session config per user (startUrl, viewport) for code generation
const userSessionMeta = new Map();

// Per-user `framenavigated` listener so we can detach the previous one
// before attaching a new one (e.g. across SPA reconnects on the same page).
// Without this, every call to navigate would stack another listener.
const modeReapplyListeners = new Map();

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
        socket.emit('browserEvent', event);
      });
      await browserManager.ensureBinding(userId, 'sendCursorType', (cursorType) => {
        socket.emit('cursorType', { cursor: cursorType });
      });
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

  // ── Reset selection ───────────────────────────────────────────────────────
  socket.on('resetSelection', async () => {
    try {
      const page = await getActivePage();
      if (page) await page.evaluate(() => { if (typeof window.__resetSelection__ === 'function') window.__resetSelection__(); });
    } catch (_) {}
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
      const page = await browserManager.getPage(userId);

      // Re-apply the user's last-set mode whenever the page navigates
      // (link click, redirect, history nav). evaluateOnNewDocument resets
      // window.__SELECTION_MODE__ to false on every new document, so without
      // this hook the user would have to toggle Select → Navigate → Select
      // to recover their mode after each page change.
      const prevHook = modeReapplyListeners.get(userId);
      if (prevHook) { try { page.off('framenavigated', prevHook); } catch (_) {} }
      const hook = async (frame) => {
        if (frame !== page.mainFrame()) return;
        const mode = scraperService.getMode(userId);
        try {
          await page.evaluate((m) => { window.__SELECTION_MODE__ = m === 'selection'; }, mode);
        } catch (_) {}
      };
      modeReapplyListeners.set(userId, hook);
      page.on('framenavigated', hook);

      // ─────────────────────────────────────────────────────────────
      // BYPASS CSP (must happen BEFORE goto)
      // ─────────────────────────────────────────────────────────────
      await page.setBypassCSP(true);

      // ─────────────────────────────────────────────────────────────
      // Node bindings
      // ─────────────────────────────────────────────────────────────
      await browserManager.ensureBinding(userId, 'sendToNode', (event) => {
        socket.emit('browserEvent', event);
      });

      await browserManager.ensureBinding(userId, 'sendCursorType', (cursorType) => {
        socket.emit('cursorType', { cursor: cursorType });
      });

      const viewportWidth  = data.viewportWidth  || 1280;
      const viewportHeight = data.viewportHeight || 720;

      await page.setViewport({
        width: viewportWidth,
        height: viewportHeight,
        deviceScaleFactor: 1,
        hasTouch: false,
        isMobile: false,
      });

      // ─────────────────────────────────────────────────────────────
      // Inject BEFORE page scripts run
      // This bypasses CSP entirely
      // ─────────────────────────────────────────────────────────────
      await page.evaluateOnNewDocument(
        (selectorsCode, toolCode) => {

          // Prevent double injection on SPA navigations
          if (window.__SCRAPER_TOOL_ALREADY_INJECTED__) return;

          window.__SCRAPER_TOOL_ALREADY_INJECTED__ = true;

          try {
            eval(selectorsCode);
            eval(toolCode);

            window.__SELECTION_MODE__ = false;

            console.log('✅ Injection successful');
          } catch (err) {
            console.error('❌ Injection failed:', err);
          }
        },
        injectedSelectors,
        injectedScript
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
      });

      await client.send('Page.startScreencast', {
        format: 'png',
        maxWidth: viewportWidth,
        maxHeight: viewportHeight,
        everyNthFrame: 1,
      });

      socket.emit('viewportUpdated', {
        width: viewportWidth,
        height: viewportHeight,
      });

      const onFrame = async (frame) => {
        const s = userSessions.get(userId);

        if (!s?.streaming) return;

        try {
          socket.emit('frame', Buffer.from(frame.data, 'base64'));

          await client.send('Page.screencastFrameAck', {
            sessionId: frame.sessionId,
          });
        } catch (_) {}
      };

      client.on('Page.screencastFrame', onFrame);

      // ─────────────────────────────────────────────────────────────
      // Stop streaming
      // ─────────────────────────────────────────────────────────────
      const stopStreaming = async () => {
        const s = userSessions.get(userId);

        if (!s?.streaming) return;

        s.streaming = false;

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

      socket.on('disconnect', stopStreaming);
      socket.on('stopStreaming', stopStreaming);

      socket.emit('message', '✅ Navigation + streaming started');

    } catch (err) {
      console.error(err);

      socket.emit('message', `❌ Navigation error: ${err.message}`);
    }
  });

  // ── Resize viewport ──────────────────────────────────────────────────────
  socket.on('resizeViewport', async ({ width, height }) => {
    const s = userSessions.get(userId);
    if (!s?.streaming) return;
    if (Math.abs(s.currentWidth - width) < 10 && Math.abs(s.currentHeight - height) < 10) return;
    try {
      await s.session.send('Page.stopScreencast').catch(() => {});
      await s.page.setViewport({ width, height, deviceScaleFactor: 1, hasTouch: false, isMobile: false });
      s.currentWidth  = width;
      s.currentHeight = height;
      const meta = userSessionMeta.get(userId);
      if (meta) { meta.viewportWidth = width; meta.viewportHeight = height; }
      await s.session.send('Page.startScreencast', { format: 'png', maxWidth: width, maxHeight: height, everyNthFrame: 1 });
      socket.emit('viewportUpdated', { width, height });
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
        steps:   [...],   // the full workflow step tree
        meta?:   { startUrl, viewportWidth, viewportHeight }
      }
    */
    const meta = data.meta || userSessionMeta.get(userId) || {};
    const steps = data.steps || [];
    const customActions = resolveCustomActions(steps, socket.user.id);
    const workflow = { steps, meta, customActions };

    socket.emit('executionStarted');

    try {
      await executeWorkflow(workflow, socket);
    } catch (err) {
      socket.emit('executionLog', { line: `❌ Executor error: ${err.message}`, level: 'error' });
      socket.emit('executionDone', { success: false, results: null, error: err.message });
    }
  });

  // ── Highlight elements for compact workflow hover ────────
  socket.on('detectPagination', async () => {
    const page = await getActivePage();
    if (!page) { socket.emit('paginationDetected', { suggestions: [] }); return; }
    try {
      // ── Phase 1: high-confidence static DOM scan ───────────────────
      const staticResults = await page.evaluate(() => {
        const results = [];
        const vis = el => !!(el && el.offsetParent !== null && el.getBoundingClientRect().width > 0);
        const txt = el => (el.innerText || el.textContent || '').trim();
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
        // Only exact start-of-text match; applied strictly inside confirmed containers
        const NEXT_RE      = /^next\b|^[›»→>]$|^forward$|^load next$/i;
        const LOAD_MORE_RE = /^(load more|show more|see more|view more|load additional|more results|show all results)$/i;

        // 1. a[rel="next"] — unambiguous
        const relNext = document.querySelector('a[rel="next"]');
        if (relNext && vis(relNext)) {
          results.push({ type: 'next_button', confidence: 0.97, selector: 'a[rel="next"]',
            previewText: txt(relNext) || 'Next', description: 'Explicit <a rel="next"> link found.' });
        }

        // 2. Exact aria-label "Next" / "Next page"
        if (!results.find(r => r.type === 'next_button')) {
          const el = document.querySelector('[aria-label="Next"],[aria-label="Next page"],[aria-label="next page"],[aria-label="next"]');
          if (el && vis(el)) {
            results.push({ type: 'next_button', confidence: 0.93, selector: stableSelector(el),
              previewText: txt(el) || 'Next', description: 'Found an exact aria-label "Next" button.' });
          }
        }

        // 3. "Next*" text ONLY inside a verified pagination container — NO document fallback
        if (!results.find(r => r.type === 'next_button')) {
          const container = document.querySelector(
            'nav[aria-label*="page" i],nav[aria-label*="paginat" i],[class*="paginat"],[class*="pager"],[class="pagination"]'
          );
          if (container) {
            const el = Array.from(container.querySelectorAll('a,button'))
              .find(el => NEXT_RE.test(txt(el).replace(/\s+/g,' ').trim()) && vis(el));
            if (el) {
              results.push({ type: 'next_button', confidence: 0.88, selector: stableSelector(el),
                previewText: txt(el), description: 'Found "Next" inside a confirmed pagination container.' });
            }
          }
        }

        // 3b. URL-sequence detection: link to /path/N+1/ when current page is /path/N/
        //     Only fires when the increment is exactly +1 — very low false-positive rate
        if (!results.find(r => r.type === 'next_button')) {
          const pathname = window.location.pathname;
          // Extract the last numeric segment from the current URL path
          const currentNumMatch = pathname.match(/\/(\d+)\/?$/);
          const currentNum = currentNumMatch ? parseInt(currentNumMatch[1]) : 1;
          // Base path: everything before the trailing /N/
          const basePath = currentNumMatch
            ? pathname.slice(0, currentNumMatch.index)
            : pathname.replace(/\/$/, '');
          const nextNum = currentNum + 1;

          // Find a visible link whose href matches basePath/nextNum/
          const linkToNextPage = Array.from(document.querySelectorAll('a[href]')).find(el => {
            if (!vis(el)) return false;
            const href = el.getAttribute('href') || '';
            // Match absolute paths like /path/2/ or relative /2/
            const hrefPath = href.startsWith('http') ? new URL(href, location.href).pathname : href.split('?')[0];
            // Must end with /nextNum/ and share the same base path
            return hrefPath === `${basePath}/${nextNum}/` ||
                   hrefPath === `${basePath}/${nextNum}` ||
                   // Also match ?page=N query param pattern
                   href.includes(`page=${nextNum}`) ||
                   href.includes(`p=${nextNum}`);
          });

          if (linkToNextPage) {
            results.push({
              type: 'next_button', confidence: 0.87,
              selector: stableSelector(linkToNextPage),
              previewText: txt(linkToNextPage) || linkToNextPage.getAttribute('href'),
              description: `Found a link to page ${nextNum} (URL sequence: …/${nextNum}/).`,
            });
          }
        }

        // 4. Numbered pages inside a verified pagination container
        const paginationNav = document.querySelector(
          'nav[aria-label*="page" i],[class*="paginat"],[class*="pager"],[class="pagination"]'
        );
        if (paginationNav) {
          const numLinks = Array.from(paginationNav.querySelectorAll('a,button'))
            .filter(el => /^\d+$/.test(txt(el).trim()) && vis(el));
          if (numLinks.length >= 2) {
            const nextInNav = paginationNav.querySelector('a[rel="next"],[aria-label="Next"],[aria-label="next"]')
              || Array.from(paginationNav.querySelectorAll('a,button'))
                   .find(el => NEXT_RE.test(txt(el).trim()) && vis(el));
            results.push({ type: 'page_numbers', confidence: 0.91,
              selector: nextInNav ? stableSelector(nextInNav) : stableSelector(paginationNav),
              previewText: numLinks.map(el => txt(el)).slice(0,5).join(', ') + '\u2026',
              description: `Found numbered pagination with ${numLinks.length} page links.` });
          }
        }

        // 5. Load-more button — exact text match only
        const loadMoreEl = Array.from(document.querySelectorAll('a,button,[role="button"]'))
          .find(el => LOAD_MORE_RE.test(txt(el).trim()) && vis(el));
        if (loadMoreEl) {
          results.push({ type: 'load_more', confidence: 0.92, selector: stableSelector(loadMoreEl),
            previewText: txt(loadMoreEl), description: 'Found a "Load More" button below the content.' });
        }

        // 6. Infinite scroll library class/data markers
        const infScrollEl = document.querySelector(
          '[class*="infinite-scroll"],[data-infinite],[data-infinite-scroll],[class*="auto-load"],[class*="endless-scroll"]'
        );
        if (infScrollEl) {
          results.push({ type: 'infinite_scroll', confidence: 0.88, selector: null,
            previewText: infScrollEl.className || infScrollEl.tagName,
            description: 'Found infinite-scroll library markers in the page DOM.' });
        }

        return results.sort((a, b) => b.confidence - a.confidence);
      });

      // ── Phase 2: empirical scroll test ─────────────────────────
      const alreadyHasInfScroll = staticResults.some(r => r.type === 'infinite_scroll');
      if (!alreadyHasInfScroll) {
        const beforeH = await page.evaluate(() => document.body.scrollHeight);
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
          const items = document.querySelectorAll('li,article,[class*="item"],[class*="card"],[class*="result"],[class*="product"]');
          if (items.length) items[items.length-1].scrollIntoView({ block:'end', behavior:'instant' });
        });
        await new Promise(r => setTimeout(r, 2500));
        const afterH = await page.evaluate(() => document.body.scrollHeight);
        await page.evaluate(() => window.scrollTo(0, 0));
        if (afterH > beforeH + 100) {
          staticResults.push({ type: 'infinite_scroll', confidence: 0.92, selector: null,
            previewText: `Page grew ${afterH - beforeH}px after scrolling`,
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

  socket.on('downloadCode', (data) => {
    /*
      data = { steps, meta? }
      Response: codeReady { code: string }
    */
    try {
      const meta = data.meta || userSessionMeta.get(userId) || {};
      const steps = data.steps || [];
      const customActions = resolveCustomActions(steps, socket.user.id);
      const code = generateCode({ steps, meta, customActions });
      socket.emit('codeReady', { code });
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
          socket.emit('previewResult', { stepId, previewValues: values });
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
          return multiple ? targets.map(extract).join(' | ') : extract(targets[0]);
        } catch(e) { return null; }
      }, selector, type, multiple, attribute);

      if (result !== null) {
        socket.emit('previewResult', { stepId, previewValue: String(result) });
      } else {
        socket.emit('previewResult', { stepId, notFound: true });
      }
    } catch(err) { /* silent — preview is best-effort */ }
  });

  socket.on('disconnect', () => {
    console.log(`🔌 User disconnected: ${userId}`);
    userSessions.delete(userId);
    scraperService.clearUser(userId);
    // Note: we deliberately don't touch modeReapplyListeners here — the
    // puppeteer page can outlive the socket (SPA refresh) and the hook is
    // still useful on the next navigate. The listener gets replaced cleanly
    // when navigate runs again.
  });
});

server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));