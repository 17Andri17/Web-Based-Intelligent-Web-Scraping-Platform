'use strict';

/* ===========================================================================
   Resume durability — "done" must mean "saved"
   ---------------------------------------------------------------------------
   Reproduces the reported failure. A run paginates 3 pages to collect 30
   links, then walks them with a subflow, and is stopped after a few details.
   Two things went wrong:

     1. Completion was announced the instant a task returned, on its own
        marker, independently of the rows. The checkpoint that carries rows is
        throttled, so a kill in between left the ledger claiming items whose
        data never left the child — the run reported 3 finished but had saved
        1, and the resume then skipped 2 pages forever.

     2. The resume re-ran the pagination to rebuild a link list the previous
        run had already captured and saved.

   The invariant under test is therefore: for every item the ledger calls
   finished, its rows are present in what was saved — under interruption at
   any point, and under parallelism.
   ========================================================================= */

const assert = require('assert');
const vm = require('vm');
const { buildCodegenPoolHelper } = require('../browser/pagePool');
const { generateCode } = require('../workflow/workflowCodegen');
const { applyResultChunk } = require('../services/runner.service');

/* Boots the REAL runtime: the checkpoint/ledger block from generated code plus
   the real pool. `kill()` freezes it exactly as a SIGKILL would — anything not
   already emitted as a RESULT_CHUNK is gone. */
function makeChild() {
  const code = generateCode({
    id: 1, meta: {},
    steps: [{ kind: 'action', id: 'n', type: 'NAVIGATE', params: { url: 'https://e.com' } }],
  });
  const start = code.indexOf('let __rootResults = null;');
  const end = code.indexOf("process.on('SIGTERM'");
  const checkpointRuntime = code.slice(start, end);

  const chunks = [];
  let dead = false;
  const box = {
    Date, JSON, Object, Array, Set, Math, String, Number, Promise, setTimeout, clearTimeout, require,
    process: { env: {} },
    console: {
      log: (line) => {
        if (dead || typeof line !== 'string') return;
        if (line.startsWith('RESULT_CHUNK:')) chunks.push(JSON.parse(line.slice(13)));
      },
      error: () => {},
    },
    applyStealthToPage: async () => {},
    applyResourceBlocking: async () => {},
    __browser: { newPage: async () => ({ close: async () => {} }) },
  };
  vm.createContext(box);
  vm.runInContext(checkpointRuntime, box);
  vm.runInContext(buildCodegenPoolHelper({ instrument: true }), box);
  vm.runInContext('this.__bind = (r) => { __rootResults = r; };', box);

  const results = {};
  box.__bind(results);
  return {
    box, results, chunks,
    kill: () => { dead = true; },
    flush: () => vm.runInContext('__checkpoint(true)', box),
    tick:  () => vm.runInContext('__checkpoint()', box),
  };
}

// Reassemble on the parent side exactly as runner.service does.
function reassemble(chunks) {
  const results = {};
  const itemsByStep = new Map();
  const doneSteps = new Set();
  const times = {};
  for (const c of chunks) applyResultChunk(c, { results, itemsByStep, doneSteps, times });
  return { results, itemsByStep, doneSteps, times };
}

let failures = 0;
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => console.log(`  ok  ${name}`))
    .catch(err => { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); });
}

const LINKS = Array.from({ length: 30 }, (_, i) => `https://shop/p/${i}`);

(async () => {
  console.log('resume durability');

  await test('THE BUG: a kill mid-loop never reports more done than it saved', async () => {
    const child = makeChild();
    child.results.details = [];

    // 30 detail pages, killed partway. The checkpoint is throttled, so most
    // items complete without their rows having been emitted yet.
    await child.box.__iterateInto(child.box.__browser, LINKS.length, child.results.details, 1, 'sf',
      async (i) => {
        if (i === 7) child.kill();          // nothing else can escape after this
        return [{ url: LINKS[i], n: i }];
      },
      (i) => LINKS[i]);

    const parent = reassemble(child.chunks);
    const savedRows = (parent.results.details || []).length;
    const claimedDone = (parent.itemsByStep.get('sf') || new Set()).size;

    // Guard against the test passing for the wrong reason: if nothing at all
    // escaped the child, the invariant would hold trivially and prove nothing.
    assert.ok(claimedDone > 0, 'the run must have saved something before the kill');
    assert.ok(savedRows < LINKS.length, 'and must genuinely have been interrupted');

    assert.ok(claimedDone <= savedRows,
      `ledger claims ${claimedDone} finished but only ${savedRows} rows were saved — ` +
      'a resume would skip pages whose data was lost');

    // Stronger: every url claimed finished must have its row in the output.
    const savedUrls = new Set((parent.results.details || []).map(r => r.url));
    for (const u of (parent.itemsByStep.get('sf') || [])) {
      assert.ok(savedUrls.has(u), `${u} is marked finished but its row was never saved`);
    }
  });

  await test('the invariant holds at every kill point, not just one', async () => {
    for (const killAt of [0, 1, 3, 9, 17, 29]) {
      const child = makeChild();
      child.results.details = [];
      await child.box.__iterateInto(child.box.__browser, LINKS.length, child.results.details, 1, 'sf',
        async (i) => { if (i === killAt) child.kill(); return [{ url: LINKS[i] }]; },
        (i) => LINKS[i]);
      const p = reassemble(child.chunks);
      const savedUrls = new Set((p.results.details || []).map(r => r.url));
      for (const u of (p.itemsByStep.get('sf') || [])) {
        assert.ok(savedUrls.has(u), `kill@${killAt}: ${u} claimed finished without a saved row`);
      }
    }
  });

  await test('the invariant holds under parallelism', async () => {
    const child = makeChild();
    child.results.details = [];
    await child.box.__iterateInto(child.box.__browser, LINKS.length, child.results.details, 6, 'sf',
      async (i) => {
        await new Promise(r => setTimeout(r, (i % 5) * 3));
        if (i === 11) child.kill();
        return [{ url: LINKS[i] }];
      },
      (i) => LINKS[i]);
    const p = reassemble(child.chunks);
    const savedUrls = new Set((p.results.details || []).map(r => r.url));
    for (const u of (p.itemsByStep.get('sf') || [])) {
      assert.ok(savedUrls.has(u), `${u} claimed finished without a saved row`);
    }
  });

  await test('a completed loop reports every item, with every row', async () => {
    const child = makeChild();
    child.results.details = [];
    await child.box.__iterateInto(child.box.__browser, LINKS.length, child.results.details, 4, 'sf',
      async (i) => [{ url: LINKS[i] }], (i) => LINKS[i]);
    child.flush();
    const p = reassemble(child.chunks);
    assert.strictEqual((p.results.details || []).length, 30);
    assert.strictEqual((p.itemsByStep.get('sf') || new Set()).size, 30);
  });

  await test('a finished step is recorded so its work is not repeated', () => {
    const child = makeChild();
    child.results.products = LINKS.map(u => ({ link: u }));
    vm.runInContext('__stageStepDone("pg")', child.box);
    child.flush();
    const p = reassemble(child.chunks);
    assert.ok(p.doneSteps.has('pg'), 'the pagination step must be recorded as complete');
    assert.strictEqual((p.results.products || []).length, 30, 'along with the links it produced');
  });

  await test('a step whose completion never got flushed is NOT recorded', () => {
    // Same durability rule as items: if the report didn't make it out, the
    // resume re-runs the step rather than assuming its output exists.
    const child = makeChild();
    child.results.products = LINKS.map(u => ({ link: u }));
    vm.runInContext('__stageStepDone("pg")', child.box);
    child.kill();
    child.flush();
    const p = reassemble(child.chunks);
    assert.ok(!p.doneSteps.has('pg'));
  });

  await test('per-step timings reach the parent with counts and totals', async () => {
    const child = makeChild();
    vm.runInContext('__stepTime("loop", 900); __stepTime("inner", 100); __stepTime("inner", 300);', child.box);
    child.flush();
    const p = reassemble(child.chunks);
    assert.deepStrictEqual(p.times.loop, { n: 1, ms: 900 }, 'a loop reports its whole duration');
    assert.deepStrictEqual(p.times.inner, { n: 2, ms: 400 },
      'a step inside a loop reports count + total, so the UI can average it');
  });

  await test('an item that fails is never claimed, even if others around it succeed', async () => {
    const child = makeChild();
    child.results.details = [];
    await child.box.__iterateInto(child.box.__browser, 5, child.results.details, 1, 'sf',
      async (i) => (i === 2 ? null : [{ url: LINKS[i] }]),
      (i) => LINKS[i]);
    child.flush();
    const p = reassemble(child.chunks);
    const done = p.itemsByStep.get('sf') || new Set();
    assert.ok(!done.has(LINKS[2]), 'the failed page must be retried on resume');
    assert.strictEqual(done.size, 4);
  });

  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall resume-durability tests passed');
})();
