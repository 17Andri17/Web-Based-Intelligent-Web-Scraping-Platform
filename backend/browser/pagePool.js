'use strict';

/* ===========================================================================
   pagePool
   ---------------------------------------------------------------------------
   Iteration scheduling for the per-item loops — RUN_SUBFLOW iterate/enrich and
   FOR_EACH_ROW. These are the loops that walk a list of detail pages, so on a
   large job they ARE the run: 5,000 products means 5,000 trips through here.

   Until now each trip was strictly sequential — open a tab, navigate, extract,
   close the tab, repeat — so total time was the sum of every page load, and a
   fast machine on a fast connection sat idle waiting on network latency.

   Three things live here:

     __openPage(browser)   The single page factory. Everything a fresh tab
                           needs, in one place: stealth, request blocking, and
                           proxy auth. (Sub-pages previously never got
                           page.authenticate(), so an authenticated proxy only
                           ever worked on the FIRST page — a latent bug this
                           centralisation fixes.)

     __rateGate()          Global request pacing, shared by all workers. Being
                           able to go faster is only useful if you can also
                           choose not to; this is what makes concurrency safe
                           to turn up against a site you don't want to hammer.

     __iterateInto(...)    The scheduler. At concurrency 1 it is the original
                           sequential loop, tab-per-item and all. Above 1 it
                           runs N workers, each REUSING one tab (saving the
                           100-300ms a tab costs to create and destroy).

   Ordering is preserved regardless of concurrency. Workers finish out of
   order, so each writes into its own slot and completed slots are committed to
   the output array in source order. That keeps rows aligned with their source
   rows — essential for enrich — while still letting them land incrementally,
   so the Phase-1 checkpointing continues to see data as it arrives rather than
   in one dump at the end.
   ========================================================================= */

/**
 * @param {object} opts
 *   instrument   — emit ITER_TICK / __checkpoint calls (false for downloaded
 *                  scripts, which have neither).
 *   proxyAuth    — JS source applied to a new page for proxy credentials.
 *   proxyWebRtc  — JS source applied to a new page for the WebRTC guard.
 *   requestsPerSecond — global cap across all workers (0 = unlimited).
 *   jitterMs     — random extra delay per request, so pacing isn't metronomic.
 */
function buildCodegenPoolHelper(opts = {}) {
  const instrument = !!opts.instrument;
  const proxyAuth = opts.proxyAuth || '';
  const proxyWebRtc = opts.proxyWebRtc || '';
  const rps = Number(opts.requestsPerSecond) > 0 ? Number(opts.requestsPerSecond) : 0;
  const jitter = Number(opts.jitterMs) > 0 ? Math.floor(Number(opts.jitterMs)) : 0;
  const minInterval = rps > 0 ? Math.ceil(1000 / rps) : 0;

  const tick = instrument
    ? `    if (stepId) console.log('ITER_TICK:' + JSON.stringify({ stepId: stepId, index: completed - 1, active: activeCount() }));\n`
      + `    __checkpoint();\n`
    : '';

  /* Which item each worker is on. With one worker "12 of 30" says everything;
     with eight it says almost nothing — the interesting question becomes
     whether the workers are all busy and where they are. Reported as a whole
     small array rather than per-worker events, so the UI renders one coherent
     picture instead of stitching together deltas.

     Throttled: this fires on every item start, which at high concurrency is
     far more often than anyone can read. */
  const workerReport = instrument
    ? `
  let __lastWorkerReport = 0;
  let __workerTimer = null;
  const reportWorkers = (force) => {
    if (!stepId) return;
    const now = Date.now();
    if (!force && now - __lastWorkerReport < __WORKER_REPORT_MS) {
      /* Coalesce, don't DROP. Worker state changes when an item starts, and
         items can take minutes — so discarding a report inside the window left
         the display stale until the next item began, which is why the worker
         list used to appear only as the first items finished. Deferring the
         latest state instead means it always arrives, just no more often than
         the window. */
      if (!__workerTimer) {
        __workerTimer = setTimeout(() => { __workerTimer = null; reportWorkers(true); },
                                   __WORKER_REPORT_MS - (now - __lastWorkerReport));
        if (__workerTimer.unref) __workerTimer.unref();
      }
      return;
    }
    if (__workerTimer) { clearTimeout(__workerTimer); __workerTimer = null; }
    __lastWorkerReport = now;
    try {
      console.log('ITER_WORKERS:' + JSON.stringify({
        stepId: stepId,
        workers: workerState.map((s) => (s == null ? null : s)),
      }));
    } catch (_) {}
  };`
    : `
  const reportWorkers = () => {};`;

  /* Resume bookkeeping.

     A completed item is reported as its own marker rather than being inferred
     from the output rows. Inference looked tempting — subflow results carry a
     _sourceUrl — but __enrichRows moves that key around per merge strategy
     (top-level for flat/explode, prefixed for prefix, nested for nest) and a
     user field transform could drop it entirely. A dedicated marker is
     independent of output shape, so resume stays correct no matter what the
     workflow does to its own data.

     Downloaded scripts get inert stubs: there is no platform to resume into. */
  const resumeRuntime = instrument
    ? `
// Resume state, supplied by the platform as a JSON sidecar (see
// services/resume.service.js). Read from a file rather than embedded in this
// script because it can carry thousands of URLs and every restored row.
const __RESUME = (() => {
  try {
    const f = process.env.WS_RESUME_FILE;
    if (!f) return null;
    return JSON.parse(require('fs').readFileSync(f, 'utf8'));
  } catch (_) { return null; }
})();
function __resumeFor(stepId) {
  if (!__RESUME || !__RESUME.steps || !stepId) return null;
  return __RESUME.steps[stepId] || null;
}

/* Sharding: split one huge list across several independent runs.

   Assignment is a hash of the item's URL, not its position, so every shard
   decides membership on its own with no coordination and no shared cursor —
   and it stays stable if the list shifts between runs (a page added upstream
   doesn't migrate items between shards the way an index split would).

   Each shard is an ordinary run producing ordinary results, so the existing
   cross-run dataset view already unions them; there is no separate merge step
   and no shard-group bookkeeping to get wrong. */
const __SHARD = (__RESUME && __RESUME.shard && __RESUME.shard.count > 1) ? __RESUME.shard : null;
function __shardHash(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}
function __inShard(url) {
  if (!__SHARD) return true;
  return (__shardHash(url) % __SHARD.count) === __SHARD.index;
}
function __resumeStepDone(stepId) {
  return !!(__RESUME && __RESUME.doneSteps && stepId && __RESUME.doneSteps[stepId]);
}
function __resumeValue(key) {
  if (!__RESUME || !__RESUME.values) return undefined;
  return __RESUME.values[key];
}
`
    : `
function __resumeFor(_stepId) { return null; }
function __inShard(_url) { return true; }
function __resumeStepDone(_stepId) { return false; }
function __resumeValue(_key) { return undefined; }
// The completion ledger is platform-only (it feeds resume); a downloaded
// script has nothing to resume into, so these are inert.
function __stageItemDone(_stepId, _url) {}
function __stageStepDone(_stepId) {}
function __inLane(_owner, _lane, _item, fn) { return fn(); }
`;

  return `${resumeRuntime}
// Timeout-bounded fetch for EXTRACT_API. A bare fetch() has no timeout, so a
// hung endpoint could stall a paginated walk indefinitely with no way out.
const __API_TIMEOUT_MS = ${Number(opts.apiTimeoutMs) > 0 ? Math.floor(Number(opts.apiTimeoutMs)) : 30000};
async function __apiFetch(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), __API_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, init || {}, { signal: ctl.signal }));
  } finally { clearTimeout(timer); }
}

// ─── Page factory + iteration scheduling (see backend/browser/pagePool.js) ──
async function __openPage(browser) {
  const _p = await browser.newPage();
${proxyAuth}${proxyWebRtc}  await applyStealthToPage(_p);
  await applyResourceBlocking(_p);
  return _p;
}

// Global request pacing. Serialised through a promise chain so that N workers
// share ONE schedule rather than each pacing itself (which would multiply the
// real rate by the worker count).
const __RATE_MIN_INTERVAL_MS = ${minInterval};
const __RATE_JITTER_MS = ${jitter};
let __rateChain = Promise.resolve();
let __rateNextAt = 0;
function __rateGate() {
  if (__RATE_MIN_INTERVAL_MS <= 0 && __RATE_JITTER_MS <= 0) return Promise.resolve();
  const grant = __rateChain.then(async () => {
    const wait = __rateNextAt - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const jitter = __RATE_JITTER_MS > 0 ? Math.floor(Math.random() * __RATE_JITTER_MS) : 0;
    __rateNextAt = Date.now() + __RATE_MIN_INTERVAL_MS + jitter;
  });
  __rateChain = grant.catch(() => {});
  return grant;
}

/**
 * Run task(i, getPage) for i in [0, count) and append the rows it returns to
 * \`out\` IN SOURCE ORDER, whatever order the tasks actually finish in.
 *
 * task must return an array of output rows (empty array = contributes none).
 * A task that throws is logged and contributes nothing — one bad detail page
 * must never abort a 5,000-page run.
 *
 * getPage() is a LAZY accessor, not a page: a worker's tab is created on first
 * use and reused thereafter. That matters for HTTP-first mode, where most
 * items are scraped without a browser at all — eagerly opening a tab per
 * worker would spend 50-80MB each on tabs that are never navigated, which is
 * exactly the memory ceiling HTTP mode exists to escape.
 */
async function __iterateInto(browser, count, out, concurrency, stepId, task, urlOf) {
  const slots = new Array(count);
  const failed = new Array(count);   // slot i threw / returned nothing usable
  let nextCommit = 0;
  let completed = 0;
  // Which item index each worker is currently on; null when idle/finished.
  const workerState = [];
  const activeCount = () => workerState.reduce((n, s) => n + (s == null ? 0 : 1), 0);
  const __WORKER_REPORT_MS = 250;
${workerReport}

  // Commit every slot that is now contiguous with what's already output. An
  // out-of-order finish simply waits for its predecessor, so \`out\` is always
  // a correctly-ordered prefix of the final result.
  //
  // This is also the ONLY place an item is recorded as finished. Staging the
  // url here — after its rows are in \`out\`, and therefore in the next
  // RESULT_CHUNK — is what makes "done" mean "saved". An item that failed is
  // deliberately never staged, so a resume retries it.
  const commit = () => {
    while (nextCommit < count && slots[nextCommit] !== undefined) {
      const rows = slots[nextCommit];
      if (Array.isArray(rows)) { for (const r of rows) out.push(r); }
      if (!failed[nextCommit] && stepId && typeof urlOf === 'function') {
        try { __stageItemDone(stepId, urlOf(nextCommit)); } catch (_) {}
      }
      slots[nextCommit] = null;   // release as we go — these can be large
      nextCommit++;
    }
  };

  /* What a task may return, and what each means for the ledger:
       [rows]                     completed — emit these rows, mark it done
       null / undefined           did not complete — no rows, NOT done
       { __failed: true, rows }   did not complete, but keep these rows
                                  (an enrich still emits its source row so the
                                  parent list isn't lost, yet the detail page
                                  must be revisited on resume)
     The distinction exists because "produced no rows" and "did not finish"
     look identical from an empty array, and conflating them is what let a
     resume skip pages it had never actually captured. */
  const runItem = async (i, getPage, lane) => {
    try {
      // Run the item inside its lane so every marker the body emits — nested
      // loop ticks, step boundaries — says which worker produced it. Without
      // this, N workers running the same subflow body report one interleaved
      // stream of step ids that describes none of them.
      const r = lane == null
        ? await task(i, getPage)
        : await __inLane(stepId, lane, i, () => task(i, getPage));
      if (r == null) {
        slots[i] = []; failed[i] = true;
      } else if (Array.isArray(r)) {
        slots[i] = r;
      } else if (r && r.__failed) {
        slots[i] = Array.isArray(r.rows) ? r.rows : [];
        failed[i] = true;
      } else {
        slots[i] = [];
      }
    } catch (err) {
      slots[i] = [];
      failed[i] = true;
      console.error('Iteration ' + i + ' failed —', err && err.message);
    }
    completed++;
    commit();
${tick}  };

  const workers = Math.max(1, Math.min(Math.floor(concurrency) || 1, count || 1));

  if (workers <= 1) {
    // Sequential: a fresh tab per item, opened and closed around it — the
    // page lifecycle this loop has always had.
    for (let i = 0; i < count; i++) {
      let page = null;
      const getPage = async () => (page || (page = await __openPage(browser)));
      try {
        await __rateGate();
        await runItem(i, getPage);
      } finally { if (page) { try { await page.close(); } catch (_) {} } }
    }
    commit();
    return;
  }

  // Parallel: N workers pulling from a shared cursor, each holding ONE tab for
  // its whole lifetime instead of churning a tab per item.
  let cursor = 0;
  const worker = async (slot) => {
    let page = null;
    const getPage = async () => (page || (page = await __openPage(browser)));
    try {
      for (;;) {
        const i = cursor++;
        if (i >= count) break;
        await __rateGate();
        workerState[slot] = i;
        reportWorkers();
        await runItem(i, getPage, slot);
      }
    } finally {
      workerState[slot] = null;
      reportWorkers(true);
      if (page) { try { await page.close(); } catch (_) {} }
    }
  };
  // Announce the pool's shape before anyone starts. Without this the first
  // report describes a partly-filled array (whichever workers had assigned a
  // slot by then), so the display could not even tell how many workers exist
  // until several items had come and gone.
  for (let w = 0; w < workers; w++) workerState[w] = null;
  reportWorkers(true);

  await Promise.all(Array.from({ length: workers }, (_, slot) => worker(slot)));
  commit();
}
`;
}

module.exports = { buildCodegenPoolHelper };
