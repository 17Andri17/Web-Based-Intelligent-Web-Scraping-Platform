'use strict';

/* ===========================================================================
   Page pool / iteration scheduler
   ---------------------------------------------------------------------------
   Exercises the REAL generated scheduler (extracted from buildCodegenPoolHelper,
   not a reimplementation) against a fake browser.

   The property that matters: output order must equal SOURCE order, whatever
   order the tasks finish in. Parallelism is worthless if it silently shuffles
   rows — an enrich would then attach the wrong details to the wrong product,
   which is far worse than being slow. So the tests deliberately make tasks
   finish out of order and assert the output is still ordered, and that rows
   land incrementally (never in one dump at the end) so check-pointing keeps
   working.
   ========================================================================= */

const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildCodegenPoolHelper } = require('../browser/pagePool');

function makeSandbox(opts = {}) {
  const src = buildCodegenPoolHelper(Object.assign({ instrument: true }, opts));
  const ticks = [];
  const doneUrls = [];
  const checkpoints = [];
  let openPages = 0;
  let maxOpenPages = 0;
  let totalPagesOpened = 0;

  const workerReports = [];
  // The completion ledger lives in the instrumentation block (with
  // __checkpoint) and is drained into a RESULT_CHUNK. Here we just record what
  // the pool stages, which is the part this file is responsible for.
  const stagedItems = new Map();

  const sandbox = {
    Date, JSON, Promise, Array, Set, Math, String, Number, Object, setTimeout, clearTimeout,
    require,
    process: { env: Object.assign({}, opts.env || {}) },
    console: {
      log: (line) => {
        if (typeof line !== 'string') return;
        if (line.startsWith('ITER_TICK:')) ticks.push(JSON.parse(line.slice(10)));
        else if (line.startsWith('ITER_WORKERS:')) workerReports.push(JSON.parse(line.slice(13)));
      },
      error: () => {},
    },
    // Stubs for what __openPage calls.
    applyStealthToPage: async () => {},
    applyResourceBlocking: async () => {},
    __stageItemDone: (stepId, url) => {
      if (!stagedItems.has(stepId)) stagedItems.set(stepId, []);
      stagedItems.get(stepId).push(String(url));
    },
    __checkpoint: () => checkpoints.push(true),
    // Also from the instrumentation block: carries the worker lane so markers
    // emitted inside a worker can be attributed to it. Passthrough here.
    __inLane: (_owner, _lane, _item, fn) => fn(),
    __browser: {
      newPage: async () => {
        openPages++; totalPagesOpened++;
        maxOpenPages = Math.max(maxOpenPages, openPages);
        return { close: async () => { openPages--; } };
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return {
    sandbox, ticks, doneUrls, checkpoints, workerReports,
    staged: (stepId) => stagedItems.get(stepId) || [],
    stats: () => ({ maxOpenPages, totalPagesOpened }),
    iterate: (count, out, concurrency, stepId, task, urlOf) =>
      sandbox.__iterateInto(sandbox.__browser, count, out, concurrency, stepId, task, urlOf),
  };
}

let failures = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  ${name}`))
    .catch(err => { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); });
}

(async () => {
  console.log('page-pool scheduler');

  await test('sequential (concurrency 1) preserves order and opens a tab per item', async () => {
    const h = makeSandbox();
    const out = [];
    await h.iterate(5, out, 1, 's1', async (i, getPage) => { await getPage(); return [{ i }]; });
    assert.deepStrictEqual(out.map(r => r.i), [0, 1, 2, 3, 4]);
    assert.strictEqual(h.stats().totalPagesOpened, 5, 'one tab per item, as before pooling');
    assert.strictEqual(h.stats().maxOpenPages, 1, 'never more than one tab at a time');
  });

  await test('a task that never asks for a page opens no tab at all', async () => {
    // This is what makes HTTP-first mode worth having: when the data comes
    // from a plain fetch, the run must not still be paying for browser tabs.
    const h = makeSandbox();
    const out = [];
    await h.iterate(50, out, 8, 's1', async (i) => [{ i }]);
    assert.strictEqual(h.stats().totalPagesOpened, 0, 'no tab should be created');
    assert.strictEqual(out.length, 50, 'and every item still produced its row');
  });

  await test('a tab is opened once per worker, on first use, and reused after', async () => {
    const h = makeSandbox();
    // Only the first item of each worker needs the browser; the rest do not.
    await h.iterate(20, [], 4, 's1', async (i, getPage) => {
      if (i < 4) await getPage();
      return [{ i }];
    });
    assert.ok(h.stats().totalPagesOpened <= 4, `at most one tab per worker, got ${h.stats().totalPagesOpened}`);
    assert.ok(h.stats().totalPagesOpened >= 1, 'the items that asked for a page must have got one');
  });

  await test('parallel preserves SOURCE order despite out-of-order completion', async () => {
    const h = makeSandbox();
    const out = [];
    // Later items finish first: item 0 is the slowest.
    await h.iterate(8, out, 4, 's1', async (i) => {
      await new Promise(r => setTimeout(r, (8 - i) * 6));
      return [{ i }];
    });
    assert.deepStrictEqual(out.map(r => r.i), [0, 1, 2, 3, 4, 5, 6, 7]);
  });

  await test('parallel reuses one tab per worker instead of one per item', async () => {
    const h = makeSandbox();
    await h.iterate(20, [], 4, 's1', async (i, getPage) => { await getPage(); return [{ i }]; });
    const { totalPagesOpened, maxOpenPages } = h.stats();
    assert.strictEqual(totalPagesOpened, 4, `expected 4 tabs for 20 items, got ${totalPagesOpened}`);
    assert.strictEqual(maxOpenPages, 4, 'concurrency cap respected');
  });

  await test('worker count never exceeds the item count', async () => {
    const h = makeSandbox();
    await h.iterate(2, [], 8, 's1', async (i, getPage) => { await getPage(); return [{ i }]; });
    assert.strictEqual(h.stats().maxOpenPages, 2, 'should not open 8 tabs for 2 items');
  });

  await test('rows land incrementally, not in one dump at the end', async () => {
    const h = makeSandbox();
    const out = [];
    const seen = [];
    await h.iterate(6, out, 3, 's1', async (i) => {
      await new Promise(r => setTimeout(r, 5));
      seen.push(out.length);
      return [{ i }];
    });
    assert.ok(seen.some(n => n > 0 && n < 6),
      `output should grow during the run (saw lengths ${JSON.stringify(seen)})`);
    assert.strictEqual(out.length, 6);
  });

  await test('a task that throws contributes nothing and does not abort the run', async () => {
    const h = makeSandbox();
    const out = [];
    await h.iterate(5, out, 2, 's1', async (i) => {
      if (i === 2) throw new Error('detail page exploded');
      return [{ i }];
    });
    assert.deepStrictEqual(out.map(r => r.i), [0, 1, 3, 4], 'other items still captured, order intact');
  });

  await test('a task returning multiple rows keeps them grouped and ordered (explode)', async () => {
    const h = makeSandbox();
    const out = [];
    await h.iterate(3, out, 3, 's1', async (i) => [{ i, n: 1 }, { i, n: 2 }]);
    assert.deepStrictEqual(out.map(r => `${r.i}.${r.n}`), ['0.1', '0.2', '1.1', '1.2', '2.1', '2.2']);
  });

  await test('progress ticks are monotonic and reach the item count', async () => {
    const h = makeSandbox();
    await h.iterate(6, [], 3, 'step-x', async (i) => {
      await new Promise(r => setTimeout(r, (6 - i) * 4));
      return [{ i }];
    });
    const idx = h.ticks.map(t => t.index);
    assert.deepStrictEqual(idx, [0, 1, 2, 3, 4, 5], 'ticks count completions, so they never go backwards');
    assert.ok(h.ticks.every(t => t.stepId === 'step-x'));
  });

  await test('checkpoint fires per completed item', async () => {
    const h = makeSandbox();
    await h.iterate(7, [], 3, 's1', async (i) => [{ i }]);
    assert.strictEqual(h.checkpoints.length, 7);
  });

  await test('rate limiting paces the whole pool, not each worker separately', async () => {
    // 20 req/s ⇒ 50ms apart. 6 items ⇒ ≥250ms even with 6 workers.
    const h = makeSandbox({ requestsPerSecond: 20 });
    const t0 = Date.now();
    await h.iterate(6, [], 6, 's1', async (i) => [{ i }]);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 200, `expected global pacing (~250ms), took ${elapsed}ms`);
  });

  await test('no rate limit configured ⇒ no artificial delay', async () => {
    const h = makeSandbox();
    const t0 = Date.now();
    await h.iterate(20, [], 5, 's1', async (i) => [{ i }]);
    assert.ok(Date.now() - t0 < 200, 'unpaced runs should not sleep');
  });

  await test('resume: no sidecar file ⇒ no resume state', async () => {
    const h = makeSandbox();
    assert.strictEqual(h.sandbox.__resumeFor('s1'), null);
    assert.strictEqual(h.sandbox.__resumeFor(''), null, 'missing stepId must not throw');
  });

  await test('resume: the sidecar file is loaded and keyed by step', async () => {
    const file = path.join(os.tmpdir(), `ws_resume_test_${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({
      steps: { s1: { urls: ['https://x/0', 'https://x/2'], rows: [{ old: 1 }, { old: 2 }] } },
    }), 'utf8');
    try {
      const h = makeSandbox({ env: { WS_RESUME_FILE: file } });
      const st = h.sandbox.__resumeFor('s1');
      assert.ok(st, 'step state should load from the sidecar');
      assert.deepStrictEqual(st.urls, ['https://x/0', 'https://x/2']);
      assert.strictEqual(st.rows.length, 2);
      assert.strictEqual(h.sandbox.__resumeFor('other'), null, 'unknown step ⇒ no state');
    } finally { try { fs.unlinkSync(file); } catch (_) {} }
  });

  await test('resume: a corrupt sidecar degrades to a full run rather than crashing', async () => {
    const file = path.join(os.tmpdir(), `ws_resume_bad_${process.pid}.json`);
    fs.writeFileSync(file, '{ not json', 'utf8');
    try {
      const h = makeSandbox({ env: { WS_RESUME_FILE: file } });
      assert.strictEqual(h.sandbox.__resumeFor('s1'), null);
    } finally { try { fs.unlinkSync(file); } catch (_) {} }
  });

  await test('an item is recorded as done only when its rows are committed', async () => {
    const h = makeSandbox();
    const out = [];
    await h.iterate(3, out, 1, 's1', async (i) => [{ i }], (i) => 'https://x/' + i);
    assert.deepStrictEqual(h.staged('s1'), ['https://x/0', 'https://x/1', 'https://x/2']);
    assert.strictEqual(out.length, 3, 'and each of those has a row behind it');
  });

  await test('a FAILED item is never recorded as done, so a resume retries it', async () => {
    const h = makeSandbox();
    const out = [];
    await h.iterate(3, out, 1, 's1', async (i) => {
      if (i === 1) throw new Error('detail page exploded');
      return [{ i }];
    }, (i) => 'https://x/' + i);
    assert.deepStrictEqual(h.staged('s1'), ['https://x/0', 'https://x/2'],
      'the failed url must be absent — re-scraping it is the safe direction');
  });

  await test('an item returning null counts as unfinished, not as "no rows"', async () => {
    const h = makeSandbox();
    await h.iterate(2, [], 1, 's1', async (i) => (i === 0 ? null : [{ i }]), (i) => 'u' + i);
    assert.deepStrictEqual(h.staged('s1'), ['u1']);
  });

  await test('a partial failure keeps its rows but is still not marked done', async () => {
    // The enrich case: the source row is emitted so the parent list is not
    // lost, but the detail page must be revisited.
    const h = makeSandbox();
    const out = [];
    await h.iterate(2, out, 1, 's1',
      async (i) => (i === 0 ? { __failed: true, rows: [{ i, partial: true }] } : [{ i }]),
      (i) => 'u' + i);
    assert.strictEqual(out.length, 2, 'both rows are kept');
    assert.deepStrictEqual(h.staged('s1'), ['u1'], 'only the item that truly finished is done');
  });

  await test('done-ness follows commit order, not completion order', async () => {
    const h = makeSandbox();
    const out = [];
    await h.iterate(6, out, 3, 's1', async (i) => {
      await new Promise(r => setTimeout(r, (6 - i) * 5));   // later items finish first
      return [{ i }];
    }, (i) => 'u' + i);
    assert.deepStrictEqual(h.staged('s1'), ['u0', 'u1', 'u2', 'u3', 'u4', 'u5']);
  });

  await test('parallel workers report which item each is on', async () => {
    const h = makeSandbox();
    await h.iterate(12, [], 4, 's1', async () => {
      await new Promise(r => setTimeout(r, 15));
      return [{}];
    }, (i) => 'u' + i);
    assert.ok(h.workerReports.length > 0, 'the UI needs per-worker positions under concurrency');
    const widest = h.workerReports.reduce((m, r) => Math.max(m, r.workers.length), 0);
    assert.strictEqual(widest, 4, 'one entry per worker');
    const last = h.workerReports[h.workerReports.length - 1];
    assert.ok(last.workers.every(w => w === null), 'workers report idle once the loop drains');
  });

  await test('a single-worker loop reports no worker lanes (nothing to show)', async () => {
    const h = makeSandbox();
    await h.iterate(5, [], 1, 's1', async (i) => [{ i }], (i) => 'u' + i);
    assert.strictEqual(h.workerReports.length, 0);
  });

  await test('downloaded (clean) scripts get inert resume stubs, no markers', async () => {
    const src = buildCodegenPoolHelper({ instrument: false });
    assert.ok(!/ITER_TICK|ITER_DONE|__checkpoint/.test(src),
      'clean scripts must not emit platform markers');
    assert.ok(/function __resumeFor\(_stepId\) \{ return null; \}/.test(src));
  });

  await test('zero items completes cleanly without opening a tab', async () => {
    const h = makeSandbox();
    const out = [];
    await h.iterate(0, out, 4, 's1', async () => [{}]);
    assert.strictEqual(out.length, 0);
    assert.strictEqual(h.stats().totalPagesOpened, 0);
  });

  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall page-pool tests passed');
})();
