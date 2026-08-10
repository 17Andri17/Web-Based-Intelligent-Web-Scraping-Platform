'use strict';

/* ===========================================================================
   changeDiff
   ---------------------------------------------------------------------------
   Row-level diff between two runs' extracted data for a single output list —
   the engine behind "Monitor for changes".

   Keyed by the same dedupe rule as the cross-run dataset view (rowKey from
   dataset.service), so what counts as "the same row" is consistent between
   the two features: pick a key field, or fall back to a whole-row hash.

   Pure and I/O-free — the caller (changeMonitor.service) loads the two runs'
   results and persists / notifies on the result. See test/changeDiff.test.js.
   ========================================================================= */

const { rowKey } = require('./dataset.service');

// Compare the `output` list of a previous run against a current run.
//   prevResults / currResults : parsed results_json objects ({ [key]: value })
//   opts.output               : which output key to diff
//   opts.keyField             : dedupe field, or null for whole-row
//
// Returns:
//   {
//     output, keyField,
//     added:   [row, …]                         rows present now, absent before
//     removed: [row, …]                         rows present before, gone now
//     changed: [{ key, fields:[…], before, after }]  same key, differing values
//     summary: { added, removed, changed, unchanged, before, after },
//     hasChanges: bool,
//   }
function diffResults(prevResults, currResults, { output, keyField = null } = {}) {
  const prev = indexRows(listFor(prevResults, output), keyField);
  const curr = indexRows(listFor(currResults, output), keyField);

  const added = [];
  const removed = [];
  const changed = [];
  let unchanged = 0;

  for (const [key, currRow] of curr) {
    const prevRow = prev.get(key);
    if (!prevRow) { added.push(currRow); continue; }
    const fields = changedFields(prevRow, currRow);
    if (fields.length === 0) { unchanged += 1; continue; }
    changed.push({ key: displayKey(key), fields, before: prevRow, after: currRow });
  }
  for (const [key, prevRow] of prev) {
    if (!curr.has(key)) removed.push(prevRow);
  }

  const summary = {
    added: added.length,
    removed: removed.length,
    changed: changed.length,
    unchanged,
    before: prev.size,
    after: curr.size,
  };

  return {
    output,
    keyField: keyField || null,
    added,
    removed,
    changed,
    summary,
    hasChanges: summary.added > 0 || summary.removed > 0 || summary.changed > 0,
  };
}

// A compact, storable version of a diff (counts + a bounded sample of the
// affected rows/keys), so a run row can carry it without holding whole tables.
//
// The changed sample carries the old and new value of each field that moved —
// that is the whole point of monitoring, so a stored summary must be readable
// on its own without re-running the diff. Values are truncated (maxValue) and
// only the *changed* fields are kept, which keeps a summary roughly the size of
// the added/removed samples that already store whole rows.
function summarizeDiff(diff, { sample = 20, maxValue = 300 } = {}) {
  return {
    output: diff.output,
    keyField: diff.keyField,
    counts: diff.summary,
    hasChanges: diff.hasChanges,
    // Which fields moved, and in how many rows — "price changed in 42 rows".
    fieldStats: fieldStats(diff),
    sample: {
      added: diff.added.slice(0, sample).map(r => truncateRow(r, maxValue)),
      removed: diff.removed.slice(0, sample).map(r => truncateRow(r, maxValue)),
      changed: diff.changed.slice(0, sample).map(c => ({
        key: c.key,
        fields: c.fields,
        // { field: { before, after } } for exactly the fields that changed.
        values: fieldValues(c, maxValue),
      })),
    },
  };
}

// How many changed rows each field accounts for, most-changed first. Cheap to
// compute here and it is the one bit of analysis a feed row can't derive.
function fieldStats(diff) {
  const counts = new Map();
  for (const c of diff.changed) {
    for (const f of c.fields) counts.set(f, (counts.get(f) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([field, rows]) => ({ field, rows }))
    .sort((a, b) => b.rows - a.rows || a.field.localeCompare(b.field));
}

// Before/after pairs for the changed fields of one row, values truncated.
function fieldValues(change, maxValue) {
  const out = {};
  for (const f of change.fields) {
    out[f] = {
      before: truncateValue(change.before ? change.before[f] : undefined, maxValue),
      after: truncateValue(change.after ? change.after[f] : undefined, maxValue),
    };
  }
  return out;
}

// Keep a stored row readable without letting one long description blow up the
// runs table. Objects/arrays are JSON-stringified before measuring so a deeply
// nested value can't sneak past the cap.
function truncateValue(v, maxValue) {
  if (v == null) return v === undefined ? null : v;
  if (typeof v === 'object') {
    const json = JSON.stringify(v);
    return json.length <= maxValue ? v : json.slice(0, maxValue) + '…';
  }
  const s = String(v);
  return s.length <= maxValue ? v : s.slice(0, maxValue) + '…';
}

function truncateRow(row, maxValue) {
  if (!isRecord(row)) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = truncateValue(v, maxValue);
  return out;
}

// ── internals ───────────────────────────────────────────────────────────────

function listFor(results, output) {
  if (!results || typeof results !== 'object') return [];
  const v = results[output];
  return Array.isArray(v) ? v : [];
}

// Map dedupe-key → row. Later duplicates within one run overwrite earlier ones
// (latest wins), matching the dataset builder.
function indexRows(rows, keyField) {
  const map = new Map();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    map.set(rowKey(row, keyField), row);
  }
  return map;
}

// Field names whose values differ between two rows (union of both key sets, so
// a field that appeared or disappeared counts as a change). Object/array values
// compared by JSON so nested shapes are handled.
function changedFields(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [];
  for (const k of keys) {
    if (!valuesEqual(a[k], b[k])) out.push(k);
  }
  return out;
}

function valuesEqual(x, y) {
  if (x === y) return true;
  if (x == null || y == null) return x == null && y == null;
  if (typeof x === 'object' || typeof y === 'object') {
    return JSON.stringify(x) === JSON.stringify(y);
  }
  return String(x) === String(y);
}

// rowKey returns "k:<value>" or "h:<hash>"; strip the prefix for display.
function displayKey(key) {
  return typeof key === 'string' ? key.replace(/^[kh]:/, '') : String(key);
}

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

module.exports = { diffResults, summarizeDiff, truncateValue };
