'use strict';

const db = require('../db');

/* ===========================================================================
   runStore.service
   ---------------------------------------------------------------------------
   Thin DB wrapper for runs, run_logs, run_repairs and schedules. Everything
   here is synchronous (better-sqlite3) — callers can treat these as plain
   function calls.
   ========================================================================= */

// ── runs ───────────────────────────────────────────────────────────────────
function createRun({ userId, workflowId, scheduleId = null, parentRunId = null, trigger = 'manual' }) {
  const info = db.prepare(`
    INSERT INTO runs (user_id, workflow_id, schedule_id, parent_run_id, trigger, status)
    VALUES (?, ?, ?, ?, ?, 'running')
  `).run(userId, workflowId, scheduleId, parentRunId, trigger);
  return info.lastInsertRowid;
}

function finishRun(runId, patch) {
  const allowed = [
    'status', 'finished_at', 'duration_ms', 'results_json',
    'error_message', 'error_category', 'failed_step_id', 'failed_step_type',
    'failed_step_label', 'ai_summary', 'retry_count',
  ];
  const fields = Object.keys(patch).filter(k => allowed.includes(k));
  if (fields.length === 0) return;
  const sql = `UPDATE runs SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...fields.map(f => patch[f]), runId);
}

function getRun(runId) {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
}

function getRunForUser(runId, userId) {
  return db.prepare('SELECT * FROM runs WHERE id = ? AND user_id = ?').get(runId, userId);
}

function listRunsForUser(userId, { limit = 50, workflowId = null } = {}) {
  if (workflowId) {
    return db.prepare(`
      SELECT id, workflow_id, schedule_id, trigger, status, started_at, finished_at,
             duration_ms, error_message, error_category, failed_step_label,
             ai_summary, retry_count, parent_run_id
      FROM runs
      WHERE user_id = ? AND workflow_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(userId, workflowId, limit);
  }
  return db.prepare(`
    SELECT id, workflow_id, schedule_id, trigger, status, started_at, finished_at,
           duration_ms, error_message, error_category, failed_step_label,
           ai_summary, retry_count, parent_run_id
    FROM runs
    WHERE user_id = ?
    ORDER BY started_at DESC
    LIMIT ?
  `).all(userId, limit);
}

// ── logs ──────────────────────────────────────────────────────────────────
const logCounters = new Map(); // runId -> next seq number, kept in memory

function appendLog(runId, level, line) {
  const seq = (logCounters.get(runId) || 0) + 1;
  logCounters.set(runId, seq);
  const trimmed = String(line || '').slice(0, 4000); // hard cap per line
  db.prepare(`
    INSERT INTO run_logs (run_id, seq, level, line) VALUES (?, ?, ?, ?)
  `).run(runId, seq, level || 'info', trimmed);
}

function getLogs(runId) {
  return db.prepare(`
    SELECT seq, level, line FROM run_logs WHERE run_id = ? ORDER BY seq ASC
  `).all(runId);
}

function clearLogCounter(runId) {
  logCounters.delete(runId);
}

// ── repairs ───────────────────────────────────────────────────────────────
function recordRepair({
  runId, workflowId, stepId, stepType, attempt,
  errorMessage, originalParams, suggestedParams, explanation, confidence,
  applied = false, verified = false, llmError = null,
}) {
  const info = db.prepare(`
    INSERT INTO run_repairs
      (run_id, workflow_id, step_id, step_type, attempt, error_message,
       original_params, suggested_params, explanation, confidence,
       applied, verified, llm_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId, workflowId, stepId, stepType, attempt,
    truncate(errorMessage, 1000),
    originalParams == null ? null : JSON.stringify(originalParams),
    suggestedParams == null ? null : JSON.stringify(suggestedParams),
    truncate(explanation, 1000),
    confidence || null,
    applied ? 1 : 0,
    verified ? 1 : 0,
    truncate(llmError, 500),
  );
  return info.lastInsertRowid;
}

function markRepairVerified(repairId, verified) {
  db.prepare('UPDATE run_repairs SET verified = ? WHERE id = ?').run(verified ? 1 : 0, repairId);
}

function listRepairsForRun(runId) {
  return db.prepare(`
    SELECT id, step_id, step_type, attempt, error_message,
           original_params, suggested_params, explanation, confidence,
           applied, verified, llm_error, created_at
    FROM run_repairs
    WHERE run_id = ?
    ORDER BY attempt ASC, id ASC
  `).all(runId);
}

// ── schedules ─────────────────────────────────────────────────────────────
function listSchedulesForUser(userId) {
  return db.prepare(`
    SELECT s.*, w.name AS workflow_name
    FROM schedules s
    JOIN workflows w ON w.id = s.workflow_id
    WHERE s.user_id = ?
    ORDER BY s.updated_at DESC
  `).all(userId);
}

function getScheduleByWorkflow(userId, workflowId) {
  return db.prepare(`
    SELECT * FROM schedules WHERE user_id = ? AND workflow_id = ?
  `).get(userId, workflowId);
}

function upsertSchedule({ userId, workflowId, intervalMinutes, isActive }) {
  // SQLite upsert via unique index on workflow_id.
  const existing = db.prepare(
    'SELECT id FROM schedules WHERE workflow_id = ?'
  ).get(workflowId);
  const nextRun = new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString();
  if (existing) {
    db.prepare(`
      UPDATE schedules
      SET interval_minutes = ?, is_active = ?, next_run_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(intervalMinutes, isActive ? 1 : 0, nextRun, existing.id);
    return getScheduleById(existing.id);
  }
  const info = db.prepare(`
    INSERT INTO schedules (user_id, workflow_id, interval_minutes, is_active, next_run_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, workflowId, intervalMinutes, isActive ? 1 : 0, nextRun);
  return getScheduleById(info.lastInsertRowid);
}

function getScheduleById(id) {
  return db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
}

function deleteSchedule(userId, workflowId) {
  return db.prepare(`
    DELETE FROM schedules WHERE user_id = ? AND workflow_id = ?
  `).run(userId, workflowId).changes;
}

function dueSchedules(now = new Date()) {
  // Used by the scheduler poll loop. We pass the current ISO time as a
  // bound parameter so the comparison is text-based (sqlite ISO ordering
  // is lexicographic — fine because we always store UTC ISO).
  return db.prepare(`
    SELECT s.*, w.steps_json, w.meta_json, w.name AS workflow_name
    FROM schedules s
    JOIN workflows w ON w.id = s.workflow_id
    WHERE s.is_active = 1 AND s.next_run_at <= ?
  `).all(now.toISOString());
}

function bumpScheduleAfterRun(scheduleId, intervalMinutes) {
  const next = new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString();
  db.prepare(`
    UPDATE schedules
    SET last_run_at = datetime('now'), next_run_at = ?
    WHERE id = ?
  `).run(next, scheduleId);
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
  appendLog, getLogs, clearLogCounter,
  // repairs
  recordRepair, markRepairVerified, listRepairsForRun,
  // schedules
  listSchedulesForUser, getScheduleByWorkflow, upsertSchedule,
  deleteSchedule, dueSchedules, bumpScheduleAfterRun, getScheduleById,
};
