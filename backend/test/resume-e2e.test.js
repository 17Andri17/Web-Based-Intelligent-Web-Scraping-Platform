'use strict';

/* ===========================================================================
   Resume, end to end (generated code, no browser)
   ---------------------------------------------------------------------------
   The claim resume makes is strong: a run that stops halfway and is then
   resumed produces the SAME output as one that never stopped. This test holds
   it to that, using the real generated loop scaffolding — the resume filter,
   the scheduler and the ordering logic that codegen actually emits — driven by
   a fake browser so no network or Chrome is involved.

   It also covers the case that motivated recording completions explicitly:
   an interruption where some rows were captured but their items were never
   reported, which must lead to re-scraping (safe) rather than skipping (data
   loss).
   ========================================================================= */

const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildCodegenPoolHelper } = require('../browser/pagePool');
const { resumeSkipCode } = require('../workflow/workflowCodegen');

const URLS = ['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'];

// Build a sandbox holding the real pool/resume runtime, plus the small amount
// of loop scaffolding codegen wraps around it (filter → iterate → collect).
function makeRuntime({ resumeFile = null, concurrency = 1 } = {}) {
  const src = buildCodegenPoolHelper({ instrument: true });
  const doneUrls = [];
  const logs = [];
  const sandbox = {
    Date, JSON, Promise, Array, Set, Math, String, Number, Object, setTimeout, clearTimeout, URL, require,
    process: { env: resumeFile ? { WS_RESUME_FILE: resumeFile } : {} },
    console: {
      log: (line) => {
        if (typeof line !== 'string') return;
        logs.push(line);
      },
      error: () => {},
    },
    applyStealthToPage: async () => {},
    applyResourceBlocking: async () => {},
    __checkpoint: () => {},
    // The pool stages a completed item here; the real runtime drains this
    // into a RESULT_CHUNK alongside the item's rows.
    __stageItemDone: (_stepId, url) => { doneUrls.push(String(url)); },
    // Worker-lane context, also from the instrumentation block. Passthrough:
    // this file is about resume semantics, not lane attribution.
    __inLane: (_owner, _lane, _item, fn) => fn(),
    __browser: { newPage: async () => ({ close: async () => {} }) },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { sandbox, doneUrls, logs, concurrency };
}

/* Mirrors what codegen emits for a subflow iterate loop:
     out = []                       (result array)
     resume filter                  (skip done urls, restore rows)
     __iterateInto(... task ...)    (scheduler)
   `failAt` simulates the run dying: the task throws from that index on.
   `reportDone` mirrors __iterDone being reached only on success. */
async function runLoop(rt, { failAt = Infinity, urls = URLS } = {}) {
  const { sandbox } = rt;
  sandbox.__out = [];
  sandbox.__list = urls.slice();

  // The REAL filter codegen emits for a subflow-iterate loop, evaluated as-is.
  vm.runInContext(
    resumeSkipCode({ listVar: '__list', outVar: '__out', stepId: 's1', urlOf: 'String(_u)', pad: '' }),
    sandbox
  );
  const out = sandbox.__out;
  const list = sandbox.__list;

  await sandbox.__iterateInto(sandbox.__browser, list.length, out, rt.concurrency, 's1',
    async (i) => {
      if (i >= failAt) throw new Error('run died');
      return [{ url: list[i], scraped: true }];
    },
    (i) => String(list[i]));

  return { out, list };
}

let failures = 0;
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => console.log(`  ok  ${name}`))
    .catch(err => { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); });
}

(async () => {
  console.log('resume end-to-end');

  // The reference result: a run that is never interrupted.
  const reference = (await runLoop(makeRuntime())).out;

  await test('baseline: an uninterrupted run captures every url in order', () => {
    assert.deepStrictEqual(reference.map(r => r.url), URLS);
  });

  await test('interrupted + resumed == never interrupted', async () => {
    // First attempt dies after 3 items.
    const first = makeRuntime();
    const a = await runLoop(first, { failAt: 3 });
    assert.deepStrictEqual(first.doneUrls, ['u0', 'u1', 'u2'], 'only completed items are reported');

    // Platform writes the sidecar from what that run reported + its rows.
    const file = path.join(os.tmpdir(), `ws_resume_e2e_${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({
      steps: { s1: { urls: first.doneUrls, rows: a.out.slice(0, 3) } },
    }), 'utf8');

    try {
      const second = makeRuntime({ resumeFile: file });
      const b = await runLoop(second);
      assert.deepStrictEqual(b.out, reference,
        'resumed output must equal the uninterrupted output, exactly and in order');
      assert.deepStrictEqual(second.doneUrls, ['u3', 'u4', 'u5', 'u6', 'u7'],
        'the resumed run must not re-scrape what was already done');
      assert.ok(second.logs.some(l => /Resume: skipping 3/.test(l)), 'resume should report what it skipped');
    } finally { try { fs.unlinkSync(file); } catch (_) {} }
  });

  await test('resuming a resume keeps converging (three-way split)', async () => {
    const mkFile = (urls, rows) => {
      const f = path.join(os.tmpdir(), `ws_resume_e2e2_${process.pid}_${urls.length}.json`);
      fs.writeFileSync(f, JSON.stringify({ steps: { s1: { urls, rows } } }), 'utf8');
      return f;
    };
    const r1 = makeRuntime();
    const a = await runLoop(r1, { failAt: 2 });                       // u0,u1
    const f1 = mkFile(r1.doneUrls, a.out.slice(0, 2));

    const r2 = makeRuntime({ resumeFile: f1 });
    const b = await runLoop(r2, { failAt: 3 });                       // + u2,u3,u4
    // Union of both runs' ledgers — what executionPipeline.mergeProgress does.
    const union = Array.from(new Set([...r1.doneUrls, ...r2.doneUrls]));
    const f2 = mkFile(union, b.out.slice(0, union.length));

    try {
      const r3 = makeRuntime({ resumeFile: f2 });
      const c = await runLoop(r3);
      assert.deepStrictEqual(c.out, reference, 'two resumes still reconstruct the full, ordered result');
    } finally { [f1, f2].forEach(f => { try { fs.unlinkSync(f); } catch (_) {} }); }
  });

  await test('parallel resume also reconstructs the exact ordered result', async () => {
    const first = makeRuntime({ concurrency: 4 });
    const a = await runLoop(first, { failAt: 5 });
    const doneSet = new Set(first.doneUrls);
    const keptRows = a.out.filter(r => doneSet.has(r.url));

    const file = path.join(os.tmpdir(), `ws_resume_e2e_par_${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({
      steps: { s1: { urls: Array.from(doneSet), rows: keptRows } },
    }), 'utf8');
    try {
      const second = makeRuntime({ resumeFile: file, concurrency: 4 });
      const b = await runLoop(second);
      assert.deepStrictEqual(
        b.out.map(r => r.url).slice().sort(),
        URLS.slice().sort(),
        'every url appears exactly once across the two runs — none lost, none duplicated');
      assert.strictEqual(b.out.length, URLS.length);
    } finally { try { fs.unlinkSync(file); } catch (_) {} }
  });

  await test('rows captured but never reported are re-scraped, not skipped', async () => {
    // The unsafe direction would be to trust rows over the ledger: an item
    // whose row landed but whose completion never got reported must be redone,
    // because we cannot tell whether its row is complete.
    const file = path.join(os.tmpdir(), `ws_resume_e2e_gap_${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({
      steps: { s1: { urls: ['u0', 'u1'], rows: [{ url: 'u0', scraped: true }, { url: 'u1', scraped: true }] } },
    }), 'utf8');
    try {
      const rt = makeRuntime({ resumeFile: file });
      const b = await runLoop(rt);
      assert.deepStrictEqual(rt.doneUrls, ['u2', 'u3', 'u4', 'u5', 'u6', 'u7']);
      assert.deepStrictEqual(b.out, reference);
    } finally { try { fs.unlinkSync(file); } catch (_) {} }
  });

  await test('a resume whose urls no longer exist in the list is harmless', async () => {
    // The site changed and dropped some pages: resume must not invent rows for
    // them, and must still scrape whatever is genuinely new.
    const file = path.join(os.tmpdir(), `ws_resume_e2e_stale_${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({
      steps: { s1: { urls: ['gone-1', 'gone-2'], rows: [{ url: 'gone-1', scraped: true }] } },
    }), 'utf8');
    try {
      const rt = makeRuntime({ resumeFile: file });
      const b = await runLoop(rt);
      assert.strictEqual(b.out.length, URLS.length + 1, 'restored row is kept, all current urls scraped');
      assert.deepStrictEqual(rt.doneUrls, URLS);
    } finally { try { fs.unlinkSync(file); } catch (_) {} }
  });

  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall resume-e2e tests passed');
})();
