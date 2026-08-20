'use strict';

/* ===========================================================================
   datasetView.service
   ---------------------------------------------------------------------------
   Server-side filtering, sorting, profiling and projection for the data grid.

   This is a deliberate port of frontend/src/utils/dataGrid.js and
   columnProfile.js. The grid runs client-side under ~2,000 rows and switches
   to the server above that, and a scrape must not change its story when it
   crosses that line — the same column cannot read 85% full in one mode and
   92% in the other, and a price column cannot sort numerically in one and
   lexically in the other.

   Agreement between the two implementations is pinned by a shared fixture,
   shared/datagrid-vectors.json, which both test suites assert against. If
   you change a rule here, change it there and regenerate — see
   test/dataset-view.test.js.

   Why a port rather than a shared module: the frontend is ESM built by Vite,
   the backend is CommonJS with no build step, and there is no bundler in
   between. A dual-format package for ~300 lines of pure functions would cost
   more than the fixture that guards them.

   Everything here is pure. The route layer supplies the rows.
   ========================================================================= */

// ── values ──────────────────────────────────────────────────────────────────

function isEmptyValue(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function hasUntrimmedWhitespace(v) {
  return typeof v === 'string' && v.trim() !== '' && v !== v.trim();
}

// Digits fenced on both sides are an identifier ("SKU-1234-A"); currency and
// units sit on one side only ("$1,299.00", "89 zl", "12%").
const CORE_RX  = /^[-+]?\d{1,3}(?:[ ,]\d{3})+(?:\.\d+)?$|^[-+]?\d+(?:\.\d+)?$/;
const AFFIX_RX = /^[^\p{L}\p{N}\s]{1,3}$|^\p{L}{1,3}$/u;
const SPLIT_RX = /^([^\d]*)([-+]?[\d ,.]*\d)([^\d]*)$/;

function looksNumeric(v) {
  if (isEmptyValue(v)) return false;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'string') return false;
  const s = v.replace(/\s+/g, ' ').trim();
  const m = SPLIT_RX.exec(s);
  if (!m) return false;
  const pre = m[1].trim(), post = m[3].trim();
  if (pre && post) return false;
  const affix = pre || post;
  if (affix && !AFFIX_RX.test(affix)) return false;
  return CORE_RX.test(m[2].trim());
}

// A decimal comma is deliberately not handled: "1299,00" stays text rather
// than being silently read as 129900.
function toNumber(v) {
  if (isEmptyValue(v)) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const stripped = v.replace(/\s/g, '').replace(/,(?=\d{3}(\D|$))/g, '');
  const m = /-?\d+(?:\.\d+)?/.exec(stripped);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

function strictNumber(v) {
  return looksNumeric(v) ? toNumber(v) : null;
}

function formatCellValue(v) {
  if (isEmptyValue(v)) return '';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch (_) { return String(v); } }
  return String(v);
}

// ── columns ─────────────────────────────────────────────────────────────────

// Every key across EVERY row, in first-seen order — a field that only appears
// on later rows is exactly the one worth catching.
function buildColumns(rows) {
  const seen = new Set();
  const columns = [];
  for (const row of rows || []) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) { seen.add(key); columns.push(key); }
    }
  }
  return columns;
}

// ── value types ─────────────────────────────────────────────────────────────

const URL_RX = /^(https?:\/\/|\/)\S*$/i;
const BOOLS  = new Set(['true', 'false', 'yes', 'no']);
const CURRENCY_RX = /[$€£¥₹₽₩¢]|(?:^|[\s\d])(?:USD|EUR|GBP|PLN|CHF|JPY|CNY|SEK|NOK|DKK|CZK|CAD|AUD|INR|BRL|MXN|zł|kr|Kč|lei|Ft)(?:[\s\d]|$)/i;

// Matched by shape, not Date.parse — which accepts "1" and "2024" and would
// relabel every numeric column as a date.
const DATE_RXS = [
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/,
  /^\d{1,2}[/.]\d{1,2}[/.]\d{4}$/,
  /^\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}$/,
  /^[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}$/,
];

function inferValueType(v) {
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

// Money is a flavour of number, not a rival: prices that lost their symbol on
// a few rows must not report the column as `mixed`.
const FAMILY = { money: 'number' };
const familyOf = (t) => FAMILY[t] || t;
const DOMINANCE = 0.8;

function dominantType(typeCounts, populated) {
  if (!populated) return 'empty';
  const families = {};
  for (const type of Object.keys(typeCounts)) {
    const f = familyOf(type);
    families[f] = (families[f] || 0) + typeCounts[type];
  }
  let best = null, bestN = 0;
  for (const f of Object.keys(families)) {
    if (families[f] > bestN) { best = f; bestN = families[f]; }
  }
  if (bestN / populated < DOMINANCE) return 'mixed';
  if (best === 'number') {
    return (typeCounts.money || 0) > (typeCounts.number || 0) ? 'money' : 'number';
  }
  return best;
}

// ── profiling ───────────────────────────────────────────────────────────────

/* A fill rate that never lies at the boundaries. Plain rounding reports 999
   of 1000 as "100%", which is exactly the reading a fill rate exists to
   prevent. 100 is reserved for genuinely complete and 0 for genuinely empty;
   anything in between clamps to 99 or 1 rather than rounding past the truth. */
function fillPercent(filled, total) {
  if (!total) return 0;
  if (filled === 0) return 0;
  if (filled === total) return 100;
  const pct = Math.round((filled / total) * 100);
  if (pct >= 100) return 99;   // something IS missing
  if (pct <= 0) return 1;      // something IS present
  return pct;
}

function profileColumn(rows, id) {
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
    constant: distinct === 1 && filled >= 2,
    constantEverywhere: distinct === 1 && filled >= 2 && filled === total,
    untrimmed,
    typeCounts,
    type: dominantType(typeCounts, filled),
  };
}

function profileColumns(rows, columns) {
  const out = {};
  for (const id of columns || []) out[id] = profileColumn(rows, id);
  return out;
}

// ── whole rows ──────────────────────────────────────────────────────────────

function isIncompleteRow(row, columns) {
  if (!row || typeof row !== 'object') return true;
  return (columns || []).some(id => isEmptyValue(row[id]));
}

function rowKey(row, columns) {
  const flat = {};
  const sorted = [...(columns || [])].sort();
  for (const id of sorted) flat[id] = formatCellValue(row ? row[id] : undefined);
  return JSON.stringify(flat);
}

function duplicateRows(rows, columns) {
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

// A field present on only a few rows is optional, not missing. Counting it
// would mark almost every row incomplete and make the filter select the lot.
const MOSTLY_FILLED = 50;

function findIssues(rows, columns, profiles) {
  const list = Array.isArray(rows) ? rows : [];
  const cols = columns || [];
  const prof = profiles || profileColumns(list, cols);
  const issues = [];

  const sparse   = cols.filter(id => prof[id] && prof[id].empty > 0 && prof[id].filled > 0);
  const blank    = cols.filter(id => prof[id] && prof[id].filled === 0 && prof[id].total > 0);
  const constant = cols.filter(id => prof[id] && prof[id].constant);
  const mixed    = cols.filter(id => prof[id] && prof[id].type === 'mixed');

  if (sparse.length || blank.length) {
    const expected = sparse.filter(id => prof[id].fillPct >= MOSTLY_FILLED);
    issues.push({
      kind: 'sparse',
      columns: blank.concat(sparse),
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

// ── comparison ──────────────────────────────────────────────────────────────

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// Only the unambiguous form: "12/03/2024" is December 3rd to Date.parse and
// the 12th of March to half the planet, so those sort as text instead.
const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/;

function compareValues(a, b, type) {
  if (type === 'number' || type === 'money') {
    const an = toNumber(a), bn = toNumber(b);
    if (an !== null && bn !== null) return an === bn ? 0 : (an < bn ? -1 : 1);
  }
  if (type === 'date') {
    const as = String(a).trim(), bs = String(b).trim();
    if (ISO_DATE_RX.test(as) && ISO_DATE_RX.test(bs)) {
      const at = Date.parse(as), bt = Date.parse(bs);
      if (!Number.isNaN(at) && !Number.isNaN(bt)) return at === bt ? 0 : (at < bt ? -1 : 1);
    }
  }
  return collator.compare(String(a).trim(), String(b).trim());
}

// ── filtering ───────────────────────────────────────────────────────────────

/*   gaming    contains, case-insensitive (the default)
     >100      greater than (also >= < <=)
     =         is empty
     !=        is not empty
     "exact"   equals, case-insensitive                                    */
function parseFilterExpression(expr) {
  const raw = String(expr === null || expr === undefined ? '' : expr).trim();
  if (!raw) return { op: 'none' };
  if (raw === '=')  return { op: 'empty' };
  if (raw === '!=') return { op: 'notEmpty' };
  const cmp = /^([<>]=?)\s*(-?[\d.,\s]+)$/.exec(raw);
  if (cmp) {
    const n = toNumber(cmp[2]);
    if (n !== null) return { op: cmp[1], value: n };
  }
  if (raw.length > 1 && raw.startsWith('"') && raw.endsWith('"')) {
    return { op: 'equals', value: raw.slice(1, -1).toLowerCase() };
  }
  return { op: 'contains', value: raw.toLowerCase() };
}

function matchesFilter(value, expr) {
  const f = parseFilterExpression(expr);
  switch (f.op) {
    case 'none':     return true;
    case 'empty':    return isEmptyValue(value);
    case 'notEmpty': return !isEmptyValue(value);
    case 'equals':   return formatCellValue(value).trim().toLowerCase() === f.value;
    case 'contains': return formatCellValue(value).toLowerCase().includes(f.value);
    case '>': case '>=': case '<': case '<=': {
      // Stricter than the sort's reader on purpose: `>1` must not match
      // "Item 2" just because a 2 happens to be in there.
      const n = strictNumber(value);
      if (n === null) return false;
      if (f.op === '>')  return n >  f.value;
      if (f.op === '>=') return n >= f.value;
      if (f.op === '<')  return n <  f.value;
      return n <= f.value;
    }
    default: return true;
  }
}

// ── the view ────────────────────────────────────────────────────────────────

/* rows → filtered → sorted. Column filters AND together; the global query is
   OR across the columns given. Empty values sort LAST in both directions —
   they are resolved outside the ascending/descending flip, or sorting a price
   column descending returns a screen of blanks. Comparison runs on the
   trimmed value, so one stray leading space cannot decide the order. */
function buildView(rows, opts) {
  const o = opts || {};
  const filters = o.filters || {};
  const query = o.query || '';
  const searchColumns = o.searchColumns || null;
  const sorts = o.sorts || [];
  const types = o.types || {};
  const rowFilter = o.rowFilter || null;

  const all = Array.isArray(rows) ? rows : [];
  const active = Object.keys(filters)
    .filter(id => String(filters[id] === null || filters[id] === undefined ? '' : filters[id]).trim() !== '')
    .map(id => [id, filters[id]]);
  const q = String(query).trim().toLowerCase();
  const searchIn = searchColumns && searchColumns.length ? searchColumns : null;

  let out = all;
  if (active.length || q || rowFilter) {
    out = all.filter(row => {
      if (!row || typeof row !== 'object') return false;
      if (rowFilter && !rowFilter(row)) return false;
      for (const pair of active) {
        if (!matchesFilter(row[pair[0]], pair[1])) return false;
      }
      if (q) {
        const cols = searchIn || Object.keys(row);
        const hit = cols.some(id => formatCellValue(row[id]).toLowerCase().includes(q));
        if (!hit) return false;
      }
      return true;
    });
  }

  const ranked = sorts.filter(s => s && s.id);
  if (ranked.length) {
    const position = new Map();
    all.forEach((row, i) => position.set(row, i));
    out = out.slice().sort((a, b) => {
      for (const s of ranked) {
        const av = a[s.id], bv = b[s.id];
        const ae = isEmptyValue(av), be = isEmptyValue(bv);
        if (ae && be) continue;
        if (ae) return 1;
        if (be) return -1;
        const c = compareValues(av, bv, types[s.id]);
        if (c) return s.dir === 'asc' ? c : -c;
      }
      return position.get(a) - position.get(b);
    });
  }

  return out;
}

// ── projection ──────────────────────────────────────────────────────────────

/* Only the requested columns, with long values clipped.

   This is the answer to a wide scrape: a single description or html column
   routinely outweighs every other field combined, and the grid cannot render
   more than a couple of hundred characters of it anyway. Clipping happens
   here rather than in the browser so the bytes never leave the server — the
   row detail view fetches the full record separately when someone asks. */
function projectRows(rows, columns, cellMax) {
  const cols = Array.isArray(columns) && columns.length ? columns : null;
  const max = Number.isFinite(cellMax) && cellMax > 0 ? cellMax : 0;

  return (rows || []).map(row => {
    const out = {};
    const keys = cols || Object.keys(row || {});
    for (const id of keys) {
      let v = row ? row[id] : undefined;
      if (v === undefined) continue;
      if (max && typeof v === 'string' && v.length > max) {
        v = v.slice(0, max) + '…';
      } else if (max && v && typeof v === 'object') {
        const s = formatCellValue(v);
        v = s.length > max ? s.slice(0, max) + '…' : s;
      }
      out[id] = v;
    }
    return out;
  });
}

module.exports = {
  isEmptyValue, hasUntrimmedWhitespace, looksNumeric, toNumber, formatCellValue,
  buildColumns,
  inferValueType, dominantType, fillPercent, profileColumn, profileColumns,
  isIncompleteRow, rowKey, duplicateRows, findIssues,
  compareValues, parseFilterExpression, matchesFilter,
  buildView, projectRows,
};
