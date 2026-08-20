'use strict';

/* ===========================================================================
   dataset.service
   ---------------------------------------------------------------------------
   Accumulate a workflow's extracted rows across runs into one deduplicated
   dataset — the "Data across runs" view.

   This is computed on read by unioning the `results_json` of a workflow's
   retained successful runs, rather than materialised into its own table:
     • it works retroactively on every run already stored,
     • it needs no migration and no write-path coupling, and
     • it is bounded by the existing results-retention window
       (RUN_RESULTS_RETENTION_COUNT), so the union stays cheap.

   The trade-off is honest and must be surfaced in the UI: first-seen /
   times-seen are computed over *retained* runs only. Once retention prunes an
   old run's results, rows first observed there report their earliest still-
   retained appearance. `runCount` in the output says how many runs were
   considered so the caller can show "across the last N runs".

   All functions here are pure (no DB, no I/O) so they are trivially testable —
   see test/dataset.test.js. The route layer fetches runs and calls in.
   ========================================================================= */

// A run, as this module consumes it:
//   { id, startedAt, finishedAt, results }
// where `results` is the already-parsed results_json object
//   ({ [outputKey]: value }) and timestamps are whatever the DB stores
//   (compared as strings only for max/min, never parsed).

// ── output discovery ────────────────────────────────────────────────────────
// Which output keys across all the runs are list-shaped (an array of record
// objects) and therefore make sense as a dataset. Returns, per such key, the
// first-seen-order union of its record fields and the latest row count.
function listOutputs(runs) {
  const order = [];
  const byKey = new Map(); // key -> { fields:[], seen:Set, recordRuns, latestCount, latestRunIdx }

  runs.forEach((run, idx) => {
    const results = run && run.results;
    if (!results || typeof results !== 'object' || Array.isArray(results)) return;
    for (const [key, value] of Object.entries(results)) {
      if (!byKey.has(key)) {
        byKey.set(key, { fields: [], seen: new Set(), recordRuns: 0, latestCount: 0, latestRunIdx: -1 });
        order.push(key);
      }
      const entry = byKey.get(key);
      if (isRecordArray(value)) {
        entry.recordRuns += 1;
        for (const row of value) {
          if (!isRecord(row)) continue;
          for (const f of Object.keys(row)) {
            if (!entry.seen.has(f)) { entry.seen.add(f); entry.fields.push(f); }
          }
        }
        // Runs are passed oldest→newest, so the last record-array we see is
        // the latest — remember its length for the "current size" hint.
        if (idx >= entry.latestRunIdx) { entry.latestRunIdx = idx; entry.latestCount = value.length; }
      }
    }
  });

  return order
    .map(key => {
      const e = byKey.get(key);
      return {
        key,
        fields: e.fields,
        latestCount: e.latestCount,
        // Only keys that were a record-array in at least one run are datasetable.
        datasetable: e.recordRuns > 0,
      };
    })
    .filter(o => o.datasetable);
}

// ── dedupe-key default ──────────────────────────────────────────────────────
// Pick a sensible default dedupe field for a set of columns. A step-declared
// key (COLLECT_LIST's keyField) wins; otherwise the first column matching a
// common identity name; otherwise null (dedupe on the whole row).
const IDENTITY_FIELDS = ['id', 'uuid', 'guid', 'sku', 'url', 'link', 'href', 'permalink', 'slug', 'asin'];

function defaultKeyField(columns, stepKeyField = null) {
  const cols = Array.isArray(columns) ? columns : [];
  if (stepKeyField && cols.includes(stepKeyField)) return stepKeyField;
  const lower = new Map(cols.map(c => [c.toLowerCase(), c]));
  for (const cand of IDENTITY_FIELDS) {
    if (lower.has(cand)) return lower.get(cand);
  }
  return null; // whole-row dedupe
}

// ── the dataset ─────────────────────────────────────────────────────────────
// Union the chosen output's rows across all runs (oldest→newest), keyed by
// `keyField` (or the whole row when keyField is null/absent). Latest values
// win for display; first/last-seen and times-seen are accumulated.
function buildDataset(runs, { output, keyField = null } = {}) {
  const columns = [];
  const colSeen = new Set();
  const map = new Map(); // key -> row aggregate, in insertion (first-seen) order

  let runCount = 0;

  for (const run of runs) {
    const results = run && run.results;
    if (!results || typeof results !== 'object') continue;
    const value = results[output];
    if (!isRecordArray(value)) continue;
    runCount += 1;

    const seenThisRun = new Set(); // a key seen twice in one run counts once for timesSeen

    for (const row of value) {
      if (!isRecord(row)) continue;
      for (const f of Object.keys(row)) {
        if (!colSeen.has(f)) { colSeen.add(f); columns.push(f); }
      }
      const key = rowKey(row, keyField);
      const firstInRun = !seenThisRun.has(key);
      seenThisRun.add(key);

      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          key,
          data: { ...row },              // latest values (this is the first)
          firstSeenAt: run.startedAt,
          lastSeenAt:  run.finishedAt || run.startedAt,
          firstRunId:  run.id,
          lastRunId:   run.id,
          timesSeen:   1,
        });
      } else {
        // Latest values win — merge so a field missing from the newer row
        // keeps its previous value rather than being dropped.
        existing.data = { ...existing.data, ...row };
        existing.lastSeenAt = run.finishedAt || run.startedAt;
        existing.lastRunId  = run.id;
        if (firstInRun) existing.timesSeen += 1;
      }
    }
  }

  const rows = Array.from(map.values());
  return {
    output,
    keyField: keyField || null,
    columns,
    rows,
    totalRows: rows.length,
    runCount,
  };
}

// The dedupe key for a row. A usable keyField value keys by it; otherwise the
// whole row is hashed via a key-order-independent JSON so two rows with the
// same fields in a different order collapse together.
function rowKey(row, keyField) {
  if (keyField) {
    const v = row[keyField];
    if (v != null && String(v).trim() !== '') return 'k:' + String(v);
  }
  return 'h:' + stableStringify(row);
}

function stableStringify(row) {
  const keys = Object.keys(row).sort();
  const flat = {};
  for (const k of keys) {
    const v = row[k];
    flat[k] = (v != null && typeof v === 'object') ? JSON.stringify(v) : v;
  }
  return JSON.stringify(flat);
}

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isRecordArray(v) {
  return Array.isArray(v) && v.some(isRecord);
}

/* ── build cache ────────────────────────────────────────────────────────────
   The union above is computed on read, which was an honest trade when the
   dataset was fetched once per panel open. The grid now re-requests on every
   sort, filter and keystroke, and re-parsing a hundred results blobs per
   keystroke is not a trade, it is a bug waiting to be reported as "the data
   screen is slow".

   Keyed on a cheap fingerprint of the underlying runs
   (runStore.datasetFingerprint), so a new run or a retention prune
   invalidates it and nothing else has to remember to.

   NOTE ON SAFETY: this cache is keyed by workflow, not by user. Callers MUST
   verify ownership before consulting it — see loadDataset in
   workflows.routes.js, which resolves the workflow for the user first and
   only then looks in here. Never move the lookup above that check.        */

const CACHE_MAX_ENTRIES = 8;
// Above this the entry is served but not retained: holding several very large
// datasets resident costs more memory than the rebuild costs time.
const CACHE_MAX_ROWS = 100000;

const cache = new Map();   // key -> value; Map keeps insertion order for LRU

function cacheKey(parts) {
  return parts.map(p => String(p === null || p === undefined ? '' : p)).join(' ');
}

function cacheGet(key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);        // reinsert so the most recently used is last
  cache.set(key, value);
  return value;
}

function cacheSet(key, value, rowCount) {
  if (rowCount > CACHE_MAX_ROWS) return value;
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);   // oldest first
  }
  return value;
}

function cacheClear() { cache.clear(); }
function cacheSize()  { return cache.size; }

module.exports = {
  listOutputs, buildDataset, defaultKeyField, rowKey,
  cacheKey, cacheGet, cacheSet, cacheClear, cacheSize,
};
