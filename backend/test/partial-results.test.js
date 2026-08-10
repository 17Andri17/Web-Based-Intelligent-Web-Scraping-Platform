'use strict';

/* ===========================================================================
   Durable partial results — round-trip test
   ---------------------------------------------------------------------------
   The child emits RESULT_CHUNK deltas; the parent reassembles them. Those two
   halves live in different files (workflowCodegen's __checkpoint and
   runner.service's applyResultDelta) and only ever meet over stdout, so this
   test runs the REAL __checkpoint source — extracted from the generated
   script, not a reimplementation — against the REAL parent-side reassembly and
   asserts they agree.

   What matters: after any sequence of mutations + checkpoints, the parent's
   reconstruction equals the child's actual results. That is the property the
   whole feature rests on — if it holds, a run killed at any moment leaves
   behind exactly what it had captured.
   ========================================================================= */

const assert = require('assert');
const vm = require('vm');
const { generateCode } = require('../workflow/workflowCodegen');
const { applyResultChunk, countResultRows } = require('../services/runner.service');

// Pull the checkpoint runtime out of a generated script and instantiate it in a
// sandbox, capturing the RESULT_CHUNK lines it prints. Using the generated
// source (rather than a copy) is the point: if codegen changes, this test sees it.
function makeChild() {
  const code = generateCode({
    id: 1,
    meta: {},
    steps: [{ kind: 'action', id: 'n', type: 'NAVIGATE', params: { url: 'https://example.com' } }],
  });

  const start = code.indexOf('let __rootResults = null;');
  const endMarker = "process.on('SIGTERM'";
  const end = code.indexOf(endMarker);
  assert.ok(start > -1 && end > start,
    'checkpoint runtime not found in generated code — did the marker text change?');
  const runtime = code.slice(start, end);

  const chunks = [];
  const sandbox = {
    Date,
    JSON,
    Object,
    // The checkpoint runtime now sets up the worker-lane context, which pulls
    // in async_hooks — so the sandbox needs a require.
    require,
    console: {
      log: (line) => {
        if (typeof line === 'string' && line.startsWith('RESULT_CHUNK:')) {
          chunks.push(JSON.parse(line.slice('RESULT_CHUNK:'.length)));
        }
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(runtime + '\nthis.__bind = (r) => { __rootResults = r; };', sandbox);

  const results = {};
  sandbox.__bind(results);
  return {
    results,
    chunks,
    // force=true bypasses the 1.5s throttle so a test can checkpoint at will.
    checkpoint: () => vm.runInContext('__checkpoint(true)', sandbox),
    // The real call shape used by generated loops — subject to the throttle.
    checkpointThrottled: () => vm.runInContext('__checkpoint()', sandbox),
  };
}

/* Replay every chunk the child emitted through the parent's reassembly.

   A chunk is an envelope — row deltas plus the completion ledger — because the
   two must be applied together (see applyResultChunk). These tests only assert
   on the rows, so the ledger accumulators are throwaway. */
function reassemble(chunks) {
  const results = {};
  for (const c of chunks) {
    applyResultChunk(c, { results, itemsByStep: new Map(), doneSteps: new Set(), times: {} });
  }
  return results;
}

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

console.log('partial-results round-trip');

test('rows appended across iterations reassemble exactly', () => {
  const child = makeChild();
  for (let i = 0; i < 25; i++) {
    (child.results.products || (child.results.products = [])).push({ id: i, name: 'p' + i });
    child.checkpoint();
  }
  assert.deepStrictEqual(reassemble(child.chunks), child.results);
  assert.strictEqual(countResultRows(child.results), 25);
});

test('emission is O(n), not O(n^2) — each row is sent once', () => {
  const child = makeChild();
  for (let i = 0; i < 50; i++) {
    (child.results.items || (child.results.items = [])).push({ i });
    child.checkpoint();
  }
  const emitted = child.chunks.reduce((n, c) => n + (c.rows?.items?.append?.length || 0), 0);
  assert.strictEqual(emitted, 50, `each row should be emitted exactly once, got ${emitted}`);
});

test('a run killed mid-loop keeps every row captured before the kill', () => {
  const child = makeChild();
  child.results.products = [];
  for (let i = 0; i < 10; i++) { child.results.products.push({ i }); child.checkpoint(); }
  const atDeath = reassemble(child.chunks);          // parent state when SIGKILL lands
  for (let i = 10; i < 20; i++) child.results.products.push({ i }); // never checkpointed
  assert.strictEqual(atDeath.products.length, 10);
  assert.deepStrictEqual(atDeath.products.map(r => r.i), [0,1,2,3,4,5,6,7,8,9]);
});

test('multiple result keys stay independent', () => {
  const child = makeChild();
  child.results.a = [{ n: 1 }];
  child.results.b = [{ n: 2 }];
  child.checkpoint();
  child.results.a.push({ n: 3 });
  child.checkpoint();
  assert.deepStrictEqual(reassemble(child.chunks), child.results);
});

test('scalars are sent once, then only on change', () => {
  const child = makeChild();
  child.results.heading = 'Hello';
  child.checkpoint();
  child.checkpoint();                       // unchanged → nothing new
  const afterNoChange = child.chunks.length;
  child.results.heading = 'Changed';
  child.checkpoint();
  assert.strictEqual(afterNoChange, 1, 'unchanged scalar should not re-emit');
  assert.strictEqual(reassemble(child.chunks).heading, 'Changed');
});

test('an array reset wholesale (step re-ran) replaces rather than appends', () => {
  const child = makeChild();
  child.results.rows = [{ n: 1 }, { n: 2 }, { n: 3 }];
  child.checkpoint();
  child.results.rows = [{ n: 9 }];          // the enrich/for-each-row reset
  child.checkpoint();
  assert.deepStrictEqual(reassemble(child.chunks), child.results,
    'shrunk array must resend in full, not leave stale rows behind');
});

test('throttle suppresses rapid checkpoints; the final flush still catches up', () => {
  const child = makeChild();
  child.results.x = [{ n: 1 }];
  child.checkpoint();                       // forced — establishes the throttle window
  for (let i = 2; i <= 200; i++) {
    child.results.x.push({ n: i });
    child.checkpointThrottled();            // inside the window → suppressed
  }
  assert.strictEqual(reassemble(child.chunks).x.length, 1,
    'throttled calls within the window should not emit');
  // The catch/SIGTERM paths call __checkpoint(true) — nothing is left behind.
  child.checkpoint();
  assert.deepStrictEqual(reassemble(child.chunks), child.results);
});

test('parent reassembly ignores malformed chunks instead of throwing', () => {
  const results = { keep: [{ n: 1 }] };
  const sink = { results, itemsByStep: new Map(), doneSteps: new Set(), times: {} };
  applyResultChunk(null, sink);
  applyResultChunk({ rows: { bad: 'not-an-object' } }, sink);
  applyResultChunk({ rows: { other: {} } }, sink);
  applyResultChunk({ doneItems: 'nope', doneSteps: 'nope' }, sink);
  assert.deepStrictEqual(results, { keep: [{ n: 1 }] });
});

test('countResultRows counts arrays by length and scalars as one', () => {
  assert.strictEqual(countResultRows({ a: [1, 2, 3], b: 'x', c: null }), 4);
  assert.strictEqual(countResultRows({}), 0);
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall partial-results tests passed');
