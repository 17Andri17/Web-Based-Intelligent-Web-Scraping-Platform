/* What the grid claims is wrong with a scrape, pinned.

   These assertions are the difference between a warning worth acting on and
   one people learn to ignore. The fixture below is a product scrape with the
   four defects the profiler exists to catch, so each one is checked against
   a case that looks exactly like the real thing.

   Run (from frontend/):  npm test  */

import {
  inferValueType, dominantType, fillPercent, profileColumn, profileColumns,
  isIncompleteRow, rowKey, duplicateRows, findIssues,
} from './columnProfile.js';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

// ── one value at a time ─────────────────────────────────────────────────────
t('plain number',        inferValueType('4.6'), 'number');
t('dollar price',        inferValueType('$1,299.00'), 'money');
t('euro price',          inferValueType('€89'), 'money');
t('zloty price',         inferValueType('129 zł'), 'money');
t('currency code',       inferValueType('PLN 129'), 'money');
t('percent is a number, not money', inferValueType('12%'), 'number');
t('absolute url',        inferValueType('https://shop.example/p/1'), 'url');
t('root-relative url',   inferValueType('/p/aurora-27'), 'url');
t('ISO date',            inferValueType('2024-03-12'), 'date');
t('ISO timestamp',       inferValueType('2024-03-12T09:30:00'), 'date');
t('written date',        inferValueType('12 March 2024'), 'date');
t('US written date',     inferValueType('March 12, 2024'), 'date');
t('slashed date',        inferValueType('12/03/2024'), 'date');
t('a bare year is a number, not a date', inferValueType('2024'), 'number');
t('boolean word',        inferValueType('yes'), 'bool');
t('real boolean',        inferValueType(false), 'bool');
t('prose',               inferValueType('27-inch IPS panel'), 'text');
t('a SKU is text',       inferValueType('SKU-1234-A'), 'text');
t('empty has no type',   inferValueType('   '), null);

// ── dominance ───────────────────────────────────────────────────────────────
t('a clean column takes its type',   dominantType({ number: 10 }, 10), 'number');
t('a stray outlier does not flip it', dominantType({ number: 9, text: 1 }, 10), 'number');
t('a real disagreement is mixed',     dominantType({ number: 6, text: 4 }, 10), 'mixed');
// Money and number are the same family: prices that lost their symbol on a
// few rows must not be reported as a mixed column.
t('money + number stay one family',   dominantType({ money: 6, number: 4 }, 10), 'money');
t('mostly-plain numbers read as number', dominantType({ money: 3, number: 7 }, 10), 'number');
t('no populated values is empty',     dominantType({}, 0), 'empty');

/* ── fill rate, especially at the boundaries ───────────────────────────────
   Plain rounding reports 999 of 1000 as "100%", which is the exact reading a
   fill rate exists to prevent: the column looks complete and the missing
   value goes unnoticed. 100 and 0 have to mean what they say. */
t('complete is 100',            fillPercent(10, 10), 100);
t('wholly empty is 0',          fillPercent(0, 10), 0);
t('no rows at all is 0',        fillPercent(0, 0), 0);
t('ordinary rounding still rounds', fillPercent(5, 6), 83);

t('999 of 1000 is NOT 100',     fillPercent(999, 1000), 99);
t('9999 of 10000 is NOT 100',   fillPercent(9999, 10000), 99);
t('one short of complete is never 100', fillPercent(199, 200), 99);
t('1 of 1000 is NOT 0',         fillPercent(1, 1000), 1);
t('1 of 10000 is NOT 0',        fillPercent(1, 10000), 1);

// And through the profiler, which is where it is actually read.
const nearlyFull = Array.from({ length: 200 }, (_, i) => ({ v: i === 7 ? '' : 'x' }));
const nf = profileColumn(nearlyFull, 'v');
t('a single gap in 200 rows does not read as complete', nf.fillPct, 99);
t('and the gap is still counted exactly', [nf.filled, nf.empty], [199, 1]);
t('a genuinely complete column does read as complete',
  profileColumn([{ v: 'a' }, { v: 'b' }], 'v').fillPct, 100);

// ── the fixture ─────────────────────────────────────────────────────────────
const SHIP = 'Free shipping over $50';
const r = (title, price, rating, sku, desc) =>
  ({ title, price, rating, sku, shipping: SHIP, description: desc, notes: '' });

const shop = [
  r('Aurora 27" Monitor', '$549.00', '4.6', 'AUR-27', 'Big bright screen'),
  r('Kestrel Mouse',      '$39.99',  '4.4', 'KES-01', ''),
  r('  Halcyon Keyboard', '$129.00', '4.8', 'HAL-87', 'Clicky'),
  r('Vertex Dock',        '',        '4.1', 'VTX-11', ''),
  r('Atlas Desk',         '$799.00', '',    'ATL-120', 'Tall'),
  r('Willow Chair',       '$429.00', '4.5', 'WIL-09', 'Mesh back'),
];
const columns = ['title', 'price', 'rating', 'sku', 'shipping', 'description', 'notes'];

const p = profileColumns(shop, columns);

// Fill rates, over every loaded row — never over a page.
t('complete column is 100%',   p.title.fillPct, 100);
t('one gap in six is 83%',     p.price.fillPct, 83);
t('price counts its gap',      [p.price.filled, p.price.empty], [5, 1]);
t('description gap counted',   p.description.fillPct, 67);
t('a wholly empty column is 0%', p.notes.fillPct, 0);

// The banner bug: one distinct value all the way down.
t('constant column detected',      p.shipping.constant, true);
t('constant column is complete',   p.shipping.constantEverywhere, true);
t('a varied column is not constant', p.title.constant, false);
t('a wholly empty column is not constant', p.notes.constant, false);

// A column identical wherever it appears, but with gaps, is still the bug —
// it just cannot claim to be identical on "every row".
const patchy = [{ a: 'same' }, { a: 'same' }, { a: '' }];
t('constant with gaps still flagged', profileColumn(patchy, 'a').constant, true);
t('but not claimed as everywhere',    profileColumn(patchy, 'a').constantEverywhere, false);
t('a single filled row cannot be constant',
  profileColumn([{ a: 'only' }, { a: '' }], 'a').constant, false);

// Types over the whole column.
t('price column is money',     p.price.type, 'money');
t('rating column is number',   p.rating.type, 'number');
t('sku column is text',        p.sku.type, 'text');
t('empty column types as empty', p.notes.type, 'empty');

// A selector picking up two different elements.
const muddled = [{ v: '$10' }, { v: 'Out of stock' }, { v: '$12' }, { v: 'Call us' }, { v: '$8' }];
t('disagreeing values read as mixed', profileColumn(muddled, 'v').type, 'mixed');

t('untrimmed values counted', p.title.untrimmed, 1);
t('distinct counted',         p.shipping.distinct, 1);

// ── rows ────────────────────────────────────────────────────────────────────
t('a row with any gap is incomplete', isIncompleteRow(shop[3], columns), true);
t('a complete row is not',            isIncompleteRow(shop[0], ['title', 'price']), false);

t('row identity ignores key order',
  rowKey({ a: '1', b: '2' }, ['a', 'b']), rowKey({ b: '2', a: '1' }, ['a', 'b']));

const withDupes = [{ a: '1' }, { a: '2' }, { a: '1' }, { a: '3' }];
t('duplicates return every member of the group, not just the repeat',
  duplicateRows(withDupes, ['a']).size, 2);
t('nothing duplicated returns empty',
  duplicateRows([{ a: '1' }, { a: '2' }], ['a']).size, 0);

// ── the roll-up ─────────────────────────────────────────────────────────────
const issues = findIssues(shop, columns, p);
const kinds = issues.map(i => i.kind);

t('sparse and constant are both reported', kinds.sort(), ['constant', 'sparse']);
t('sparse names every affected column',
  issues.find(i => i.kind === 'sparse').columns.sort(),
  ['description', 'notes', 'price', 'rating']);
t('sparse counts the incomplete ROWS, not the columns',
  issues.find(i => i.kind === 'sparse').rows, 3);
// A column empty on every row must not drag every row into the count —
// otherwise "show me the rows with a gap" selects the whole table.
t('a wholly empty column is excluded from the row count',
  issues.find(i => i.kind === 'sparse').rowColumns.sort(),
  ['description', 'price', 'rating']);

/* Same reasoning, one step further: a field only a few rows ever carry is
   optional, not missing. It is still reported as a gappy column, but the
   rows without it are not anomalies. */
const optional = [
  { a: '1', rare: 'x' },
  { a: '2', rare: '' },
  { a: '3', rare: '' },
  { a: '4', rare: '' },
];
const optIssue = findIssues(optional, ['a', 'rare']).find(i => i.kind === 'sparse');
t('a rarely-filled column is still reported as gappy', optIssue.columns, ['rare']);
t('but its absence does not make every row incomplete', optIssue.rows, 0);
t('and it is not counted as an expected field',        optIssue.rowColumns, []);

// The other side of the line: a field present on most rows.
const usual = [
  { a: '1', normally: 'x' },
  { a: '2', normally: 'y' },
  { a: '3', normally: 'z' },
  { a: '4', normally: '' },
];
const usualIssue = findIssues(usual, ['a', 'normally']).find(i => i.kind === 'sparse');
t('a mostly-filled column makes its gaps anomalies', usualIssue.rows, 1);
t('and counts as an expected field',                 usualIssue.rowColumns, ['normally']);
t('constant names the column', issues.find(i => i.kind === 'constant').columns, ['shipping']);

t('a clean scrape reports nothing',
  findIssues([{ a: '1', b: 'x' }, { a: '2', b: 'y' }], ['a', 'b']), []);

t('duplicates surface as their own issue',
  findIssues(withDupes, ['a']).find(i => i.kind === 'duplicates').rows, 2);

t('a mixed column surfaces',
  findIssues(muddled, ['v']).some(i => i.kind === 'mixed'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
