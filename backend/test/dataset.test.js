'use strict';

/* Unit tests for the cross-run dataset builder (services/dataset.service).
   Run: node test/dataset.test.js  (from backend/) */

const assert = require('assert');
const { listOutputs, buildDataset, defaultKeyField, rowKey } = require('../services/dataset.service');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// Helper: a run (oldest→newest order is the caller's responsibility).
function run(id, startedAt, results, finishedAt = startedAt) {
  return { id, startedAt, finishedAt, results };
}

console.log('listOutputs');
test('enumerates only record-array outputs', () => {
  const runs = [
    run(1, 't1', { products: [{ name: 'A' }], count: 5, note: 'hi' }),
  ];
  const outs = listOutputs(runs);
  assert.deepEqual(outs.map(o => o.key), ['products']);
  assert.deepEqual(outs[0].fields, ['name']);
});
test('unions fields across runs and reports latest count', () => {
  const runs = [
    run(1, 't1', { items: [{ a: 1 }] }),
    run(2, 't2', { items: [{ a: 1, b: 2 }, { a: 3, b: 4 }] }),
  ];
  const [items] = listOutputs(runs);
  assert.deepEqual(items.fields, ['a', 'b']);
  assert.equal(items.latestCount, 2); // newest run has 2 rows
});
test('a key that is a list in only one run is still datasetable', () => {
  const runs = [
    run(1, 't1', { x: 'scalar' }),
    run(2, 't2', { x: [{ a: 1 }] }),
  ];
  assert.deepEqual(listOutputs(runs).map(o => o.key), ['x']);
});

console.log('buildDataset — union & provenance');
test('rows dedupe by keyField across runs; latest values win', () => {
  const runs = [
    run(10, 't1', { p: [{ id: 'x', price: '10' }] }),
    run(11, 't2', { p: [{ id: 'x', price: '12' }, { id: 'y', price: '5' }] }),
  ];
  const ds = buildDataset(runs, { output: 'p', keyField: 'id' });
  assert.equal(ds.totalRows, 2);
  const x = ds.rows.find(r => r.key === 'k:x');
  assert.equal(x.data.price, '12');     // newest value
  assert.equal(x.firstSeenAt, 't1');    // first observed in run 10
  assert.equal(x.lastSeenAt, 't2');
  assert.equal(x.firstRunId, 10);
  assert.equal(x.lastRunId, 11);
  assert.equal(x.timesSeen, 2);
  const y = ds.rows.find(r => r.key === 'k:y');
  assert.equal(y.timesSeen, 1);
  assert.equal(y.firstSeenAt, 't2');
});
test('columns are the first-seen-order union across runs', () => {
  const runs = [
    run(1, 't1', { p: [{ id: 'a', name: 'A' }] }),
    run(2, 't2', { p: [{ id: 'b', name: 'B', rating: 5 }] }),
  ];
  const ds = buildDataset(runs, { output: 'p', keyField: 'id' });
  assert.deepEqual(ds.columns, ['id', 'name', 'rating']);
});
test('latest-wins merge keeps a field absent from the newer row', () => {
  const runs = [
    run(1, 't1', { p: [{ id: 'a', name: 'A', extra: 'keep' }] }),
    run(2, 't2', { p: [{ id: 'a', name: 'A2' }] }), // no `extra`
  ];
  const ds = buildDataset(runs, { output: 'p', keyField: 'id' });
  const a = ds.rows[0];
  assert.equal(a.data.name, 'A2');
  assert.equal(a.data.extra, 'keep'); // not dropped
});
test('a row seen twice within one run counts once for timesSeen', () => {
  const runs = [
    run(1, 't1', { p: [{ id: 'a' }, { id: 'a' }] }),
  ];
  const ds = buildDataset(runs, { output: 'p', keyField: 'id' });
  assert.equal(ds.totalRows, 1);
  assert.equal(ds.rows[0].timesSeen, 1);
});

console.log('buildDataset — whole-row dedupe');
test('null keyField dedupes on the whole row, order-independent', () => {
  const runs = [
    run(1, 't1', { p: [{ a: 1, b: 2 }] }),
    run(2, 't2', { p: [{ b: 2, a: 1 }] }), // same content, different key order
  ];
  const ds = buildDataset(runs, { output: 'p', keyField: null });
  assert.equal(ds.totalRows, 1);
  assert.equal(ds.rows[0].timesSeen, 2);
});
test('missing/blank keyField value falls back to whole-row hash', () => {
  // Two rows, one with id, one without — must not collapse together.
  const runs = [run(1, 't1', { p: [{ id: 'a', v: 1 }, { v: 2 }] })];
  const ds = buildDataset(runs, { output: 'p', keyField: 'id' });
  assert.equal(ds.totalRows, 2);
});

console.log('buildDataset — edge cases');
test('output not present anywhere → empty dataset', () => {
  const ds = buildDataset([run(1, 't1', { p: [{ a: 1 }] })], { output: 'nope' });
  assert.equal(ds.totalRows, 0);
  assert.equal(ds.runCount, 0);
});
test('runCount counts only runs that had the output as a record array', () => {
  const runs = [
    run(1, 't1', { p: [{ id: 'a' }] }),
    run(2, 't2', { p: 'not-a-list' }),
    run(3, 't3', { p: [{ id: 'b' }] }),
  ];
  const ds = buildDataset(runs, { output: 'p', keyField: 'id' });
  assert.equal(ds.runCount, 2);
  assert.equal(ds.totalRows, 2);
});
test('non-record entries inside the array are skipped', () => {
  const runs = [run(1, 't1', { p: [{ id: 'a' }, 'junk', 42, null] })];
  const ds = buildDataset(runs, { output: 'p', keyField: 'id' });
  assert.equal(ds.totalRows, 1);
});

console.log('defaultKeyField');
test('prefers a step-declared keyField when it is a column', () => {
  assert.equal(defaultKeyField(['name', 'link'], 'link'), 'link');
});
test('falls back to an identity-named column (case-insensitive)', () => {
  assert.equal(defaultKeyField(['Name', 'URL', 'Price'], null), 'URL');
});
test('returns null (whole-row) when nothing identifies a row', () => {
  assert.equal(defaultKeyField(['name', 'price'], null), null);
});
test('ignores a step keyField that is not among the columns', () => {
  assert.equal(defaultKeyField(['name', 'id'], 'gone'), 'id');
});

console.log('rowKey');
test('keys by field when present, hashes otherwise', () => {
  assert.equal(rowKey({ id: 'x' }, 'id'), 'k:x');
  assert.ok(rowKey({ id: '' }, 'id').startsWith('h:')); // blank → hash
  assert.ok(rowKey({ a: 1 }, null).startsWith('h:'));
});

console.log(`\n${passed} assertions passed`);
