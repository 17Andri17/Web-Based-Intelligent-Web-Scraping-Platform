'use strict';

const { TRACKER_HOST_PATTERNS, TRACKER_PATH_RE } = require('../services/apiDiscovery.service');

/* ===========================================================================
   resourceBlock
   ---------------------------------------------------------------------------
   Request-level blocking for generated scrape scripts.

   Until now nothing in the platform intercepted requests at all: every page
   load pulled down every image, font, video, ad iframe and tracker beacon in
   full, even though extraction only ever reads the DOM. On a typical product
   page that is the majority of the bytes and a large share of the wall-clock —
   and it is paid again on every one of the thousands of pages in a big run.

   What gets blocked:
     • image / media / font  — never read by any extraction. Note that aborting
       the REQUEST does not remove the element or its attributes, so extracting
       an <img src> still works exactly as before.
     • stylesheet — opt-in and off by default. Extraction is selector-based so
       CSS is usually irrelevant, but a site can key lazy-loading off layout,
       and :visible-style heuristics would change meaning.
     • analytics / ad / telemetry hosts — reusing the tracker list that already
       backs API discovery, so the two stay in sync by construction.

   What is NEVER blocked: document, script, xhr, fetch, websocket. Those carry
   the page and its data; blocking them would break the scrape.

   Trade-off worth knowing: Puppeteer disables its HTTP cache while request
   interception is on. For a run that walks thousands of DISTINCT urls (the
   case this is built for) there was nothing to reuse anyway, so the blocking
   win dominates. For a run that revisits the same few pages repeatedly it is
   closer to a wash.

   Off by default — see PERF_DEFAULTS in workflowCodegen. It changes what the
   page loads, so it is the user's call per workflow, not a silent upgrade of
   every existing one.
   ========================================================================= */

// Resource types that never carry extractable data.
const ALWAYS_BLOCKED_TYPES = ['image', 'media', 'font'];

// Types that are only blocked when the workflow opts in.
const OPTIONAL_BLOCKED_TYPES = { stylesheet: 'blockStylesheets' };

/**
 * Node-side helper inlined into generated scripts. Defines
 * `applyResourceBlocking(page)`, called on every page the run opens.
 *
 * @param {object} opts
 *   enabled          — master switch (false ⇒ emits a no-op helper)
 *   blockStylesheets — also abort CSS
 *   blockTrackers    — abort analytics/ad/telemetry hosts (default true)
 */
function buildCodegenResourceBlockHelper(opts = {}) {
  const enabled = !!opts.enabled;
  if (!enabled) {
    return `
// ─── Resource blocking: disabled for this workflow ─────────────────────────
async function applyResourceBlocking(_page) { /* no-op */ }
`;
  }

  const types = ALWAYS_BLOCKED_TYPES.slice();
  for (const [type, flag] of Object.entries(OPTIONAL_BLOCKED_TYPES)) {
    if (opts[flag]) types.push(type);
  }
  const blockTrackers = opts.blockTrackers !== false;

  return `
// ─── Resource blocking (skip bytes no extraction ever reads) ───────────────
const __BLOCK_TYPES = new Set(${JSON.stringify(types)});
const __BLOCK_TRACKERS = ${blockTrackers};
const __TRACKER_HOSTS = ${JSON.stringify(TRACKER_HOST_PATTERNS)};
const __TRACKER_PATH_RE = ${String(TRACKER_PATH_RE)};

function __isTrackerUrl(url) {
  if (!__BLOCK_TRACKERS) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    for (const pat of __TRACKER_HOSTS) {
      if (host.includes(pat) || (host + u.pathname).includes(pat)) return true;
    }
    return __TRACKER_PATH_RE.test(u.pathname);
  } catch (_) { return false; }
}

async function applyResourceBlocking(targetPage) {
  const pg = targetPage || (typeof page !== 'undefined' ? page : null);
  if (!pg) return;
  try {
    await pg.setRequestInterception(true);
    pg.on('request', (req) => {
      // The stealth plugin registers its own interception handlers. Resolving
      // a request twice throws, so defer to whoever got there first.
      try { if (req.isInterceptResolutionHandled && req.isInterceptResolutionHandled()) return; } catch (_) {}
      let blocked = false;
      try {
        blocked = __BLOCK_TYPES.has(req.resourceType()) || __isTrackerUrl(req.url());
      } catch (_) { blocked = false; }
      // Never let a decision error strand the request: on any throw, continue.
      try {
        if (blocked) req.abort('blockedbyclient').catch(() => {});
        else req.continue().catch(() => {});
      } catch (_) {
        try { req.continue().catch(() => {}); } catch (_2) {}
      }
    });
  } catch (_) { /* interception unavailable → run unblocked rather than fail */ }
}
`;
}

module.exports = {
  buildCodegenResourceBlockHelper,
  ALWAYS_BLOCKED_TYPES,
  OPTIONAL_BLOCKED_TYPES,
};
