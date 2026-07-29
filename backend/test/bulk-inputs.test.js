'use strict';

/* Unit tests for bulk/parameterized-run helpers:
     • backend  utils/workflowInputs.validateInputs
     • frontend src/utils/bulkInputs.parseBulkRows (evaluated here via vm, so
       the pasted-list parsing that feeds the bulk-run route is covered)
   Run: node test/bulk-inputs.test.js  (from backend/) */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { validateInputs, declaredVariableNames } = require('../utils/workflowInputs');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const meta = { variables: [{ name: 'query' }, { name: 'limit' }] };

console.log('validateInputs');
test('accepts known variables', () => {
  assert.equal(validateInputs(meta, { query: 'shoes', limit: '10' }), null);
});
test('accepts a subset (omitted → default)', () => {
  assert.equal(validateInputs(meta, { query: 'shoes' }), null);
  assert.equal(validateInputs(meta, {}), null);
});
test('rejects unknown variables', () => {
  assert.ok(/Unknown input\(s\): q/.test(validateInputs(meta, { q: 'x' })));
});
test('rejects null values', () => {
  assert.ok(/must not be null/.test(validateInputs(meta, { query: null })));
});
test('rejects non-objects', () => {
  assert.ok(validateInputs(meta, [1, 2]));
  assert.ok(validateInputs(meta, null));
  assert.ok(validateInputs(meta, 'x'));
});
test('declaredVariableNames', () => {
  assert.deepEqual([...declaredVariableNames(meta)], ['query', 'limit']);
  assert.deepEqual([...declaredVariableNames({})], []);
});

// ── frontend bulkInputs.parseBulkRows via vm ────────────────────────────────
function loadBulk() {
  const p = path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'bulkInputs.js');
  const src = fs.readFileSync(p, 'utf8').replace(/^export\s+/gm, '');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;this.__api = { parseBulkRows, splitLine };`, sandbox, { filename: p });
  return sandbox.__api;
}
const bulk = loadBulk();
const vars1 = [{ name: 'url' }];
const vars2 = [{ name: 'query' }, { name: 'limit' }];

console.log('parseBulkRows — single column');
test('one value per line → the sole variable', () => {
  const r = bulk.parseBulkRows('https://a.com\nhttps://b.com', { variables: vars1 });
  assert.equal(r.mode, 'single');
  assert.equal(r.target, 'url');
  assert.deepEqual(r.rows, [{ url: 'https://a.com' }, { url: 'https://b.com' }]);
});
test('blank lines are ignored', () => {
  const r = bulk.parseBulkRows('a\n\n  \nb\n', { variables: vars1 });
  assert.equal(r.rows.length, 2);
});
test('multi-var: each line fills the chosen columnVar', () => {
  const r = bulk.parseBulkRows('shoes\nboots', { variables: vars2, columnVar: 'query' });
  assert.equal(r.mode, 'single');
  assert.deepEqual(r.rows, [{ query: 'shoes' }, { query: 'boots' }]);
});

console.log('parseBulkRows — CSV header');
test('header row matching variable names → per-column objects', () => {
  const r = bulk.parseBulkRows('query,limit\nshoes,10\nboots,5', { variables: vars2 });
  assert.equal(r.mode, 'csv');
  assert.deepEqual(r.columns, ['query', 'limit']);
  assert.deepEqual(r.rows, [{ query: 'shoes', limit: '10' }, { query: 'boots', limit: '5' }]);
});
test('quoted cell with a comma stays one value', () => {
  const r = bulk.parseBulkRows('query,limit\n"a,b",3', { variables: vars2 });
  assert.deepEqual(r.rows[0], { query: 'a,b', limit: '3' });
});
test('a header-looking line whose cells are NOT all vars is treated as data', () => {
  // 'url' is the only var; "url,extra" has a non-var cell → single-column mode.
  const r = bulk.parseBulkRows('url,extra\nx', { variables: vars1 });
  assert.equal(r.mode, 'single');
});
test('tab-delimited CSV is detected', () => {
  const r = bulk.parseBulkRows('query\tlimit\nshoes\t10', { variables: vars2 });
  assert.equal(r.mode, 'csv');
  assert.deepEqual(r.rows[0], { query: 'shoes', limit: '10' });
});
test('no variables → an error, no rows', () => {
  const r = bulk.parseBulkRows('a\nb', { variables: [] });
  assert.equal(r.rows.length, 0);
  assert.ok(r.error);
});
test('empty text → no rows', () => {
  assert.deepEqual(bulk.parseBulkRows('', { variables: vars1 }).rows, []);
});

console.log(`\n${passed} assertions passed`);
