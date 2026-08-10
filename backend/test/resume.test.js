'use strict';

/* ===========================================================================
   Resume eligibility + payload
   ---------------------------------------------------------------------------
   Resume is only safe where it is provably correct, so most of this file is
   about the cases it must REFUSE. Wrongly resuming is much worse than wrongly
   re-running: it produces one output stitched from two different workflows, or
   silently omits pages that were never actually scraped. Every refusal here is
   a case where continuing would have produced a plausible-looking but wrong
   result set.
   ========================================================================= */

const assert = require('assert');
const { eligibility, buildPayload } = require('../services/resume.service');

const run = (over = {}) => Object.assign({
  id: 7,
  status: 'partial',
  version_id: 42,
  progress_json: JSON.stringify({ steps: { s1: { urls: ['u1', 'u2'], outKey: 'details' } } }),
  results_json: JSON.stringify({ details: [{ a: 1 }, { a: 2 }] }),
}, over);

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

console.log('resume eligibility');

test('a partial run with progress on the same workflow version is resumable', () => {
  const r = eligibility(run(), 42);
  assert.strictEqual(r.resumable, true);
  assert.strictEqual(r.items, 2);
  assert.strictEqual(r.steps, 1);
});

test('a failed run that captured items is resumable too', () => {
  assert.strictEqual(eligibility(run({ status: 'error' }), 42).resumable, true);
});

test('a cancelled run is resumable', () => {
  assert.strictEqual(eligibility(run({ status: 'cancelled' }), 42).resumable, true);
});

test('a successful run is refused — nothing left to do', () => {
  const r = eligibility(run({ status: 'success' }), 42);
  assert.strictEqual(r.resumable, false);
  assert.match(r.reason, /finished successfully/i);
});

test('an in-flight run is refused', () => {
  assert.strictEqual(eligibility(run({ status: 'running' }), 42).resumable, false);
  assert.strictEqual(eligibility(run({ status: 'queued' }), 42).resumable, false);
});

test('an EDITED workflow is refused — the two halves would not match', () => {
  const r = eligibility(run(), 99);          // current version differs from run's 42
  assert.strictEqual(r.resumable, false);
  assert.match(r.reason, /edited/i);
});

test('a run with no per-item ledger is refused, and says which workflows qualify', () => {
  const r = eligibility(run({ progress_json: null }), 42);
  assert.strictEqual(r.resumable, false);
  assert.match(r.reason, /list of pages/i);
});

test('a ledger with zero finished items is refused (it would just be a fresh run)', () => {
  const r = eligibility(run({ progress_json: JSON.stringify({ steps: { s1: { urls: [] } } }) }), 42);
  assert.strictEqual(r.resumable, false);
  assert.match(r.reason, /did not finish any items/i);
});

test('corrupt progress json is refused rather than throwing', () => {
  const r = eligibility(run({ progress_json: '{ broken' }), 42);
  assert.strictEqual(r.resumable, false);
});

test('a missing run is refused', () => {
  assert.strictEqual(eligibility(null, 42).resumable, false);
});

test('an unknown current version does not block resume', () => {
  // findVersionIdByContent returns null when the current steps were never run.
  // That is not evidence of an edit, so it must not refuse on its own.
  assert.strictEqual(eligibility(run(), null).resumable, true);
});

console.log('\nresume payload');

test('payload carries the finished urls and the rows to restore', () => {
  const p = buildPayload(run());
  assert.deepStrictEqual(p.steps.s1.urls, ['u1', 'u2']);
  assert.deepStrictEqual(p.steps.s1.rows, [{ a: 1 }, { a: 2 }]);
});

test('rows come from the key the loop reported, not a guess', () => {
  const r = run({
    progress_json: JSON.stringify({ steps: { s1: { urls: ['u1'], outKey: 'enriched' } } }),
    results_json: JSON.stringify({ details: [{ wrong: 1 }], enriched: [{ right: 1 }] }),
  });
  assert.deepStrictEqual(buildPayload(r).steps.s1.rows, [{ right: 1 }]);
});

test('a step with no recorded outKey still skips its urls, restoring no rows', () => {
  // Better to re-emit nothing than to restore rows from the wrong key: the
  // urls are what prevent re-scraping, the rows are only a convenience.
  const r = run({ progress_json: JSON.stringify({ steps: { s1: { urls: ['u1'] } } }) });
  const p = buildPayload(r);
  assert.deepStrictEqual(p.steps.s1.urls, ['u1']);
  assert.deepStrictEqual(p.steps.s1.rows, []);
});

test('multiple loops each get their own url set and rows', () => {
  const r = run({
    progress_json: JSON.stringify({
      steps: { s1: { urls: ['a'], outKey: 'k1' }, s2: { urls: ['b', 'c'], outKey: 'k2' } },
    }),
    results_json: JSON.stringify({ k1: [{ n: 1 }], k2: [{ n: 2 }, { n: 3 }] }),
  });
  const p = buildPayload(r);
  assert.strictEqual(p.steps.s1.rows.length, 1);
  assert.strictEqual(p.steps.s2.urls.length, 2);
  assert.strictEqual(p.steps.s2.rows.length, 2);
});

test('no progress ⇒ no payload (caller falls back to a fresh run)', () => {
  assert.strictEqual(buildPayload(run({ progress_json: null })), null);
  assert.strictEqual(buildPayload(null), null);
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall resume tests passed');
