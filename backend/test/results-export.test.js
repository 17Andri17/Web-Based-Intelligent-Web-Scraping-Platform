'use strict';

/* Plain-node unit tests for the run-results CSV serialiser, plus a parity
   check against the browser copy the editor's Results download uses.
   Run: node test/results-export.test.js  (from backend/) */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { resultsToCsv, toCSV, csvCell } = require('../utils/resultsExport');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('toCSV — header union across heterogeneous rows');
test('columns missing from the first row are still exported', () => {
  // The enrich failure mode: row 0's detail page failed, so it carries none
  // of the enriched columns. Keying headers off row 0 dropped them entirely.
  const rows = [
    { name: 'Widget A', price: '10' },
    { name: 'Widget B', price: '12', rating: '4.5', stock: '3' },
    { name: 'Widget C', price: '9', rating: '4.9', stock: '7' },
  ];
  const lines = toCSV(rows).split('\n');
  assert.equal(lines[0], 'name,price,rating,stock');
  assert.equal(lines[1], 'Widget A,10,,');
  assert.equal(lines[2], 'Widget B,12,4.5,3');
});
test('header order is first-seen, not alphabetical', () => {
  const out = toCSV([{ b: 1 }, { a: 2 }, { c: 3 }]);
  assert.equal(out.split('\n')[0], 'b,a,c');
});
test('a column seen only in the last row survives', () => {
  const out = toCSV([{ a: 1 }, { a: 2 }, { a: 3, late: 'yes' }]);
  assert.equal(out.split('\n')[0], 'a,late');
  assert.equal(out.split('\n')[3], '3,yes');
});

console.log('toCSV — cell values');
test('object cells are JSON, not [object Object]', () => {
  // The enrich "nest" merge strategy puts objects/arrays in a column.
  const out = toCSV([{ name: 'A', reviews: [{ stars: 5 }] }]);
  assert.ok(!out.includes('[object Object]'), 'must not stringify via String()');
  assert.ok(out.includes('"[{""stars"":5}]"'), `got: ${out}`);
});
test('null and undefined become empty cells', () => {
  assert.equal(toCSV([{ a: null, b: undefined, c: 0 }]), 'a,b,c\n,,0');
});
test('quotes, commas and newlines are escaped', () => {
  const out = toCSV([{ n: 'A "quoted" name', p: '9,99', d: 'two\nlines' }]);
  assert.ok(out.includes('"A ""quoted"" name"'));
  assert.ok(out.includes('"9,99"'));
  assert.ok(out.includes('"two\nlines"'));
});
test('a lone carriage return is quoted (RFC 4180)', () => {
  assert.equal(csvCell('a\rb'), '"a\rb"');
});

console.log('toCSV — non-record shapes');
test('flat scalar list stays one unheaded column', () => {
  assert.equal(toCSV(['a', 'b', 'c']), 'a\nb\nc');
});
test('scalar list cells are escaped', () => {
  // Previously data.join('\n') emitted these raw and broke the row.
  assert.equal(toCSV(['plain', 'has,comma']), 'plain\n"has,comma"');
});
test('scalars mixed among records land in a value column', () => {
  const out = toCSV([{ a: 1 }, 'loose']);
  assert.equal(out, 'a,value\n1,\n,loose');
});
test('array rows are values, not records with numeric headers', () => {
  const out = toCSV([[1, 2], [3, 4]]);
  assert.ok(!out.startsWith('0,1'), `array rows must not yield 0,1 headers: ${out}`);
});
test('empty array is empty output', () => {
  assert.equal(toCSV([]), '');
});
test('null/undefined data is empty output', () => {
  assert.equal(toCSV(null), '');
  assert.equal(toCSV(undefined), '');
});
test('a non-array value is JSON', () => {
  assert.equal(toCSV({ a: 1 }), '{"a":1}');
});

console.log('resultsToCsv — sections');
test('one # section per output key (documented /v1 contract)', () => {
  const out = resultsToCsv({ products: [{ a: 1 }], jobs: [{ b: 2 }] });
  assert.equal(out, '# products\na\n1\n\n# jobs\nb\n2');
});
test('empty results is empty output', () => {
  assert.equal(resultsToCsv({}), '');
  assert.equal(resultsToCsv(null), '');
});

/* ── Parity with the browser copy ────────────────────────────────────────────
   frontend/src/utils/resultsExport.js is a deliberate twin (the editor's
   Results download has no run id to fetch the server's CSV through). Evaluate
   it here and assert both produce identical bytes, so the two cannot drift. */
console.log('parity — backend vs frontend/src/utils/resultsExport.js');

function loadFrontendCopy() {
  const p = path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'resultsExport.js');
  const src = fs.readFileSync(p, 'utf8').replace(/^export\s+/gm, '');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;this.__api = { resultsToCsv, toCSV, csvCell };`, sandbox, { filename: p });
  return sandbox.__api;
}

const PARITY_FIXTURES = [
  { products: [{ name: 'A', price: '1' }, { name: 'B', price: '2', rating: '5' }] },
  { items: [{ a: null, b: undefined, c: 'x,y' }, { d: 'new' }] },
  { nested: [{ name: 'A', reviews: [{ stars: 5 }], meta: { k: 'v' } }] },
  { scalars: ['a', 'b,c', 'd"e'] },
  { mixed: [{ a: 1 }, 'loose', [1, 2]] },
  { empty: [], nothing: null, scalar: 42, obj: { a: 1 } },
  { multi: [{ a: 1 }], second: [{ b: 2 }], third: ['x'] },
  { weird: [{ 'col,with comma': 1, 'col"quote': 2, 'col\nnewline': 3 }] },
];

let frontend;
test('frontend copy loads', () => {
  frontend = loadFrontendCopy();
  assert.ok(typeof frontend.resultsToCsv === 'function');
  assert.ok(typeof frontend.toCSV === 'function');
  assert.ok(typeof frontend.csvCell === 'function');
});

if (frontend) {
  PARITY_FIXTURES.forEach((fixture, i) => {
    test(`fixture ${i + 1} serialises identically on both sides`, () => {
      assert.strictEqual(
        frontend.resultsToCsv(fixture),
        resultsToCsv(fixture),
        'frontend/src/utils/resultsExport.js has drifted from backend/utils/resultsExport.js — edit both together'
      );
    });
  });
}

console.log(`\n${passed} assertions passed`);
