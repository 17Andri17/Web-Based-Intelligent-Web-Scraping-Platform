'use strict';

/* Unit tests for the run-to-run diff engine (services/changeDiff.service).
   Run: node test/changeDiff.test.js  (from backend/) */

const assert = require('assert');
const { diffResults, summarizeDiff } = require('../services/changeDiff.service');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('diffResults — added / removed / changed');
test('detects an added row', () => {
  const prev = { p: [{ id: 'a', price: '1' }] };
  const curr = { p: [{ id: 'a', price: '1' }, { id: 'b', price: '2' }] };
  const d = diffResults(prev, curr, { output: 'p', keyField: 'id' });
  assert.equal(d.summary.added, 1);
  assert.equal(d.added[0].id, 'b');
  assert.equal(d.summary.removed, 0);
  assert.equal(d.summary.changed, 0);
  assert.equal(d.summary.unchanged, 1);
  assert.equal(d.hasChanges, true);
});
test('detects a removed row', () => {
  const prev = { p: [{ id: 'a' }, { id: 'b' }] };
  const curr = { p: [{ id: 'a' }] };
  const d = diffResults(prev, curr, { output: 'p', keyField: 'id' });
  assert.equal(d.summary.removed, 1);
  assert.equal(d.removed[0].id, 'b');
});
test('detects a changed row and names the changed fields', () => {
  const prev = { p: [{ id: 'a', price: '10', stock: '5' }] };
  const curr = { p: [{ id: 'a', price: '12', stock: '5' }] };
  const d = diffResults(prev, curr, { output: 'p', keyField: 'id' });
  assert.equal(d.summary.changed, 1);
  assert.deepEqual(d.changed[0].fields, ['price']);
  assert.equal(d.changed[0].key, 'a');           // prefix stripped
  assert.equal(d.changed[0].before.price, '10');
  assert.equal(d.changed[0].after.price, '12');
});
test('a field appearing or disappearing counts as a change', () => {
  const prev = { p: [{ id: 'a', price: '10' }] };
  const curr = { p: [{ id: 'a', price: '10', sale: 'yes' }] };
  const d = diffResults(prev, curr, { output: 'p', keyField: 'id' });
  assert.equal(d.summary.changed, 1);
  assert.deepEqual(d.changed[0].fields, ['sale']);
});
test('identical runs → no changes', () => {
  const same = { p: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }] };
  const d = diffResults(same, JSON.parse(JSON.stringify(same)), { output: 'p', keyField: 'id' });
  assert.equal(d.hasChanges, false);
  assert.equal(d.summary.unchanged, 2);
});

console.log('diffResults — value semantics');
test('number vs string of same value is not a change', () => {
  const prev = { p: [{ id: 'a', n: 5 }] };
  const curr = { p: [{ id: 'a', n: '5' }] };
  const d = diffResults(prev, curr, { output: 'p', keyField: 'id' });
  assert.equal(d.summary.changed, 0);
});
test('nested object values compared structurally', () => {
  const prev = { p: [{ id: 'a', meta: { x: 1 } }] };
  const curr = { p: [{ id: 'a', meta: { x: 2 } }] };
  const d = diffResults(prev, curr, { output: 'p', keyField: 'id' });
  assert.deepEqual(d.changed[0].fields, ['meta']);
});

console.log('diffResults — whole-row & edges');
test('whole-row keying: a changed field reads as remove+add', () => {
  const prev = { p: [{ name: 'A', price: '1' }] };
  const curr = { p: [{ name: 'A', price: '2' }] };
  const d = diffResults(prev, curr, { output: 'p', keyField: null });
  assert.equal(d.summary.added, 1);
  assert.equal(d.summary.removed, 1);
  assert.equal(d.summary.changed, 0);
});
test('missing output on one side → all added or all removed', () => {
  const d1 = diffResults({}, { p: [{ id: 'a' }] }, { output: 'p', keyField: 'id' });
  assert.equal(d1.summary.added, 1);
  const d2 = diffResults({ p: [{ id: 'a' }] }, {}, { output: 'p', keyField: 'id' });
  assert.equal(d2.summary.removed, 1);
});
test('null previous (first monitored run) → everything added', () => {
  const d = diffResults(null, { p: [{ id: 'a' }, { id: 'b' }] }, { output: 'p', keyField: 'id' });
  assert.equal(d.summary.added, 2);
  assert.equal(d.summary.before, 0);
});
test('before/after totals reported', () => {
  const d = diffResults({ p: [{ id: 'a' }] }, { p: [{ id: 'a' }, { id: 'b' }] }, { output: 'p', keyField: 'id' });
  assert.equal(d.summary.before, 1);
  assert.equal(d.summary.after, 2);
});

console.log('summarizeDiff');
test('bounds the stored sample and drops before/after bodies for changed', () => {
  const curr = { p: Array.from({ length: 50 }, (_, i) => ({ id: String(i) })) };
  const d = diffResults({ p: [] }, curr, { output: 'p', keyField: 'id' });
  const s = summarizeDiff(d, { sample: 20 });
  assert.equal(s.counts.added, 50);
  assert.equal(s.sample.added.length, 20);        // capped
  assert.equal(s.hasChanges, true);
  assert.equal(s.output, 'p');
});
test('changed sample carries only key + fields', () => {
  const prev = { p: [{ id: 'a', price: '1' }] };
  const curr = { p: [{ id: 'a', price: '2' }] };
  const s = summarizeDiff(diffResults(prev, curr, { output: 'p', keyField: 'id' }));
  assert.deepEqual(s.sample.changed[0], { key: 'a', fields: ['price'] });
});

console.log(`\n${passed} assertions passed`);
