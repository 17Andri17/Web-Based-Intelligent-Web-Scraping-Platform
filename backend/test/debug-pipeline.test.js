'use strict';

/* ===========================================================================
   Debug Mode — the pipeline seam
   ---------------------------------------------------------------------------
   debug-mode.test.js pins the gate and the session in isolation; the e2e test
   drives a real child against real Chrome. What is left is the join between
   them: the execution pipeline has to hand the child's control channel to the
   session, keep the run otherwise ordinary, and let go of it at the end.

   The properties worth stating, each with a way it could plausibly regress:

     • A debug run is a REAL run — metered, persisted, in the history. It would
       be easy (and wrong) to treat it like the guided tour's practice run and
       quietly stop charging for the pages it loads.

     • It never restarts itself. Retry and self-healing both respawn a fresh
       child with a fresh browser; the person watching would lose their page,
       their pause, and any idea of what they were looking at.

     • It cannot deliver. Nobody subscribed to a run someone stepped through
       by hand and may have stopped half way.

     • The session is released on EVERY exit path, or the user can never start
       another debug run.

   Driven against a throwaway database with a stubbed child, so the pipeline is
   the real one but nothing launches.
   ========================================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-pipeline-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.sqlite');
delete process.env.DB_CLIENT;

const assert = require('assert');
const EventEmitter = require('events');

const db = require('../db/client');
const migrate = require('../db/migrate');
const runner = require('../services/runner.service');
const debugSessions = require('../services/debugSession.service');
const usageRepo = require('../db/repositories/usage.repo');

/* The stub child. Records how it was launched and what was sent to it, and
   lets each test script what the "run" does. Installed on the shared module
   object before the pipeline is required, so the pipeline's reference is this. */
let scripted = null;
const launches = [];
const toChild = [];

runner.runChild = function fakeRunChild(workflow, opts = {}) {
  launches.push(opts);
  const events = new EventEmitter();
  const promise = (async () => {
    await new Promise((r) => setImmediate(r));
    return scripted(events);
  })();
  return { events, promise, control: (msg) => { toChild.push(msg); return true; } };
};

const pipeline = require('../services/executionPipeline.service');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

const STEPS = [
  { kind: 'action', id: 'nav', type: 'NAVIGATE', label: 'Open', params: { url: 'https://e.com' } },
  { kind: 'action', id: 'list', type: 'EXTRACT_LIST', label: 'products',
    params: { containerSelector: '.c', fields: { link: { selector: 'a' } } } },
];

const fakeSocket = () => ({
  got: [],
  emit(evt, payload) { this.got.push({ evt, payload }); },
});

(async () => {
  await migrate.run(db);
  const user = await db.get(
    "INSERT INTO users (username, password_hash, plan) VALUES ('debugger', 'x', 'business') RETURNING id", []);
  const wf = await db.get(
    "INSERT INTO workflows (user_id, name, steps_json) VALUES (?, 'Catalogue', ?) RETURNING id",
    [user.id, JSON.stringify(STEPS)]);

  const run = (opts = {}) => {
    let runId = null;
    const done = pipeline.executeAndPersist({
      workflow: { id: wf.id, steps: STEPS, meta: {}, subflows: {}, customActions: {} },
      userId: user.id,
      workflowId: wf.id,
      trigger: opts.debug ? 'debug' : 'manual',
      debug: !!opts.debug,
      callbacks: { onStart: ({ runId: id }) => { runId = id; if (opts.onStart) opts.onStart(id); } },
    });
    return { done, runIdOf: () => runId };
  };

  console.log('a debug run is a real run');

  await test('the child is launched in debug mode, and only then', async () => {
    launches.length = 0;
    scripted = () => ({ success: true, exitCode: 0, results: { products: [{ link: 'a' }] },
                        stepResults: [], stepSnapshots: {}, pagesFetched: 3 });

    await run({ debug: true }).done;
    assert.strictEqual(launches.at(-1).debug, true, 'debug run asks for a debug child');

    await run({}).done;
    assert.strictEqual(!!launches.at(-1).debug, false, 'a normal run does not');
  });

  await test('it is metered and persisted like any other run', async () => {
    const before = await usageRepo.getForPeriod(user.id);
    scripted = () => ({ success: true, exitCode: 0, results: { products: [{ link: 'a' }] },
                        stepResults: [], stepSnapshots: {}, pagesFetched: 5 });

    const r = run({ debug: true });
    const finalRow = await r.done;

    const after = await usageRepo.getForPeriod(user.id);
    assert.strictEqual(Number(after.runs_used) - Number(before.runs_used), 1, 'the run is counted');
    assert.strictEqual(Number(after.pages_used) - Number(before.pages_used), 5, 'its pages are billed');
    assert.strictEqual(finalRow.status, 'success', 'and it lands in the history as a real run');

    const row = await db.get('SELECT status, rows_captured FROM runs WHERE id = ?', [r.runIdOf()]);
    assert.ok(row && row.status === 'success', 'the row is there');
  });

  console.log('it never restarts itself');

  await test('a repairable failure fails instead of retrying', async () => {
    launches.length = 0;
    // A thrown error on a step with an id is the shape that normally triggers
    // the LLM repair path and a second attempt.
    scripted = () => ({
      success: false, exitCode: 1,
      errorInfo: { message: 'Node is not visible', step: { id: 'list', type: 'EXTRACT_LIST', label: 'products' } },
      results: null, stepResults: [], stepSnapshots: {}, pagesFetched: 1,
    });

    const finalRow = await run({ debug: true }).done;
    assert.strictEqual(launches.length, 1, 'exactly one child was launched');
    assert.notStrictEqual(finalRow.status, 'success', 'and the failure is reported as one');
  });

  await test('an empty extraction is not healed away underneath the user', async () => {
    launches.length = 0;
    // "Succeeded" but captured nothing — the shape that normally starts a
    // self-healing pass and re-runs to verify the fix.
    scripted = () => ({
      success: true, exitCode: 0, results: { products: [] },
      stepResults: [{ stepId: 'list', type: 'EXTRACT_LIST', label: 'products', count: 0, fields: {} }],
      stepSnapshots: { list: { url: 'https://e.com', html: '<html></html>' } },
      pagesFetched: 1,
    });

    await run({ debug: true }).done;
    assert.strictEqual(launches.length, 1, 'no verification re-run happened');
  });

  console.log('the session lives exactly as long as the run');

  await test('the control channel reaches viewers, and is released at the end', async () => {
    const win = fakeSocket();
    let sessionDuringRun = null;

    scripted = (events) => {
      // The child announcing itself, pausing, and being watched — all of it
      // has to work through the session the pipeline registered for us.
      events.emit('debug', { t: 'hello', pid: 999 });
      events.emit('stepResult', { stepId: 'list', count: 7, fields: {} });
      events.emit('debug', { t: 'paused', payload: { when: 'after', step: { id: 'list' }, url: 'https://e.com' } });
      return { success: true, exitCode: 0, results: { products: [] },
               stepResults: [], stepSnapshots: {}, pagesFetched: 1 };
    };

    const r = run({
      debug: true,
      onStart: (runId) => {
        sessionDuringRun = debugSessions.get(runId);
        debugSessions.attachViewer(runId, win);
      },
    });
    await r.done;

    assert.ok(sessionDuringRun, 'a session existed before the first event could arrive');
    const paused = win.got.find((g) => g.evt === 'debugPaused');
    assert.ok(paused, 'the pause reached the window');
    assert.strictEqual(paused.payload.captured.count, 7,
      'carrying what the step captured, folded in from the stdout marker stream');

    assert.strictEqual(debugSessions.get(r.runIdOf()), null, 'the session is released when the run ends');
    assert.strictEqual(debugSessions.canStart(user.id).ok, true, 'so another debug run can start');
    assert.ok(win.got.some((g) => g.evt === 'debugClosed'), 'and the window is told it is over');
  });

  await test('a run that dies mid-flight still releases its session', async () => {
    scripted = () => { throw new Error('child exploded'); };
    const r = run({ debug: true });
    await r.done.catch(() => {});
    assert.strictEqual(debugSessions.get(r.runIdOf()), null, 'no session outlives its run');
    assert.strictEqual(debugSessions.canStart(user.id).ok, true, 'the user is not locked out by a crash');
  });

  console.log('it cannot deliver');

  await test('every outbound side effect is behind the debug guard too', async () => {
    // Same shape as the guarded-block check in tour-demo.test.js: the calls
    // must sit INSIDE the block, not merely after it.
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'executionPipeline.service.js'), 'utf8');
    const m = src.match(/if \(!isDemoRun && !isDebugRun\) \{/);
    assert.ok(m, 'deliveries are guarded against debug runs');
    let depth = 0, end = m.index;
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { end = i; break; }
    }
    const guarded = src.slice(m.index, end);
    for (const call of ['webhookDispatcher.dispatchRunEvent', 'emailNotifier.notifyRunFailed',
                        'changeMonitor.evaluateRun', 'sheetsDelivery.deliverRun']) {
      assert.ok(guarded.includes(call), `${call} is inside the guard`);
    }
  });

  console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
