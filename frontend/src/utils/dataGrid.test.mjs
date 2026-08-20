/* The data grid's semantics, pinned.

   These are the rules a person notices immediately when they are wrong:
   money that sorts as text, blanks that float to the top of a descending
   sort, a column that vanishes because row 1 didn't have it. All of them
   were real bugs in the preview this replaces.

   Run (from frontend/):  npm test  */

import {
  isEmptyValue, hasUntrimmedWhitespace, looksNumeric, toNumber,
  buildColumns, compareValues, matchesFilter,
  buildView, toggleSort,
} from './dataGrid.js';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

// ── emptiness ───────────────────────────────────────────────────────────────
t('null is empty',            isEmptyValue(null), true);
t('whitespace is empty',      isEmptyValue('   \n '), true);
t('zero is NOT empty',        isEmptyValue(0), false);
t('false is NOT empty',       isEmptyValue(false), false);
t('empty array is empty',     isEmptyValue([]), true);
t('untrimmed detected',       hasUntrimmedWhitespace('  Halcyon\n'), true);
t('trimmed not flagged',      hasUntrimmedWhitespace('Halcyon'), false);
t('blank not flagged as untrimmed', hasUntrimmedWhitespace('   '), false);

// ── numbers hiding in scraped strings ───────────────────────────────────────
t('money is numeric',         looksNumeric('$1,299.00'), true);
t('percent is numeric',       looksNumeric('12%'), true);
t('trailing unit is numeric', looksNumeric('89 zl'), true);
t('negative is numeric',      looksNumeric('-4.5'), true);
t('"Item 2" is NOT numeric',  looksNumeric('Item 2'), false);
t('a SKU is NOT numeric',     looksNumeric('SKU-1234-A'), false);
t('"2 of 5" is NOT numeric',  looksNumeric('2 of 5'), false);
t('money parses',             toNumber('$1,299.00'), 1299);
t('spaced thousands parse',   toNumber('1 234'), 1234);
t('decimal comma stays text', looksNumeric('1299,00'), false);

// ── columns come from every row, not just the first ─────────────────────────
const ragged = [
  { title: 'A', price: '$10' },
  { title: 'B', price: '$20', discount: '10%' },   // discount appears late
];
t('columns union every row',  buildColumns(ragged), ['title', 'price', 'discount']);
t('non-records skipped',      buildColumns(['x', null, { a: 1 }]), ['a']);

// Column type inference lives in columnProfile.js — see its own test file.
const shop = [
  { title: 'Aurora 27" Monitor', price: '$549.00', rating: '4.6', url: '/p/aurora',  desc: 'Big screen' },
  { title: 'Kestrel Mouse',      price: '$39.99',  rating: '4.4', url: '/p/kestrel', desc: '' },
  { title: '  Halcyon Keyboard', price: '$129.00', rating: '4.8', url: '/p/halcyon', desc: 'Clicky' },
  { title: 'Vertex Dock',        price: '',        rating: '4.1', url: '/p/vertex',  desc: '' },
  { title: 'Atlas Desk',         price: '$799.00', rating: '',    url: '/p/atlas',   desc: 'Tall' },
];
// ── comparison ──────────────────────────────────────────────────────────────
t('money compares numerically', compareValues('$9.00', '$1,299.00', 'number') < 0, true);
t('the money type also sorts numerically', compareValues('$9.00', '$1,299.00', 'money') < 0, true);
t('money as text would be wrong', compareValues('$9.00', '$1,299.00', 'text') > 0, true);
t('natural order: 2 before 10', compareValues('Item 2', 'Item 10', 'text') < 0, true);
t('comparison ignores stray space', compareValues('  Halcyon', 'Halcyon', 'text'), 0);
t('ISO dates compare chronologically',
  compareValues('2024-09-01', '2024-10-01', 'date') < 0, true);
t('ISO dates beat lexical order on time-of-day',
  compareValues('2024-01-01T09:30', '2024-01-01T10:00', 'date') < 0, true);
// 12/03 is December 3rd to some readers and 12 March to others; there is no
// way to know which, so these must NOT be given a confident chronology.
t('ambiguous dates fall back to text order',
  compareValues('12/03/2024', '03/12/2024', 'date'), compareValues('12/03/2024', '03/12/2024', 'text'));

// ── sorting ─────────────────────────────────────────────────────────────────
const types = { title: 'text', price: 'number', rating: 'number' };
const titles = (rows) => rows.map(r => r.title.trim());

t('price ascending is cheapest first',
  titles(buildView(shop, { sorts: [{ id: 'price', dir: 'asc' }], types }))[0],
  'Kestrel Mouse');

t('price descending is dearest first — NOT the blank',
  titles(buildView(shop, { sorts: [{ id: 'price', dir: 'desc' }], types }))[0],
  'Atlas Desk');

t('blanks sort last ascending',
  titles(buildView(shop, { sorts: [{ id: 'price', dir: 'asc' }], types })).at(-1),
  'Vertex Dock');

t('blanks sort last descending too',
  titles(buildView(shop, { sorts: [{ id: 'price', dir: 'desc' }], types })).at(-1),
  'Vertex Dock');

t('a stray leading space does not win the sort',
  titles(buildView(shop, { sorts: [{ id: 'title', dir: 'asc' }], types }))[0],
  'Atlas Desk');

t('no sort keeps the scrape order',
  titles(buildView(shop, { types })),
  ['Aurora 27" Monitor', 'Kestrel Mouse', 'Halcyon Keyboard', 'Vertex Dock', 'Atlas Desk']);

// Multi-sort: group by whether the item has a description, then by price.
const tiered = [
  { g: 'b', n: '2' }, { g: 'a', n: '10' }, { g: 'b', n: '1' }, { g: 'a', n: '2' },
];
t('multi-sort ranks left to right',
  buildView(tiered, { sorts: [{ id: 'g', dir: 'asc' }, { id: 'n', dir: 'asc' }], types: { g: 'text', n: 'number' } })
    .map(r => r.g + r.n),
  ['a2', 'a10', 'b1', 'b2']);

// ── filter operators ────────────────────────────────────────────────────────
const count = (filters, query) => buildView(shop, { filters, query, types }).length;
t('contains (the default)',   count({ title: 'desk' }), 1);
t('contains is case-insensitive', count({ title: 'DESK' }), 1);
t('greater than',             count({ price: '>100' }), 3);
t('less than',                count({ price: '<100' }), 1);
t('greater or equal',         count({ rating: '>=4.6' }), 2);
t('is empty',                 count({ price: '=' }), 1);
t('is not empty',             count({ price: '!=' }), 4);
t('quoted is exact',          count({ title: '"Atlas Desk"' }), 1);
t('quoted exact rejects partial', count({ title: '"Atlas"' }), 0);
t('filters AND together',     count({ price: '>100', rating: '>4.7' }), 1);
t('global query spans columns', count({}, 'halcyon'), 1);
t('numeric filter on a blank never matches', matchesFilter('', '>0'), false);
t('numeric filter on text never matches', matchesFilter('Item 2', '>1'), false);

t('search is limited to the columns given',
  buildView(shop, { query: 'clicky', searchColumns: ['title', 'price'], types }).length, 0);

// ── whole-row filter (what the issue chips narrow with) ─────────────────────
t('rowFilter narrows to matching rows',
  buildView(shop, { rowFilter: r => r.price === '', types }).length, 1);
t('rowFilter ANDs with column filters',
  buildView(shop, { rowFilter: r => r.rating !== '', filters: { price: '=' }, types }).length, 1);
t('rowFilter ANDs with the global query',
  buildView(shop, { rowFilter: r => r.price !== '', query: 'vertex', types }).length, 0);

// ── header click cycle ──────────────────────────────────────────────────────
t('first click sorts ascending',  toggleSort([], 'price'), [{ id: 'price', dir: 'asc' }]);
t('second click flips to descending',
  toggleSort([{ id: 'price', dir: 'asc' }], 'price'), [{ id: 'price', dir: 'desc' }]);
t('third click clears the sort',
  toggleSort([{ id: 'price', dir: 'desc' }], 'price'), []);
t('a plain click replaces other sorts',
  toggleSort([{ id: 'title', dir: 'asc' }], 'price'), [{ id: 'price', dir: 'asc' }]);
t('shift-click appends, ranked after',
  toggleSort([{ id: 'title', dir: 'asc' }], 'price', true),
  [{ id: 'title', dir: 'asc' }, { id: 'price', dir: 'asc' }]);
t('shift-click can drop one sort and keep the rest',
  toggleSort([{ id: 'title', dir: 'asc' }, { id: 'price', dir: 'desc' }], 'price', true),
  [{ id: 'title', dir: 'asc' }]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
