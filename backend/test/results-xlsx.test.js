'use strict';

/* Unit tests for the .xlsx run-results serialiser. Builds a workbook, reads
   it back with exceljs, and asserts the sheet/column/cell structure lines up
   with the CSV export (utils/resultsExport.js).
   Run: node test/results-xlsx.test.js  (from backend/) */

const assert = require('assert');
const ExcelJS = require('exceljs');

const { resultsToXlsx } = require('../utils/resultsXlsx');

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((e) => { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; });
}

// Load a produced buffer back into a workbook for assertions.
async function readBack(results) {
  const buf = await resultsToXlsx(results);
  assert.ok(Buffer.isBuffer(buf) && buf.length > 0, 'expected a non-empty Buffer');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
}

// Cell values as a plain 2-D array of a worksheet (1-based rows/cols in exceljs).
function grid(ws) {
  const out = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    row.eachCell({ includeEmpty: true }, (c) => { cells.push(c.value); });
    out.push(cells);
  });
  return out;
}

async function main() {
  console.log('resultsToXlsx — worksheets');
  await test('one worksheet per output key', async () => {
    const wb = await readBack({ products: [{ a: 1 }], jobs: [{ b: 2 }] });
    assert.deepEqual(wb.worksheets.map(w => w.name), ['products', 'jobs']);
  });
  await test('empty results still yields a valid one-sheet workbook', async () => {
    const wb = await readBack({});
    assert.equal(wb.worksheets.length, 1);
  });
  await test('sheet name is sanitised and truncated to 31 chars', async () => {
    const wb = await readBack({ 'a/very:long[name]*with?bad\\chars and padding here': [{ a: 1 }] });
    const n = wb.worksheets[0].name;
    assert.ok(n.length <= 31, `length ${n.length}`);
    assert.ok(!/[\\/?*[\]:]/.test(n), `illegal char in "${n}"`);
  });
  await test('duplicate sheet names are disambiguated', async () => {
    // Two keys that collapse to the same sanitised name.
    const wb = await readBack({ 'a:b': [{ x: 1 }], 'a/b': [{ y: 2 }] });
    const names = wb.worksheets.map(w => w.name.toLowerCase());
    assert.equal(new Set(names).size, names.length, `names not unique: ${names}`);
  });

  console.log('resultsToXlsx — header union (matches CSV)');
  await test('columns missing from the first row are still exported', async () => {
    const wb = await readBack({ items: [
      { name: 'A', price: '10' },
      { name: 'B', price: '12', rating: '4.5', stock: '3' },
    ]});
    const g = grid(wb.getWorksheet('items'));
    assert.deepEqual(g[0], ['name', 'price', 'rating', 'stock']);
    // row 0 had no rating/stock → those cells are blank (null), not shifted
    assert.equal(g[1][0], 'A');
    assert.equal(g[1][2], null);
    assert.equal(g[1][3], null);
    assert.equal(g[2][2], '4.5');
  });
  await test('header order is first-seen, not alphabetical', async () => {
    const wb = await readBack({ t: [{ b: 1 }, { a: 2 }, { c: 3 }] });
    assert.deepEqual(grid(wb.getWorksheet('t'))[0], ['b', 'a', 'c']);
  });

  console.log('resultsToXlsx — cell coercion');
  await test('object/array cells become JSON text', async () => {
    const wb = await readBack({ t: [{ name: 'A', reviews: [{ stars: 5 }] }] });
    const g = grid(wb.getWorksheet('t'));
    assert.equal(g[1][1], '[{"stars":5}]');
  });
  await test('numbers stay real numbers (Excel can sum them)', async () => {
    const wb = await readBack({ t: [{ n: 42 }] });
    const v = grid(wb.getWorksheet('t'))[1][0];
    assert.strictEqual(v, 42, `expected numeric 42, got ${typeof v} ${v}`);
  });
  await test('null / undefined become blank cells', async () => {
    const wb = await readBack({ t: [{ a: null, b: undefined, c: 'x' }] });
    const g = grid(wb.getWorksheet('t'));
    assert.equal(g[1][0], null);
    assert.equal(g[1][1], null);
    assert.equal(g[1][2], 'x');
  });

  console.log('resultsToXlsx — non-record shapes');
  await test('flat scalar list is a single unheaded column', async () => {
    const wb = await readBack({ t: ['a', 'b', 'c'] });
    assert.deepEqual(grid(wb.getWorksheet('t')), [['a'], ['b'], ['c']]);
  });
  await test('a non-array value is one JSON cell', async () => {
    const wb = await readBack({ t: { a: 1 } });
    assert.equal(grid(wb.getWorksheet('t'))[0][0], '{"a":1}');
  });

  console.log(`\n${passed} assertions passed`);
}

main();
