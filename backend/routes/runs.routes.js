'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const runStore = require('../services/runStore.service');

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
  };
}

// List runs (optionally filtered by workflow)
router.get('/', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const workflowId = req.query.workflowId ? Number(req.query.workflowId) : null;
  if (workflowId) {
    const owns = db.prepare('SELECT id FROM workflows WHERE id = ? AND user_id = ?')
                    .get(workflowId, req.user.id);
    if (!owns) return res.status(404).json({ error: 'Workflow not found' });
  }
  const rows = runStore.listRunsForUser(req.user.id, { limit, workflowId });
  res.json({ runs: rows.map(serialize) });
});

// Full run detail (results, repairs, logs summary)
router.get('/:id', (req, res) => {
  const row = runStore.getRunForUser(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Run not found' });
  const out = serialize(row);
  out.results = row.results_json ? safeJson(row.results_json) : null;
  const repairs = runStore.listRepairsForRun(row.id);
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
    createdAt:       r.created_at,
  }));
  res.json({ run: out });
});

// Run logs
router.get('/:id/logs', (req, res) => {
  const row = runStore.getRunForUser(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Run not found' });
  res.json({ logs: runStore.getLogs(row.id) });
});

// Download results as JSON
router.get('/:id/data.json', (req, res) => {
  const row = runStore.getRunForUser(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Run not found' });
  if (!row.results_json) return res.status(404).json({ error: 'No results for this run' });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="run-${row.id}.json"`);
  res.send(row.results_json);
});

// Download results as CSV (concatenated sections, one per result key)
router.get('/:id/data.csv', (req, res) => {
  const row = runStore.getRunForUser(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Run not found' });
  const results = safeJson(row.results_json);
  if (!results) return res.status(404).json({ error: 'No results for this run' });
  const sections = Object.entries(results).map(([k, v]) => `# ${k}\n${toCSV(v)}`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="run-${row.id}.csv"`);
  res.send(sections.join('\n\n'));
});

// One-click adopt: replace the workflow's steps with the auto-patched version
// produced by the LLM repair pass for this run.
router.post('/:id/apply-patch', (req, res) => {
  const row = runStore.getRunForUser(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Run not found' });
  if (!row.patched_steps_json) return res.status(400).json({ error: 'No patched workflow available for this run' });
  const owns = db.prepare('SELECT id, name FROM workflows WHERE id = ? AND user_id = ?')
                  .get(row.workflow_id, req.user.id);
  if (!owns) return res.status(404).json({ error: 'Workflow no longer exists' });

  db.prepare(`
    UPDATE workflows
    SET steps_json = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `).run(row.patched_steps_json, row.workflow_id, req.user.id);

  const updated = db.prepare('SELECT * FROM workflows WHERE id = ?').get(row.workflow_id);
  res.json({
    workflow: {
      id: updated.id,
      name: updated.name,
      steps: safeJson(updated.steps_json) || [],
      meta:  updated.meta_json ? safeJson(updated.meta_json) : null,
      updatedAt: updated.updated_at,
    },
  });
});

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

function toCSV(data) {
  if (data == null) return '';
  if (!Array.isArray(data)) return JSON.stringify(data);
  if (data.length === 0) return '';
  if (typeof data[0] !== 'object' || data[0] === null) return data.join('\n');
  const headers = Object.keys(data[0]);
  const rows = data.map(r => headers.map(h => csvCell(r[h])).join(','));
  return [headers.join(','), ...rows].join('\n');
}

function csvCell(v) {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = router;
