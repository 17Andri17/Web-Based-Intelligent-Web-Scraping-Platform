'use strict';

/* ===========================================================================
   Watching a run — pipeline → runEvents → viewer snapshot
   ---------------------------------------------------------------------------
   run-events.test.js checks the bookkeeping in isolation. This drives the REAL
   execution pipeline against a throwaway database with a stubbed child process,
   because the failure being fixed was an integration one: progress existed, but
   only as events aimed at one socket, so nothing that arrived later could see
   it. What matters here is that a viewer who never started the run — the
   scheduler's run, another tab's run, a run from before a reload — can
   reconstruct the whole picture from the snapshot alone.
   ========================================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-run-test-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.sqlite');
delete process.env.DB_CLIENT;

const assert = require('assert');
const EventEmitter = require('events');

const db = require('../db/client');
const migrate = require('../db/migrate');
const runner = require('../services/runner.service');
const runEvents = require('../services/runEvents.service');

// Stand in for the generated child process. Replaced on the shared module
// object before the pipeline is required, so the pipeline's own reference
// picks it up — no Chrome, no network, but every event the real runner emits.
let scripted = null;
runner.runChild = function fakeRunChild() {
  const events = new EventEmitter();
  const promise = (async () => {
    await new Promise(r => setImmediate(r));
    return scripted(events);
  })();
  return { events, promise };
};

const pipeline = require('../services/executionPipeline.service');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

const STEPS = [
  { kind: 'action', id: 'nav', type: 'NAVIGATE', label: 'Open list', params: { url: 'https://e.com' } },
  { kind: 'action', id: 'list', type: 'EXTRACT_LIST', label: 'products',
    params: { containerSelector: '.c', fields: { link: { selector: 'a', kind: 'attr', attribute: 'href' } } } },
];

(async () => {
  await migrate.run(db);
  const user = await db.get(
    "INSERT INTO users (username, password_hash) VALUES ('watcher','x') RETURNING id", []);
  const wf = await db.get(
    "INSERT INTO workflows (user_id, name, steps_json) VALUES (?, 'Catalogue', ?) RETURNING id",
    [user.id, JSON.stringify(STEPS)]);

  console.log('watching a run');

  // Snapshots taken WHILE the run is in flight, from outside the pipeline —
  // exactly what a watcher's `watchRun` would return at that moment.
  const midRun = [];

  await test('a run started with no socket is still fully watchable', async () => {
    scripted = async (events) => {
      events.emit('stepBegin', { id: 'nav', type: 'NAVIGATE', label: 'Open list' });
      events.emit('log', { line: 'navigating…', level: 'info' });
      events.emit('stepBegin', { id: 'list', type: 'EXTRACT_LIST', label: 'products' });
      events.emit('iteration', { kind: 'start', stepId: 'list', total: 3 });
      events.emit('iteration', { kind: 'tick', stepId: 'list', index: 0 });
      events.emit('partial', { results: { products: [{ n: 1 }] }, rows: 1, progress: null });
      // Grab the live view at the point a watcher would attach.
      midRun.push(runEvents.viewerSnapshot(runEvents.liveRunIds()[0]));
      const results = { products: [{ n: 1 }, { n: 2 }, { n: 3 }] };
      events.emit('results', results);
      return { success: true, exitCode: 0, results, errorInfo: null,
               stepResults: [], stepSnapshots: {}, captchaEvents: [],
               partialResults: results, partialRows: 3, sawAnyChunk: true, progress: null };
    };

    // No `callbacks` at all — the scheduler/API shape, which previously left a
    // watcher with nothing to look at.
    const run = await pipeline.executeAndPersist({
      workflow: { id: wf.id, steps: STEPS, meta: {}, customActions: {}, subflows: {} },
      userId: user.id, workflowId: wf.id, trigger: 'schedule',
    });
    assert.strictEqual(run.status, 'success');

    const snap = midRun[0];
    assert.ok(snap, 'a watcher attaching mid-run must find a snapshot');
    assert.strictEqual(snap.trigger, 'schedule');
    assert.strictEqual(snap.status, 'running');
    assert.deepStrictEqual(snap.flowTree.map(s => s.id), ['nav', 'list'],
      'the flow tree is built for every run, not only interactive ones');
    assert.strictEqual(snap.stepStates.nav, 'done');
    assert.strictEqual(snap.stepStates.list, 'running');
    assert.strictEqual(snap.lastStepId, 'list');
    assert.deepStrictEqual(snap.iterations.list, { total: 3, index: 1, running: true });
    assert.ok(snap.logs.some(l => /navigating/.test(l.line)), 'the log backlog is available');
    assert.strictEqual(snap.rowsCaptured, 1);
  });

  await test('the flow tree carries labels and types the panel renders', async () => {
    const snap = midRun[0];
    const nav = snap.flowTree.find(s => s.id === 'nav');
    assert.strictEqual(nav.type, 'NAVIGATE');
    assert.strictEqual(nav.label, 'Open list');
  });

  await test('a watcher of a finished run sees resolved steps, not spinners', async () => {
    // The run above has ended by now; its snapshot is briefly retained.
    const id = midRun[0].runId;
    const snap = runEvents.viewerSnapshot(id);
    assert.strictEqual(snap.status, 'success');
    assert.strictEqual(snap.stepStates.list, 'done', 'the last step must not stay running');
    assert.strictEqual(snap.iterations.list.running, false);
    assert.strictEqual(snap.results.products.length, 3);
  });

  await test('a cancelled run surfaces as partial with the rows it kept', async () => {
    const seen = [];
    scripted = async (events) => {
      events.emit('stepBegin', { id: 'list', type: 'EXTRACT_LIST', label: 'products' });
      events.emit('partial', { results: { products: [{ n: 1 }, { n: 2 }] }, rows: 2, progress: null });
      seen.push(runEvents.viewerSnapshot(runEvents.liveRunIds().slice(-1)[0]));
      return { success: false, exitCode: 1,
               results: null,
               errorInfo: { message: 'Run cancelled by user', step: null, cancelled: true },
               stepResults: [], stepSnapshots: {}, captchaEvents: [],
               partialResults: { products: [{ n: 1 }, { n: 2 }] }, partialRows: 2,
               sawAnyChunk: true, progress: null };
    };
    const run = await pipeline.executeAndPersist({
      workflow: { id: wf.id, steps: STEPS, meta: {}, customActions: {}, subflows: {} },
      userId: user.id, workflowId: wf.id, trigger: 'manual',
    });
    assert.strictEqual(run.status, 'partial');
    const snap = runEvents.viewerSnapshot(run.id);
    assert.strictEqual(snap.status, 'partial');
    assert.strictEqual(snap.rowsCaptured, 2);
    assert.strictEqual(snap.stepStates.list, 'error', 'an unfinished step is not reported as done');
    assert.ok(seen[0] && seen[0].status === 'running');
  });

  await test('the launching caller still gets its callbacks (nothing regressed)', async () => {
    const got = { start: 0, log: 0, step: 0, done: 0 };
    scripted = async (events) => {
      events.emit('stepBegin', { id: 'nav', type: 'NAVIGATE' });
      events.emit('log', { line: 'x', level: 'info' });
      const results = { products: [{ n: 1 }] };
      events.emit('results', results);
      return { success: true, exitCode: 0, results, errorInfo: null,
               stepResults: [], stepSnapshots: {}, captchaEvents: [],
               partialResults: results, partialRows: 1, sawAnyChunk: true, progress: null };
    };
    await pipeline.executeAndPersist({
      workflow: { id: wf.id, steps: STEPS, meta: {}, customActions: {}, subflows: {} },
      userId: user.id, workflowId: wf.id, trigger: 'manual',
      callbacks: {
        onStart: () => got.start++,
        onLog: () => got.log++,
        onStepBegin: () => got.step++,
        onDone: () => got.done++,
      },
    });
    assert.strictEqual(got.start, 1, 'onStart fires (this is how the socket joins the run room)');
    assert.ok(got.log > 0);
    assert.strictEqual(got.step, 1);
    assert.strictEqual(got.done, 1);
  });

  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall watch-run tests passed');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
