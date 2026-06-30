'use strict';

const crypto = require('crypto');
const db = require('../db/client');

/* ===========================================================================
   runStore.service
   ---------------------------------------------------------------------------
   Data access for runs, run_logs, run_repairs, workflow_versions and
   schedules, on the async dual-backend client (migration slice 4). Every
   function returns a Promise — callers must await.

   Log sequence numbers are now derived from the DB (previously an in-memory
   Map), so any process can write the next correct seq — a step toward a
   stateless backend (see docs/SCALING_AND_DB_MIGRATION.md, habit #1). A small
   per-run, process-local write queue serialises a single run's log writes so
   the atomic "next seq" computation can't race with itself.
   ========================================================================= */

// ── runs ───────────────────────────────────────────────────────────────────
async function createRun({ userId, workflowId, scheduleId = null, parentRunId = null, trigger = 'manual', versionId = null }) {
  const row = await db.get(`
    INSERT INTO runs (user_id, workflow_id, schedule_id, parent_run_id, trigger, status, version_id)
    VALUES (?, ?, ?, ?, ?, 'running', ?)
    RETURNING id
  `, [userId, workflowId, scheduleId, parentRunId, trigger, versionId]);
  return row.id;
}

async function finishRun(runId, patch) {
  const allowed = [
    'status', 'finished_at', 'duration_ms', 'results_json',
    'error_message', 'error_category', 'failed_step_id', 'failed_step_type',
    'failed_step_label', 'ai_summary', 'retry_count',
    'patched_steps_json',
  ];
  const fields = Object.keys(patch).filter(k => allowed.includes(k));
  if (fields.length === 0) return;
  const sql = `UPDATE runs SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`;
  await db.run(sql, [...fields.map(f => patch[f]), runId]);
}

async function getRun(runId) {
  return db.get('SELECT * FROM runs WHERE id = ?', [runId]);
}

async function getRunForUser(runId, userId) {
  return db.get('SELECT * FROM runs WHERE id = ? AND user_id = ?', [runId, userId]);
}

async function listRunsForUser(userId, { limit = 50, workflowId = null } = {}) {
  const cols = `id, workflow_id, schedule_id, trigger, status, started_at, finished_at,
                duration_ms, error_message, error_category, failed_step_label,
                ai_summary, retry_count, parent_run_id, version_id`;
  if (workflowId) {
    return db.all(`
      SELECT ${cols} FROM runs
      WHERE user_id = ? AND workflow_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `, [userId, workflowId, limit]);
  }
  return db.all(`
    SELECT ${cols} FROM runs
    WHERE user_id = ?
    ORDER BY started_at DESC
    LIMIT ?
  `, [userId, limit]);
}

// ── logs ──────────────────────────────────────────────────────────────────
// Per-run, process-local write queue: chains a run's log inserts so the
// atomic MAX(seq)+1 computation can't race with itself. The DB is the source
// of truth for seq; this map only holds an in-flight tail promise and is
// cleared by flushLogs when the run ends.
const logQueues = new Map(); // runId -> tail Promise

function appendLog(runId, level, line) {
  const trimmed = String(line || '').slice(0, 4000); // hard cap per line
  const prev = logQueues.get(runId) || Promise.resolve();
  const next = prev.then(() => db.run(`
    INSERT INTO run_logs (run_id, seq, level, line)
    SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?
    FROM run_logs WHERE run_id = ?
  `, [runId, level || 'info', trimmed, runId])).catch(() => { /* logging is best-effort */ });
  logQueues.set(runId, next);
  return next;
}

async function getLogs(runId) {
  return db.all(
    'SELECT seq, level, line FROM run_logs WHERE run_id = ? ORDER BY seq ASC',
    [runId]
  );
}

// Await any pending log writes for a run and drop its queue entry. Call this
// before marking a run done so its logs are durable. (Replaces the old
// clearLogCounter, which just cleared the in-memory counter.)
async function flushLogs(runId) {
  const tail = logQueues.get(runId);
  logQueues.delete(runId);
  if (tail) { try { await tail; } catch (_) {} }
}

// ── repairs ───────────────────────────────────────────────────────────────
async function recordRepair({
  runId, workflowId, stepId, stepType, attempt,
  errorMessage, originalParams, suggestedParams, explanation, confidence,
  applied = false, verified = false, llmError = null,
  repairKind = null, evidence = null, autoAdopted = false,
}) {
  const row = await db.get(`
    INSERT INTO run_repairs
      (run_id, workflow_id, step_id, step_type, attempt, error_message,
       original_params, suggested_params, explanation, confidence,
       applied, verified, llm_error, repair_kind, evidence_json, auto_adopted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [
    runId, workflowId, stepId, stepType, attempt,
    truncate(errorMessage, 1000),
    originalParams == null ? null : JSON.stringify(originalParams),
    suggestedParams == null ? null : JSON.stringify(suggestedParams),
    truncate(explanation, 1000),
    confidence || null,
    applied ? 1 : 0,
    verified ? 1 : 0,
    truncate(llmError, 500),
    repairKind || null,
    evidence == null ? null : truncate(JSON.stringify(evidence), 4000),
    autoAdopted ? 1 : 0,
  ]);
  return row.id;
}

async function markRepairVerified(repairId, verified) {
  await db.run('UPDATE run_repairs SET verified = ? WHERE id = ?', [verified ? 1 : 0, repairId]);
}

// Mark a repair as auto-written into the saved workflow. (Moved here from
// executionPipeline so all run_repairs access lives in one place.)
async function markAutoAdopted(repairId) {
  await db.run('UPDATE run_repairs SET auto_adopted = 1, verified = 1 WHERE id = ?', [repairId]);
}

async function listRepairsForRun(runId) {
  return db.all(`
    SELECT id, step_id, step_type, attempt, error_message,
           original_params, suggested_params, explanation, confidence,
           applied, verified, llm_error, repair_kind, evidence_json,
           auto_adopted, created_at
    FROM run_repairs
    WHERE run_id = ?
    ORDER BY attempt ASC, id ASC
  `, [runId]);
}

// Parsed results_json from the most recent successful runs of a workflow.
async function recentSuccessfulResults(workflowId, limit = 5) {
  const rows = await db.all(`
    SELECT results_json FROM runs
    WHERE workflow_id = ? AND status = 'success' AND results_json IS NOT NULL
    ORDER BY started_at DESC
    LIMIT ?
  `, [workflowId, limit]);
  const out = [];
  for (const r of rows) {
    try { out.push(JSON.parse(r.results_json)); } catch (_) {}
  }
  return out;
}

// ── workflow versions (rollback history) ────────────────────────────────────
function hashSteps(steps) {
  return crypto.createHash('sha256').update(JSON.stringify(steps || [])).digest('hex');
}

// Record a workflow's step tree as a version, deduped by content hash. Returns
// the version id, or null on failure.
async function ensureVersion(workflowId, userId, steps, meta, source) {
  try {
    const hash = hashSteps(steps);
    const existing = await db.get(
      'SELECT id FROM workflow_versions WHERE workflow_id = ? AND hash = ?',
      [workflowId, hash]
    );
    if (existing) return existing.id;
    const row = await db.get(`
      INSERT INTO workflow_versions (workflow_id, user_id, hash, steps_json, meta_json, source)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `, [workflowId, userId, hash, JSON.stringify(steps || []),
        meta == null ? null : JSON.stringify(meta), source || null]);
    return row.id;
  } catch (_) { return null; }
}

async function getVersionForUser(versionId, userId) {
  if (!versionId) return null;
  return db.get('SELECT * FROM workflow_versions WHERE id = ? AND user_id = ?', [versionId, userId]);
}

async function listVersionsForWorkflow(workflowId, userId, { limit = 50 } = {}) {
  return db.all(`
    SELECT id, hash, source, created_at
    FROM workflow_versions
    WHERE workflow_id = ? AND user_id = ?
    ORDER BY id DESC
    LIMIT ?
  `, [workflowId, userId, limit]);
}

// Persist a healed step tree back into the saved workflow (auto-adopt path).
// Returns the number of rows changed.
async function updateWorkflowSteps(workflowId, userId, steps) {
  const info = await db.run(`
    UPDATE workflows
    SET steps_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `, [JSON.stringify(steps), workflowId, userId]);
  return info.changes;
}

// ── schedules ─────────────────────────────────────────────────────────────
async function listSchedulesForUser(userId) {
  return db.all(`
    SELECT s.*, w.name AS workflow_name
    FROM schedules s
    JOIN workflows w ON w.id = s.workflow_id
    WHERE s.user_id = ?
    ORDER BY s.updated_at DESC
  `, [userId]);
}

async function getScheduleByWorkflow(userId, workflowId) {
  return db.get('SELECT * FROM schedules WHERE user_id = ? AND workflow_id = ?', [userId, workflowId]);
}

async function upsertSchedule({ userId, workflowId, intervalMinutes, isActive, anchorAtIso = null }) {
  const existing = await db.get('SELECT id FROM schedules WHERE workflow_id = ?', [workflowId]);
  const validAnchor = normaliseAnchor(anchorAtIso);
  const nextRun = computeNextRun(validAnchor, intervalMinutes).toISOString();
  if (existing) {
    await db.run(`
      UPDATE schedules
      SET interval_minutes = ?, is_active = ?, anchor_at = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [intervalMinutes, isActive ? 1 : 0, validAnchor, nextRun, existing.id]);
    return getScheduleById(existing.id);
  }
  const inserted = await db.get(`
    INSERT INTO schedules (user_id, workflow_id, interval_minutes, is_active, anchor_at, next_run_at)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [userId, workflowId, intervalMinutes, isActive ? 1 : 0, validAnchor, nextRun]);
  return getScheduleById(inserted.id);
}

function normaliseAnchor(anchorAtIso) {
  if (!anchorAtIso) return null;
  const t = Date.parse(anchorAtIso);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Compute the next time a scheduled workflow should fire.
 *
 * With an anchor: recurring at anchor + k * interval (k >= 0); the next fire
 * is the smallest such slot strictly in the future. Without an anchor: fire in
 * `intervalMinutes` from now.
 */
function computeNextRun(anchorIso, intervalMinutes) {
  const now = Date.now();
  const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;
  if (!anchorIso) return new Date(now + intervalMs);
  const anchor = Date.parse(anchorIso);
  if (Number.isNaN(anchor)) return new Date(now + intervalMs);
  if (anchor > now) return new Date(anchor);
  const slots = Math.ceil((now - anchor) / intervalMs);
  let next = anchor + slots * intervalMs;
  if (next <= now) next += intervalMs;
  return new Date(next);
}

async function getScheduleById(id) {
  return db.get('SELECT * FROM schedules WHERE id = ?', [id]);
}

async function deleteSchedule(userId, workflowId) {
  const info = await db.run('DELETE FROM schedules WHERE user_id = ? AND workflow_id = ?', [userId, workflowId]);
  return info.changes;
}

async function dueSchedules(now = new Date()) {
  // ISO comparison is text-based; we always store UTC ISO so ordering holds.
  return db.all(`
    SELECT s.*, w.steps_json, w.meta_json, w.name AS workflow_name
    FROM schedules s
    JOIN workflows w ON w.id = s.workflow_id
    WHERE s.is_active = 1 AND s.next_run_at <= ?
  `, [now.toISOString()]);
}

async function bumpScheduleAfterRun(scheduleId, intervalMinutes) {
  const row = await db.get('SELECT anchor_at FROM schedules WHERE id = ?', [scheduleId]);
  const next = computeNextRun(row && row.anchor_at, intervalMinutes).toISOString();
  await db.run(`
    UPDATE schedules
    SET last_run_at = CURRENT_TIMESTAMP, next_run_at = ?
    WHERE id = ?
  `, [next, scheduleId]);
}

// ── helpers ───────────────────────────────────────────────────────────────
function truncate(s, n) {
  if (s == null) return null;
  const t = String(s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}

module.exports = {
  // runs
  createRun, finishRun, getRun, getRunForUser, listRunsForUser,
  // logs
  appendLog, getLogs, flushLogs,
  // repairs
  recordRepair, markRepairVerified, markAutoAdopted, listRepairsForRun,
  // self-healing helpers
  recentSuccessfulResults, updateWorkflowSteps,
  // version history / rollback
  ensureVersion, getVersionForUser, listVersionsForWorkflow,
  // schedules
  listSchedulesForUser, getScheduleByWorkflow, upsertSchedule,
  deleteSchedule, dueSchedules, bumpScheduleAfterRun, getScheduleById,
};
