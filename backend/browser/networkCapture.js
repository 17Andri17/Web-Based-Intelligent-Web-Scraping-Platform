'use strict';

/* ===========================================================================
   networkCapture
   ---------------------------------------------------------------------------
   Passive, per-user capture of the XHR/fetch traffic a page makes while the
   user browses it in the live editor. This is the raw material for the API
   discovery module (services/apiDiscovery.service.js): almost every modern
   site's frontend fetches its data as JSON from its own backend, and if we
   watch those calls we can often find the exact endpoint that returns the
   data the user is about to scrape — an API call being faster, cleaner to
   paginate, and far more stable than scraping the rendered DOM.

   Mechanism: a dedicated CDP session on the page's target with the Network
   domain enabled. This is *passive* — we never intercept, pause, or modify a
   request (that would change timing and is more detectable), we only listen.
   It's the same class of CDP session BrowserManager/server.js already open
   for the screencast, so it adds no new detection surface.

   We keep a bounded, per-user ring buffer of finalized records so a
   long-lived session (or a page that streams video/telemetry) can't grow
   memory without limit — capped by both entry count and total body bytes,
   evicting oldest first.

   Public:
     attach(page, userId)   → begin (or keep) capturing for this user's page
     getRecords(userId)     → finalized records captured since attach/clear
     clear(userId)          → drop the buffer but keep capturing
     detach(userId)         → stop capturing and release the CDP session
   ========================================================================= */

// Only these resource types can plausibly be a data API. Everything else
// (images, css, fonts, media, the top-level document) is noise we never even
// buffer a body for.
const CAPTURED_TYPES = new Set(['XHR', 'Fetch']);

// Bounds for the ring buffer. Bodies are the expensive part, so we cap both
// the number of records AND the total bytes of response bodies we hold.
const MAX_RECORDS         = 400;
const MAX_TOTAL_BODY_BYTES = 8 * 1024 * 1024;   // 8 MB across all buffered bodies
const MAX_SINGLE_BODY_BYTES = 1.5 * 1024 * 1024; // skip storing bodies larger than this

// Per-user capture state: userId → {
//   client, page, buffer: Record[], totalBodyBytes,
//   pending: Map<requestId, PartialRecord>,   // in-flight, not yet finalized
//   extra:   Map<requestId, { requestHeaders }> // from *ExtraInfo events
// }
const captures = new Map();

// requestWillBeSent gives us the "will be sent" request headers, but Chrome
// often omits Cookie (and sometimes Authorization) from that view. The
// *ExtraInfo events carry the ACTUAL headers/cookies the browser attached, so
// we merge them in — this is what lets auth classification see cookie/session
// vs bearer vs open. Kept in a side map keyed by requestId and folded into the
// record when it finalizes.
function rememberExtra(state, requestId, headers) {
  if (!headers) return;
  const prev = state.extra.get(requestId) || {};
  state.extra.set(requestId, { requestHeaders: { ...(prev.requestHeaders || {}), ...headers } });
}

function evictIfNeeded(state) {
  while (state.buffer.length > MAX_RECORDS ||
         (state.totalBodyBytes > MAX_TOTAL_BODY_BYTES && state.buffer.length > 1)) {
    const dropped = state.buffer.shift();
    if (dropped && dropped.responseBodyBytes) state.totalBodyBytes -= dropped.responseBodyBytes;
  }
}

async function attach(page, userId) {
  if (!page || !userId) return null;

  const existing = captures.get(userId);
  // Already capturing this exact page → nothing to do (idempotent across the
  // repeated navigate() calls an SPA makes). Different page → tear the old one
  // down first so listeners/CDP sessions don't stack.
  if (existing) {
    if (existing.page === page) return existing;
    await detach(userId);
  }

  let client;
  try {
    client = await page.target().createCDPSession();
  } catch (err) {
    console.warn(`⚠️ networkCapture: could not open CDP session for ${userId}: ${err.message}`);
    return null;
  }

  const state = {
    client,
    page,
    buffer: [],
    totalBodyBytes: 0,
    pending: new Map(),
    extra: new Map(),
    detached: false,
  };
  captures.set(userId, state);

  // ── Wire listeners BEFORE Network.enable so we don't miss early events ────
  client.on('Network.requestWillBeSent', (e) => {
    try {
      const type = e.type;
      if (!CAPTURED_TYPES.has(type)) return;
      const req = e.request || {};
      state.pending.set(e.requestId, {
        requestId:      e.requestId,
        url:            req.url,
        method:         req.method || 'GET',
        requestHeaders: req.headers || {},
        requestBody:    typeof req.postData === 'string' ? req.postData.slice(0, 64 * 1024) : null,
        hasPostData:    !!req.hasPostData,
        resourceType:   type,
        initiatorType:  e.initiator && e.initiator.type,
        startedAt:      Date.now(),
      });
    } catch (_) {}
  });

  // Actual outgoing headers (incl. Cookie) — merged into the record on finalize.
  client.on('Network.requestWillBeSentExtraInfo', (e) => {
    try { rememberExtra(state, e.requestId, e.headers); } catch (_) {}
  });

  client.on('Network.responseReceived', (e) => {
    try {
      const rec = state.pending.get(e.requestId);
      if (!rec) return;
      const resp = e.response || {};
      rec.status           = resp.status;
      rec.responseHeaders  = resp.headers || {};
      rec.responseMimeType = resp.mimeType || '';
      rec.remoteIp         = resp.remoteIPAddress || null;
      rec.fromCache        = !!resp.fromDiskCache;
    } catch (_) {}
  });

  // Body is only reliably retrievable once loading finishes. We fetch it here,
  // but only for JSON-ish responses under the per-body cap — that keeps the
  // getResponseBody round-trips (and the memory) proportional to actual API
  // traffic rather than every asset on the page.
  client.on('Network.loadingFinished', async (e) => {
    const rec = state.pending.get(e.requestId);
    if (!rec) return;
    state.pending.delete(e.requestId);
    if (state.detached) return;

    // Fold in the real headers captured via ExtraInfo (Cookie/Authorization).
    const extra = state.extra.get(e.requestId);
    if (extra && extra.requestHeaders) {
      rec.requestHeaders = { ...rec.requestHeaders, ...extra.requestHeaders };
    }
    state.extra.delete(e.requestId);

    const mime = (rec.responseMimeType || '').toLowerCase();
    const looksJson = mime.includes('json') || mime.includes('javascript') ||
                      mime.includes('graphql') || mime === '' || mime.includes('text/plain');
    const encoded = Number(e.encodedDataLength) || 0;

    if (looksJson && encoded <= MAX_SINGLE_BODY_BYTES) {
      try {
        const { body, base64Encoded } = await client.send('Network.getResponseBody', { requestId: e.requestId });
        let text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
        if (text && text.length > MAX_SINGLE_BODY_BYTES) text = text.slice(0, MAX_SINGLE_BODY_BYTES);
        rec.responseBody      = text || '';
        rec.responseBodyBytes = rec.responseBody.length;
        state.totalBodyBytes += rec.responseBodyBytes;
      } catch (_) {
        // Body may already be evicted from Chrome's own buffer, or the target
        // closed — record still useful for metadata/auth classification.
        rec.responseBody = null;
        rec.responseBodyBytes = 0;
      }
    } else {
      rec.responseBody = null;
      rec.responseBodyBytes = 0;
    }

    state.buffer.push(rec);
    evictIfNeeded(state);
  });

  client.on('Network.loadingFailed', (e) => {
    state.pending.delete(e.requestId);
    state.extra.delete(e.requestId);
  });

  try {
    await client.send('Network.enable', {
      maxTotalBufferSize:    16 * 1024 * 1024,
      maxResourceBufferSize:  8 * 1024 * 1024,
    });
  } catch (err) {
    console.warn(`⚠️ networkCapture: Network.enable failed for ${userId}: ${err.message}`);
    await detach(userId);
    return null;
  }

  // If the page target dies (tab closed), drop our state so we don't leak.
  client.on('CDPSession.Disconnected', () => { captures.delete(userId); });

  console.log(`🛰️  networkCapture attached for ${userId}`);
  return state;
}

function getRecords(userId) {
  const state = captures.get(userId);
  if (!state) return [];
  // Return a shallow copy so callers can't mutate our buffer.
  return state.buffer.slice();
}

function count(userId) {
  const state = captures.get(userId);
  return state ? state.buffer.length : 0;
}

function clear(userId) {
  const state = captures.get(userId);
  if (!state) return;
  state.buffer = [];
  state.totalBodyBytes = 0;
  state.pending.clear();
  state.extra.clear();
}

async function detach(userId) {
  const state = captures.get(userId);
  if (!state) return;
  state.detached = true;
  captures.delete(userId);
  try { await state.client.send('Network.disable'); } catch (_) {}
  try { await state.client.detach(); } catch (_) {}
}

module.exports = { attach, getRecords, count, clear, detach };
