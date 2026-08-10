'use strict';

const EventEmitter = require('events');

/* ===========================================================================
   runEvents
   ---------------------------------------------------------------------------
   A run's progress used to exist in exactly one place: the socket that started
   it. Step states, the flow tree, the log stream and the results were all
   derived client-side from events delivered to that one connection. So a
   second tab, a reload, or a run started by the scheduler or the API had
   nothing to show — the panel opened empty, which is the "seeing progress
   doesn't really work" problem.

   This makes a run's progress a property of the RUN rather than of whoever
   happened to launch it:

     • every run publishes here, whatever started it (interactive, scheduled,
       API, resumed, sharded);
     • a live snapshot is kept in memory, so a viewer arriving mid-run gets the
       backlog — the flow tree, which steps have run, loop counters, the recent
       log tail — instead of only seeing what happens after it connects;
     • server.js bridges this to socket.io rooms, so any number of viewers can
       watch one run.

   Memory is bounded: only the log TAIL is retained (the full log is in
   run_logs and served by /api/runs/:id/logs), and a finished run's snapshot is
   dropped after a short grace period so a viewer attaching just as the run
   ends still gets a complete final picture.
   ========================================================================= */

const bus = new EventEmitter();
// A busy instance can have several runs going, each with a handful of viewers.
bus.setMaxListeners(0);

const LOG_TAIL_MAX = 400;      // lines kept for late joiners
const KEEP_AFTER_END_MS = 60_000;

/** @type {Map<number, object>} runId → live snapshot */
const runs = new Map();

function snapshotFor(runId) {
  return runs.get(Number(runId)) || null;
}

/**
 * Register a run as started and publish its shape. `flowTree` is the step tree
 * with subflows inlined — the thing the Flow tab draws. Computing it once here
 * means a watcher never has to reconstruct it, and scheduled runs get one too
 * (previously only the interactive path built it).
 */
function begin(runId, { userId, workflowId, workflowName = null, flowTree = [], trigger = 'manual' }) {
  const id = Number(runId);
  const snap = {
    runId: id,
    userId,
    workflowId,
    workflowName,
    trigger,
    status: 'running',
    flowTree: Array.isArray(flowTree) ? flowTree : [],
    stepStates: {},          // stepId → 'running' | 'done' | 'error'
    iterations: {},          // stepId → { total, index, running }
    lastStepId: null,
    logs: [],                // bounded tail
    rowsCaptured: 0,
    stepTimes: {},           // stepId → { n, ms }
    workers: {},             // loop stepId → [itemIndex|null] per parallel worker
    // loop stepId → lane → { item, step, iter }: what each worker is doing
    // right now, kept apart so interleaved workers don't overwrite each other.
    lanes: {},
    // stepId → monotonic count of iterations across ALL lanes. The honest
    // number for a nested loop that several workers are running at once.
    laneTotals: {},
    results: null,
    startedAt: Date.now(),
    endedAt: null,
  };
  runs.set(id, snap);
  emit(id, 'started', { runId: id });
  return snap;
}

function emit(runId, event, payload) {
  bus.emit('event', { runId: Number(runId), event, payload });
}

/* Each recorder folds the event into the snapshot AND republishes it, so a
   watcher that is already attached and one that joins a second later end up
   with the same state. */

function log(runId, entry) {
  const s = snapshotFor(runId);
  if (s) {
    s.logs.push(entry);
    if (s.logs.length > LOG_TAIL_MAX) s.logs.splice(0, s.logs.length - LOG_TAIL_MAX);
  }
  emit(runId, 'log', entry);
}

/* A marker tagged with `owner` came from inside a parallel worker of that
   loop. Those are recorded per lane rather than folded into the global step
   state, because N workers are at N different points and collapsing them into
   one value produces the flicker (and the jumping counters) rather than
   information. The top-level stream — untagged markers — is unaffected. */
function laneBucket(s, info) {
  if (!s || !info || info.owner == null || info.lane == null) return null;
  const byLane = s.lanes[info.owner] || (s.lanes[info.owner] = {});
  let lane = byLane[info.lane];
  if (!lane) {
    lane = byLane[info.lane] = {
      item: info.item,
      step: null,        // the step this worker is on right now (collapsed view)
      iter: null,        // its position in whichever loop it is inside
      stepStates: {},    // stepId → running|done|error, for THIS worker's item
      iterations: {},    // stepId → { total, index, running }, same scope
      lastStepId: null,
    };
  }
  // A worker moving to a new item starts the body again, so its per-item
  // progress resets — otherwise steps would still read "done" from the
  // previous item and the tree would describe the wrong thing.
  if (info.item != null && lane.item !== info.item) {
    lane.item = info.item;
    lane.stepStates = {};
    lane.iterations = {};
    lane.lastStepId = null;
    lane.iter = null;
  }
  return lane;
}

function stepBegin(runId, info) {
  const s = snapshotFor(runId);
  const lane = laneBucket(s, info);
  if (lane && info.id) {
    lane.step = { id: info.id, label: info.label, type: info.type };
    // Same "the previous step finished when the next one starts" rule as the
    // top-level stream — just scoped to this worker, so each one carries its
    // own copy of the subflow's progress.
    if (lane.lastStepId && lane.stepStates[lane.lastStepId] === 'running') {
      lane.stepStates[lane.lastStepId] = 'done';
    }
    lane.stepStates[info.id] = 'running';
    lane.lastStepId = info.id;
  } else if (s && info && info.id) {
    // The previous step is only known to have finished when the next one
    // starts — the runner emits no "step ended" marker.
    if (s.lastStepId && s.stepStates[s.lastStepId] === 'running') s.stepStates[s.lastStepId] = 'done';
    s.stepStates[info.id] = 'running';
    s.lastStepId = info.id;
  }
  emit(runId, 'stepBegin', info);
}

function stepError(runId, info) {
  const s = snapshotFor(runId);
  const stepId = info && info.step && info.step.id;
  if (s && stepId) s.stepStates[stepId] = 'error';
  emit(runId, 'stepError', info);
}

function iteration(runId, info) {
  const s = snapshotFor(runId);
  const lane = laneBucket(s, info);
  if (lane && info.stepId) {
    // This lane's own position in a nested loop — kept per loop id so a body
    // with several loops renders each of them, and also as `iter` for the
    // one-line collapsed summary.
    const cur = lane.iterations[info.stepId] || {};
    if (info.kind === 'start') {
      lane.iterations[info.stepId] = { total: info.total || 0, index: 0, running: true };
      lane.iter = { stepId: info.stepId, total: info.total || 0, index: 0 };
    } else if (info.kind === 'tick') {
      lane.iterations[info.stepId] = { ...cur, index: (info.index ?? 0) + 1, running: true };
      lane.iter = { ...(lane.iter || {}), stepId: info.stepId, index: (info.index ?? 0) + 1 };
    } else if (info.kind === 'end') {
      lane.iterations[info.stepId] = { ...cur, running: false };
      lane.iter = null;
    }
    // Plus a running total across all lanes. Unlike a per-lane index — which
    // restarts on every item and reads as noise when several are interleaved —
    // this only ever goes up, so it is the number worth showing on the step.
    if (s && info.kind === 'tick') {
      s.laneTotals[info.stepId] = (s.laneTotals[info.stepId] || 0) + 1;
    }
  } else if (s && info && info.stepId) {
    const cur = s.iterations[info.stepId] || {};
    if (info.kind === 'start')     s.iterations[info.stepId] = { total: info.total || 0, index: 0, running: true };
    else if (info.kind === 'tick') s.iterations[info.stepId] = { ...cur, index: (info.index ?? 0) + 1, running: true };
    else if (info.kind === 'end')  s.iterations[info.stepId] = { ...cur, running: false };
  }
  emit(runId, 'iteration', info);
}

function partial(runId, info) {
  const s = snapshotFor(runId);
  if (s && info) {
    if (typeof info.rows === 'number') s.rowsCaptured = info.rows;
    // stepId → { n, ms }. Kept on the snapshot so a viewer that attaches late
    // sees the timings accumulated so far rather than starting from blank.
    if (info.times) s.stepTimes = Object.assign({}, s.stepTimes, info.times);
  }
  emit(runId, 'partial', info);
}

// Which item each parallel worker is on, for one loop.
function workers(runId, info) {
  const s = snapshotFor(runId);
  if (s && info && info.stepId) s.workers[info.stepId] = info.workers || [];
  emit(runId, 'workers', info);
}

function results(runId, payload) {
  const s = snapshotFor(runId);
  if (s) s.results = payload;
  emit(runId, 'results', payload);
}

/**
 * The run reached a terminal state. Any step still marked running is resolved
 * to match the outcome, so the Flow view never strands a step on a spinner —
 * nothing follows the last step to move it along.
 */
function end(runId, { status, run = null, results: finalResults = null }) {
  const s = snapshotFor(runId);
  if (s) {
    s.status = status || 'done';
    s.endedAt = Date.now();
    const ok = status === 'success';
    for (const k of Object.keys(s.stepStates)) {
      if (s.stepStates[k] === 'running') s.stepStates[k] = ok ? 'done' : 'error';
    }
    for (const k of Object.keys(s.iterations)) s.iterations[k] = { ...s.iterations[k], running: false };
    // No worker is on anything once the run is over.
    for (const k of Object.keys(s.workers)) s.workers[k] = (s.workers[k] || []).map(() => null);
    // Steps that only ever ran inside workers have no entry in the shared
    // state — that is what let them be shown per lane. Once the lanes are
    // cleared they would fall back to "idle", i.e. look like they never ran,
    // so fold their outcome into the shared state first.
    for (const byLane of Object.values(s.lanes)) {
      for (const lane of Object.values(byLane || {})) {
        for (const stepId of Object.keys((lane && lane.stepStates) || {})) {
          if (s.stepStates[stepId] !== 'error') s.stepStates[stepId] = ok ? 'done' : 'error';
        }
      }
    }
    s.lanes = {};   // nobody is mid-item once the run is over
    if (finalResults) s.results = finalResults;
    // Held briefly so a viewer attaching as the run ends still sees the whole
    // picture; after that the DB is the record and memory is released.
    setTimeout(() => runs.delete(Number(runId)), KEEP_AFTER_END_MS).unref?.();
  }
  // Shape kept identical to what the launching socket used to receive, so the
  // client renders a finished run through one code path regardless of whether
  // it started the run or joined halfway through.
  emit(runId, 'done', {
    runId: Number(runId),
    status,
    success: status === 'success',
    exitCode: status === 'success' ? 0 : 1,
    run,
    results: finalResults,
  });
  cancellers.delete(Number(runId));
}

/* ── Cancellation by run id ───────────────────────────────────────────────
   Cancelling used to be bound to the socket that started the run ("stop the
   thing I launched"). Once a run can be watched from anywhere, that no longer
   holds: the tab looking at a runaway job is often not the one that started
   it, and may be a different session entirely. Registering the abort here
   makes "stop this run" a property of the run. */
const cancellers = new Map();   // runId → () => void

function registerCanceller(runId, fn) {
  if (typeof fn === 'function') cancellers.set(Number(runId), fn);
}

/** @returns {boolean} whether a live run was actually signalled. */
function cancel(runId) {
  const fn = cancellers.get(Number(runId));
  if (!fn) return false;
  try { fn(); } catch (_) {}
  return true;
}

/* Everything a late viewer needs to render the panel as if it had been
   watching from the start. userId is stripped — callers check ownership.

   The mutable parts are COPIED. Handing out the live objects would mean a
   caller's "snapshot" kept changing under it as the run progressed — which is
   the opposite of what a snapshot is for, and produces the confusing result
   that a view captured mid-run reads as finished by the time it's inspected.
   flowTree is fixed at begin() and results is replaced wholesale rather than
   mutated, so those can be shared by reference (results can be large). */
function viewerSnapshot(runId) {
  const s = snapshotFor(runId);
  if (!s) return null;
  return {
    runId: s.runId,
    workflowId: s.workflowId,
    workflowName: s.workflowName,
    trigger: s.trigger,
    status: s.status,
    flowTree: s.flowTree,
    stepStates: { ...s.stepStates },
    iterations: Object.fromEntries(Object.entries(s.iterations).map(([k, v]) => [k, { ...v }])),
    lastStepId: s.lastStepId,
    logs: s.logs.slice(),
    rowsCaptured: s.rowsCaptured,
    stepTimes: Object.assign({}, s.stepTimes),
    workers: Object.assign({}, s.workers),
    lanes: JSON.parse(JSON.stringify(s.lanes || {})),
    laneTotals: Object.assign({}, s.laneTotals),
    results: s.results,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
  };
}

function ownerOf(runId) {
  const s = snapshotFor(runId);
  return s ? s.userId : null;
}

function liveRunIds() {
  return Array.from(runs.keys());
}

module.exports = {
  bus, begin, log, stepBegin, stepError, iteration, partial, workers, results, end,
  viewerSnapshot, ownerOf, liveRunIds,
  registerCanceller, cancel,
  LOG_TAIL_MAX,
};
