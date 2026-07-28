'use strict';

const express = require('express');
const runStore = require('../../services/runStore.service');
const apiWorker = require('../../services/apiWorker.service');
const workflowsRepo = require('../../db/repositories/workflows.repo');
const { sendApiError } = require('../../middleware/apiKeyAuth');
const { serializeRun } = require('../../utils/apiSerialize');
const { resultsToCsv } = require('../../utils/resultsExport');
const { resultsToXlsx } = require('../../utils/resultsXlsx');
const { parseId, parseLimit, parseCursor, pageEnvelope, safeJson } = require('./helpers');

// application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/* ===========================================================================
   /v1/runs — the fetch half of trigger-and-fetch: status, extracted data
   (JSON/CSV), logs, cancellation, and a cursor-paginated listing.
   Every lookup is user-scoped through the API key's owner, so a valid key
   can never read another account's runs (they 404).
   ========================================================================= */

const router = express.Router();

const RUN_STATUSES = new Set(['queued', 'running', 'success', 'error', 'needs_review', 'cancelled']);

// List runs, newest first (?workflow_id=&status=&limit=&cursor=)
router.get('/', async (req, res) => {
  const limit = parseLimit(req.query.limit);
  if (limit === null) return sendApiError(res, 400, 'invalid_request', '"limit" must be a positive integer.');
  const cursor = parseCursor(req.query.cursor);
  if (cursor === null) return sendApiError(res, 400, 'invalid_request', '"cursor" is not a valid cursor from a previous response.');

  let workflowId = null;
  if (req.query.workflow_id != null && req.query.workflow_id !== '') {
    workflowId = parseId(String(req.query.workflow_id));
    if (!workflowId) return sendApiError(res, 400, 'invalid_request', '"workflow_id" must be a positive integer.');
    const owns = await workflowsRepo.existsForUser(workflowId, req.user.id);
    if (!owns) return sendApiError(res, 404, 'not_found', 'No such workflow.');
  }

  let status = null;
  if (req.query.status != null && req.query.status !== '') {
    status = String(req.query.status);
    if (!RUN_STATUSES.has(status)) {
      return sendApiError(res, 400, 'invalid_request',
        `"status" must be one of: ${[...RUN_STATUSES].join(', ')}.`);
    }
  }

  const rows = await runStore.listRunsForUserPage(req.user.id, {
    limit: limit + 1, workflowId, status, beforeId: cursor ?? null,
  });
  res.json(pageEnvelope(rows, limit, serializeRun));
});

// Run status + metadata
router.get('/:id', async (req, res) => {
  const run = await ownedRun(req);
  if (!run) return sendApiError(res, 404, 'not_found', 'No such run.');
  res.json(serializeRun(run));
});

// Extracted data (?format=json|csv, default json)
router.get('/:id/data', async (req, res) => {
  const run = await ownedRun(req);
  if (!run) return sendApiError(res, 404, 'not_found', 'No such run.');

  const format = String(req.query.format || 'json').toLowerCase();
  if (format !== 'json' && format !== 'csv' && format !== 'xlsx') {
    return sendApiError(res, 400, 'invalid_request', '"format" must be "json", "csv", or "xlsx".');
  }
  if (!run.results_json) {
    const hint = ['queued', 'running'].includes(run.status)
      ? `The run is still ${run.status} — poll GET /v1/runs/${run.id} until it finishes.`
      : 'The run finished without extracting any data.';
    return sendApiError(res, 404, 'no_data', `No data for this run. ${hint}`);
  }

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="run-${run.id}.csv"`);
    return res.send(resultsToCsv(safeJson(run.results_json) || {}));
  }
  if (format === 'xlsx') {
    const buf = await resultsToXlsx(safeJson(run.results_json) || {});
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="run-${run.id}.xlsx"`);
    return res.send(buf);
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify({
    object: 'run.data',
    run_id: run.id,
    workflow_id: run.workflow_id,
    data: safeJson(run.results_json),
  }));
});

// Run logs
router.get('/:id/logs', async (req, res) => {
  const run = await ownedRun(req);
  if (!run) return sendApiError(res, 404, 'not_found', 'No such run.');
  const logs = await runStore.getLogs(run.id);
  res.json({
    object: 'list',
    data: logs.map(l => ({ seq: l.seq, level: l.level, line: l.line })),
    has_more: false,
    next_cursor: null,
  });
});

// Cancel a queued or running run.
//   queued  → cancelled in the DB before it ever starts (atomic vs. claim)
//   running → aborted via the worker when it executes in this process
router.post('/:id/cancel', async (req, res) => {
  let run = await ownedRun(req);
  if (!run) return sendApiError(res, 404, 'not_found', 'No such run.');

  if (run.status === 'queued') {
    const cancelled = await runStore.cancelQueuedRun(run.id, req.user.id);
    run = await runStore.getRunForUser(run.id, req.user.id);
    if (cancelled) return res.json(serializeRun(run));
    // Lost the race to the worker — the run is starting; fall through.
  }

  if (run.status === 'running') {
    if (apiWorker.cancel(run.id)) {
      // Abort is signalled; the pipeline persists status='cancelled' shortly.
      return res.status(202).json({ ...serializeRun(run), cancel_requested: true });
    }
    return sendApiError(res, 409, 'not_cancellable',
      'This run is executing outside the API worker (e.g. started from the UI or another process) and cannot be cancelled here.');
  }

  return sendApiError(res, 409, 'not_cancellable', `This run already finished (status: ${run.status}).`);
});

async function ownedRun(req) {
  const id = parseId(req.params.id);
  if (!id) return null;
  return runStore.getRunForUser(id, req.user.id);
}

module.exports = router;
