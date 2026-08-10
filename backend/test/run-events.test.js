'use strict';

/* ===========================================================================
   Live run progress
   ---------------------------------------------------------------------------
   The bug this exists to prevent: a viewer that arrives mid-run sees an empty
   panel, because progress was only ever delivered as events to the connection
   that started the run. So the property under test is the BACKLOG — a late
   joiner's snapshot must describe the run as if it had been watching from the
   first step, not just whatever happens next.

   The other half is terminal state. Nothing follows the last step, so a step
   left "running" when the run ends would spin forever in the Flow view.
   ========================================================================= */

const assert = require('assert');
const runEvents = require('../services/runEvents.service');

let seq = 1000;
const newRunId = () => ++seq;

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

// Collect what a socket bridge would relay for one run.
function collect(runId) {
  const seen = [];
  const handler = (e) => { if (e.runId === runId) seen.push(e); };
  runEvents.bus.on('event', handler);
  return { seen, stop: () => runEvents.bus.off('event', handler) };
}

console.log('live run progress');

test('a run publishes its shape up front, so a viewer can draw the flow', () => {
  const id = newRunId();
  runEvents.begin(id, { userId: 7, workflowId: 3, trigger: 'schedule', flowTree: [{ id: 's1' }, { id: 's2' }] });
  const snap = runEvents.viewerSnapshot(id);
  assert.strictEqual(snap.status, 'running');
  assert.strictEqual(snap.workflowId, 3);
  assert.strictEqual(snap.trigger, 'schedule');
  assert.deepStrictEqual(snap.flowTree.map(s => s.id), ['s1', 's2']);
});

test('a late joiner gets the backlog, not just what happens next', () => {
  const id = newRunId();
  runEvents.begin(id, { userId: 7, workflowId: 3, flowTree: [{ id: 's1' }, { id: 's2' }] });
  runEvents.log(id, { line: 'first', level: 'info' });
  runEvents.stepBegin(id, { id: 's1', type: 'NAVIGATE' });
  runEvents.log(id, { line: 'second', level: 'info' });
  runEvents.stepBegin(id, { id: 's2', type: 'EXTRACT_LIST' });
  runEvents.iteration(id, { kind: 'start', stepId: 's2', total: 10 });
  runEvents.iteration(id, { kind: 'tick', stepId: 's2', index: 3 });
  runEvents.partial(id, { rows: 42 });

  // Someone opens the panel now.
  const snap = runEvents.viewerSnapshot(id);
  assert.deepStrictEqual(snap.logs.map(l => l.line), ['first', 'second']);
  assert.strictEqual(snap.stepStates.s1, 'done', 'a step the next one superseded is finished');
  assert.strictEqual(snap.stepStates.s2, 'running');
  assert.strictEqual(snap.lastStepId, 's2');
  assert.deepStrictEqual(snap.iterations.s2, { total: 10, index: 4, running: true });
  assert.strictEqual(snap.rowsCaptured, 42);
});

test('a step error is reflected in the snapshot', () => {
  const id = newRunId();
  runEvents.begin(id, { userId: 7, workflowId: 3 });
  runEvents.stepBegin(id, { id: 's1' });
  runEvents.stepError(id, { step: { id: 's1' }, message: 'boom' });
  assert.strictEqual(runEvents.viewerSnapshot(id).stepStates.s1, 'error');
});

test('ending the run resolves every step still marked running', () => {
  const id = newRunId();
  runEvents.begin(id, { userId: 7, workflowId: 3 });
  runEvents.stepBegin(id, { id: 's1' });
  runEvents.iteration(id, { kind: 'start', stepId: 's1', total: 5 });
  runEvents.end(id, { status: 'success' });
  const snap = runEvents.viewerSnapshot(id);
  assert.strictEqual(snap.status, 'success');
  assert.strictEqual(snap.stepStates.s1, 'done', 'nothing follows the last step to move it along');
  assert.strictEqual(snap.iterations.s1.running, false, 'loop counters must stop pulsing');
});

test('a failed run resolves its running step to error, not done', () => {
  const id = newRunId();
  runEvents.begin(id, { userId: 7, workflowId: 3 });
  runEvents.stepBegin(id, { id: 's1' });
  runEvents.end(id, { status: 'error' });
  assert.strictEqual(runEvents.viewerSnapshot(id).stepStates.s1, 'error');
});

test('a partial run keeps its captured rows in the snapshot', () => {
  const id = newRunId();
  runEvents.begin(id, { userId: 7, workflowId: 3 });
  runEvents.partial(id, { rows: 8000 });
  runEvents.end(id, { status: 'partial', results: { products: [{ n: 1 }] } });
  const snap = runEvents.viewerSnapshot(id);
  assert.strictEqual(snap.status, 'partial');
  assert.strictEqual(snap.rowsCaptured, 8000);
  assert.deepStrictEqual(snap.results, { products: [{ n: 1 }] });
});

test('every event is republished for the socket bridge to relay', () => {
  const id = newRunId();
  const c = collect(id);
  runEvents.begin(id, { userId: 7, workflowId: 3 });
  runEvents.log(id, { line: 'x', level: 'info' });
  runEvents.stepBegin(id, { id: 's1' });
  runEvents.iteration(id, { kind: 'start', stepId: 's1', total: 2 });
  runEvents.partial(id, { rows: 1 });
  runEvents.results(id, { a: [1] });
  runEvents.end(id, { status: 'success' });
  c.stop();
  assert.deepStrictEqual(c.seen.map(e => e.event),
    ['started', 'log', 'stepBegin', 'iteration', 'partial', 'results', 'done']);
});

test('the done payload carries what the client needs to render a finish', () => {
  const id = newRunId();
  const c = collect(id);
  runEvents.begin(id, { userId: 7, workflowId: 3 });
  runEvents.end(id, { status: 'success', run: { id }, results: { a: [1] } });
  c.stop();
  const done = c.seen.find(e => e.event === 'done').payload;
  assert.strictEqual(done.status, 'success');
  assert.strictEqual(done.success, true, 'legacy field the client also reads');
  assert.strictEqual(done.exitCode, 0);
  assert.deepStrictEqual(done.results, { a: [1] });
});

test('the log tail is bounded so a long run cannot grow without limit', () => {
  const id = newRunId();
  runEvents.begin(id, { userId: 7, workflowId: 3 });
  for (let i = 0; i < runEvents.LOG_TAIL_MAX + 250; i++) runEvents.log(id, { line: `l${i}`, level: 'info' });
  const snap = runEvents.viewerSnapshot(id);
  assert.strictEqual(snap.logs.length, runEvents.LOG_TAIL_MAX);
  // The TAIL is what's kept — the newest lines, not the oldest.
  assert.strictEqual(snap.logs[snap.logs.length - 1].line, `l${runEvents.LOG_TAIL_MAX + 249}`);
});

test('events for an unknown run are harmless (snapshot may have expired)', () => {
  const id = newRunId();
  runEvents.log(id, { line: 'orphan', level: 'info' });
  runEvents.stepBegin(id, { id: 's1' });
  runEvents.end(id, { status: 'success' });
  assert.strictEqual(runEvents.viewerSnapshot(id), null);
});

console.log('\ncancellation by run id');

test('a live run can be cancelled by whoever is watching it', () => {
  const id = newRunId();
  let aborted = false;
  runEvents.begin(id, { userId: 7, workflowId: 3 });
  runEvents.registerCanceller(id, () => { aborted = true; });
  assert.strictEqual(runEvents.cancel(id), true);
  assert.strictEqual(aborted, true);
});

test('cancelling an unknown or finished run reports failure instead of throwing', () => {
  assert.strictEqual(runEvents.cancel(999999), false);
  const id = newRunId();
  runEvents.begin(id, { userId: 7, workflowId: 3 });
  runEvents.registerCanceller(id, () => {});
  runEvents.end(id, { status: 'success' });
  assert.strictEqual(runEvents.cancel(id), false, 'the canceller is dropped when the run ends');
});

test('ownership is recorded so a watcher can be checked against it', () => {
  const id = newRunId();
  runEvents.begin(id, { userId: 42, workflowId: 3 });
  assert.strictEqual(runEvents.ownerOf(id), 42);
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall run-events tests passed');
