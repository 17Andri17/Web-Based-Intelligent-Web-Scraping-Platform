/* ===========================================================================
   dataGrid — the pure model behind <DataGrid>.
   ---------------------------------------------------------------------------
   Column discovery, type sniffing, comparison, filtering and sorting for
   scraped rows. Everything here is a pure function of its arguments so the
   semantics can be pinned down in tests without a DOM — see dataGrid.test.mjs.

   Two rules in here are not obvious and are the reason this is a module
   rather than a handful of inline callbacks:

     • Empty values sort last in BOTH directions. They are excluded from the
       ascending/descending flip, because negating the whole comparison
       negates the empty handling too — and then sorting a price column
       descending hands you a screen of blanks instead of the top prices.

     • Comparison runs on the TRIMMED value. Scraped text routinely carries
       leading whitespace from the page's markup; one stray space otherwise
       decides the whole sort. The cell still flags the untrimmed original,
       because that whitespace is a real defect worth seeing.

   Note on whitespace: JavaScript's \s already matches the non-breaking space
   (U+00A0), which scraped markup is full of. Every whitespace class below
   relies on that rather than spelling the character out.
   ========================================================================= */

// ── values ──────────────────────────────────────────────────────────────────

// Empty means "the scraper got nothing here": null, undefined, or a string
// that is only whitespace. `0` and `false` are values, not gaps.
export function isEmptyValue(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

// Whitespace the extraction should have trimmed and didn't. Invisible in the
// cell, but it survives into the CSV and breaks joins downstream.
export function hasUntrimmedWhitespace(v) {
  return typeof v === 'string' && v.trim() !== '' && v !== v.trim();
}

/* Strings that a person would read as a number, including scraped money.

   The whole difficulty is telling "$1,299.00" from "SKU-1234-A". Both are
   digits wrapped in punctuation, and both are extremely common in scraped
   data. Two rules separate them:

     • Digits fenced on BOTH sides are an identifier, not a number. Currency
       and units sit on one side only ("$1,299", "89 zl", "12%").
     • The one affix that is allowed must be short, and either symbols or a
       brief unit — never something carrying an identifier separator. */
const CORE_RX  = /^[-+]?\d{1,3}(?:[ ,]\d{3})+(?:\.\d+)?$|^[-+]?\d+(?:\.\d+)?$/;
/* Either a short run of symbols ($, €, %) or a short run of letters — and
   letters means ANY letters, so "zł", "Kč" and "₽" work as well as "kg".
   Mixing the two is what rules out an identifier: "SKU-" and "AB-" are
   neither pure symbols nor pure letters, so they never read as a currency. */
const AFFIX_RX = /^[^\p{L}\p{N}\s]{1,3}$|^\p{L}{1,3}$/u;
const SPLIT_RX = /^([^\d]*)([-+]?[\d ,.]*\d)([^\d]*)$/;

export function looksNumeric(v) {
  if (isEmptyValue(v)) return false;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'string') return false;
  // Normalise every flavour of space to a plain one so a non-breaking space
  // between the digits and the currency still reads as a number.
  const s = v.replace(/\s+/g, ' ').trim();
  const m = SPLIT_RX.exec(s);
  if (!m) return false;
  const pre = m[1].trim(), post = m[3].trim();
  if (pre && post) return false;                    // fenced both sides
  const affix = pre || post;
  if (affix && !AFFIX_RX.test(affix)) return false;
  return CORE_RX.test(m[2].trim());
}

// The number a filter comparison is allowed to see. Deliberately stricter
// than toNumber: `>1` must not match "Item 2" just because a 2 is in there.
function strictNumber(v) {
  return looksNumeric(v) ? toNumber(v) : null;
}

// The number inside a scraped value. Thousands separators are dropped; a
// decimal comma is not handled on purpose — "1299,00" stays text rather than
// being silently read as 129900.
export function toNumber(v) {
  if (isEmptyValue(v)) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const stripped = v.replace(/\s/g, '').replace(/,(?=\d{3}(\D|$))/g, '');
  const m = /-?\d+(?:\.\d+)?/.exec(stripped);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

// One cell, as text. Objects and arrays become JSON so a nested extraction is
// at least readable instead of "[object Object]".
export function formatCellValue(v) {
  if (isEmptyValue(v)) return '';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

// ── columns ─────────────────────────────────────────────────────────────────

/* Every key across EVERY row, in first-seen order.

   The old preview read its headers from `data[0]` alone, so a field that
   only appeared on later rows was invisible — exactly the case worth
   catching, since a field missing from row 1 is usually the bug. */
export function buildColumns(rows) {
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

// ── comparison ──────────────────────────────────────────────────────────────

// numeric:true gives natural order — "Item 2" before "Item 10". Scraped
// titles are full of numbers and lexical order reads as broken.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// Only the unambiguous form. "12/03/2024" is December 3rd to Date.parse and
// the 12th of March to half the planet, and there is no way to tell from the
// value which one the site meant — so those sort as text rather than being
// given a confidently wrong order.
const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/;

/* Compares two POPULATED values. Empties are the caller's problem, and
   deliberately so: they have to be resolved outside the direction flip.

   `type` comes from columnProfile; money sorts as the number it is, and
   anything unrecognised falls through to natural text order. */
export function compareValues(a, b, type) {
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

/* The inline filter box infers its operator from what you type, so the
   common case needs no UI at all:

     gaming     contains, case-insensitive   (the default)
     >100       greater than                 (also >= < <=)
     =          is empty
     !=         is not empty
     "exact"    equals, case-insensitive
*/
export function parseFilterExpression(expr) {
  const raw = String(expr ?? '').trim();
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

export function matchesFilter(value, expr) {
  const f = parseFilterExpression(expr);
  switch (f.op) {
    case 'none':     return true;
    case 'empty':    return isEmptyValue(value);
    case 'notEmpty': return !isEmptyValue(value);
    case 'equals':   return formatCellValue(value).trim().toLowerCase() === f.value;
    case 'contains': return formatCellValue(value).toLowerCase().includes(f.value);
    case '>': case '>=': case '<': case '<=': {
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

/* rows → filtered → sorted. Column filters combine with AND; the global
   query is OR across the columns it is given (the visible ones — searching a
   column you have hidden would return rows you cannot see the match in).

   `rowFilter` is an extra whole-row predicate, ANDed with everything else.
   It is how the issue chips narrow to "only the rows with a gap" or "only
   the duplicates" — conditions that belong to the row rather than to any one
   column, and so cannot be expressed as a column filter.

   `sorts` is [{ id, dir }], ranked: the first entry decides, later entries
   break ties. Ties left over after every sort fall back to the row's
   original position, which keeps the sort stable and means "no sort" is the
   order the page actually listed things in. */
export function buildView(rows, {
  filters = {}, query = '', searchColumns = null, sorts = [], types = {}, rowFilter = null,
} = {}) {
  const all = Array.isArray(rows) ? rows : [];

  const active = Object.entries(filters).filter(([, expr]) => String(expr ?? '').trim() !== '');
  const q = String(query ?? '').trim().toLowerCase();
  const searchIn = searchColumns && searchColumns.length ? searchColumns : null;

  let out = all;
  if (active.length || q || rowFilter) {
    out = all.filter(row => {
      if (!row || typeof row !== 'object') return false;
      if (rowFilter && !rowFilter(row)) return false;
      for (const [id, expr] of active) {
        if (!matchesFilter(row[id], expr)) return false;
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
        if (ae) return 1;     // empties last in both directions — outside
        if (be) return -1;    // the flip below, deliberately.
        const c = compareValues(av, bv, types[s.id]);
        if (c) return s.dir === 'asc' ? c : -c;
      }
      return position.get(a) - position.get(b);
    });
  }

  return out;
}

/* Header click: ascending → descending → off. `additive` (shift-click) keeps
   the existing sorts and ranks this one after them; a plain click replaces
   them. Turning a sort off restores the original scrape order, which is
   itself information — it is the order the page listed the rows in. */
export function toggleSort(sorts, id, additive = false) {
  const existing = (sorts || []).find(s => s.id === id);
  const others   = (sorts || []).filter(s => s.id !== id);
  let next = null;
  if (!existing) next = { id, dir: 'asc' };
  else if (existing.dir === 'asc') next = { id, dir: 'desc' };
  if (additive) return next ? [...others, next] : others;
  return next ? [next] : [];
}
