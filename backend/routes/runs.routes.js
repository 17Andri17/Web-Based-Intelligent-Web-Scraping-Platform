'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const runStore = require('../services/runStore.service');
const workflows = require('../db/repositories/workflows.repo');
const resume = require('../services/resume.service');
const runEvents = require('../services/runEvents.service');
const executionPipeline = require('../services/executionPipeline.service');
const { resolveCustomActions, resolveSubflows } = require('../workflow/dependencyResolver');
const { resultsToCsv, resultsToCsvZip } = require('../utils/resultsExport');
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
    // Rows this run captured. On a 'partial' run this is what survived the
    // interruption — the reason the run is still worth opening.
    rowsCaptured:      row.rows_captured ?? 0,
    // Whether a per-item ledger exists at all. The full resumability check
    // (workflow unchanged, items actually done) lives on /:id/resume-info.
    hasProgress:       !!row.progress_json,
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

// Runs that are still going (queued or running), newest first.
//
// A run outlives the page that started it — it executes on the server, so
// closing the workflow or reloading the browser doesn't stop it. Without this
// the progress was only visible to the tab that launched it, and coming back
// looked like the run had vanished. The UI polls this on load to re-attach.
//
// Declared BEFORE '/:id' so "active" isn't swallowed as a run id.
router.get('/active', async (req, res) => {
  const queued  = await runStore.listRunsForUserPage(req.user.id, { limit: 20, status: 'queued' });
  const running = await runStore.listRunsForUserPage(req.user.id, { limit: 20, status: 'running' });
  const rows = [...running, ...queued].sort((a, b) => b.id - a.id);
  res.json({ runs: rows.map(serialize) });
});

// Full run detail (results, repairs, logs summary)
router.get('/:id', async (req, res) => {
  const row = await runStore.getRunForUser(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Run not found' });
  const out = serialize(row);
  /* Is anything actually executing this, or does the row just SAY running?
     A run whose owning process died leaves the row untouched, so the status
     alone can't be trusted — this is what lets the client tell "working" from
     "abandoned" instead of spinning forever. */
  out.live = row.status === 'running' ? !!runEvents.viewerSnapshot(row.id) : null;
  out.results = row.results_json ? safeJson(row.results_json) : null;
  // Inputs this run was triggered with (bulk / run-with-inputs / API), so the
  // history shows which values produced these results.
  out.inputs = row.inputs_json ? safeJson(row.inputs_json) : null;
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

// Download results as a ZIP of one CSV per table.
// A single concatenated CSV is unusable once a run captures more than one
// table — the columns change partway down the file and no spreadsheet opens it
// correctly. This gives each output its own well-formed CSV.
router.get('/:id/data.csv.zip', async (req, res) => {
  const row = await runStore.getRunForUser(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Run not found' });
  const results = safeJson(row.results_json);
  if (!results) return res.status(404).json({ error: 'No results for this run' });
  const buf = await resultsToCsvZip(results);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="run-${row.id}-csv.zip"`);
  res.send(buf);
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

/* Can this run be continued rather than re-run from scratch, and if not, why?
   Split from the resume action itself so the UI can show the button (or the
   reason it can't) without committing to anything. */
router.get('/:id/resume-info', async (req, res) => {
  const row = await runStore.getRunForUser(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Run not found' });

  const wf = await workflows.getForUser(row.workflow_id, req.user.id);
  if (!wf) return res.json({ resumable: false, reason: 'The workflow this run belongs to no longer exists.' });

  // Compare against the CURRENT workflow content, not just the stored version
  // id: unsaved edits change what a resumed run would execute.
  const currentVersionId = await runStore.findVersionIdByContent(
    row.workflow_id, req.user.id, safeJson(wf.steps_json) || []
  );
  const check = resume.eligibility(row, currentVersionId);
  res.json(check);
});

/* Resume: re-run the workflow with the items this run already captured skipped
   and its rows restored. A new run row is created, linked back via
   parent_run_id, so both halves stay independently inspectable. */
router.post('/:id/resume', async (req, res) => {
  const runId = Number(req.params.id);
  const row = await runStore.getRunForUser(runId, req.user.id);
  if (!row) return res.status(404).json({ error: 'Run not found' });

  const wf = await workflows.getForUser(row.workflow_id, req.user.id);
  if (!wf) return res.status(404).json({ error: 'Workflow no longer exists' });

  const steps = safeJson(wf.steps_json) || [];
  const currentVersionId = await runStore.findVersionIdByContent(row.workflow_id, req.user.id, steps);
  const prep = await resume.prepare(runId, req.user.id, currentVersionId);
  if (!prep.ok) return res.status(400).json({ error: prep.reason });

  const meta = wf.meta_json ? (safeJson(wf.meta_json) || {}) : {};
  const [customActions, subflows] = await Promise.all([
    resolveCustomActions(steps, req.user.id),
    resolveSubflows(steps, req.user.id, row.workflow_id),
  ]);

  // Fire and forget: a resumed run can take hours, so respond with the new run
  // id immediately and let the client follow it like any other run.
  const started = executionPipeline.executeAndPersist({
    workflow: { id: row.workflow_id, steps, meta, customActions, subflows },
    userId: req.user.id,
    workflowId: row.workflow_id,
    trigger: 'resume',
    parentRunId: runId,
    resume: prep.payload,
  });
  started.catch(() => { /* surfaced on the run row itself */ });

  res.status(202).json({
    resumedFrom: runId,
    skipping: prep.info.items,
    message: `Resuming — ${prep.info.items} already-captured item(s) will be skipped.`,
  });
});

/* Shard a workflow across several independent runs.

   Each shard executes the whole workflow but claims only its slice of the
   per-item loops, decided by hashing each item's URL — so the shards need no
   coordination and no shared cursor. They are ordinary runs producing ordinary
   results, which means the existing cross-run dataset view already unions
   them; there is no bespoke merge step to keep correct.

   Worth being clear about the trade: every shard re-runs the steps BEFORE the
   loop (the list-producing part), so this pays for itself only when the
   per-item work dominates — which on a job big enough to want sharding it
   does. In-run concurrency is the cheaper lever and should be turned up first;
   sharding is for going wider than one process can. */
const MAX_SHARDS = 8;

router.post('/shard', async (req, res) => {
  const workflowId = Number(req.body?.workflowId);
  const shards = Math.floor(Number(req.body?.shards));
  if (!Number.isFinite(workflowId)) return res.status(400).json({ error: '"workflowId" is required' });
  if (!Number.isFinite(shards) || shards < 2 || shards > MAX_SHARDS) {
    return res.status(400).json({ error: `"shards" must be between 2 and ${MAX_SHARDS}` });
  }

  const wf = await workflows.getForUser(workflowId, req.user.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });

  const steps = safeJson(wf.steps_json) || [];
  const meta = wf.meta_json ? (safeJson(wf.meta_json) || {}) : {};
  const [customActions, subflows] = await Promise.all([
    resolveCustomActions(steps, req.user.id),
    resolveSubflows(steps, req.user.id, workflowId),
  ]);

  // Launched together; the global run-slot semaphore (runner.service) decides
  // how many actually execute at once, so this can't stampede the machine.
  const started = [];
  for (let i = 0; i < shards; i++) {
    const p = executionPipeline.executeAndPersist({
      workflow: { id: workflowId, steps, meta, customActions, subflows },
      userId: req.user.id,
      workflowId,
      trigger: 'shard',
      resume: { steps: {}, shard: { index: i, count: shards } },
    });
    p.catch(() => { /* each shard reports on its own run row */ });
    started.push(p);
  }

  res.status(202).json({
    shards,
    message: `Started ${shards} shards. Each captures part of the list; the dataset view combines them.`,
  });
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
