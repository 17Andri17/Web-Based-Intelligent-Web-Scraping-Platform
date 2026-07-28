'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const runStore = require('../services/runStore.service');
const workflows = require('../db/repositories/workflows.repo');
const { resultsToCsv } = require('../utils/resultsExport');
const { resultsToXlsx } = require('../utils/resultsXlsx');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const router = express.Router();
router.use(requireAuth);

function serialize(row) {
  if (!row) return null;
  return {
    id:             row.id,
    workflowId:     row.workflow_id,
    scheduleId:     row.schedule_id,
    parentRunId:    row.parent_run_id,
    trigger:        row.trigger,
    status:         row.status,
    startedAt:      row.started_at,
    finishedAt:     row.finished_at,
    durationMs:     row.duration_ms,
    errorMessage:   row.error_message,
    errorCategory:  row.error_category,
    aiSummary:      row.ai_summary,
    retryCount:     row.retry_count,
    failedStep: row.failed_step_id ? {
      id:    row.failed_step_id,
      type:  row.failed_step_type,
      label: row.failed_step_label,
    } : null,
    hasResults:        !!row.results_json,
    hasPatchedSteps:   !!row.patched_steps_json,
    // The workflow version this run executed — present means it can be
    // restored (rolled back to) with one click from run history.
    versionId:         row.version_id ?? null,
    // Change-monitoring diff summary vs the previous run (null unless the
    // workflow is monitored and this run had a baseline to compare against).
    changeSummary:     row.change_summary_json ? safeJson(row.change_summary_json) : null,
  };
}

// List runs (optionally filtered by workflow)
router.get('/', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const workflowId = req.query.workflowId ? Number(req.query.workflowId) : null;
  if (workflowId) {
    const owns = await workflows.existsForUser(workflowId, req.user.id);
    if (!owns) return res.status(404).json({ error: 'Workflow not found' });
  }
  const rows = await runStore.listRunsForUser(req.user.id, { limit, workflowId });
  res.json({ runs: rows.map(serialize) });
});

// Full run detail (results, repairs, logs summary)
router.get('/:id', async (req, res) => {
  const row = await runStore.getRunForUser(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Run not found' });
  const out = serialize(row);
  out.results = row.results_json ? safeJson(row.results_json) : null;
  const repairs = await runStore.listRepairsForRun(row.id);
  out.repairs = repairs.map(r => ({
    id: r.id,
    stepId:          r.step_id,
    stepType:        r.step_type,
    attempt:         r.attempt,
    errorMessage:    r.error_message,
    originalParams:  r.original_params  ? safeJson(r.original_params)  : null,
    suggestedParams: r.suggested_params ? safeJson(r.suggested_params) : null,
    explanation:     r.explanation,
    confidence:      r.confidence,
    applied:         r.applied === 1,
    verified:        r.verified === 1,
    llmError:        r.llm_error,
    // Self-healing metadata: how the step was repaired ('selector' |
    // 'field-drop' | 'remove-step' | 'manual'), the deterministic
    // verification evidence, and whether it was auto-written into the
    // saved workflow.
    repairKind:      r.repair_kind || 'selector',
    evidence:        r.evidence_json ? safeJson(r.evidence_json) : null,
    autoAdopted:     r.auto_adopted === 1,
    createdAt:       r.created_at,
  }));
  res.json({ run: out });
});

// Run logs
router.get('/:id/logs', async (req, res) => {
  const row = await runStore.getRunForUser(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Run not found' });
  res.json({ logs: await runStore.getLogs(row.id) });
});

// Download results as JSON
router.get('/:id/data.json', async (req, res) => {
  const row = await runStore.getRunForUser(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Run not found' });
  if (!row.results_json) return res.status(404).json({ error: 'No results for this run' });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="run-${row.id}.json"`);
  res.send(row.results_json);
});

// Download results as CSV (concatenated sections, one per result key)
router.get('/:id/data.csv', async (req, res) => {
  const row = await runStore.getRunForUser(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Run not found' });
  const results = safeJson(row.results_json);
  if (!results) return res.status(404).json({ error: 'No results for this run' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="run-${row.id}.csv"`);
  res.send(resultsToCsv(results));
});

// Download results as an .xlsx workbook (one worksheet per result key)
router.get('/:id/data.xlsx', async (req, res) => {
  const row = await runStore.getRunForUser(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Run not found' });
  const results = safeJson(row.results_json);
  if (!results) return res.status(404).json({ error: 'No results for this run' });
  const buf = await resultsToXlsx(results);
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="run-${row.id}.xlsx"`);
  res.send(buf);
});

// One-click adopt: replace the workflow's steps with the auto-patched version
// produced by the LLM repair pass for this run.
router.post('/:id/apply-patch', async (req, res) => {
  const row = await runStore.getRunForUser(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Run not found' });
  if (!row.patched_steps_json) return res.status(400).json({ error: 'No patched workflow available for this run' });
  const owns = await workflows.existsForUser(row.workflow_id, req.user.id);
  if (!owns) return res.status(404).json({ error: 'Workflow no longer exists' });

  const stepsArr = safeJson(row.patched_steps_json) || [];
  await runStore.updateWorkflowSteps(row.workflow_id, req.user.id, stepsArr);

  // Record the adopted state as a restorable version.
  const updated = await workflows.getForUser(row.workflow_id, req.user.id);
  await runStore.ensureVersion(row.workflow_id, req.user.id, stepsArr,
    updated.meta_json ? safeJson(updated.meta_json) : null, 'adopt');
  res.json({ workflow: serializeWorkflow(updated) });
});

// One-click rollback: restore the workflow to the exact version this run
// executed. Run history is the version timeline, so this is "roll back to how
// the workflow was for that run".
router.post('/:id/restore', async (req, res) => {
  const row = await runStore.getRunForUser(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Run not found' });
  if (!row.version_id) return res.status(400).json({ error: 'This run has no recorded version to restore' });
  const version = await runStore.getVersionForUser(row.version_id, req.user.id);
  if (!version) return res.status(404).json({ error: 'Version not found' });
  const owns = await workflows.existsForUser(row.workflow_id, req.user.id);
  if (!owns) return res.status(404).json({ error: 'Workflow no longer exists' });

  // Restore steps (and meta if the version captured it). The restored state is
  // already a version row, so no new version is created — the next run will
  // simply reference it again.
  const updated = await workflows.restore({
    id: row.workflow_id, userId: req.user.id,
    stepsJson: version.steps_json, metaJson: version.meta_json,
  });
  res.json({ workflow: serializeWorkflow(updated), restoredVersionId: version.id });
});

function serializeWorkflow(w) {
  return {
    id: w.id,
    name: w.name,
    steps: safeJson(w.steps_json) || [],
    meta:  w.meta_json ? safeJson(w.meta_json) : null,
    updatedAt: w.updated_at,
  };
}

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

module.exports = router;
