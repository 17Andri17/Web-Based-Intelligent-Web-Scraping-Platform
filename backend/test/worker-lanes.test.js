'use strict';

/* ===========================================================================
   Worker lanes — nested progress under parallelism
   ---------------------------------------------------------------------------
   The reported symptom: a subflow containing a paginated loop, run with
   several workers, showed its inner counter jumping — 11, 6, 2, 4, 12, 7 …
   Every worker executes the same subflow body, so every worker's inner loop
   emitted ticks for the SAME step id. Folded into one value, the display
   showed whichever worker ticked last: one sequence that is really N
   interleaved ones, describing none of them.

   So the property under test is separation: markers produced inside a worker
   must be attributable to that worker, the shared step state must be left
   alone, and the number shown on the step must be monotonic.
   ========================================================================= */

const assert = require('assert');
const vm = require('vm');
const { generateCode } = require('../workflow/workflowCodegen');
const { buildCodegenPoolHelper } = require('../browser/pagePool');
const runEvents = require('../services/runEvents.service');

/* Boots the real lane runtime (AsyncLocalStorage + __emitMark) together with
   the real pool, and captures the markers a run would emit. */
function makeRuntime() {
  const code = generateCode({
    id: 1, meta: {},
    steps: [{ kind: 'action', id: 'n', type: 'NAVIGATE', params: { url: 'https://e.com' } }],
  });
  const start = code.indexOf('let __rootResults = null;');
  const end = code.indexOf("process.on('SIGTERM'");
  const runtime = code.slice(start, end);

  const marks = [];
  const box = {
    Date, JSON, Object, Array, Set, Math, String, Number, Promise, setTimeout, clearTimeout, require,
    process: { env: {} },
    console: {
      log: (line) => {
        if (typeof line !== 'string') return;
        const i = line.indexOf(':');
        const kind = line.slice(0, i);
        if (/^(STEP_BEGIN|ITER_START|ITER_TICK|ITER_END)$/.test(kind)) {
          marks.push({ kind, ...JSON.parse(line.slice(i + 1)) });
        }
      },
      error: () => {},
    },
    applyStealthToPage: async () => {},
    applyResourceBlocking: async () => {},
    __browser: { newPage: async () => ({ close: async () => {} }) },
  };
  vm.createContext(box);
  vm.runInContext(runtime, box);
  vm.runInContext(buildCodegenPoolHelper({ instrument: true }), box);
  vm.runInContext('this.__bind = (r) => { __rootResults = r; };', box);
  box.__bind({});
  return { box, marks };
}

/* One item of the subflow body: a step, then an inner paginated loop of
   `pages` iterations — exactly the shape that produced the jumping counter. */
function subflowBody(box, pages) {
  return async () => {
    box.__emitMark('STEP_BEGIN', { id: 'inner-extract', type: 'EXTRACT_LIST', label: 'reviews' });
    box.__emitMark('ITER_START', { stepId: 'inner-pg', total: pages });
    for (let p = 0; p < pages; p++) {
      await new Promise(r => setTimeout(r, 1));
      box.__emitMark('ITER_TICK', { stepId: 'inner-pg', index: p });
    }
    box.__emitMark('ITER_END', { stepId: 'inner-pg' });
    return [{ ok: true }];
  };
}

let failures = 0;
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => console.log(`  ok  ${name}`))
    .catch(err => { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); });
}

let seq = 5000;
const newRunId = () => ++seq;

(async () => {
  console.log('worker lanes');

  await test('markers from inside a worker carry its lane and item', async () => {
    const rt = makeRuntime();
    await rt.box.__iterateInto(rt.box.__browser, 8, [], 4, 'sf',
      (i) => subflowBody(rt.box, 3)(), (i) => 'u' + i);

    const inner = rt.marks.filter(m => m.stepId === 'inner-pg' && m.kind === 'ITER_TICK');
    assert.ok(inner.length > 0, 'the inner loop must emit ticks');
    for (const m of inner) {
      assert.strictEqual(m.owner, 'sf', 'tagged with the loop that owns the workers');
      assert.ok(Number.isInteger(m.lane), 'and with which worker produced it');
      assert.ok(Number.isInteger(m.item), 'and which item that worker was on');
    }
    const lanesSeen = new Set(inner.map(m => m.lane));
    assert.strictEqual(lanesSeen.size, 4, 'all four workers are distinguishable');
  });

  await test('the top-level stream stays untagged', async () => {
    const rt = makeRuntime();
    rt.box.__emitMark('STEP_BEGIN', { id: 'top', type: 'NAVIGATE' });
    const top = rt.marks.find(m => m.id === 'top');
    assert.strictEqual(top.lane, undefined, 'nothing outside a worker should be tagged');
  });

  await test('a sequential loop tags nothing (there is only one instance)', async () => {
    const rt = makeRuntime();
    await rt.box.__iterateInto(rt.box.__browser, 3, [], 1, 'sf',
      () => subflowBody(rt.box, 2)(), (i) => 'u' + i);
    assert.ok(rt.marks.every(m => m.lane === undefined),
      'concurrency 1 needs no lane — there is nothing to disambiguate');
  });

  console.log('\nhow the parent keeps them apart');

  await test('lane-tagged progress does NOT overwrite the shared step state', () => {
    const id = newRunId();
    runEvents.begin(id, { userId: 1, workflowId: 1, flowTree: [] });
    runEvents.stepBegin(id, { id: 'sf', type: 'RUN_SUBFLOW' });          // top level
    runEvents.stepBegin(id, { id: 'inner-extract', owner: 'sf', lane: 0, item: 3 });
    runEvents.stepBegin(id, { id: 'inner-extract', owner: 'sf', lane: 1, item: 7 });

    const snap = runEvents.viewerSnapshot(id);
    assert.strictEqual(snap.lastStepId, 'sf', 'the shared cursor still points at the top-level step');
    assert.strictEqual(snap.stepStates['inner-extract'], undefined,
      'a step running in N workers has no single state — it must not claim one');
    assert.strictEqual(snap.lanes.sf[0].item, 3);
    assert.strictEqual(snap.lanes.sf[1].item, 7);
    assert.strictEqual(snap.lanes.sf[1].step.id, 'inner-extract');
  });

  await test('each worker keeps its own inner-loop position', () => {
    const id = newRunId();
    runEvents.begin(id, { userId: 1, workflowId: 1, flowTree: [] });
    runEvents.iteration(id, { kind: 'start', stepId: 'inner-pg', total: 5, owner: 'sf', lane: 0, item: 1 });
    runEvents.iteration(id, { kind: 'tick',  stepId: 'inner-pg', index: 2, owner: 'sf', lane: 0, item: 1 });
    runEvents.iteration(id, { kind: 'start', stepId: 'inner-pg', total: 5, owner: 'sf', lane: 1, item: 2 });
    runEvents.iteration(id, { kind: 'tick',  stepId: 'inner-pg', index: 0, owner: 'sf', lane: 1, item: 2 });

    const snap = runEvents.viewerSnapshot(id);
    assert.strictEqual(snap.lanes.sf[0].iter.index, 3, 'worker 1 is on page 3');
    assert.strictEqual(snap.lanes.sf[1].iter.index, 1, 'worker 2 is on page 1 — not clobbered by worker 1');
    assert.strictEqual(snap.iterations['inner-pg'], undefined,
      'and neither of them pretends to be THE value for that step');
  });

  await test('the step shows a monotonic cross-worker total, never a jumping index', () => {
    const id = newRunId();
    runEvents.begin(id, { userId: 1, workflowId: 1, flowTree: [] });
    // Interleaved exactly like the report: 11, 6, 2, 4, 12, 7 …
    const interleaved = [
      [0, 11], [1, 6], [2, 2], [3, 4], [0, 12], [1, 7], [2, 3], [3, 5], [0, 1], [1, 8],
    ];
    const seen = [];
    for (const [lane, index] of interleaved) {
      runEvents.iteration(id, { kind: 'tick', stepId: 'inner-pg', index, owner: 'sf', lane, item: lane });
      seen.push(runEvents.viewerSnapshot(id).laneTotals['inner-pg']);
    }
    assert.deepStrictEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      'the displayed number must only ever go up');
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i] > seen[i - 1], 'strictly monotonic — this is what the user saw jumping');
    }
  });

  await test('steps that only ran in workers end up done, not idle', () => {
    // They have no shared state while running — that is what lets them be
    // tracked per worker. Clearing the lanes at the end would leave them
    // reading as "never ran" unless their outcome is folded in first.
    const id = newRunId();
    runEvents.begin(id, { userId: 1, workflowId: 1, flowTree: [] });
    runEvents.stepBegin(id, { id: 'inner-a', owner: 'sf', lane: 0, item: 1 });
    runEvents.stepBegin(id, { id: 'inner-b', owner: 'sf', lane: 1, item: 2 });
    assert.strictEqual(runEvents.viewerSnapshot(id).stepStates['inner-a'], undefined,
      'no shared state while the run is live');

    runEvents.end(id, { status: 'success' });
    const snap = runEvents.viewerSnapshot(id);
    assert.strictEqual(snap.stepStates['inner-a'], 'done');
    assert.strictEqual(snap.stepStates['inner-b'], 'done');
  });

  await test('a failed run marks its worker steps errored, not done', () => {
    const id = newRunId();
    runEvents.begin(id, { userId: 1, workflowId: 1, flowTree: [] });
    runEvents.stepBegin(id, { id: 'inner-a', owner: 'sf', lane: 0, item: 1 });
    runEvents.end(id, { status: 'error' });
    assert.strictEqual(runEvents.viewerSnapshot(id).stepStates['inner-a'], 'error');
  });

  await test('finishing the run clears the lanes so nothing is left mid-item', () => {
    const id = newRunId();
    runEvents.begin(id, { userId: 1, workflowId: 1, flowTree: [] });
    runEvents.stepBegin(id, { id: 'x', owner: 'sf', lane: 0, item: 1 });
    runEvents.workers(id, { stepId: 'sf', workers: [1, 2, null, 4] });
    runEvents.end(id, { status: 'success' });
    const snap = runEvents.viewerSnapshot(id);
    assert.deepStrictEqual(snap.lanes, {});
    assert.deepStrictEqual(snap.workers.sf, [null, null, null, null]);
  });

  console.log('\nhow promptly the pool is reported');

  await test('the pool announces its full shape before any item starts', async () => {
    const rt = makeRuntime();
    const reports = [];
    const origLog = rt.box.console.log;
    rt.box.console.log = (line) => {
      if (typeof line === 'string' && line.startsWith('ITER_WORKERS:')) reports.push(JSON.parse(line.slice(13)));
      origLog(line);
    };
    // Items that never finish within the test — the display must still know
    // there are four workers immediately.
    const started = rt.box.__iterateInto(rt.box.__browser, 8, [], 4, 'sf',
      () => new Promise(r => setTimeout(() => r([{}]), 400)), (i) => 'u' + i);
    await new Promise(r => setTimeout(r, 30));

    assert.ok(reports.length > 0, 'a report must arrive before the first item completes');
    assert.strictEqual(reports[0].workers.length, 4,
      'the very first report already describes all four workers, not a partly-filled array');
    await started;
  });

  await test('a coalesced report is DEFERRED, not dropped', async () => {
    // The reported symptom: four workers start within milliseconds of each
    // other, so three reports fell inside the throttle window and were
    // discarded. With items taking minutes, nothing replaced them and the
    // display stayed stale until the first item finished.
    const rt = makeRuntime();
    const reports = [];
    const origLog = rt.box.console.log;
    rt.box.console.log = (line) => {
      if (typeof line === 'string' && line.startsWith('ITER_WORKERS:')) reports.push(JSON.parse(line.slice(13)));
      origLog(line);
    };
    const started = rt.box.__iterateInto(rt.box.__browser, 4, [], 4, 'sf',
      () => new Promise(r => setTimeout(() => r([{}]), 900)), (i) => 'u' + i);

    // Well after the coalescing window, but long before any item finishes.
    await new Promise(r => setTimeout(r, 450));
    const latest = reports[reports.length - 1];
    const busy = latest.workers.filter(w => w != null).length;
    assert.strictEqual(busy, 4,
      `all four workers should show as busy mid-item, saw ${busy} — a dropped report leaves the display stale`);
    await started;
  });

  console.log('\nper-worker step trees');

  await test('each worker accumulates its OWN pass through the body', () => {
    const id = newRunId();
    runEvents.begin(id, { userId: 1, workflowId: 1, flowTree: [] });
    // Worker 0 gets through two steps; worker 1 is still on the first.
    runEvents.stepBegin(id, { id: 'a', label: 'Open', owner: 'sf', lane: 0, item: 1 });
    runEvents.stepBegin(id, { id: 'b', label: 'Extract', owner: 'sf', lane: 0, item: 1 });
    runEvents.stepBegin(id, { id: 'a', label: 'Open', owner: 'sf', lane: 1, item: 2 });

    const snap = runEvents.viewerSnapshot(id);
    assert.deepStrictEqual(snap.lanes.sf[0].stepStates, { a: 'done', b: 'running' },
      'worker 1 finished the first step and is on the second');
    assert.deepStrictEqual(snap.lanes.sf[1].stepStates, { a: 'running' },
      'worker 2 has its own, independent progress');
  });

  await test('a worker moving to a new item resets its tree', () => {
    const id = newRunId();
    runEvents.begin(id, { userId: 1, workflowId: 1, flowTree: [] });
    runEvents.stepBegin(id, { id: 'a', owner: 'sf', lane: 0, item: 1 });
    runEvents.stepBegin(id, { id: 'b', owner: 'sf', lane: 0, item: 1 });
    runEvents.iteration(id, { kind: 'start', stepId: 'pg', total: 4, owner: 'sf', lane: 0, item: 1 });
    runEvents.iteration(id, { kind: 'tick',  stepId: 'pg', index: 2, owner: 'sf', lane: 0, item: 1 });

    // Same worker, next item — the body starts over.
    runEvents.stepBegin(id, { id: 'a', owner: 'sf', lane: 0, item: 2 });

    const lane = runEvents.viewerSnapshot(id).lanes.sf[0];
    assert.strictEqual(lane.item, 2);
    assert.deepStrictEqual(lane.stepStates, { a: 'running' },
      'a "done" mark from the previous item must not linger on the new one');
    assert.deepStrictEqual(lane.iterations, {}, 'nor its loop positions');
  });

  await test('a worker tracks several loops in its body independently', () => {
    const id = newRunId();
    runEvents.begin(id, { userId: 1, workflowId: 1, flowTree: [] });
    runEvents.iteration(id, { kind: 'start', stepId: 'pages',   total: 5, owner: 'sf', lane: 0, item: 1 });
    runEvents.iteration(id, { kind: 'tick',  stepId: 'pages',   index: 1, owner: 'sf', lane: 0, item: 1 });
    runEvents.iteration(id, { kind: 'start', stepId: 'gallery', total: 9, owner: 'sf', lane: 0, item: 1 });
    runEvents.iteration(id, { kind: 'tick',  stepId: 'gallery', index: 6, owner: 'sf', lane: 0, item: 1 });

    const lane = runEvents.viewerSnapshot(id).lanes.sf[0];
    assert.strictEqual(lane.iterations.pages.index, 2);
    assert.strictEqual(lane.iterations.gallery.index, 7);
    assert.strictEqual(lane.iterations.pages.total, 5, 'each loop keeps its own total');
  });

  await test('an ended loop stops pulsing for that worker', () => {
    const id = newRunId();
    runEvents.begin(id, { userId: 1, workflowId: 1, flowTree: [] });
    runEvents.iteration(id, { kind: 'start', stepId: 'pg', total: 3, owner: 'sf', lane: 0, item: 1 });
    runEvents.iteration(id, { kind: 'end',   stepId: 'pg', owner: 'sf', lane: 0, item: 1 });
    const lane = runEvents.viewerSnapshot(id).lanes.sf[0];
    assert.strictEqual(lane.iterations.pg.running, false);
    assert.strictEqual(lane.iter, null, 'and drops out of the one-line summary');
  });

  await test('a late viewer gets the lane detail in its snapshot', () => {
    const id = newRunId();
    runEvents.begin(id, { userId: 1, workflowId: 1, flowTree: [] });
    runEvents.workers(id, { stepId: 'sf', workers: [3, 7] });
    runEvents.stepBegin(id, { id: 'inner', label: 'Reviews', owner: 'sf', lane: 1, item: 7 });
    const snap = runEvents.viewerSnapshot(id);
    assert.deepStrictEqual(snap.workers.sf, [3, 7]);
    assert.strictEqual(snap.lanes.sf[1].step.label, 'Reviews');
  });

  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall worker-lane tests passed');
})();
