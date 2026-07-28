'use strict';

const express = require('express');
const workflows = require('../db/repositories/workflows.repo');
const runStore = require('../services/runStore.service');
const dataset = require('../services/dataset.service');
const { resultsToCsv } = require('../utils/resultsExport');
const { resultsToXlsx } = require('../utils/resultsXlsx');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const MAX_NAME_LEN = 120;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2 MB cap per workflow

// Cross-run dataset tuning.
const DATASET_MAX_RUNS = 100;      // how many recent successful runs to union
const DATASET_PAGE_MAX = 1000;     // hard cap on rows returned per JSON page
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
async function loadDataset(workflowId, userId, query) {
  const row = await workflows.getForUser(workflowId, userId);
  if (!row) return { error: 'Not found', status: 404 };

  const runs = await runStore.recentSuccessfulRunsWithResults(workflowId, DATASET_MAX_RUNS);
  const outputs = dataset.listOutputs(runs);
  if (outputs.length === 0) {
    return { empty: true, outputs: [], runsConsidered: runs.length };
  }

  // Chosen output: requested if it's datasetable, else the first one.
  const requested = query.output != null ? String(query.output) : null;
  const chosen = outputs.find(o => o.key === requested) || outputs[0];

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
  return { built, outputs, runsConsidered: runs.length };
}

// Flatten dataset rows for CSV/XLSX export: scraped fields first, then the
// human-labelled provenance columns.
function flattenForExport(built) {
  return built.rows.map(r => ({
    ...r.data,
    [META_FIRST]: r.firstSeenAt,
    [META_LAST]:  r.lastSeenAt,
    [META_TIMES]: r.timesSeen,
  }));
}

// JSON: dataset metadata + a page of rows. ?output=&key=&limit=&offset=
router.get('/:id/dataset', async (req, res) => {
  const r = await loadDataset(req.params.id, req.user.id, req.query);
  if (r.error) return res.status(r.status).json({ error: r.error });
  if (r.empty) {
    return res.json({ outputs: [], rows: [], columns: [], total: 0, runsConsidered: r.runsConsidered });
  }

  const { built, outputs, runsConsidered } = r;
  const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), DATASET_PAGE_MAX);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const page = built.rows.slice(offset, offset + limit);

  res.json({
    outputs: outputs.map(o => ({ key: o.key, fields: o.fields, latestCount: o.latestCount })),
    output: built.output,
    keyField: built.keyField,          // null = whole-row dedupe
    columns: built.columns,
    keyOptions: built.columns,          // fields the user can dedupe on
    rows: page,
    total: built.totalRows,
    offset,
    limit,
    runsConsidered,
  });
});

// CSV / XLSX download of the whole dataset (not just a page).
router.get('/:id/dataset.csv', async (req, res) => {
  const r = await loadDataset(req.params.id, req.user.id, req.query);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const results = r.empty ? {} : { [r.built.output]: flattenForExport(r.built) };
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="dataset-${req.params.id}.csv"`);
  res.send(resultsToCsv(results));
});

router.get('/:id/dataset.xlsx', async (req, res) => {
  const r = await loadDataset(req.params.id, req.user.id, req.query);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const results = r.empty ? {} : { [r.built.output]: flattenForExport(r.built) };
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

module.exports = router;
