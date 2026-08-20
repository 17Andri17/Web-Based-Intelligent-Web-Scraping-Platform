'use strict';

/* ===========================================================================
   datasetView.service — agreement with the client, plus projection.

   The grid filters and sorts in the browser under ~2,000 rows and on the
   server above it. A scrape must not change its story when it crosses that
   line, so almost every assertion here reads its expected value out of
   shared/datagrid-vectors.json — the same fixture the frontend suite asserts
   against. A rule that drifts on one side fails on the other.

   Run: node test/dataset-view.test.js  (from backend/)
   ========================================================================= */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const V = require('../services/datasetView.service');

const VECTORS = path.join(__dirname, '..', '..', 'shared', 'datagrid-vectors.json');
const vec = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const rows = vec.rows;
const titles = (list) => list.map(x => String(x.title).trim());

// ── the shared contract ─────────────────────────────────────────────────────
console.log('agreement with the client implementation');

test('columns are discovered in the same order', () => {
  assert.deepEqual(V.buildColumns(rows), vec.columns);
});

test('every column profiles identically', () => {
  const got = V.profileColumns(rows, vec.columns);
  for (const id of vec.columns) {
    assert.deepEqual(got[id], vec.profiles[id], `column "${id}" differs`);
  }
});

test('inferred types match', () => {
  const got = V.profileColumns(rows, vec.columns);
  for (const id of vec.columns) {
    assert.equal(got[id].type, vec.types[id], `column "${id}" typed ${got[id].type}, client says ${vec.types[id]}`);
  }
});

test('the issue roll-up matches', () => {
  const profiles = V.profileColumns(rows, vec.columns);
  assert.deepEqual(V.findIssues(rows, vec.columns, profiles), vec.issues);
});

for (const c of vec.filterCases) {
  test(`filter — ${c.name}`, () => {
    const got = titles(V.buildView(rows, { filters: c.filters, query: c.query || '', types: vec.types }));
    assert.deepEqual(got, c.expect);
  });
}

for (const c of vec.sortCases) {
  test(`sort — ${c.name}`, () => {
    const got = titles(V.buildView(rows, { sorts: c.sorts, types: vec.types }));
    assert.deepEqual(got, c.expect);
  });
}

// ── the rules worth stating twice ───────────────────────────────────────────
console.log('the rules that were bugs once');

test('empties sort last in BOTH directions', () => {
  const asc  = V.buildView(rows, { sorts: [{ id: 'price', dir: 'asc' }],  types: vec.types });
  const desc = V.buildView(rows, { sorts: [{ id: 'price', dir: 'desc' }], types: vec.types });
  assert.ok(V.isEmptyValue(asc[asc.length - 1].price), 'ascending must end on a blank');
  assert.ok(V.isEmptyValue(desc[desc.length - 1].price), 'descending must end on a blank too');
  assert.ok(!V.isEmptyValue(desc[0].price), 'descending must not START on a blank');
});

test('money sorts as a number, not as text', () => {
  const asc = V.buildView(rows, { sorts: [{ id: 'price', dir: 'asc' }], types: vec.types });
  const nums = asc.filter(r => !V.isEmptyValue(r.price)).map(r => V.toNumber(r.price));
  assert.deepEqual(nums, nums.slice().sort((a, b) => a - b));
});

test('a stray leading space does not decide the sort', () => {
  const asc = titles(V.buildView(rows, { sorts: [{ id: 'title', dir: 'asc' }], types: vec.types }));
  assert.equal(asc[0], 'Atlas Standing Desk');
});

test('a numeric filter never matches text that merely contains digits', () => {
  assert.equal(V.matchesFilter('Item 2', '>1'), false);
  assert.equal(V.matchesFilter('SKU-1234-A', '>1'), false);
  assert.equal(V.matchesFilter('$549.00', '>1'), true);
});

test('non-ASCII currency still reads as a number', () => {
  assert.equal(V.looksNumeric('129 zł'), true);
  assert.equal(V.inferValueType('129 zł'), 'money');
  assert.equal(V.inferValueType('Kč 1,299'), 'money');
});

test('a rarely-filled column does not make every row incomplete', () => {
  const optional = [
    { a: '1', rare: 'x' }, { a: '2', rare: '' }, { a: '3', rare: '' }, { a: '4', rare: '' },
  ];
  const issue = V.findIssues(optional, ['a', 'rare']).find(i => i.kind === 'sparse');
  assert.deepEqual(issue.columns, ['rare']);
  assert.equal(issue.rows, 0);
  assert.deepEqual(issue.rowColumns, []);
});

test('a clean scrape reports no issues', () => {
  assert.deepEqual(V.findIssues([{ a: '1', b: 'x' }, { a: '2', b: 'y' }], ['a', 'b']), []);
});

/* Plain rounding reports 999 of 1000 as "100%", which is the exact reading a
   fill rate exists to prevent. 100 and 0 have to mean what they say. */
test('a fill rate never rounds past the truth', () => {
  assert.equal(V.fillPercent(10, 10), 100);
  assert.equal(V.fillPercent(0, 10), 0);
  assert.equal(V.fillPercent(0, 0), 0);
  assert.equal(V.fillPercent(5, 6), 83);
  assert.equal(V.fillPercent(999, 1000), 99, '999/1000 must not read as complete');
  assert.equal(V.fillPercent(9999, 10000), 99);
  assert.equal(V.fillPercent(1, 1000), 1, '1/1000 must not read as empty');
});

test('one gap in two hundred rows does not profile as complete', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ v: i === 7 ? '' : 'x' }));
  const p = V.profileColumn(rows, 'v');
  assert.equal(p.fillPct, 99);
  assert.equal(p.filled, 199);
  assert.equal(p.empty, 1);
});

// ── projection ──────────────────────────────────────────────────────────────
console.log('projectRows');

test('only the requested columns come back', () => {
  const out = V.projectRows(rows, ['title', 'price'], 0);
  assert.deepEqual(Object.keys(out[0]).sort(), ['price', 'title']);
});

test('no column list means every column', () => {
  const out = V.projectRows([{ a: 1, b: 2 }], null, 0);
  assert.deepEqual(Object.keys(out[0]).sort(), ['a', 'b']);
});

test('long values are clipped and marked', () => {
  const long = 'x'.repeat(500);
  const out = V.projectRows([{ d: long }], ['d'], 100);
  assert.equal(out[0].d.length, 101);          // 100 chars + the ellipsis
  assert.ok(out[0].d.endsWith('…'));
});

test('short values are left exactly alone', () => {
  const out = V.projectRows([{ d: 'short' }], ['d'], 100);
  assert.equal(out[0].d, 'short');
});

test('cellMax 0 clips nothing', () => {
  const long = 'y'.repeat(400);
  assert.equal(V.projectRows([{ d: long }], ['d'], 0)[0].d, long);
});

test('a requested column a row lacks is simply absent, not null', () => {
  const out = V.projectRows([{ a: 1 }], ['a', 'missing'], 0);
  assert.equal('missing' in out[0], false);
});

test('nested values survive projection as JSON when clipped', () => {
  const out = V.projectRows([{ o: { a: 1, b: 2 } }], ['o'], 5);
  assert.equal(typeof out[0].o, 'string');
  assert.ok(out[0].o.endsWith('…'));
});

test('projection does not mutate the source rows', () => {
  const src = [{ d: 'z'.repeat(50) }];
  V.projectRows(src, ['d'], 10);
  assert.equal(src[0].d.length, 50);
});

console.log(`\n${passed} passed`);
