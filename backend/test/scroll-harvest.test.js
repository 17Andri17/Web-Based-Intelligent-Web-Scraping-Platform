'use strict';

/* ===========================================================================
   Scroll-harvest accuracy test — drives the REAL harvestWhileScrolling engine
   against real pages in headless Chromium.

   Each fixture reproduces one of the ways an infinite-scroll scrape silently
   loses records:

     lazy      — an IntersectionObserver sentinel with a VARIABLE, sometimes
                 slow (up to 2.5s) load. A fixed-delay scraper stops early here
                 and returns a different count every run. 200 records.
     virtual   — a recycling list: only ~14 rows exist in the DOM at any time,
                 so anything not harvested in the window it was visible is gone
                 forever. 240 records.
     sentinel  — the loader fires ONLY while a sentinel is intersecting, and the
                 sentinel sits 400px above the bottom. A scraper that jumps
                 straight to scrollHeight teleports over it and loads nothing
                 beyond the first batch. 120 records.
     stuck     — a non-scrollable element configured as the scroll container.
                 Must be reported as an error, never as a clean finish.
     dupes     — two genuinely distinct records with identical visible text.
                 Whole-row de-duping would merge them; the engine must notice.

   The assertion is always the same and always exact: every record, once.

   Run (from backend/):  node test/scroll-harvest.test.js
   Needs a Chromium — uses the same resolution as the app (CHROME_PATH env or
   puppeteer's bundled build).
   ========================================================================= */

const http = require('http');
const assert = require('assert');
const puppeteer = require('puppeteer');
const { resolveChromePath } = require('../browser/chromePath');
const { HARVEST_RUNTIME_SRC } = require('../workflow/workflowCodegen');

// Eval the inlined runtime exactly as a generated script would define it.
const RUNTIME_BODY = HARVEST_RUNTIME_SRC
  .replace(/^const HARVEST_RUNTIME_SRC = `/, '')
  .replace(/`;?\s*$/, '');
const { harvestWhileScrolling, exhaustScroll } = new Function(
  `${RUNTIME_BODY}\nreturn { harvestWhileScrolling, exhaustScroll };`
)();

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

/* ── Fixtures ───────────────────────────────────────────────────────────── */

// Batched infinite scroll behind an IntersectionObserver sentinel.
//   total      — records overall
//   batch      — records appended per load
//   minMs/maxMs— load latency range (variability is the point)
//   rootMargin — how far ahead of the sentinel loading triggers
//   sentinelGap— px of content BELOW the sentinel (jumping past it = no load)
function lazyPage({ total, batch, minMs, maxMs, rootMargin = '0px', sentinelGap = 0 }) {
  return `<!doctype html><meta charset="utf-8"><style>
    body { margin:0; font:14px sans-serif; }
    .row { height:80px; border-bottom:1px solid #ccc; padding:8px; }
    #sentinel { height:1px; }
    #gap { height:${sentinelGap}px; }
  </style>
  <div id="list"></div><div id="sentinel"></div><div id="gap"></div>
  <script>
    const TOTAL = ${total}, BATCH = ${batch};
    let n = 0, loading = false;
    const list = document.getElementById('list');
    function append() {
      const upto = Math.min(n + BATCH, TOTAL);
      for (; n < upto; n++) {
        const d = document.createElement('div');
        d.className = 'row';
        d.dataset.id = 'r' + n;
        d.innerHTML = '<span class="t">Item ' + n + '</span>';
        list.appendChild(d);
      }
      if (n >= TOTAL) document.getElementById('sentinel').remove();
    }
    append();
    const io = new IntersectionObserver((entries) => {
      if (!entries.some(e => e.isIntersecting)) return;
      if (loading || n >= TOTAL) return;
      loading = true;
      const wait = ${minMs} + Math.random() * ${maxMs - minMs};
      // A real XHR so the engine's network-idle signal has something to see.
      fetch('/slow?ms=' + Math.round(wait)).then(() => { append(); loading = false; });
    }, { rootMargin: '${rootMargin}' });
    io.observe(document.getElementById('sentinel'));
  </script>`;
}

// Virtualized list: fixed-height scroller, only the visible window is in the DOM.
function virtualPage({ total, rowH = 60, viewH = 500 }) {
  return `<!doctype html><meta charset="utf-8"><style>
    body { margin:0; font:14px sans-serif; }
    #scroller { height:${viewH}px; overflow-y:auto; border:1px solid #999; }
    #spacer { position:relative; }
    .row { position:absolute; left:0; right:0; height:${rowH}px; border-bottom:1px solid #ddd; }
  </style>
  <div id="scroller"><div id="spacer"></div></div>
  <script>
    const TOTAL = ${total}, ROW = ${rowH};
    const sc = document.getElementById('scroller'), sp = document.getElementById('spacer');
    sp.style.height = (TOTAL * ROW) + 'px';
    function render() {
      const first = Math.max(0, Math.floor(sc.scrollTop / ROW) - 2);
      const last  = Math.min(TOTAL, Math.ceil((sc.scrollTop + sc.clientHeight) / ROW) + 2);
      sp.innerHTML = '';
      for (let i = first; i < last; i++) {
        const d = document.createElement('div');
        d.className = 'row';
        d.dataset.id = 'v' + i;
        d.style.top = (i * ROW) + 'px';
        d.innerHTML = '<span class="t">Row ' + i + '</span>';
        sp.appendChild(d);
      }
    }
    sc.addEventListener('scroll', render);
    render();
  </script>`;
}

// The classic misconfigured "scroll container": a short element whose content
// OVERFLOWS it, but with overflow:visible — so scrollTop can never move. The
// engine must call this out instead of reading zero movement as "the end".
function stuckPage() {
  const rows = Array.from({ length: 40 },
    (_, i) => `<div class="row" data-id="s${i}"><span class="t">Stuck ${i}</span></div>`).join('');
  return `<!doctype html><meta charset="utf-8"><style>
    .row { height:100px; }
    #nope { height:60px; overflow:visible; }
  </style>
  <div id="nope">${rows}</div>`;
}

// REGRESSION: the first screen barely fills the viewport, and more only arrives
// once something scrolls. The very first scroll therefore cannot move far (or at
// all) and the content "fits" — which must NOT be read as "nothing to collect".
// This is the shape of most real infinite-scroll pages and it is what broke when
// the first step was allowed to end the sweep.
function shortFirstScreenPage({ total, batch, firstBatchPx = 620 }) {
  return `<!doctype html><meta charset="utf-8"><style>
    body { margin:0; }
    .row { height:${Math.round(firstBatchPx / batch)}px; border-bottom:1px solid #ccc; }
  </style>
  <div id="list"></div><div id="sentinel" style="height:1px"></div>
  <script>
    const TOTAL = ${total}, BATCH = ${batch};
    let n = 0, loading = false;
    const list = document.getElementById('list');
    function append() {
      const upto = Math.min(n + BATCH, TOTAL);
      for (; n < upto; n++) {
        const d = document.createElement('div');
        d.className = 'row'; d.dataset.id = 'q' + n;
        d.innerHTML = '<span class="t">Q ' + n + '</span>';
        list.appendChild(d);
      }
      if (n >= TOTAL) document.getElementById('sentinel').remove();
    }
    append();   // one screenful (or less) — the page barely scrolls at first
    // Real implementations re-check after appending: if the sentinel is STILL
    // on screen there is room for more, so they load again. Without that a page
    // shorter than the viewport would deadlock, since IntersectionObserver only
    // fires when the intersection STATE changes, not while it stays visible.
    function maybeLoad() {
      if (loading || n >= TOTAL) return;
      const s = document.getElementById('sentinel');
      if (!s) return;
      const r = s.getBoundingClientRect();
      if (r.top > window.innerHeight) return;      // below the fold: wait for a scroll
      loading = true;
      fetch('/slow?ms=400').then(() => { append(); loading = false; maybeLoad(); });
    }
    new IntersectionObserver((e) => { if (e.some(x => x.isIntersecting)) maybeLoad(); })
      .observe(document.getElementById('sentinel'));
  </script>`;
}

// REGRESSION: `scroll-behavior: smooth` (extremely common on real sites) turns
// every scrollTop assignment into an animation. The scraper then advances a few
// dozen px per step instead of a viewport, misreads its own position, and burns
// its whole scroll budget a fraction of the way down — "it scrolled a bit, then
// skipped the rest of the step". The engine must force instant scrolling.
function smoothScrollPage({ total, batch }) {
  return `<!doctype html><meta charset="utf-8"><style>
    html { scroll-behavior: smooth; }
    body { margin:0; scroll-behavior: smooth; }
    .row { height:120px; border-bottom:1px solid #ccc; }
  </style>
  <div id="list"></div><div id="sentinel" style="height:1px"></div>
  <script>
    const TOTAL = ${total}, BATCH = ${batch};
    let n = 0, loading = false;
    const list = document.getElementById('list');
    function append() {
      const upto = Math.min(n + BATCH, TOTAL);
      for (; n < upto; n++) {
        const d = document.createElement('div');
        d.className = 'row'; d.dataset.id = 'm' + n;
        d.innerHTML = '<span class="t">Smooth ' + n + '</span>';
        list.appendChild(d);
      }
      if (n >= TOTAL) document.getElementById('sentinel').remove();
    }
    append();
    new IntersectionObserver((e) => {
      if (!e.some(x => x.isIntersecting) || loading || n >= TOTAL) return;
      loading = true;
      fetch('/slow?ms=250').then(() => { append(); loading = false; });
    }).observe(document.getElementById('sentinel'));
  </script>`;
}

// REGRESSION (measured on lock.me): the element that triggers the next load sits
// ABOVE the end of the page — there is a footer/related block below it — so at
// the true bottom the trigger is off-screen and never fires again. Backing off
// by a fixed amount can miss it by pixels; the engine must cover the whole tail.
function triggerAboveBottomPage({ total, batch, footerPx = 900 }) {
  return `<!doctype html><meta charset="utf-8"><style>
    body { margin:0; } .row { height:100px; border-bottom:1px solid #ccc; }
    #footer { height:${footerPx}px; background:#eee; }
  </style>
  <div id="list"></div><div id="sentinel" style="height:1px"></div>
  <div id="footer">footer / related content below the trigger</div>
  <script>
    const TOTAL = ${total}, BATCH = ${batch};
    let n = 0, loading = false;
    const list = document.getElementById('list');
    function append() {
      const upto = Math.min(n + BATCH, TOTAL);
      for (; n < upto; n++) {
        const d = document.createElement('div');
        d.className = 'row'; d.dataset.id = 'a' + n;
        d.innerHTML = '<span class="t">Above ' + n + '</span>';
        list.appendChild(d);
      }
      if (n >= TOTAL) document.getElementById('sentinel').remove();
    }
    append();
    // Fires ONLY while the sentinel is actually within the viewport.
    new IntersectionObserver((e) => {
      if (!e.some(x => x.isIntersecting) || loading || n >= TOTAL) return;
      loading = true;
      fetch('/slow?ms=300').then(() => { append(); loading = false; });
    }).observe(document.getElementById('sentinel'));
  </script>`;
}

// A list that fits entirely on one screen — nothing to scroll, and no amount
// of waiting can produce more. Must finish immediately, not burn the ladder.
function shortPage() {
  const rows = Array.from({ length: 3 },
    (_, i) => `<div class="row" data-id="f${i}"><span class="t">Fits ${i}</span></div>`).join('');
  return `<!doctype html><meta charset="utf-8">${rows}`;
}

// Two distinct records whose extracted text is identical.
function dupePage() {
  return `<!doctype html><meta charset="utf-8">
  <div class="row" data-id="x1"><span class="t">Same Text</span></div>
  <div class="row" data-id="x2"><span class="t">Same Text</span></div>
  <div class="row" data-id="x3"><span class="t">Other</span></div>`;
}

/* ── Harness ────────────────────────────────────────────────────────────── */

const ROUTES = new Map();
let server, base, browser;

async function withPage(html, fn) {
  const path = '/p' + Math.random().toString(36).slice(2);
  ROUTES.set(path, html);
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 600 });
  try {
    await page.goto(base + path, { waitUntil: 'domcontentloaded' });
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
    ROUTES.delete(path);
  }
}

const FIELDS = { t: { selector: '.t', kind: 'text', attribute: null } };

// The production bottom-patience ladder is 1+2+4+8+15 = 30s. That is a fixed
// ONE-TIME cost per run (it only runs to completion when the list is genuinely
// exhausted), and it is the whole point of the design — but paying it in every
// test would make the suite take minutes. Most tests therefore compress it and
// a dedicated test below proves the real ladder outlasts a slow final batch.
const FAST = { maxScrolls: 400, bottomWaitsMs: [200, 500, 1200] };

// Silence the engine's own console output; capture it for assertions.
function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  return Promise.resolve(fn()).finally(() => { console.log = orig; }).then(r => ({ result: r, lines }));
}

async function main() {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/slow') {
      // The variable-latency backend the fixtures fetch from.
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); },
                 Math.min(4000, Number(url.searchParams.get('ms')) || 0));
      return;
    }
    const html = ROUTES.get(url.pathname);
    if (!html) { res.writeHead(404); res.end('no'); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;

  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: resolveChromePath(),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  console.log('accuracy mode — every record, every time');

  await test('slow + variable lazy loading: all 200 records', async () => {
    await withPage(lazyPage({ total: 200, batch: 20, minMs: 200, maxMs: 2500 }), async (page) => {
      const rows = await harvestWhileScrolling(page, '.row', FIELDS, '', '', FAST);
      assert.equal(rows.length, 200, `got ${rows.length}`);
      const texts = new Set(rows.map(r => r.t));
      assert.equal(texts.size, 200, 'records must be distinct');
      assert.ok(texts.has('Item 0') && texts.has('Item 199'), 'first and last must both be present');
    });
  });

  await test('first screen barely fills the viewport: keeps going, all 100 records', async () => {
    // Regression: the first scroll cannot move far and the content "fits", which
    // was being read as "nothing to scroll" — ending the run after one screen.
    await withPage(shortFirstScreenPage({ total: 100, batch: 8 }), async (page) => {
      const rows = await harvestWhileScrolling(page, '.row', FIELDS, '', '', FAST);
      assert.equal(rows.length, 100, `got ${rows.length} — the sweep gave up early`);
    });
  });

  await test('a first screen that cannot scroll AT ALL still waits for a load', async () => {
    // Harsher: the initial content is shorter than the viewport, so the first
    // scroll cannot move by even one pixel.
    await withPage(shortFirstScreenPage({ total: 60, batch: 4, firstBatchPx: 200 }), async (page) => {
      const rows = await harvestWhileScrolling(page, '.row', FIELDS, '', '', FAST);
      assert.equal(rows.length, 60, `got ${rows.length} — gave up before anything loaded`);
    });
  });

  await test('scroll-behavior:smooth page still reaches the bottom, and quickly', async () => {
    // 150 rows × 120px ≈ 18,000px. With animated scrolling the sweep used to
    // creep ~30px per step and die on the safety cap a fifth of the way down.
    await withPage(smoothScrollPage({ total: 150, batch: 15 }), async (page) => {
      const t0 = Date.now();
      const rows = await harvestWhileScrolling(page, '.row', FIELDS, '', '', FAST);
      const secs = (Date.now() - t0) / 1000;
      assert.equal(rows.length, 150, `got ${rows.length} — the sweep stalled`);
      assert.ok(secs < 60, `took ${secs.toFixed(1)}s — far too slow for an 18,000px page`);
    });
  });

  await test('load trigger sits ABOVE the page bottom (footer below it)', async () => {
    // At the true bottom the sentinel is ~900px off-screen above, so parking
    // there loads nothing. Only sweeping the tail brings it back into view.
    await withPage(triggerAboveBottomPage({ total: 120, batch: 12 }), async (page) => {
      const rows = await harvestWhileScrolling(page, '.row', FIELDS, '', '', FAST);
      assert.equal(rows.length, 120, `got ${rows.length} — the trailing trigger was never re-entered`);
    });
  });

  await test('sentinel above the fold: a jump would skip it, traversal does not', async () => {
    await withPage(lazyPage({ total: 120, batch: 15, minMs: 100, maxMs: 400, sentinelGap: 400 }), async (page) => {
      const rows = await harvestWhileScrolling(page, '.row', FIELDS, '', '', FAST);
      assert.equal(rows.length, 120, `got ${rows.length}`);
    });
  });

  await test('virtualized list: all 240 rows despite DOM recycling', async () => {
    await withPage(virtualPage({ total: 240 }), async (page) => {
      const inDom = await page.$$eval('.row', els => els.length);
      assert.ok(inDom < 30, `fixture must recycle (saw ${inDom} rows in the DOM)`);
      const rows = await harvestWhileScrolling(page, '.row', FIELDS, '', '#scroller', FAST);
      assert.equal(rows.length, 240, `got ${rows.length}`);
      assert.equal(new Set(rows.map(r => r.t)).size, 240, 'records must be distinct');
    });
  });

  await test('repeated runs agree exactly (no latency race)', async () => {
    const counts = [];
    for (let i = 0; i < 3; i++) {
      await withPage(lazyPage({ total: 80, batch: 10, minMs: 100, maxMs: 1800 }), async (page) => {
        const rows = await harvestWhileScrolling(page, '.row', FIELDS, '', '', FAST);
        counts.push(rows.length);
      });
    }
    assert.deepEqual(counts, [80, 80, 80], `counts varied: ${counts.join(', ')}`);
  });

  await test('expected-total selector is honoured', async () => {
    const html = lazyPage({ total: 60, batch: 10, minMs: 50, maxMs: 300 })
      + '<div id="total">Showing 1-10 of 60</div>';
    await withPage(html, async (page) => {
      const rows = await harvestWhileScrolling(page, '.row', FIELDS, '', '',
        Object.assign({}, FAST, { expectedSelector: '#total' }));
      assert.equal(rows.length, 60, `got ${rows.length}`);
    });
  });

  await test('the real patience ladder outlasts a very slow final batch', async () => {
    // The last batch takes 6s — longer than any single early rung, and far
    // longer than the old fixed 3×1200ms budget, which is exactly the case
    // that used to truncate the results (differently on every run).
    const html = lazyPage({ total: 30, batch: 10, minMs: 100, maxMs: 300 })
      .replace("const wait = 100 + Math.random() * 200;",
               "const wait = n >= 20 ? 6000 : 100 + Math.random() * 200;");
    await withPage(html, async (page) => {
      const rows = await harvestWhileScrolling(page, '.row', FIELDS, '', '',
        { maxScrolls: 400 });   // production ladder, deliberately not FAST
      assert.equal(rows.length, 30, `got ${rows.length} — the slow last batch was dropped`);
    });
  });

  console.log('honest failure reporting');

  await test('a non-scrollable container is reported, not passed off as done', async () => {
    await withPage(stuckPage(), async (page) => {
      const t0 = Date.now();
      const { lines } = await captureLogs(() =>
        harvestWhileScrolling(page, '.row', FIELDS, '', '#nope', Object.assign({}, FAST, { maxScrolls: 20 })));
      assert.ok(lines.some(l => l.startsWith('✗ Collect List')), 'expected a loud failure line');
      const sum = JSON.parse(lines.find(l => l.startsWith('COLLECT_SUMMARY:')).slice('COLLECT_SUMMARY:'.length));
      assert.equal(sum.complete, false, 'must not claim completeness');
      assert.equal(sum.reason, 'scroll-container-stuck');
      // Must bail out immediately rather than sitting through the patience ladder.
      assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0}ms — should fail fast`);
    });
  });

  await test('a list that fits on one screen finishes at once', async () => {
    await withPage(shortPage(), async (page) => {
      const t0 = Date.now();
      const { result, lines } = await captureLogs(() =>
        harvestWhileScrolling(page, '.row', FIELDS, '', '', Object.assign({}, FAST, { maxScrolls: 20 })));
      assert.equal(result.length, 3, `got ${result.length}`);
      const sum = JSON.parse(lines.find(l => l.startsWith('COLLECT_SUMMARY:')).slice('COLLECT_SUMMARY:'.length));
      assert.equal(sum.reason, 'no-scroll-needed');
      assert.equal(sum.complete, true);
      assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0}ms — nothing can load, so do not wait`);
    });
  });

  await test('a missing scroll container is reported', async () => {
    await withPage(stuckPage(), async (page) => {
      const { lines } = await captureLogs(() =>
        harvestWhileScrolling(page, '.row', FIELDS, '', '#does-not-exist', Object.assign({}, FAST, { maxScrolls: 20 })));
      const sum = JSON.parse(lines.find(l => l.startsWith('COLLECT_SUMMARY:')).slice('COLLECT_SUMMARY:'.length));
      assert.equal(sum.reason, 'scroll-container-missing');
      assert.equal(sum.complete, false);
    });
  });

  await test('records with identical text survive via intrinsic row identity', async () => {
    await withPage(dupePage(), async (page) => {
      const rows = await harvestWhileScrolling(page, '.row', FIELDS, '', '', Object.assign({}, FAST, { maxScrolls: 5 }));
      assert.equal(rows.length, 3, `identical-text rows were merged (got ${rows.length})`);
    });
  });

  await test('when no identity exists at all, the merge is reported', async () => {
    // Strip data-id so nothing distinguishes the two identical rows.
    const html = dupePage().replace(/ data-id="[^"]*"/g, '');
    await withPage(html, async (page) => {
      const { result, lines } = await captureLogs(() =>
        harvestWhileScrolling(page, '.row', FIELDS, '', '', Object.assign({}, FAST, { maxScrolls: 5 })));
      assert.equal(result.length, 2, 'content-hash dedupe merges them (expected)');
      const sum = JSON.parse(lines.find(l => l.startsWith('COLLECT_SUMMARY:')).slice('COLLECT_SUMMARY:'.length));
      assert.ok(sum.duplicateKeyRows > 0, 'the silent merge must be surfaced');
      assert.ok(lines.some(l => l.includes('Set a "Key field"')), 'expected actionable advice');
    });
  });

  console.log('PAGINATE_SCROLL (exhaustScroll) shares the engine');

  await test('exhaustScroll loads the whole page before the body extracts', async () => {
    await withPage(lazyPage({ total: 150, batch: 15, minMs: 150, maxMs: 1500 }), async (page) => {
      // The old loop teleported to document.body.scrollHeight on a fixed timer;
      // this must leave the DOM fully populated for the step body to read.
      const { lines } = await captureLogs(() => exhaustScroll(page, '', FAST));
      const inDom = await page.$$eval('.row', els => els.length);
      assert.equal(inDom, 150, `only ${inDom} rows were loaded`);
      assert.ok(!lines.some(l => l.startsWith('COLLECT_SUMMARY:')),
        'exhaustScroll must not emit a Collect List summary');
    });
  });

  await test('exhaustScroll works on a non-body scroll container', async () => {
    // document.body.scrollHeight never grows here, so the old implementation
    // could not advance this page at all.
    const html = `<!doctype html><meta charset="utf-8"><style>
      #feed { height:400px; overflow-y:auto; } .row { height:70px; }</style>
      <div id="feed"><div id="items"></div><div id="sentinel" style="height:1px"></div></div>
      <script>
        const TOTAL = 90, BATCH = 10; let n = 0, loading = false;
        const items = document.getElementById('items');
        function append() {
          const upto = Math.min(n + BATCH, TOTAL);
          for (; n < upto; n++) {
            const d = document.createElement('div');
            d.className = 'row'; d.dataset.id = 'f' + n;
            d.innerHTML = '<span class="t">Feed ' + n + '</span>';
            items.appendChild(d);
          }
          if (n >= TOTAL) document.getElementById('sentinel').remove();
        }
        append();
        new IntersectionObserver((e) => {
          if (!e.some(x => x.isIntersecting) || loading || n >= TOTAL) return;
          loading = true;
          fetch('/slow?ms=' + Math.round(100 + Math.random() * 900))
            .then(() => { append(); loading = false; });
        }, { root: document.getElementById('feed') }).observe(document.getElementById('sentinel'));
      </script>`;
    await withPage(html, async (page) => {
      await captureLogs(() => exhaustScroll(page, '#feed', FAST));
      const inDom = await page.$$eval('.row', els => els.length);
      assert.equal(inDom, 90, `only ${inDom} of 90 rows were loaded`);
    });
  });

  console.log('legacy mode still available');

  await test('accuracy:false keeps the old fast behaviour', async () => {
    await withPage(lazyPage({ total: 40, batch: 10, minMs: 20, maxMs: 60 }), async (page) => {
      const rows = await harvestWhileScrolling(page, '.row', FIELDS, '', '',
        { accuracy: false, scrollDelay: 400, maxScrolls: 200 });
      assert.equal(rows.length, 40, `got ${rows.length}`);
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
  });
