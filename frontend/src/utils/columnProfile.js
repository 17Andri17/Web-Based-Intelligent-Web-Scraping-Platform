/* ===========================================================================
   columnProfile — what a column actually holds, and what looks wrong with it.
   ---------------------------------------------------------------------------
   A generic grid tells you what you scraped. The point of this module is to
   tell you what you MISSED, which is the only question anyone opens a
   results table to answer.

   Every number here is computed over all loaded rows, never over the visible
   page. A fill rate that describes 100 rows out of 4,000 is worse than no
   fill rate at all — it reads as authoritative and isn't.

   The signals, in rough order of how often they catch a real bug:

     constant   one distinct value down the whole column. Almost always a
                selector that matched a page-level banner instead of
                something inside the repeating card. Nothing in the product
                surfaced this before and it is the single highest-yield
                defect.
     sparse     the column has gaps. Either the selector is too specific, or
                the site genuinely omits the field on some rows — the grid
                cannot tell you which, but it can show you exactly which
                rows so you can look.
     mixed      the values disagree about what they are. A column you
                expected to be numeric reading `mixed` usually means the
                selector is picking up two different elements.
     duplicates the same row captured more than once, which is what a
                pagination loop that revisits page 1 looks like.

   Pure functions only — see columnProfile.test.mjs.
   ========================================================================= */

import { isEmptyValue, hasUntrimmedWhitespace, looksNumeric, formatCellValue } from './dataGrid.js';

// ── value types ─────────────────────────────────────────────────────────────

const URL_RX  = /^(https?:\/\/|\/)\S*$/i;
const BOOLS   = new Set(['true', 'false', 'yes', 'no']);

// A currency marker anywhere in an otherwise numeric value makes it money.
// Symbols, plus the codes and short names that show up in scraped prices.
const CURRENCY_RX = /[$€£¥₹₽₩¢]|(?:^|[\s\d])(?:USD|EUR|GBP|PLN|CHF|JPY|CNY|SEK|NOK|DKK|CZK|CAD|AUD|INR|BRL|MXN|zł|kr|Kč|lei|Ft)(?:[\s\d]|$)/i;

/* Dates are matched by shape, not by Date.parse — which happily accepts
   "1", "2024" and a great deal else, and would relabel every numeric column
   as a date. Only unambiguous written forms count. */
const DATE_RXS = [
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/,     // 2024-03-12, ISO
  /^\d{1,2}[/.]\d{1,2}[/.]\d{4}$/,                          // 12/03/2024
  /^\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}$/,                   // 3 March 2024
  /^[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}$/,                 // March 3, 2024
];

export function inferValueType(v) {
  if (isEmptyValue(v)) return null;
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'object') return 'text';
  if (typeof v === 'number') return 'number';

  const s = String(v).trim();
  if (BOOLS.has(s.toLowerCase())) return 'bool';
  if (URL_RX.test(s)) return 'url';
  if (DATE_RXS.some(rx => rx.test(s))) return 'date';
  if (looksNumeric(s)) return CURRENCY_RX.test(s) ? 'money' : 'number';
  return 'text';
}

/* Money is a flavour of number, not a rival to it. Without this, a column of
   prices where some rows dropped the currency symbol would be reported as
   `mixed` — technically true, useless as a warning. */
const FAMILY = { money: 'number' };
const familyOf = (t) => FAMILY[t] || t;

// How much of a column must agree before the column takes that type.
const DOMINANCE = 0.8;

export function dominantType(typeCounts, populated) {
  if (!populated) return 'empty';
  const families = {};
  for (const [type, n] of Object.entries(typeCounts)) {
    const f = familyOf(type);
    families[f] = (families[f] || 0) + n;
  }
  let best = null, bestN = 0;
  for (const [f, n] of Object.entries(families)) {
    if (n > bestN) { best = f; bestN = n; }
  }
  if (bestN / populated < DOMINANCE) return 'mixed';
  // Within the number family, report money when most of them carry currency.
  if (best === 'number') {
    return (typeCounts.money || 0) > (typeCounts.number || 0) ? 'money' : 'number';
  }
  return best;
}

// ── one column ──────────────────────────────────────────────────────────────

/* A fill rate that never lies at the boundaries.

   Plain rounding reports 999 of 1000 as "100%", which is precisely the
   reading a fill rate exists to prevent — the column looks complete and the
   one missing value goes unnoticed. So 100 is reserved for genuinely
   complete, and 0 for genuinely empty; anything in between is clamped to
   99 or 1 rather than rounded past the truth.

   Erring towards "there is a problem" is deliberate: a false 99% costs a
   glance, a false 100% costs a silent data loss. */
export function fillPercent(filled, total) {
  if (!total) return 0;
  if (filled === 0) return 0;
  if (filled === total) return 100;
  const pct = Math.round((filled / total) * 100);
  if (pct >= 100) return 99;   // something IS missing
  if (pct <= 0) return 1;      // something IS present
  return pct;
}

export function profileColumn(rows, id) {
  const list = Array.isArray(rows) ? rows : [];
  const distinctValues = new Set();
  const typeCounts = {};
  let filled = 0, untrimmed = 0, total = 0;

  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    total++;
    const v = row[id];
    if (isEmptyValue(v)) continue;
    filled++;
    if (hasUntrimmedWhitespace(v)) untrimmed++;
    distinctValues.add(formatCellValue(v).trim());
    const t = inferValueType(v);
    if (t) typeCounts[t] = (typeCounts[t] || 0) + 1;
  }

  const distinct = distinctValues.size;
  return {
    total,
    filled,
    empty: total - filled,
    fillPct: fillPercent(filled, total),
    distinct,
    /* "Identical everywhere it appears" is the signal, whether or not the
       column also has gaps — a banner grabbed by mistake is still a banner.
       Two filled rows is the floor: one row cannot vary. */
    constant: distinct === 1 && filled >= 2,
    // Whether the column is ALSO complete decides how the chip words itself.
    constantEverywhere: distinct === 1 && filled >= 2 && filled === total,
    untrimmed,
    typeCounts,
    type: dominantType(typeCounts, filled),
  };
}

export function profileColumns(rows, columns) {
  const out = {};
  for (const id of columns || []) out[id] = profileColumn(rows, id);
  return out;
}

// ── whole rows ──────────────────────────────────────────────────────────────

// A row is incomplete when any of its columns came back empty.
export function isIncompleteRow(row, columns) {
  if (!row || typeof row !== 'object') return true;
  return (columns || []).some(id => isEmptyValue(row[id]));
}

// Key-order-independent identity for a row, so two rows with the same fields
// written in a different order still collapse together.
export function rowKey(row, columns) {
  const flat = {};
  for (const id of [...(columns || [])].sort()) flat[id] = formatCellValue(row?.[id]);
  return JSON.stringify(flat);
}

/* Every row belonging to a group that appears more than once — all members,
   not just the second onward. "Show me the duplicates" means the pairs, not
   half of each pair. */
export function duplicateRows(rows, columns) {
  const list = Array.isArray(rows) ? rows : [];
  const byKey = new Map();
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const k = rowKey(row, columns);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(row);
  }
  const dupes = new Set();
  for (const group of byKey.values()) {
    if (group.length > 1) group.forEach(r => dupes.add(r));
  }
  return dupes;
}

// ── the roll-up ─────────────────────────────────────────────────────────────

// Fill rate at which a column counts as one the scrape is expected to
// produce, so a row lacking it is an anomaly rather than an optional field.
const MOSTLY_FILLED = 50;

/* At most four kinds of chip, because a strip nobody can scan is a strip
   nobody reads. Untrimmed whitespace is deliberately not one of them: it is
   marked in the cell itself, where you can see which value is affected. */
export function findIssues(rows, columns, profiles) {
  const list = Array.isArray(rows) ? rows : [];
  const cols = columns || [];
  const prof = profiles || profileColumns(list, cols);
  const issues = [];

  const sparse   = cols.filter(id => prof[id] && prof[id].empty > 0 && prof[id].filled > 0);
  const blank    = cols.filter(id => prof[id] && prof[id].filled === 0 && prof[id].total > 0);
  const constant = cols.filter(id => prof[id] && prof[id].constant);
  const mixed    = cols.filter(id => prof[id] && prof[id].type === 'mixed');

  if (sparse.length || blank.length) {
    /* Which columns count towards a row being "incomplete" is a narrower
       question than which columns have gaps, and the difference matters.

       A row is worth looking at when it is missing something the scrape
       USUALLY gets. A field present on 8% of rows is an optional one — the
       92% without it are normal, and counting them would mark almost every
       row incomplete and turn "show me the rows with a gap" into "show me
       everything". So only columns filled on most rows qualify; the sparse
       and wholly-empty ones are still reported, as the column-level faults
       they are. */
    const expected = sparse.filter(id => prof[id].fillPct >= MOSTLY_FILLED);
    issues.push({
      kind: 'sparse',
      columns: [...blank, ...sparse],
      rows: expected.length ? list.filter(r => isIncompleteRow(r, expected)).length : 0,
      rowColumns: expected,
    });
  }
  if (constant.length) {
    issues.push({
      kind: 'constant',
      columns: constant,
      everywhere: constant.every(id => prof[id].constantEverywhere),
    });
  }
  if (mixed.length) issues.push({ kind: 'mixed', columns: mixed });

  const dupes = duplicateRows(list, cols);
  if (dupes.size > 0) issues.push({ kind: 'duplicates', rows: dupes.size });

  return issues;
}
