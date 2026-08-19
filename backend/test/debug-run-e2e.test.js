'use strict';

/* ===========================================================================
   Debug Mode — end to end, with a real browser
   ---------------------------------------------------------------------------
   test/debug-mode.test.js pins the pieces in isolation. This one spawns the
   actual generated script, against actual Chrome, and drives it the way the
   debug window will: step, look at the page, step again.

   The fixture is the scenario the feature exists for — an element that does
   not exist until something else has happened. A user watching this workflow
   fail sees only "captured 0 rows"; the question they cannot answer from the
   outside is whether the selector is wrong or the element simply isn't there
   yet. So the assertions are exactly that discrimination:

     paused before the click →  .late-item matches 0
     paused after  the click →  .late-item matches 3

   and the same page's HTML, on demand, at both points.
   ========================================================================= */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const runner = require('../services/runner.service');
const { resolveChromePath } = require('../browser/chromePath');

let passed = 0;
const ok = (label) => { console.log('  ✓ ' + label); passed++; };

/* Deliberately taller than any viewport: the part of the page you cannot see
   is the reason scrolling at a pause exists at all. */
const FIXTURE = `<!doctype html>
<html><head><title>Late list</title>
<style>
  body{margin:0}
  /* Fixed and large so a hand-aimed click in the test lands on it whatever
     the page is scrolled to — the test is about the input path, not aim. */
  #load{position:fixed;top:0;left:0;width:300px;height:150px;z-index:10}
  .spacer{height:2400px;background:linear-gradient(#fff,#eee)}
  .footnote{height:200px}
</style>
</head>
<body>
  <h1 id="heading">Catalogue</h1>
  <button id="load">Show products</button>
  <div id="grid"></div>
  <div class="spacer"></div>
  <div class="footnote" id="bottom">Bottom of the page</div>
  <script>
    document.getElementById('load').addEventListener('click', function () {
      document.getElementById('grid').innerHTML =
        ['Anvil', 'Bucket', 'Crate']
          .map(function (n) { return '<div class="late-item"><span class="name">' + n + '</span></div>'; })
          .join('');
    });
  </script>
</body></html>`;

(async () => {
  const chrome = resolveChromePath();
  if (!chrome) {
    console.log('  — no Chrome on this machine; skipping the end-to-end debug run');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-e2e-'));
  const file = path.join(dir, 'late.html');
  fs.writeFileSync(file, FIXTURE, 'utf8');
  const url = pathToFileURL(file).href;

  const workflow = {
    id: 1,
    meta: { startUrl: url, viewportWidth: 900, viewportHeight: 600 },
    steps: [
      { id: 'nav',   type: 'NAVIGATE', kind: 'action', label: 'Open', params: { url } },
      { id: 'click', type: 'CLICK_ELEMENT', kind: 'action', label: 'Show products', params: { selector: '#load' } },
      { id: 'list',  type: 'EXTRACT_LIST', kind: 'action', label: 'Products',
        params: { containerSelector: '.late-item', outputVar: 'items', fields: { name: { selector: '.name' } } } },
    ],
  };

  const { events, promise, control } = runner.runChild(workflow, { debug: true });
  const logLines = [];
  events.on('log', ({ line }) => logLines.push(line));

  const pauses = [];
  const frames = [];
  const urls = [];           // addresses reported as the run moved
  const scrolls = [];        // scroll positions reported while parked
  // Frames seen since the last pause was handled — a pause has to bring its
  // own picture, because a page that has stopped changing emits none.
  let pending = [];
  const probes = new Map();
  const htmls = new Map();
  let ready = false;

  // Drive the run: every pause is answered, either by an inspection we asked
  // for first or by stepping straight on. Nothing here waits on wall-clock
  // time — each reply is triggered by the message before it.
  const inspect = (id, selectors) => new Promise((resolve) => {
    probes.set(id, resolve);
    control({ t: 'probe', id, selectors });
  });
  const pageHtml = (id) => new Promise((resolve) => {
    htmls.set(id, resolve);
    control({ t: 'html', id });
  });
  // Scroll the parked page and wait for it to report where it ended up.
  const scrollWaiters = [];
  const scrollBy = (deltaY) => new Promise((resolve) => {
    scrollWaiters.push(resolve);
    control({ t: 'input', kind: 'wheel', x: 100, y: 100, deltaX: 0, deltaY });
  });

  events.on('debug', async (msg) => {
    switch (msg.t) {
      case 'hello':
        ready = true;
        return;
      case 'frame':
        frames.push(msg);
        pending.push(msg);
        control({ t: 'frameAck' });     // keep the stream flowing
        return;
      case 'url':
        urls.push(msg.url);
        return;
      case 'scroll': {
        scrolls.push(msg);
        const r = scrollWaiters.shift();
        if (r) r(msg);
        return;
      }
      case 'probeResult': {
        const r = probes.get(msg.id);
        if (r) { probes.delete(msg.id); r(msg.result); }
        return;
      }
      case 'htmlResult': {
        const r = htmls.get(msg.id);
        if (r) { htmls.delete(msg.id); r(msg.html); }
        return;
      }
      case 'paused': {
        const p = msg.payload;
        const key = `${p.step && p.step.id}:${p.when}`;
        p.framesBefore = pending.length;
        pending = [];
        // Ask the frozen page about an element NO step in this workflow has a
        // selector for — the ad-hoc probe a user types into the window.
        p.lateItems = await inspect(key, ['.late-item']);
        if (key === 'click:after') p.html = await pageHtml(key);
        /* Look around the page while it is parked — the reason this exists is
           that a screencast shows one viewport and the answer is often below
           it. Recorded here so the NEXT pause can show whether the run was put
           back where it left off. */
        if (key === 'list:before') p.afterScroll = await scrollBy(900);
        /* Clicking is the other half, and the dangerous one — it changes the
           page the run continues on. Done at the last pause so it cannot
           disturb the observations above. */
        if (key === 'list:after') {
          control({ t: 'input', kind: 'click', x: 100, y: 75 });
          p.clicked = await inspect('after-hand-click', ['.late-item']);
        }
        pauses.push(p);
        control({ t: 'resume', mode: 'step' });
        return;
      }
      default:
        return;
    }
  });

  const result = await promise;

  /* ── The run itself ───────────────────────────────────────────────────── */
  assert.ok(ready, 'the child announced its control channel');
  ok('the debug child opens an IPC channel and says hello');

  assert.strictEqual(result.success, true, `the workflow completed (${result.errorInfo && result.errorInfo.message})`);
  // Results are keyed by the step's label (see the codegen's outKey handling).
  assert.deepStrictEqual(result.results.Products, [{ name: 'Anvil' }, { name: 'Bucket' }, { name: 'Crate' }],
    'and captured all three rows');
  ok('a stepped-through run produces exactly the results a normal run would');

  /* ── It really stopped at every step ──────────────────────────────────── */
  const keys = pauses.map((p) => `${p.step && p.step.id}:${p.when}`);
  assert.deepStrictEqual(keys, [
    'nav:before', 'nav:after',
    'click:before', 'click:after',
    'list:before', 'list:after',
  ], 'paused before and after each of the three steps, in order');
  ok('the run parks on both sides of every step');

  /* ── The question the debugger exists to answer ───────────────────────── */
  const at = (key) => pauses.find((p) => `${p.step && p.step.id}:${p.when}` === key);
  const matches = (key) => {
    const probe = at(key).lateItems;
    return probe && probe[0] ? probe[0].matches : null;
  };

  assert.strictEqual(matches('click:before'), 0, 'before the click the element does not exist');
  assert.strictEqual(matches('click:after'), 3, 'after it, three of them do');
  ok('the before/after probe identifies the step that brings an element into being');

  assert.strictEqual(matches('list:before'), 3, 'the extraction runs against a page that has them');
  ok('a later step sees the page the earlier one left behind');

  // A step's OWN selectors are probed without being asked for, so the pause
  // arrives already answering "will this step find anything?".
  const listProbe = at('list:before').probe;
  assert.ok(listProbe && listProbe[0].selector === '.late-item', 'the step brought its own selector');
  assert.strictEqual(listProbe[0].matches, 3, 'evaluated against the live page');
  assert.ok(listProbe[0].sample.includes('Anvil'), 'with a sample of what it found');
  ok('each pause pre-answers whether the step it stopped on will match anything');

  /* ── Looking at the page while it is frozen ───────────────────────────── */
  const html = at('click:after').html;
  assert.ok(html && html.includes('late-item'), 'the HTML snapshot shows the new elements');
  assert.ok(html.includes('Anvil'), 'including their content');
  ok('the paused page can be inspected as HTML on demand');

  /* ── The picture ──────────────────────────────────────────────────────── */
  assert.ok(frames.length > 0, 'frames arrived');
  assert.ok(Buffer.isBuffer(frames[0].buf), 'as real Buffers, not base64 through JSON');
  // JPEG magic number: proof these are decodable images and not a mangled
  // round-trip through the IPC serialiser.
  assert.strictEqual(frames[0].buf[0], 0xFF, 'and they are JPEGs');
  assert.strictEqual(frames[0].buf[1], 0xD8, 'and they are JPEGs');
  ok(`the screencast delivered ${frames.length} frames of the run's own browser`);

  /* The one that matters for a debugger: a page that has stopped changing
     emits no screencast frames at all, so every pause has to arrive with a
     picture of its own or the window shows the previous step's page next to
     this step's description. */
  const noPicture = pauses.filter((p) => !p.framesBefore);
  assert.deepStrictEqual(noPicture.map((p) => `${p.step.id}:${p.when}`), [],
    'every pause was preceded by at least one frame');
  ok('a paused run always shows the page it is describing');

  /* ── The address, while the run is moving ─────────────────────────────── */
  assert.ok(urls.length >= 2, `the run reported its address as it went (${urls.length} updates)`);
  assert.strictEqual(urls[0], 'about:blank', 'starting on a blank tab');
  assert.ok(urls.some((u) => u.endsWith('late.html')), 'and reporting the page once it navigated');
  // The point of reporting it continuously: these arrive without anyone
  // pausing, which is what makes a paginating run legible while it walks.
  ok('the address is reported as the run navigates, not only when it parks');

  /* ── Looking around a parked page, without changing it ────────────────── */
  const scrolled = at('list:before').afterScroll;
  assert.ok(scrolled, 'the parked page accepted a scroll');
  assert.ok(scrolled.y > 0, `and moved (y=${scrolled.y})`);
  assert.ok(scrolled.pageHeight > scrolled.viewportHeight,
    'the fixture really is taller than the viewport, so this proved something');
  ok(`a parked page can be scrolled to look around (y=${scrolled.y} of ${scrolled.pageHeight}px)`);

  // …and the run gets its page back exactly as it left it. A workflow that
  // scrolls to harvest, or a step that acts on what is in view, must not
  // behave differently because someone looked at the page.
  const after = at('list:after');
  assert.ok(after.scroll, 'the following pause reported a scroll position');
  assert.strictEqual(after.scroll.y, 0,
    `the run resumed at the scroll position it parked at (got ${after.scroll.y})`);
  ok('scrolling to look is undone on resume — inspection cannot change the run');

  /* ── Clicking, and being told about it ───────────────────────────────── */
  const handClick = at('list:after').clicked;
  assert.ok(handClick && handClick[0] && handClick[0].matches === 3,
    'the hand-aimed click reached the page');
  // Unlike scrolling, this is not undone — so it has to be on the record. A
  // run whose page was altered by hand and does not say so is a run whose
  // results nobody can account for later.
  assert.ok(logLines.some((l) => l.includes('clicked by hand')),
    `the run log records the takeover (log had ${logLines.length} lines)`);
  ok('a click at a pause reaches the page and is written into the run log');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${passed} assertions passed\n`);
})().catch((err) => { console.error(err); process.exit(1); });
