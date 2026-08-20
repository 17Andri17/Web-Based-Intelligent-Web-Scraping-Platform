'use strict';

const express = require('express');
const workflows = require('../db/repositories/workflows.repo');
const runStore = require('../services/runStore.service');
const dataset = require('../services/dataset.service');
const view = require('../services/datasetView.service');
const changeDiff = require('../services/changeDiff.service');
const { resultsToCsv } = require('../utils/resultsExport');
const { resultsToXlsx } = require('../utils/resultsXlsx');
const sheets = require('../services/googleSheets.service');
const customActionsRepo = require('../db/repositories/customActions.repo');
const { collectCustomActionIds, collectSubflowIds } = require('../workflow/workflowUtils');
const portable = require('../utils/workflowPortable');
const workflowImport = require('../services/workflowImport.service');
const templates = require('../services/templates.service');
const { validateInputs } = require('../utils/workflowInputs');
const { requireAuth } = require('../middleware/auth');
const entitlements = require('../services/entitlements.service');

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }
const MAX_INPUTS_BYTES = 16 * 1024;   // per-row inputs cap (matches /v1)

/* Free is a one-workflow plan — maxWorkflows is the limit that defines the
   demo, so every route that can bring a workflow into existence has to check
   it, not just POST /. There are four: create, import, use-a-template, and
   duplicate. Gating only the obvious one would leave "duplicate" as a
   one-click way around the entire free tier.

   Throws EntitlementError; app.js renders it as a 402 carrying the limit and
   the cheapest plan that lifts it. */
async function assertCanAddWorkflow(userId) {
  await entitlements.assertWithinLimit(
    userId, 'maxWorkflows', await workflows.countForUser(userId), 'workflows');
}
const MAX_BULK_ROWS = 500;            // cap runs enqueued in one bulk request

const router = express.Router();
router.use(requireAuth);

const MAX_NAME_LEN = 120;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2 MB cap per workflow

// Cross-run dataset tuning.
const DATASET_MAX_RUNS = 100;      // how many recent successful runs to union
const DATASET_PAGE_MAX = 1000;     // hard cap on rows returned per JSON page
const RUN_PICKER_LIMIT = 50;       // runs offered in the dataset's run selector
// Run-to-run diff tuning.
const DIFF_RUNS_LIMIT = 50;        // runs offered in the comparison pickers
const DIFF_ROWS_DEFAULT = 200;     // rows returned per bucket (added/removed/changed)
const DIFF_ROWS_MAX = 1000;
const WHOLE_ROW_KEY = '__row__';   // same sentinel the dataset endpoint uses
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// Human-labelled provenance columns appended to each exported dataset row.
// Spaces make a collision with a scraped field name very unlikely.
const META_FIRST = 'First seen';
const META_LAST  = 'Last seen';
const META_TIMES = 'Times seen';

function serializeWorkflow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    steps: JSON.parse(row.steps_json),
    meta: row.meta_json ? JSON.parse(row.meta_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validatePayload(body) {
  const { name, steps, meta } = body || {};
  if (typeof name !== 'string' || !name.trim()) return 'Name is required';
  if (name.length > MAX_NAME_LEN) return `Name too long (max ${MAX_NAME_LEN})`;
  if (!Array.isArray(steps)) return 'Steps must be an array';
  const stepsJson = JSON.stringify(steps);
  if (Buffer.byteLength(stepsJson, 'utf8') > MAX_PAYLOAD_BYTES) return 'Workflow too large';
  const metaJson = meta == null ? null : JSON.stringify(meta);
  return { name: name.trim(), stepsJson, metaJson };
}

// Extract the workflow's declared input variables (variables flagged
// `input`) from its meta JSON, as a compact list the subflow picker can map
// parent data onto. Never throws on malformed meta — returns [].
function inputVarsFromMeta(metaJson) {
  if (!metaJson) return [];
  let meta;
  try { meta = JSON.parse(metaJson); } catch (_) { return []; }
  const vars = Array.isArray(meta?.variables) ? meta.variables : [];
  return vars
    .filter(v => v && typeof v === 'object' && v.input && v.name)
    .map(v => ({
      name: String(v.name),
      type: v.type || 'string',
      value: v.value == null ? '' : String(v.value),
      description: v.description ? String(v.description) : '',
    }));
}

// List all workflows for the user (summary only — no steps payload).
router.get('/', async (req, res) => {
  const rows = await workflows.listSummariesForUser(req.user.id);
  res.json({ workflows: rows.map(r => ({
    id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at,
    inputs: inputVarsFromMeta(r.meta_json),
  })) });
});

// Get full workflow by id
router.get('/:id', async (req, res) => {
  const row = await workflows.getForUser(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ workflow: serializeWorkflow(row) });
});

// Create new workflow
router.post('/', async (req, res) => {
  const v = validatePayload(req.body);
  if (typeof v === 'string') return res.status(400).json({ error: v });
  await assertCanAddWorkflow(req.user.id);
  const row = await workflows.create({
    userId: req.user.id, name: v.name, stepsJson: v.stepsJson, metaJson: v.metaJson,
  });
  res.status(201).json({ workflow: serializeWorkflow(row) });
});

// Update existing workflow (overwrite)
router.put('/:id', async (req, res) => {
  const owned = await workflows.existsForUser(req.params.id, req.user.id);
  if (!owned) return res.status(404).json({ error: 'Not found' });
  const v = validatePayload(req.body);
  if (typeof v === 'string') return res.status(400).json({ error: v });
  const row = await workflows.update({
    id: req.params.id, userId: req.user.id,
    name: v.name, stepsJson: v.stepsJson, metaJson: v.metaJson,
  });
  res.json({ workflow: serializeWorkflow(row) });
});

router.delete('/:id', async (req, res) => {
  const changes = await workflows.remove(req.params.id, req.user.id);
  if (changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Cross-run dataset (accumulate rows across a workflow's runs) ─────────────

// Every COLLECT_LIST keyField declared anywhere in a step tree (control-flow
// bodies included), so the dataset can default its dedupe key to what the
// workflow already de-dupes on. Recursive over any array-valued step props
// (body, then/else branches, …) so nested lists are found too.
function collectKeyFields(steps, out = []) {
  if (!Array.isArray(steps)) return out;
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const kf = step.params && step.params.keyField;
    if (kf && typeof kf === 'string') out.push(kf);
    for (const v of Object.values(step)) {
      if (Array.isArray(v)) collectKeyFields(v, out);
    }
  }
  return out;
}

// Resolve output + dedupe key + build the dataset for a workflow the caller
// owns. Returns { built, outputs, meta } or an { error, status } to send.
/* Which run (or runs) the caller is asking about.

   `?run=all`  the union across retained runs — what this screen used to be,
               and the right answer for "everything I have ever collected".
   `?run=<id>` exactly that run.
   default     the latest successful run, because the overwhelmingly common
               question after a scrape finishes is "did THIS one come out
               right?", and answering it with a union across three months of
               history buries the run you just watched. */
function resolveRun(query, runList) {
  if (query.run === 'all') return 'all';
  const asked = parseInt(query.run, 10);
  if (Number.isFinite(asked) && runList.some(r => r.id === asked)) return asked;
  return runList.length ? runList[0].id : 'all';   // brief list is newest-first
}

async function loadDataset(workflowId, userId, query) {
  // Ownership is checked FIRST and always live — the cache below is keyed by
  // workflow, not by user, so this check is what keeps it safe. Never reorder.
  const row = await workflows.getForUser(workflowId, userId);
  if (!row) return { error: 'Not found', status: 404 };

  // Cheap: ids and timestamps only, no results parsed. Feeds the run picker
  // and resolves which run "latest" means.
  const runList = await runStore.successfulRunsBrief(workflowId, RUN_PICKER_LIMIT);
  const runSel = resolveRun(query, runList);

  /* The union is expensive and the grid re-requests on every sort and
     filter, so a cheap fingerprint of the underlying runs decides whether
     any of it has to happen again. */
  const fp = await runStore.datasetFingerprint(workflowId);
  const key = dataset.cacheKey([
    workflowId, fp.latestRunId, fp.runCount, runSel,
    query.output != null ? query.output : '',
    query.key != null ? query.key : '',
  ]);
  const hit = dataset.cacheGet(key);
  if (hit) return hit;

  const result = await buildDatasetFor(row, workflowId, query, runSel, runList);
  return dataset.cacheSet(key, result, result.built ? result.built.totalRows : 0);
}

/* One run's rows, exactly as it produced them.

   Deliberately NOT de-duplicated. Across runs, collapsing repeats is the
   entire point; within one run it would hide the thing you most want to
   see — a pagination loop that revisited page 1 shows up as duplicate rows,
   and de-duplicating them silently repairs the evidence. */
function buildSingleRun(run, outputKey) {
  const value = run && run.results ? run.results[outputKey] : null;
  const list = Array.isArray(value) ? value.filter(v => v && typeof v === 'object' && !Array.isArray(v)) : [];
  const columns = view.buildColumns(list);
  return {
    output: outputKey,
    keyField: null,
    columns,
    rows: list.map((data, i) => ({ key: `i:${i}`, data, firstSeenAt: run.startedAt, lastSeenAt: run.finishedAt, timesSeen: 1 })),
    totalRows: list.length,
    runCount: 1,
  };
}

async function buildDatasetFor(row, workflowId, query, runSel, runList) {
  const runs = runSel === 'all'
    ? await runStore.recentSuccessfulRunsWithResults(workflowId, DATASET_MAX_RUNS)
    : [await runStore.runWithResults(workflowId, runSel)].filter(Boolean);

  const outputs = dataset.listOutputs(runs);
  if (outputs.length === 0) {
    return { empty: true, outputs: [], runsConsidered: runs.length, runs: runList, run: runSel };
  }

  // Chosen output: requested if it's datasetable, else the first one.
  const requested = query.output != null ? String(query.output) : null;
  const chosen = outputs.find(o => o.key === requested) || outputs[0];

  /* A single run is shown as it came out: no dedupe key, no provenance.
     "First seen / last seen / times seen" describe accumulation, and inside
     one run they are the same three values on every row — which the
     constant-column detector would then quite correctly flag as noise. */
  if (runSel !== 'all') {
    return {
      built: buildSingleRun(runs[0], chosen.key),
      outputs, runsConsidered: 1, runs: runList, run: runSel, withProvenance: false,
    };
  }

  // Dedupe key: explicit `key` (must be a column, or the literal "__row__" for
  // whole-row) wins; otherwise a default from the workflow's own keyField or an
  // identity-column heuristic.
  let steps = [];
  try { steps = JSON.parse(row.steps_json); } catch (_) {}
  const stepKeyHint = collectKeyFields(steps).find(k => chosen.fields.includes(k)) || null;

  let keyField;
  if (query.key === '__row__') {
    keyField = null;
  } else if (query.key != null && chosen.fields.includes(String(query.key))) {
    keyField = String(query.key);
  } else {
    keyField = dataset.defaultKeyField(chosen.fields, stepKeyHint);
  }

  const built = dataset.buildDataset(runs, { output: chosen.key, keyField });
  return { built, outputs, runsConsidered: runs.length, runs: runList, run: 'all', withProvenance: true };
}

// Flatten dataset rows for CSV/XLSX export: scraped fields first, then the
// human-labelled provenance columns.
function flattenForExport(built, withProvenance = true) {
  if (!withProvenance) return built.rows.map(r => ({ ...r.data }));
  return built.rows.map(r => ({
    ...r.data,
    [META_FIRST]: r.firstSeenAt,
    [META_LAST]:  r.lastSeenAt,
    [META_TIMES]: r.timesSeen,
  }));
}

const META_COLUMNS = [META_FIRST, META_LAST, META_TIMES];

/* Filtering, sorting and profiling all want a flat record; the response
   keeps the nested { key, data, …provenance } shape its callers already
   read. So build a flat mirror, work on that, and map the survivors back.

   The mirror includes the provenance columns deliberately — "which rows have
   I only seen once?" and "what appeared today?" are among the more useful
   questions this screen can answer, and they are only sortable if the
   provenance travels with the data. */
function flattenForView(built, metaColumns = META_COLUMNS) {
  const withMeta = metaColumns.length > 0;
  const flat = [];
  const origin = new Map();
  for (const r of built.rows) {
    const rec = withMeta
      ? Object.assign({}, r.data, {
          [META_FIRST]: r.firstSeenAt,
          [META_LAST]:  r.lastSeenAt,
          [META_TIMES]: r.timesSeen,
        })
      : Object.assign({}, r.data);
    flat.push(rec);
    origin.set(rec, r);
  }
  return { flat, origin };
}

// ── query parsing ───────────────────────────────────────────────────────────
// Every parser is bounded: these arrive straight off the query string.

const MAX_SORTS   = 8;
const MAX_FILTERS = 40;
const CELL_MAX_MIN = 20;
const CELL_MAX_MAX = 4000;

// "price:desc,title:asc" → [{ id, dir }], keeping only real columns.
function parseSorts(raw, columns) {
  if (!raw) return [];
  const known = new Set(columns);
  return String(raw).split(',')
    .map(part => {
      const i = part.lastIndexOf(':');
      const id = (i === -1 ? part : part.slice(0, i)).trim();
      const dir = (i === -1 ? 'asc' : part.slice(i + 1)).trim().toLowerCase();
      return { id, dir: dir === 'desc' ? 'desc' : 'asc' };
    })
    .filter(s => s.id && known.has(s.id))
    .slice(0, MAX_SORTS);
}

// A JSON object of column → filter expression. Malformed JSON filters nothing
// rather than 400-ing: a broken filter should show you your data, not an error.
function parseFilters(raw, columns) {
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const known = new Set(columns);
  const out = {};
  let n = 0;
  for (const id of Object.keys(parsed)) {
    if (!known.has(id)) continue;
    const expr = parsed[id];
    if (typeof expr !== 'string' && typeof expr !== 'number') continue;
    out[id] = String(expr);
    if (++n >= MAX_FILTERS) break;
  }
  return out;
}

// An explicit column subset, in the caller's order. Unknown names are dropped;
// asking for nothing recognisable means "everything", never "no columns".
function parseColumns(raw, columns) {
  if (!raw) return columns;
  const known = new Set(columns);
  const picked = String(raw).split(',').map(s => s.trim()).filter(s => known.has(s));
  return picked.length ? picked : columns;
}

function parseCellMax(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;          // 0 = don't clip
  return Math.min(Math.max(n, CELL_MAX_MIN), CELL_MAX_MAX);
}

// JSON: dataset metadata + a page of rows. ?output=&key=&limit=&offset=
/* Cross-workflow data summary — one row per workflow for the global "Data"
   screen, so "where is everything I've collected?" is one request instead of
   opening each workflow's dataset in turn.

   Costed deliberately: the per-workflow dataset is computed on read by
   unioning run results, so doing it for EVERY workflow over the full
   retention window would be the most expensive call in the app. This unions a
   shorter window (SUMMARY_MAX_RUNS) and reports `runsConsidered` alongside the
   count, exactly as the per-workflow view already does — the number stays
   honest, it's just over a smaller window. Anyone who wants the full picture
   clicks through to the workflow's own dataset. */
const SUMMARY_MAX_RUNS = 25;      // runs unioned per workflow for the summary
const SUMMARY_MAX_WORKFLOWS = 100; // workflows summarised in one request

// Two segments on purpose: a single-segment "/data-summary" would be captured
// by the "GET /:id" declared above it (Express matches in registration order).
router.get('/dataset/summary', async (req, res) => {
  const all = await workflows.listSummariesForUser(req.user.id);
  const slice = all.slice(0, SUMMARY_MAX_WORKFLOWS);

  const items = [];
  for (const summary of slice) {
    let entry = {
      workflowId: summary.id,
      name: summary.name,
      updatedAt: summary.updated_at,
      outputs: [],
      primaryOutput: null,
      totalRows: 0,
      runsConsidered: 0,
      error: null,
    };
    try {
      const runs = await runStore.recentSuccessfulRunsWithResults(summary.id, SUMMARY_MAX_RUNS);
      entry.runsConsidered = runs.length;
      const outputs = dataset.listOutputs(runs);
      if (outputs.length > 0) {
        const chosen = outputs[0];
        // The full row (for steps_json) rather than the summary: the dedupe
        // key must be derived exactly as the per-workflow view derives it, or
        // this screen would quote a row count the detail view then contradicts.
        // Cheap next to the run-results union we just did.
        const row = await workflows.getForUser(summary.id, req.user.id);
        let steps = [];
        try { steps = JSON.parse(row && row.steps_json); } catch (_) {}
        const stepKeyHint = collectKeyFields(steps).find(k => chosen.fields.includes(k)) || null;
        const built = dataset.buildDataset(runs, {
          output: chosen.key,
          keyField: dataset.defaultKeyField(chosen.fields, stepKeyHint),
        });
        entry.outputs = outputs.map(o => ({ key: o.key, fields: o.fields, latestCount: o.latestCount }));
        entry.primaryOutput = chosen.key;
        entry.totalRows = built.totalRows;
      }
    } catch (e) {
      // One unreadable workflow must not blank the whole screen.
      entry.error = e && e.message ? e.message : 'Could not read this dataset';
    }
    items.push(entry);
  }

  res.json({
    items,
    runsPerWorkflow: SUMMARY_MAX_RUNS,
    truncated: all.length > slice.length,
    totalWorkflows: all.length,
  });
});

/* Self-healing history — how often this scraper repaired itself, and where.

   The data has been in `run_repairs` since self-healing shipped; this is the
   first way out of the database for it. Worth surfacing because it is the
   platform's most persuasive claim and it has been completely invisible: a
   scraper that quietly fixed itself four times looks identical to one that
   never broke. */
router.get('/:id/healing', async (req, res) => {
  const wf = await workflows.getForUser(req.params.id, req.user.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });

  const sinceDays = Math.max(1, Math.min(parseInt(req.query.days, 10) || 90, 365));
  const out = await runStore.healingHistoryForWorkflow(req.params.id, req.user.id, { sinceDays });

  // Step ids mean nothing to a reader; resolve them to the labels shown in the
  // editor so the rollup names the step the user recognises.
  const labels = {};
  try {
    const walk = (arr) => {
      for (const s of arr || []) {
        if (!s || typeof s !== 'object') continue;
        if (s.id) labels[s.id] = s.label || s.type;
        for (const k of ['body', 'then', 'else', 'try', 'catch']) {
          if (Array.isArray(s[k])) walk(s[k]);
        }
      }
    };
    walk(JSON.parse(wf.steps_json));
  } catch (_) { /* a step tree we can't parse just means unlabelled ids */ }

  res.json({
    ...out,
    bySteps: out.bySteps.map(s => ({ ...s, label: labels[s.stepId] || s.stepType || 'A step' })),
    repairs: out.repairs.map(r => ({ ...r, label: labels[r.step_id] || r.step_type || 'A step' })),
  });
});

/* A page of the dataset, filtered, sorted and projected server-side.

   ?output=  ?key=            which list, and what to de-duplicate on
   ?q=                        substring across the requested columns
   ?filter=                   JSON: { column: expression } — see datasetView
   ?sort=                     "price:desc,title:asc", ranked left to right
   ?columns=                  only serialise these (the payload win on a wide scrape)
   ?cellMax=                  clip long values to N characters
   ?limit= ?offset=           the page

   Order is filter → profile → sort → project → slice, and `total` reports the
   post-filter count so the pager describes what the caller can actually reach.
   The profile is the one thing computed over the WHOLE dataset rather than
   the filtered subset: a fill rate that silently described whatever you had
   filtered to would be worse than none at all. */
router.get('/:id/dataset', async (req, res) => {
  const r = await loadDataset(req.params.id, req.user.id, req.query);
  if (r.error) return res.status(r.status).json({ error: r.error });
  if (r.empty) {
    return res.json({
      outputs: [], rows: [], columns: [], meta: [], profiles: {}, issues: [],
      total: 0, runsConsidered: r.runsConsidered,
      runs: r.runs || [], run: r.run ?? 'all',
    });
  }

  const { built, outputs, runsConsidered } = r;
  const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), DATASET_PAGE_MAX);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const metaColumns = r.withProvenance ? META_COLUMNS : [];
  const { flat, origin } = flattenForView(built, metaColumns);
  const allColumns = built.columns.concat(metaColumns);

  const profiles = view.profileColumns(flat, allColumns);
  const issues   = view.findIssues(flat, allColumns, profiles);
  const types    = {};
  for (const id of allColumns) types[id] = profiles[id].type;

  const wanted  = parseColumns(req.query.columns, allColumns);
  const filters = parseFilters(req.query.filter, allColumns);
  const sorts   = parseSorts(req.query.sort, allColumns);
  const cellMax = parseCellMax(req.query.cellMax);

  /* One full row, unprojected — what the grid's row detail asks for when the
     page it was rendered from had columns dropped or cells clipped. Answered
     from the same cached build, so it costs nothing but the lookup. */
  if (req.query.rowKey != null) {
    const found = built.rows.find(x => x.key === String(req.query.rowKey));
    if (!found) return res.status(404).json({ error: 'Row not found' });
    return res.json({ row: found });
  }

  /* The issue chips narrow to a condition that belongs to the row rather
     than to any one column — "missing something the scrape usually gets" is
     an OR across columns, and "duplicated" needs the whole dataset — so
     neither can be expressed as a column filter and both arrive as this. */
  let rowFilter = null;
  if (req.query.issue === 'incomplete') {
    const sparse = issues.find(i => i.kind === 'sparse');
    const cols = (sparse && sparse.rowColumns) || [];
    if (cols.length) rowFilter = (row) => view.isIncompleteRow(row, cols);
  } else if (req.query.issue === 'duplicates') {
    const dupes = view.duplicateRows(flat, allColumns);
    rowFilter = (row) => dupes.has(row);
  }

  const matched = view.buildView(flat, {
    filters,
    query: req.query.q || '',
    searchColumns: wanted,
    sorts,
    types,
    rowFilter,
  });

  // Back to the nested shape callers already read, with `data` reduced to the
  // requested columns and long values clipped before they cross the wire.
  const dataCols = wanted.filter(c => !metaColumns.includes(c));
  const page = matched.slice(offset, offset + limit).map(rec => {
    const src = origin.get(rec);
    return {
      key: src.key,
      data: view.projectRows([src.data], dataCols, cellMax)[0],
      firstSeenAt: src.firstSeenAt,
      lastSeenAt:  src.lastSeenAt,
      timesSeen:   src.timesSeen,
    };
  });

  res.json({
    outputs: outputs.map(o => ({ key: o.key, fields: o.fields, latestCount: o.latestCount })),
    output: built.output,
    keyField: built.keyField,          // null = whole-row dedupe
    columns: built.columns,             // scraped fields only, as before
    keyOptions: built.columns,          // fields the user can dedupe on
    meta: metaColumns,                  // provenance columns, sortable like any other
    runs: r.runs || [],                 // what the run picker can offer
    run: r.run,                         // 'all', or the run being shown
    profiles,                           // over the whole dataset, not this page
    issues,
    rows: page,
    total: matched.length,              // post-filter, so the pager is honest
    unfilteredTotal: built.totalRows,
    offset,
    limit,
    runsConsidered,
  });
});

/* CSV / XLSX download of the whole dataset (not just a page).

   These take the same ?q= / ?filter= / ?sort= / ?columns= the JSON endpoint
   does, deliberately: downloading something different from what is on screen
   is a bug report waiting to happen. With no such params the export is the
   entire dataset exactly as before.

   `cellMax` is NOT honoured here. Clipping is a rendering concession for a
   grid cell; a spreadsheet is where someone goes to get the whole value. */
function exportRows(r, query) {
  if (r.empty) return [];
  const metaColumns = r.withProvenance ? META_COLUMNS : [];
  const rows = flattenForExport(r.built, r.withProvenance);
  const allColumns = r.built.columns.concat(metaColumns);
  const profiles = view.profileColumns(rows, allColumns);
  const types = {};
  for (const id of allColumns) types[id] = profiles[id].type;

  const wanted = parseColumns(query.columns, allColumns);
  const matched = view.buildView(rows, {
    filters: parseFilters(query.filter, allColumns),
    query: query.q || '',
    searchColumns: wanted,
    sorts: parseSorts(query.sort, allColumns),
    types,
  });
  return query.columns ? view.projectRows(matched, wanted, 0) : matched;
}

router.get('/:id/dataset.csv', async (req, res) => {
  const r = await loadDataset(req.params.id, req.user.id, req.query);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const results = r.empty ? {} : { [r.built.output]: exportRows(r, req.query) };
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="dataset-${req.params.id}.csv"`);
  res.send(resultsToCsv(results));
});

router.get('/:id/dataset.xlsx', async (req, res) => {
  const r = await loadDataset(req.params.id, req.user.id, req.query);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const results = r.empty ? {} : { [r.built.output]: exportRows(r, req.query) };
  const buf = await resultsToXlsx(results);
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="dataset-${req.params.id}.xlsx"`);
  res.send(buf);
});

// ── Change monitoring (per-workflow "watch for changes") ────────────────────

function serializeMonitor(row) {
  if (!row) return null;
  return {
    workflowId: row.workflow_id,
    isActive: !!row.is_active,
    outputKey: row.output_key || null,   // null = primary list
    // Stored '' means explicit whole-row; null means auto. Surface both as-is.
    keyField: row.key_field == null ? null : row.key_field,
    updatedAt: row.updated_at,
  };
}

function parseSummary(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch (_) { return null; }
}

// Get the monitor config + recent change feed for a workflow.
router.get('/:id/monitor', async (req, res) => {
  const owned = await workflows.existsForUser(req.params.id, req.user.id);
  if (!owned) return res.status(404).json({ error: 'Not found' });
  const monitor = await runStore.getMonitorForWorkflow(req.user.id, req.params.id);
  const changed = await runStore.recentChangedRuns(req.params.id, 20);
  res.json({
    monitor: serializeMonitor(monitor),
    changes: changed.map(r => ({
      runId: r.id,
      at: r.finished_at || r.started_at,
      status: r.status,
      summary: parseSummary(r.change_summary_json),
    })),
  });
});

// Enable / update a monitor. Body: { isActive?, outputKey?, keyField? }
// keyField: a column name, "" for whole-row, or null/omitted for auto.
router.put('/:id/monitor', async (req, res) => {
  const owned = await workflows.existsForUser(req.params.id, req.user.id);
  if (!owned) return res.status(404).json({ error: 'Not found' });
  await entitlements.assertFeature(req.user.id, 'changeMonitoring', 'Change monitoring');
  const b = req.body || {};
  const isActive = b.isActive === undefined ? true : !!b.isActive;
  const outputKey = b.outputKey == null || b.outputKey === '' ? null : String(b.outputKey);
  // Distinguish "auto" (null/undefined) from "whole-row" (empty string).
  let keyField = null;
  if (b.keyField === '') keyField = '';
  else if (b.keyField != null) keyField = String(b.keyField);
  const saved = await runStore.upsertMonitor({
    userId: req.user.id, workflowId: Number(req.params.id), isActive, outputKey, keyField,
  });
  res.json({ monitor: serializeMonitor(saved) });
});

router.delete('/:id/monitor', async (req, res) => {
  const changes = await runStore.deleteMonitor(req.user.id, req.params.id);
  if (changes === 0) return res.status(404).json({ error: 'No monitor for this workflow' });
  res.json({ ok: true });
});

// ── Run-to-run diff (the Compare view) ──────────────────────────────────────
// Computes a full diff on demand rather than reading the bounded summary stored
// on the run row, so the UI can show every changed row with its old and new
// values — and can compare *any* two runs, including runs that predate the
// monitor being switched on.
//
//   GET /:id/diff?runId=&baseRunId=&output=&key=&limit=
//     runId     — the "after" run (default: latest successful run with results)
//     baseRunId — the "before" run (default: the successful run just before it)
//     output    — which list to diff (default: the monitor's, else primary)
//     key       — dedupe column, "__row__" for whole-row, omit for auto
//     limit     — cap on rows returned per bucket (counts stay exact)
router.get('/:id/diff', async (req, res) => {
  const owned = await workflows.existsForUser(req.params.id, req.user.id);
  if (!owned) return res.status(404).json({ error: 'Not found' });
  const workflowId = Number(req.params.id);

  const runs = await runStore.successfulRunsBrief(workflowId, DIFF_RUNS_LIMIT);
  if (runs.length === 0) {
    return res.json({ runs: [], run: null, base: null, outputs: [], diff: null });
  }

  const afterId = req.query.runId ? Number(req.query.runId) : runs[0].id;
  const after = await runStore.runWithResults(workflowId, afterId);
  if (!after) return res.status(404).json({ error: 'Run not found, or it has no stored results' });

  // Default baseline: the successful run immediately before the chosen one.
  let before = null;
  if (req.query.baseRunId) {
    before = await runStore.runWithResults(workflowId, Number(req.query.baseRunId));
    if (!before) return res.status(404).json({ error: 'Comparison run not found, or it has no stored results' });
  } else {
    before = await runStore.previousSuccessfulRunWithResults(workflowId, afterId);
  }

  // Which list, and how rows are matched — same defaulting as the monitor and
  // the Data view, so "changed" means the same thing everywhere.
  const monitor = await runStore.getMonitorForWorkflow(req.user.id, workflowId);
  const outputs = dataset.listOutputs([
    ...(before ? [{ results: before.results }] : []),
    { results: after.results },
  ]);
  if (outputs.length === 0) {
    return res.json({ runs, run: runMeta(after), base: before ? runMeta(before) : null, outputs: [], diff: null });
  }
  const requested = req.query.output ? String(req.query.output) : (monitor && monitor.output_key) || null;
  const chosen = (requested && outputs.find(o => o.key === requested)) || outputs[0];

  let keyField;
  if (req.query.key != null && req.query.key !== '') {
    keyField = req.query.key === WHOLE_ROW_KEY ? null : String(req.query.key);
  } else if (monitor && monitor.key_field != null) {
    keyField = monitor.key_field === '' ? null : monitor.key_field;
  } else {
    keyField = dataset.defaultKeyField(chosen.fields, null);
  }

  const full = changeDiff.diffResults(before ? before.results : null, after.results, {
    output: chosen.key,
    keyField,
  });

  // Counts always describe the whole diff; the row arrays are capped so one
  // enormous run can't produce a multi-megabyte response.
  const limit = Math.min(Math.max(Number(req.query.limit) || DIFF_ROWS_DEFAULT, 1), DIFF_ROWS_MAX);
  res.json({
    runs,
    run: runMeta(after),
    base: before ? runMeta(before) : null,
    outputs: outputs.map(o => ({ key: o.key, fields: o.fields })),
    output: chosen.key,
    // '' (not null) marks whole-row so the client can round-trip it as __row__.
    keyField: keyField == null ? '' : keyField,
    diff: {
      counts: full.summary,
      hasChanges: full.hasChanges,
      fieldStats: changeDiff.summarizeDiff(full, { sample: 0 }).fieldStats,
      truncated: {
        added: full.added.length > limit,
        removed: full.removed.length > limit,
        changed: full.changed.length > limit,
      },
      added: full.added.slice(0, limit),
      removed: full.removed.slice(0, limit),
      changed: full.changed.slice(0, limit),
    },
  });
});

function runMeta(r) {
  return { id: r.id, startedAt: r.startedAt, finishedAt: r.finishedAt || null };
}

// ── Bulk / parameterized runs ───────────────────────────────────────────────
// Enqueue one background run per input row. Each row is an inputs object
// overriding the workflow's declared variables; a single-element `rows` is
// "Run with inputs". The queued runs are executed by the API worker (headless,
// bounded concurrency) — the same path as scheduled and /v1-triggered runs, so
// self-healing, monitoring, sheets delivery, and webhooks all apply.
router.post('/:id/bulk-run', async (req, res) => {
  const wf = await workflows.getForUser(req.params.id, req.user.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });

  const rows = req.body && req.body.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'Provide a non-empty "rows" array of input objects.' });
  }
  if (rows.length > MAX_BULK_ROWS) {
    return res.status(400).json({ error: `Too many rows (${rows.length}). Max ${MAX_BULK_ROWS} per bulk run.` });
  }

  const meta = wf.meta_json ? safeJson(wf.meta_json) || {} : {};
  for (let i = 0; i < rows.length; i++) {
    const err = validateInputs(meta, rows[i]);
    if (err) return res.status(400).json({ error: `Row ${i + 1}: ${err}` });
    if (Buffer.byteLength(JSON.stringify(rows[i]), 'utf8') > MAX_INPUTS_BYTES) {
      return res.status(400).json({ error: `Row ${i + 1}: inputs too large (max ${MAX_INPUTS_BYTES / 1024}KB).` });
    }
  }

  const runIds = [];
  for (const inputs of rows) {
    const runId = await runStore.createQueuedRun({
      userId: req.user.id,
      workflowId: Number(req.params.id),
      trigger: 'bulk',
      inputsJson: JSON.stringify(inputs),
    });
    runIds.push(runId);
  }
  res.status(202).json({ created: runIds.length, runIds });
});

// ── Google Sheets delivery ──────────────────────────────────────────────────

function serializeSheet(row) {
  if (!row) return null;
  return {
    workflowId:    row.workflow_id,
    isActive:      !!row.is_active,
    spreadsheetId: row.spreadsheet_id,
    sheetName:     row.sheet_name || 'Sheet1',
    outputKey:     row.output_key || null,   // null = primary list
    lastStatus:    row.last_status || null,
    lastSentAt:    row.last_sent_at || null,
  };
}

// Config + the instance's service-account status (so the UI can tell the user
// which e-mail to share the sheet with, and whether delivery can work at all).
router.get('/:id/sheet', async (req, res) => {
  const owned = await workflows.existsForUser(req.params.id, req.user.id);
  if (!owned) return res.status(404).json({ error: 'Not found' });
  const cfg = await runStore.getSheetForWorkflow(req.user.id, req.params.id);
  res.json({
    sheet: serializeSheet(cfg),
    serviceAccount: { configured: sheets.isConfigured(), email: sheets.getServiceAccountEmail() },
  });
});

// Enable / update. Body: { isActive?, spreadsheet (id or URL), sheetName?, outputKey? }
router.put('/:id/sheet', async (req, res) => {
  const owned = await workflows.existsForUser(req.params.id, req.user.id);
  if (!owned) return res.status(404).json({ error: 'Not found' });
  await entitlements.assertFeature(req.user.id, 'sheetsDelivery', 'Google Sheets delivery');
  const b = req.body || {};

  const spreadsheetId = sheets.parseSpreadsheetId(b.spreadsheet || b.spreadsheetId || '');
  if (!spreadsheetId) {
    return res.status(400).json({ error: 'Enter a valid Google Sheets URL or spreadsheet ID.' });
  }
  const sheetName = (b.sheetName && String(b.sheetName).trim()) || 'Sheet1';
  const outputKey = b.outputKey == null || b.outputKey === '' ? null : String(b.outputKey);

  const saved = await runStore.upsertSheet({
    userId: req.user.id,
    workflowId: Number(req.params.id),
    isActive: b.isActive === undefined ? true : !!b.isActive,
    spreadsheetId, sheetName, outputKey,
  });
  res.json({ sheet: serializeSheet(saved) });
});

router.delete('/:id/sheet', async (req, res) => {
  const changes = await runStore.deleteSheet(req.user.id, req.params.id);
  if (changes === 0) return res.status(404).json({ error: 'No sheet delivery for this workflow' });
  res.json({ ok: true });
});

// ── Export / import / duplicate ─────────────────────────────────────────────

// Download a workflow as a portable JSON envelope (steps + meta + the bundled
// definitions of any custom actions it references).
router.get('/:id/export', async (req, res) => {
  const wf = await workflows.getForUser(req.params.id, req.user.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });

  const steps = safeJson(wf.steps_json) || [];
  const meta = wf.meta_json ? safeJson(wf.meta_json) || {} : {};
  const actionIds = collectCustomActionIds(steps);
  const rows = actionIds.length ? await customActionsRepo.getManyByIds(req.user.id, actionIds) : [];
  const customActions = rows.map(a => ({
    id: a.id, name: a.name, description: a.description || '',
    inputs: safeJson(a.inputs_json) || [], outputs: safeJson(a.outputs_json) || [], code: a.code || '',
  }));

  const envelope = portable.buildEnvelope({ name: wf.name, steps, meta, customActions });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${portable.exportFileName(wf.name)}"`);
  res.send(JSON.stringify(envelope, null, 2));
});

// Create a new workflow from an uploaded export envelope. Custom actions are
// recreated (or reused by name) and their ids remapped in the steps — see
// workflowImport.service, which the template gallery shares.
router.post('/import', async (req, res) => {
  await assertCanAddWorkflow(req.user.id);
  const out = await workflowImport.createFromEnvelope({
    env: req.body,
    userId: req.user.id,
    // `targetName` is an explicit override (distinct from the envelope's own
    // `name`, which would otherwise always suppress the "(imported)" suffix).
    targetName: req.body.targetName,
    suffix: ' (imported)',
  });
  if (!out.ok) return res.status(out.status).json({ error: out.error });
  // Notes the UI can surface: recreated actions, and any subflow references that
  // won't resolve unless the referenced workflows also exist in this account.
  const { ok, ...body } = out;
  res.status(201).json(body);
});

/* ── Template gallery ──────────────────────────────────────────────────────
   Declared AFTER the concrete /import route but the paths start with a
   literal segment, so they can't be shadowed by /:id — Express matches in
   declaration order and /templates is registered before nothing else that
   could claim it. */

// The catalogue (metadata only — no steps).
router.get('/templates/list', (req, res) => {
  res.json({ templates: templates.list() });
});

// Start a workflow from a template. Same import path as an uploaded file:
// a template is just an envelope this instance ships with.
router.post('/templates/:id/use', async (req, res) => {
  const env = templates.buildEnvelope(req.params.id);
  if (!env) return res.status(404).json({ error: 'Template not found' });

  await assertCanAddWorkflow(req.user.id);
  const out = await workflowImport.createFromEnvelope({
    env,
    userId: req.user.id,
    targetName: req.body && req.body.targetName,
    // No "(imported)" here — the user picked this deliberately and the
    // template's own name is the one they just read on the card.
    suffix: '',
  });
  if (!out.ok) return res.status(out.status).json({ error: out.error });
  const { ok, ...body } = out;
  res.status(201).json(body);
});

// Copy a workflow within the same account ("start from a copy"). Custom-action
// and subflow references stay valid (same account), so no remap is needed.
router.post('/:id/duplicate', async (req, res) => {
  const wf = await workflows.getForUser(req.params.id, req.user.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  await assertCanAddWorkflow(req.user.id);
  const name = `${wf.name} (copy)`.slice(0, MAX_NAME_LEN);
  const copy = await workflows.create({
    userId: req.user.id, name, stepsJson: wf.steps_json, metaJson: wf.meta_json,
  });
  res.status(201).json({ workflow: { id: copy.id, name: copy.name } });
});

module.exports = router;
