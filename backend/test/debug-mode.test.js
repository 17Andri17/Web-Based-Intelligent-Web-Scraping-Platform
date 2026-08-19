'use strict';

/* ===========================================================================
   Debug Mode
   ---------------------------------------------------------------------------
   A run executes as a child process that reports through one-way stdout
   markers. Debug Mode adds a way back IN — pause before a step, look at the
   page it is about to act on, let it go — and a live picture of the browser
   while it happens.

   Three properties carry the whole feature, and each of them fails silently if
   it breaks, which is why they are pinned here:

     • The gate is emitted around EVERY step, at every nesting depth, and never
       into a downloaded script — where nothing could ever release it and the
       user's script would hang on the first step forever.

     • A debug run gives up the optimisations that would make the picture lie
       (blocked images, parallel tabs, the HTTP fast path). A debugger that
       shows a page the real run never renders teaches the wrong lesson.

     • The gate parks and un-parks on command, and a step the user muted stops
       stopping. Without the mute, a 500-item loop is 1,000 pauses and the
       feature is unusable on exactly the workflows that need it most.

   The screencast path is exercised end-to-end (with a real Chrome) by
   test/debug-run-e2e.test.js; the pacing contract it reuses is covered by
   test/screencast-pacer.test.js.
   ========================================================================= */

const assert = require('assert');
const { generateCode } = require('../workflow/workflowCodegen');
const { buildCodegenDebugHelper } = require('../browser/debugBridge');

let passed = 0;
const ok = (label) => { console.log('  ✓ ' + label); passed++; };
const nextTick = () => new Promise((r) => setImmediate(r));

/* A workflow with a step at every nesting level that matters: top level, a
   loop body, and a selector built from a workflow variable. */
const WORKFLOW = {
  id: 1,
  meta: {
    startUrl: 'https://example.com',
    variables: [{ name: 'term', type: 'string', value: 'shoes' }],
    // Every optimisation debug mode has to switch off, switched on.
    performance: { blockResources: true, blockStylesheets: true, httpFirst: true, concurrency: 4 },
  },
  steps: [
    { id: 's1', type: 'NAVIGATE', kind: 'action', label: 'Open',
      params: { url: 'https://example.com/?q={{term}}' } },
    { id: 's2', type: 'CLICK_ELEMENT', kind: 'action', label: 'Load more',
      params: { selector: '.load-more' } },
    { id: 's3', type: 'EXTRACT_LIST', kind: 'action', label: 'Products',
      params: { containerSelector: '.product-{{term}}', outputVar: 'products', fields: { title: { selector: 'h2' } } } },
    { id: 's4', type: 'FOR_EACH', kind: 'control', label: 'Loop',
      params: { source: 'products', itemVar: 'row' },
      body: [{ id: 's5', type: 'EXTRACT_TEXT', kind: 'action', label: 'Name',
               params: { selector: '.name', outputVar: 'name' } }] },
  ],
};

/* A per-item loop — the only shape that is actually scheduled across several
   tabs (see pagePool's __iterateInto), and so the only one where debug mode's
   "one tab at a time" is observable. */
const PARALLEL_WORKFLOW = {
  id: 2,
  meta: { startUrl: 'https://example.com', performance: { concurrency: 4 } },
  steps: [
    { id: 'p1', type: 'NAVIGATE', kind: 'action', label: 'Open', params: { url: 'https://example.com' } },
    { id: 'p2', type: 'FOR_EACH_ROW', kind: 'control', label: 'Each product',
      params: { source: 'products', itemVar: 'row', openUrlField: 'href', outputVar: 'detailed' },
      body: [{ id: 'p3', type: 'EXTRACT_TEXT', kind: 'action', label: 'Spec',
               params: { selector: '.spec', outputVar: 'spec' } }] },
  ],
};

/* Load the emitted child runtime into a sandbox with a fake `process`, so the
   gate's actual behaviour can be driven without spawning anything. This is the
   real emitted source — not a re-implementation — so a change to the runtime
   that breaks pausing fails here. */
function loadRuntime({ pauseAtStart = true } = {}) {
  const sent = [];
  let onMessage = null;
  const fakeProcess = {
    pid: 1234,
    send: (m) => { sent.push(m); },
    on: (evt, fn) => { if (evt === 'message') onMessage = fn; },
    channel: { unref() {} },
  };
  const src = buildCodegenDebugHelper({ pauseAtStart });
  // eslint-disable-next-line no-new-func
  const factory = new Function('process', '__snapshotPageHtml',
    `${src}\nreturn { gate: __dbgGate, attach: __dbgAttach };`);
  const api = factory(fakeProcess, async () => '<html></html>');
  return {
    sent,
    gate: api.gate,
    send: (msg) => { if (onMessage) onMessage(msg); },
    last: (t) => [...sent].reverse().find((m) => m && m.t === t) || null,
    count: (t) => sent.filter((m) => m && m.t === t).length,
  };
}

(async () => {
  /* ── The gate is emitted where it has to be ───────────────────────────── */
  {
    const code = generateCode(WORKFLOW, { debug: true });

    for (const id of ['s1', 's2', 's3', 's4', 's5']) {
      const before = new RegExp(`__dbgGate\\(\\{"id":"${id}"[^)]*'before'`).test(code);
      const after  = new RegExp(`__dbgGate\\(\\{"id":"${id}"[^)]*'after'`).test(code);
      assert.ok(before && after, `step ${id} has both gates`);
    }
    ok('every step is gated before and after, including inside a loop body');

    // The selector handed to the probe must be the RUNTIME expression: a
    // selector built from a workflow variable has to be probed with the value
    // the step will actually use, not the {{template}} the user typed.
    assert.ok(/'before', \[\{ value: `\.product-\$\{term\}`/.test(code),
      'variable-bearing selector is compiled into the probe as a template literal');
    ok('the probe receives runtime-resolved selectors, not raw templates');

    // A step with no selector of its own must not be handed one belonging to
    // something else — an empty probe is honest, a wrong probe is not.
    assert.ok(/"id":"s1"[^)]*'before', null\)/.test(code), 'NAVIGATE gets a null selector list');
    ok('steps without selectors are gated with no probe rather than a stray one');

    // The failure gate: the page is still open and still broken, which is the
    // one state no post-mortem snapshot can reconstruct.
    assert.ok(/'error', null\)/.test(code), 'the top-level catch gates on failure');
    ok('a thrown step freezes the page instead of only reporting it');
  }

  /* ── …and nowhere it must not be ──────────────────────────────────────── */
  {
    const plain = generateCode(WORKFLOW);
    assert.ok(!/__dbgGate|__dbgAttach|__DBG_CFG/.test(plain), 'no debug runtime in a normal run');
    ok('a normal run carries no debug code at all');

    // The dangerous one: a downloaded script that parks on a gate would hang
    // on step 1 with nothing in the world able to release it.
    const downloaded = generateCode(WORKFLOW, { clean: true, debug: true });
    assert.ok(!/__dbgGate|__dbgAttach|__DBG_CFG/.test(downloaded),
      'debug is refused for a downloaded script even when asked for');
    ok('a downloaded script is never gated, even with debug requested');
  }

  /* ── The optimisations a debug run gives up ───────────────────────────── */
  {
    const plain = generateCode(WORKFLOW);
    const debug = generateCode(WORKFLOW, { debug: true });

    assert.ok(/__BLOCK_TYPES/.test(plain), 'the normal run blocks resources (as configured)');
    assert.ok(!/__BLOCK_TYPES/.test(debug),
      'the debug run loads images/fonts/stylesheets so the stream shows the real page');
    ok('resource blocking is off in debug — the picture is the page the user has');

    // Concurrency 4 was configured; a per-item loop must be scheduled at 1 in
    // debug, because "which of the four tabs am I looking at?" has no answer.
    const workerCount = (code) => {
      const m = code.match(/__iterateInto\(browser, [^,]+, [^,]+, (\d+),/);
      return m ? Number(m[1]) : null;
    };
    assert.strictEqual(workerCount(generateCode(PARALLEL_WORKFLOW)), 4,
      'the normal run keeps the configured concurrency');
    assert.strictEqual(workerCount(generateCode(PARALLEL_WORKFLOW, { debug: true })), 1,
      'the debug run walks items one at a time');
    ok('parallelism is off in debug — one tab, unambiguously the live one');

    assert.ok(/await __dbgAttach\(_p\)/.test(debug),
      'every tab the run opens registers with the screencast');
    ok('the screencast follows the run through the single page factory');
  }

  /* ── Reporting captured rows as they are captured ─────────────────────
     The production run reports rows on a 1.5s timer, which bounds stdout on a
     fast loop. The cost is that a loop finishing inside one window never
     reports at all — so a watcher sees the count from BEFORE the loop for the
     whole of it (a scalar captured earlier reads as "1 row", stuck there),
     and only the final total is right. Correct at the end, wrong throughout,
     and wrong precisely where someone is watching to see progress. */
  {
    const plain = generateCode(WORKFLOW);
    const debug = generateCode(WORKFLOW, { debug: true });

    assert.ok(/let __CHECKPOINT_MS = 1500;/.test(plain), 'a normal run keeps the throttle');
    assert.ok(!/__CHECKPOINT_MS = 0/.test(plain), 'and is not switched out of it');
    assert.ok(/__CHECKPOINT_MS = 0/.test(debug), 'a debug run reports on every step instead');
    ok('a debug run reports captured rows as they are captured, not on a timer');
  }

  /* ── The gate parks, and lets go on command ───────────────────────────── */
  {
    const rt = loadRuntime();
    const step = { id: 's1', label: 'Open', type: 'NAVIGATE' };

    let released = false;
    const parked = rt.gate(step, 'before', null).then(() => { released = true; });
    await nextTick();

    assert.strictEqual(released, false, 'the run is parked');
    const paused = rt.last('paused');
    assert.ok(paused && paused.payload.step.id === 's1', 'the pause names the step it stopped on');
    assert.strictEqual(paused.payload.when, 'before', 'and which side of it');
    ok('a debug run starts parked on its first step');

    rt.send({ t: 'resume', mode: 'run' });
    await parked;
    assert.strictEqual(released, true, 'resume released the gate');
    assert.ok(rt.last('resumed'), 'and the window is told it moved on');
    ok('resume releases the gate and reports it');

    // In 'run' mode nothing stops except a breakpoint.
    await rt.gate({ id: 's2' }, 'before', null);
    assert.strictEqual(rt.count('paused'), 1, 'no second pause');
    ok('after resume the run continues without stopping at every step');
  }

  /* ── Breakpoints, stepping, muting ────────────────────────────────────── */
  {
    const rt = loadRuntime({ pauseAtStart: false });

    rt.send({ t: 'breakpoints', ids: ['s3'] });
    await rt.gate({ id: 's2' }, 'before', null);
    assert.strictEqual(rt.count('paused'), 0, 'a step that is not a breakpoint does not stop');

    let hit = false;
    const parked = rt.gate({ id: 's3' }, 'before', null).then(() => { hit = true; });
    await nextTick();
    assert.strictEqual(rt.count('paused'), 1, 'the breakpoint stopped the run');
    ok('a breakpoint stops exactly its own step');

    // Resuming with 'step' means "stop again at the next gate", which is what
    // Step Over is: run this one, then park.
    rt.send({ t: 'resume', mode: 'step' });
    await parked;
    assert.ok(hit);
    const parked2 = rt.gate({ id: 's4' }, 'before', null);
    await nextTick();
    assert.strictEqual(rt.count('paused'), 2, 'stepping stops at the very next gate');
    ok('step-over runs one step and parks again');

    /* The loop trap. A step inside a 500-item loop is gated 1,000 times; if
       the only way out were resuming 1,000 times, the debugger would be
       unusable on the workflows people most need it for. Muting is the escape,
       and it has to survive being combined with the resume that requests it. */
    rt.send({ t: 'resume', mode: 'step', muteStep: true, stepId: 's4' });
    await parked2;
    await rt.gate({ id: 's4' }, 'before', null);
    await rt.gate({ id: 's4' }, 'after', null);
    assert.strictEqual(rt.count('paused'), 2, 'the muted step no longer stops the run');
    ok('a muted step stops stopping, even in step mode');

    // …but muting one step must not silence the rest of the workflow.
    const parked3 = rt.gate({ id: 's5' }, 'before', null);
    await nextTick();
    assert.strictEqual(rt.count('paused'), 3, 'another step still stops');
    rt.send({ t: 'resume', mode: 'run' });
    await parked3;
    ok('muting is per step, not a global off switch');
  }

  /* ── A failure always stops ───────────────────────────────────────────── */
  {
    const rt = loadRuntime({ pauseAtStart: false });
    // 'run' mode, no breakpoints, and the step is even muted — none of which
    // may swallow the one pause the user cannot get back.
    rt.send({ t: 'mute', stepId: 's9' });
    const parked = rt.gate({ id: 's9' }, 'error', null);
    await nextTick();
    assert.strictEqual(rt.count('paused'), 1, 'the failure parked the run');
    assert.strictEqual(rt.last('paused').payload.when, 'error');
    rt.send({ t: 'resume', mode: 'run' });
    await parked;
    ok('a failure freezes the page whatever the mode says');
  }

  /* ── Nothing happens without a control channel ────────────────────────── */
  {
    // The same emitted source, run by hand with no IPC channel: it must fall
    // straight through rather than park forever waiting for a resume.
    const src = buildCodegenDebugHelper();
    // eslint-disable-next-line no-new-func
    const factory = new Function('process', '__snapshotPageHtml',
      `${src}\nreturn { gate: __dbgGate };`);
    const api = factory({ pid: 1, on() {} }, async () => null);   // no .send
    await api.gate({ id: 's1' }, 'before', null);                 // resolves, or the test times out
    ok('without an IPC channel the gate is inert — the script just runs');
  }

  /* ── The session: viewers, frames, and giving up ──────────────────────── */
  {
    const debugSessions = require('../services/debugSession.service');
    const runEvents = require('../services/runEvents.service');

    // A socket, as much of one as this needs: it records what it was sent and
    // acks on demand, which is what the pacer measures the link with.
    const fakeSocket = () => {
      const acks = [];
      return {
        got: [],
        frames: [],
        emit(evt, payload, ack) {
          if (evt === 'debugFrame') { this.frames.push(payload); if (ack) acks.push(ack); }
          else this.got.push({ evt, payload });
        },
        ackAll() { const n = acks.length; acks.splice(0).forEach((f) => f()); return n; },
      };
    };

    const openSession = (runId, userId) => {
      const sent = [];
      const session = debugSessions.open(runId, { userId, control: (m) => { sent.push(m); return true; } });
      return { session, sent, last: (t) => [...sent].reverse().find((m) => m && m.t === t) || null };
    };

    /* One session per user. A paused run holds an open Chrome and one of the
       global run slots, so a second must be refused with a reason rather than
       queueing invisibly behind the first. */
    {
      const { } = openSession(101, 7);
      const gate = debugSessions.canStart(7);
      assert.strictEqual(gate.ok, false, 'a second debug run is refused');
      assert.strictEqual(gate.runId, 101, 'and says which one is in the way');
      assert.strictEqual(debugSessions.canStart(8).ok, true, 'another user is unaffected');
      debugSessions.close(101);
      assert.strictEqual(debugSessions.canStart(7).ok, true, 'closing releases the slot');
      ok('one debug session per user, released when it ends');
    }

    /* Frames are paced against the viewer. A bounded number ride the wire at
       once; past that the child stops being acked, which is what stops it
       capturing — and, one hop further back, stops Chrome encoding frames
       nobody can receive. */
    {
      const h = openSession(102, 7);
      const win = fakeSocket();
      debugSessions.attachViewer(102, win);

      const acks = () => h.sent.filter((m) => m && m.t === 'frameAck').length;
      const send = (label) => debugSessions.handleChildMessage(102, { t: 'frame', buf: Buffer.from(label), w: 900, h: 600 });

      send('one'); send('two'); send('three');
      assert.strictEqual(win.frames.length, 2, 'only a bounded number of frames are on the wire');
      assert.strictEqual(acks(), 2, 'and the child is throttled to exactly that');
      ok('a window that stops confirming frames stops the capture behind it');

      win.ackAll();
      assert.strictEqual(win.frames.length, 3, 'a confirmed frame makes room for the held one');
      assert.strictEqual(win.frames[2].toString(), 'three', 'and the newest is what goes out');
      ok('the held frame is the current one, never a stale queue');

      // Nobody watching: the child must not be left waiting on an ack that has
      // no reader — that would stall its capture loop for good.
      debugSessions.detachViewer(102, win);
      const delivered = win.frames.length;
      const ackedBefore = acks();
      send('four');
      assert.strictEqual(win.frames.length, delivered, 'a detached window gets nothing');
      assert.strictEqual(acks(), ackedBefore + 1, 'but the child is acked anyway');
      ok('with no viewers frames are dropped, never stalled');
      debugSessions.close(102);
    }

    /* A pause is state, not just an event: a window opening (or reloading)
       while the run is parked must find the current state, because the run is
       stopped and there is no next event to wait for. */
    {
      const h = openSession(103, 7);
      const win = fakeSocket();
      debugSessions.attachViewer(103, win);

      debugSessions.noteStepResult(103, { stepId: 's3', count: 24, fields: { price: { total: 24, nonEmpty: 24 } } });
      debugSessions.handleChildMessage(103, {
        t: 'paused',
        payload: { when: 'after', step: { id: 's3' }, url: 'https://shop/x', probe: [{ selector: '.p', matches: 24 }] },
      });

      const evt = win.got.find((g) => g.evt === 'debugPaused');
      assert.ok(evt, 'the window was told');
      assert.strictEqual(evt.payload.captured.count, 24,
        'an "after" pause carries what the step actually captured');
      ok('a pause reports the page AND what the step it just ran extracted');

      const late = debugSessions.snapshot(103);
      assert.ok(late.paused && late.paused.step.id === 's3',
        'a window attaching mid-pause finds the state it needs to draw');
      ok('the pause survives for a window that opens after it happened');

      // The control channel evaluates selectors inside the run's browser, so
      // what a socket may ask for is an allowlist, not a passthrough.
      assert.strictEqual(debugSessions.command(103, { t: 'resume', mode: 'run' }), true);
      assert.strictEqual(debugSessions.command(103, { t: 'evaluate', js: 'process.exit()' }), false,
        'an unlisted command is refused');
      ok('only the documented commands reach the child');
      debugSessions.close(103);
    }

    /* The run is paused and only a window can release it. If the window is
       gone, nothing ever will — so the session has to give the run up rather
       than leave a browser and a run slot held forever. */
    {
      const h = openSession(104, 7);
      let cancelled = false;
      runEvents.begin(104, { userId: 7, workflowId: 1 });
      runEvents.registerCanceller(104, () => { cancelled = true; });

      const win = fakeSocket();
      debugSessions.attachViewer(104, win);
      debugSessions.handleChildMessage(104, { t: 'paused', payload: { when: 'before', step: { id: 's1' } } });

      assert.deepStrictEqual(debugSessions.sweep(Date.now() + debugSessions.ABANDON_MS + 1), [],
        'a watched session is left alone however long it sits');

      debugSessions.detachViewer(104, win);
      assert.deepStrictEqual(debugSessions.sweep(), [], 'and gets a grace period after the window goes');

      const reaped = debugSessions.sweep(Date.now() + debugSessions.ABANDON_MS + 1);
      assert.deepStrictEqual(reaped, [104], 'past the grace period the run is given up');
      assert.strictEqual(cancelled, true, 'through the same path the Stop button takes');
      assert.strictEqual(debugSessions.get(104), null, 'and the session is gone');
      assert.strictEqual(debugSessions.canStart(7).ok, true, 'freeing the user to start another');
      ok('an abandoned pause is cancelled, not left holding a browser');
      assert.ok(h);
    }
  }

  console.log(`\n${passed} assertions passed\n`);
})().catch((err) => { console.error(err); process.exit(1); });
