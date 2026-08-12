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

// ── queued runs (public API) ────────────────────────────────────────────────
// API-triggered runs are created up-front as status='queued' so the trigger
// endpoint can return a run_id immediately (202); the apiWorker claims and
// executes them in the background. See docs/API_ARCHITECTURE.md.

async function createQueuedRun({ userId, workflowId, trigger = 'api', apiKeyId = null, inputsJson = null, idempotencyKey = null }) {
  const row = await db.get(`
    INSERT INTO runs (user_id, workflow_id, trigger, status, queued_at, api_key_id, inputs_json, idempotency_key)
    VALUES (?, ?, ?, 'queued', CURRENT_TIMESTAMP, ?, ?, ?)
    RETURNING id
  `, [userId, workflowId, trigger, apiKeyId, inputsJson, idempotencyKey]);
  return row.id;
}

async function findRunByIdempotencyKey(userId, idempotencyKey) {
  return db.get(
    'SELECT * FROM runs WHERE user_id = ? AND idempotency_key = ?',
    [userId, idempotencyKey]
  );
}

// Oldest queued runs first (FIFO). The worker still has to win the atomic
// claim below before executing one, so overlapping pollers are safe.
async function nextQueuedRuns(limit = 5) {
  return db.all(
    `SELECT * FROM runs WHERE status = 'queued' ORDER BY id ASC LIMIT ?`,
    [limit]
  );
}

// Atomically claim a queued run for execution: only the one caller whose
// conditional UPDATE succeeds may run it — the same stateless-dispatch trick
// as claimDueSchedule, so multiple worker processes can't double-run a job
// and a cancel can't race a claim.
async function claimQueuedRun(runId) {
  const info = await db.run(`
    UPDATE runs SET status = 'running', started_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'queued'
  `, [runId]);
  return info.changes === 1;
}

// Cancel a run that hasn't started. Atomic against claimQueuedRun: whichever
// conditional UPDATE wins decides whether the run executes or dies queued.
async function cancelQueuedRun(runId, userId) {
  const info = await db.run(`
    UPDATE runs
    SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP,
        error_message = 'Run cancelled before it started'
    WHERE id = ? AND user_id = ? AND status = 'queued'
  `, [runId, userId]);
  return info.changes === 1;
}

// Transition a pre-created (queued/claimed) run row into its running state —
// used by executionPipeline when the run row already exists instead of
// createRun. Also records the executed workflow version.
async function startQueuedRun(runId, versionId = null) {
  await db.run(`
    UPDATE runs SET status = 'running', started_at = CURRENT_TIMESTAMP, version_id = ?
    WHERE id = ?
  `, [versionId, runId]);
}

// Cursor-paginated run listing for the public API. Ordered by id DESC;
// `beforeId` returns the page strictly older than that id (ids only ever
// grow, so pages never shift under the caller the way offsets do).
async function listRunsForUserPage(userId, { limit = 20, workflowId = null, status = null, beforeId = null } = {}) {
  const where = ['user_id = ?'];
  const params = [userId];
  if (workflowId != null) { where.push('workflow_id = ?'); params.push(workflowId); }
  if (status)             { where.push('status = ?');      params.push(status); }
  if (beforeId != null)   { where.push('id < ?');          params.push(beforeId); }
  params.push(limit);
  return db.all(`
    SELECT id, workflow_id, schedule_id, trigger, status, queued_at, started_at,
           finished_at, duration_ms, error_message, error_category, ai_summary,
           retry_count, api_key_id, rows_captured,
           CASE WHEN results_json IS NOT NULL THEN 1 ELSE 0 END AS has_results
    FROM runs
    WHERE ${where.join(' AND ')}
    ORDER BY id DESC
    LIMIT ?
  `, params);
}

// Mid-run checkpoint of whatever the run has captured so far. Called
// periodically (debounced) by executionPipeline as RESULT_CHUNK deltas arrive
// from the child, so a run that is killed / crashes / OOMs still leaves its
// data behind. Best-effort by design: a failed checkpoint must never take down
// a healthy run, so callers don't await this for correctness.
async function savePartialResults(runId, resultsJson, rowsCaptured = 0, progressJson = null) {
  // progress rides along so a killed run leaves BOTH the rows it captured and
  // the ledger of which items produced them — data without the ledger can be
  // viewed but not resumed. Written only when the run has some, so a workflow
  // with no per-item loop doesn't null out a column it never used.
  if (progressJson != null) {
    await db.run(
      'UPDATE runs SET partial_results_json = ?, rows_captured = ?, progress_json = ? WHERE id = ?',
      [resultsJson, rowsCaptured, progressJson, runId]
    );
    return;
  }
  await db.run(
    'UPDATE runs SET partial_results_json = ?, rows_captured = ? WHERE id = ?',
    [resultsJson, rowsCaptured, runId]
  );
}

/* ── Liveness ──────────────────────────────────────────────────────────────
   A run executes as a child process of the server, so a 'running' row is only
   trustworthy while the process that owns it is alive to say so. The heartbeat
   is that proof: refreshed while the run executes, and stale the moment its
   owner is gone. Returns whether a cancel has been requested for this run, so
   the caller can honour a stop that arrived from another tab or instance. */
async function touchRun(runId) {
  const row = await db.get(
    `UPDATE runs SET heartbeat_at = CURRENT_TIMESTAMP
     WHERE id = ? RETURNING cancel_requested`, [runId]
  );
  return !!(row && row.cancel_requested);
}

// Record a stop for a run this process doesn't own. Its owner picks this up on
// the next heartbeat; if it has no owner, the reaper finalises it instead.
async function requestCancel(runId, userId) {
  const info = await db.run(
    `UPDATE runs SET cancel_requested = 1
     WHERE id = ? AND user_id = ? AND status IN ('running', 'queued')`,
    [runId, userId]
  );
  return info.changes === 1;
}

/* Runs that claim to be running but have no live owner.

   `staleMs` is measured against the heartbeat. A row with NO heartbeat is
   included when it started before the cutoff — that covers rows written by an
   older build, and the window between a run being created and its first beat.
   Postgres and SQLite disagree on date arithmetic, so the cutoff is computed
   here and compared as a string, which both engines order correctly on the
   CURRENT_TIMESTAMP format they store. */
async function findOrphanedRuns(staleMs) {
  const cutoff = new Date(Date.now() - staleMs).toISOString().slice(0, 19).replace('T', ' ');
  return db.all(
    `SELECT id, user_id, workflow_id, rows_captured, partial_results_json, results_json, started_at
     FROM runs
     WHERE status = 'running'
       AND (
         (heartbeat_at IS NOT NULL AND heartbeat_at < ?)
         OR (heartbeat_at IS NULL AND (started_at IS NULL OR started_at < ?))
       )`,
    [cutoff, cutoff]
  );
}

// Every run still marked running, regardless of heartbeat. Used at boot: this
// process spawns its runs as children, so if it has only just started, none of
// them can still be alive.
async function findRunningRuns() {
  return db.all(
    `SELECT id, user_id, workflow_id, rows_captured, partial_results_json, results_json, started_at
     FROM runs WHERE status = 'running'`, []
  );
}

async function finishRun(runId, patch) {
  const allowed = [
    'status', 'finished_at', 'duration_ms', 'results_json',
    'error_message', 'error_category', 'failed_step_id', 'failed_step_type',
    'failed_step_label', 'ai_summary', 'retry_count',
    'patched_steps_json', 'partial_results_json', 'rows_captured', 'progress_json',
    'cancel_requested',
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
                ai_summary, retry_count, parent_run_id, version_id, change_summary_json,
                rows_captured`;
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

/* Self-healing history for one workflow.

   Everything needed for this has been recorded in `run_repairs` since the
   feature shipped — it just had no way out of the database. That's a shame,
   because "this scraper fixed itself 4 times and you didn't have to do
   anything" is the single most persuasive thing the platform does, and it has
   been invisible.

   Returns the per-step tallies plus the recent individual repairs, scoped to
   the owner (via the runs join) so one user can't read another's history. */
async function healingHistoryForWorkflow(workflowId, userId, { limit = 40, sinceDays = 90 } = {}) {
  const rows = await db.all(`
    SELECT r.id, r.run_id, r.step_id, r.step_type, r.error_message, r.explanation,
           r.confidence, r.applied, r.verified, r.auto_adopted, r.repair_kind,
           r.created_at, runs.status AS run_status, runs.started_at AS run_started_at
    FROM run_repairs r
    JOIN runs ON runs.id = r.run_id
    WHERE r.workflow_id = ? AND runs.user_id = ?
    ORDER BY r.id DESC
    LIMIT ?
  `, [workflowId, userId, Math.max(1, Math.min(limit, 200))]);

  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const recent = rows.filter(r => {
    const t = Date.parse(String(r.created_at || '').replace(' ', 'T') + 'Z');
    return Number.isNaN(t) ? true : t >= cutoff;
  });

  // Per-step rollup: which parts of this scraper are actually fragile.
  const byStep = new Map();
  for (const r of recent) {
    const key = r.step_id;
    if (!byStep.has(key)) {
      byStep.set(key, {
        stepId: r.step_id, stepType: r.step_type,
        total: 0, verified: 0, autoAdopted: 0, lastAt: r.created_at,
      });
    }
    const e = byStep.get(key);
    e.total += 1;
    if (r.verified) e.verified += 1;
    if (r.auto_adopted) e.autoAdopted += 1;
    if (String(r.created_at) > String(e.lastAt)) e.lastAt = r.created_at;
  }

  return {
    totals: {
      repairs: recent.length,
      verified: recent.filter(r => r.verified).length,
      autoAdopted: recent.filter(r => r.auto_adopted).length,
      runsAffected: new Set(recent.map(r => r.run_id)).size,
      sinceDays,
    },
    bySteps: [...byStep.values()].sort((a, b) => b.total - a.total),
    repairs: recent,
  };
}

/* ── "has usable data" status predicate ───────────────────────────────────
   A 'partial' run (killed / crashed / timed out) DID capture rows — it just
   never finished. That data is genuinely useful for history and comparison,
   but including it by default would silently change what every existing diff
   and baseline means: a partial run legitimately has fewer rows than a
   complete one, so it would read as "records disappeared". So it stays
   opt-in, per-caller. Default OFF preserves today's exact semantics. */
function dataStatusSql(includePartial) {
  return includePartial ? `status IN ('success', 'partial')` : `status = 'success'`;
}

// Parsed results_json from the most recent successful runs of a workflow.
async function recentSuccessfulResults(workflowId, limit = 5, { includePartial = false } = {}) {
  const rows = await db.all(`
    SELECT results_json FROM runs
    WHERE workflow_id = ? AND ${dataStatusSql(includePartial)} AND results_json IS NOT NULL
    ORDER BY started_at DESC
    LIMIT ?
  `, [workflowId, limit]);
  const out = [];
  for (const r of rows) {
    try { out.push(JSON.parse(r.results_json)); } catch (_) {}
  }
  return out;
}

// The most recent successful runs of a workflow that carry results, with their
// ids and timestamps and parsed results — the input to the cross-run dataset
// view (dataset.service). Newest-first from SQL (bounded by `limit`); returned
// oldest→newest so first-seen accumulation is left-to-right. A retained run
// whose results_json won't parse is skipped rather than aborting the view.
async function recentSuccessfulRunsWithResults(workflowId, limit = 100, { includePartial = false } = {}) {
  const rows = await db.all(`
    SELECT id, started_at, finished_at, status, results_json FROM runs
    WHERE workflow_id = ? AND ${dataStatusSql(includePartial)} AND results_json IS NOT NULL
    ORDER BY started_at DESC
    LIMIT ?
  `, [workflowId, limit]);
  const out = [];
  for (const r of rows) {
    let results;
    try { results = JSON.parse(r.results_json); } catch (_) { continue; }
    out.push({ id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, results });
  }
  return out.reverse(); // oldest → newest
}

// The successful run immediately before `beforeRunId` (same workflow) that
// carries results — the baseline a monitored run is diffed against. Ordered by
// id so it's stable regardless of started_at clock skew. Returns
// { id, startedAt, results } or null when there's no prior run.
async function previousSuccessfulRunWithResults(workflowId, beforeRunId, { includePartial = false } = {}) {
  const r = await db.get(`
    SELECT id, started_at, results_json FROM runs
    WHERE workflow_id = ? AND ${dataStatusSql(includePartial)} AND results_json IS NOT NULL AND id < ?
    ORDER BY id DESC
    LIMIT 1
  `, [workflowId, beforeRunId]);
  if (!r) return null;
  let results;
  try { results = JSON.parse(r.results_json); } catch (_) { return null; }
  return { id: r.id, startedAt: r.started_at, results };
}

// One run of a workflow with its parsed results — the input to an on-demand
// diff between any two runs (the Compare view), as opposed to the automatic
// previous-run diff above. Returns null when the run doesn't belong to this
// workflow or its results won't parse.
async function runWithResults(workflowId, runId) {
  const r = await db.get(`
    SELECT id, started_at, finished_at, status, results_json FROM runs
    WHERE id = ? AND workflow_id = ?
  `, [runId, workflowId]);
  if (!r || !r.results_json) return null;
  let results;
  try { results = JSON.parse(r.results_json); } catch (_) { return null; }
  return { id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, results };
}

// Successful runs that carry results, newest first — just the metadata needed
// to populate the "compare which two runs?" pickers. `changed` flags the runs
// that already have a stored monitoring summary.
async function successfulRunsBrief(workflowId, limit = 50, { includePartial = false } = {}) {
  const rows = await db.all(`
    SELECT id, started_at, finished_at, status, rows_captured,
           (change_summary_json IS NOT NULL) AS changed
    FROM runs
    WHERE workflow_id = ? AND ${dataStatusSql(includePartial)} AND results_json IS NOT NULL
    ORDER BY id DESC
    LIMIT ?
  `, [workflowId, limit]);
  return rows.map(r => ({
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    changed: !!r.changed,
    status: r.status,
    partial: r.status === 'partial',
    rowsCaptured: r.rows_captured || 0,
  }));
}

// Persist the change-monitoring diff summary onto a run row.
async function saveChangeSummary(runId, summary) {
  await db.run('UPDATE runs SET change_summary_json = ? WHERE id = ?',
    [summary == null ? null : JSON.stringify(summary), runId]);
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

/* The version id matching these steps, WITHOUT creating one.
   Resume uses this to answer "is the workflow still exactly what that run
   executed?" — comparing content hashes rather than trusting a timestamp, and
   without the side effect of ensureVersion (a read-only eligibility check must
   not mint version rows). Null when the current steps have never been run. */
async function findVersionIdByContent(workflowId, userId, steps) {
  try {
    const row = await db.get(
      'SELECT id FROM workflow_versions WHERE workflow_id = ? AND user_id = ? AND hash = ?',
      [workflowId, userId, hashSteps(steps)]
    );
    return row ? row.id : null;
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

async function upsertSchedule({ userId, workflowId, intervalMinutes, isActive, anchorAtIso = null, weekdays = null, cronExpression = null }) {
  const existing = await db.get('SELECT id FROM schedules WHERE workflow_id = ?', [workflowId]);
  const validAnchor = normaliseAnchor(anchorAtIso);
  const weekdaysCsv = normaliseWeekdays(weekdays);
  const cron = normaliseCron(cronExpression);
  const nextRun = computeNextRun(validAnchor, intervalMinutes, { weekdaysCsv, cron }).toISOString();
  if (existing) {
    await db.run(`
      UPDATE schedules
      SET interval_minutes = ?, is_active = ?, anchor_at = ?, weekdays = ?, cron_expression = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [intervalMinutes, isActive ? 1 : 0, validAnchor, weekdaysCsv, cron, nextRun, existing.id]);
    return getScheduleById(existing.id);
  }
  const inserted = await db.get(`
    INSERT INTO schedules (user_id, workflow_id, interval_minutes, is_active, anchor_at, weekdays, cron_expression, next_run_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [userId, workflowId, intervalMinutes, isActive ? 1 : 0, validAnchor, weekdaysCsv, cron, nextRun]);
  return getScheduleById(inserted.id);
}

function normaliseAnchor(anchorAtIso) {
  if (!anchorAtIso) return null;
  const t = Date.parse(anchorAtIso);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// Accept an array (or CSV string) of weekday numbers 0-6; return a sorted,
// de-duped CSV, or null when it's every day / empty (no filtering).
function normaliseWeekdays(weekdays) {
  if (weekdays == null) return null;
  const arr = Array.isArray(weekdays) ? weekdays : String(weekdays).split(',');
  const set = new Set(arr.map(n => Number(String(n).trim())).filter(n => Number.isInteger(n) && n >= 0 && n <= 6));
  if (set.size === 0 || set.size === 7) return null; // no constraint
  return [...set].sort((a, b) => a - b).join(',');
}

function normaliseCron(cron) {
  if (cron == null || String(cron).trim() === '') return null;
  return String(cron).trim();
}

function parseWeekdaysCsv(csv) {
  if (!csv) return null;
  const set = new Set(String(csv).split(',').map(n => Number(n.trim())).filter(n => Number.isInteger(n)));
  return set.size ? set : null;
}

/**
 * Compute the next time a scheduled workflow should fire.
 *
 * Precedence:
 *   1. cron  — when set, the cron expression drives the next fire entirely.
 *   2. anchor + interval — recurring at anchor + k*interval (k>=0), the
 *      smallest slot strictly in the future; without an anchor, now+interval.
 *   3. weekdays — a filter on the interval slots: skip forward by interval
 *      until the slot lands on an allowed weekday (server-local).
 */
function computeNextRun(anchorIso, intervalMinutes, opts = {}) {
  const nowMsVal = opts.now instanceof Date ? opts.now.getTime()
    : (typeof opts.now === 'number' ? opts.now : Date.now());

  // 1. Cron wins.
  if (opts.cron) {
    const d = cronNext(opts.cron, new Date(nowMsVal));
    if (d) return d;
    // invalid cron → fall through to interval so a bad string never wedges the schedule
  }

  const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;
  let next;
  if (!anchorIso) {
    next = nowMsVal + intervalMs;
  } else {
    const anchor = Date.parse(anchorIso);
    if (Number.isNaN(anchor)) next = nowMsVal + intervalMs;
    else if (anchor > nowMsVal) next = anchor;
    else {
      const slots = Math.ceil((nowMsVal - anchor) / intervalMs);
      next = anchor + slots * intervalMs;
      if (next <= nowMsVal) next += intervalMs;
    }
  }

  // 3. Weekday filter.
  const allowed = parseWeekdaysCsv(opts.weekdaysCsv);
  if (allowed && allowed.size > 0 && allowed.size < 7) {
    let guard = 0;
    while (!allowed.has(new Date(next).getDay()) && guard++ < 20000) {
      next += intervalMs;
    }
  }
  return new Date(next);
}

// True iff `expr` is a cron string cron-parser can parse.
function computeNextRunCronValid(expr) {
  return cronNext(expr, new Date()) !== null;
}

// Next cron occurrence after `from`, or null if the expression is invalid.
// cron-parser v5 exposes CronExpressionParser.parse; older exposes parseExpression.
function cronNext(expr, from) {
  try {
    const cp = require('cron-parser');
    const it = cp.CronExpressionParser
      ? cp.CronExpressionParser.parse(expr, { currentDate: from })
      : cp.parseExpression(expr, { currentDate: from });
    return it.next().toDate();
  } catch (_) {
    return null;
  }
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
  const row = await db.get('SELECT anchor_at, weekdays, cron_expression FROM schedules WHERE id = ?', [scheduleId]);
  const next = computeNextRun(row && row.anchor_at, intervalMinutes, {
    weekdaysCsv: row && row.weekdays, cron: row && row.cron_expression,
  }).toISOString();
  await db.run(`
    UPDATE schedules
    SET last_run_at = CURRENT_TIMESTAMP, next_run_at = ?
    WHERE id = ?
  `, [next, scheduleId]);
}

/**
 * Atomically claim a due schedule for dispatch. The conditional UPDATE only
 * succeeds for the ONE caller that wins the race: it requires the schedule to
 * still be active and past-due (`next_run_at <= now`), and pushes next_run_at
 * into the future as part of the same statement. A losing/duplicate caller —
 * including one in another backend process — sees `changes === 0` and must not
 * dispatch. This is what lets the scheduler be stateless across processes
 * (habit #1) instead of relying on an in-memory Set.
 *
 * Returns true iff this caller claimed the slot.
 */
async function claimDueSchedule(scheduleId, intervalMinutes, now = new Date()) {
  const row = await db.get('SELECT anchor_at, weekdays, cron_expression FROM schedules WHERE id = ?', [scheduleId]);
  if (!row) return false;
  const next = computeNextRun(row.anchor_at, intervalMinutes, {
    weekdaysCsv: row.weekdays, cron: row.cron_expression, now,
  }).toISOString();
  const info = await db.run(`
    UPDATE schedules
    SET last_run_at = CURRENT_TIMESTAMP, next_run_at = ?
    WHERE id = ? AND is_active = 1 AND next_run_at <= ?
  `, [next, scheduleId, now.toISOString()]);
  return info.changes === 1;
}

// ── change monitors (per-workflow "watch for changes") ──────────────────────
async function getMonitorForWorkflow(userId, workflowId) {
  return db.get('SELECT * FROM workflow_monitors WHERE user_id = ? AND workflow_id = ?', [userId, workflowId]);
}

// Read a monitor by workflow id alone — used by the pipeline, which already
// knows the run's owner but wants the config without re-scoping by user.
async function getMonitorByWorkflow(workflowId) {
  return db.get('SELECT * FROM workflow_monitors WHERE workflow_id = ?', [workflowId]);
}

async function upsertMonitor({ userId, workflowId, isActive = true, outputKey = null, keyField = null }) {
  const existing = await db.get('SELECT id FROM workflow_monitors WHERE workflow_id = ?', [workflowId]);
  if (existing) {
    await db.run(`
      UPDATE workflow_monitors
      SET is_active = ?, output_key = ?, key_field = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [isActive ? 1 : 0, outputKey, keyField, existing.id]);
    return getMonitorById(existing.id);
  }
  const inserted = await db.get(`
    INSERT INTO workflow_monitors (user_id, workflow_id, is_active, output_key, key_field)
    VALUES (?, ?, ?, ?, ?)
    RETURNING id
  `, [userId, workflowId, isActive ? 1 : 0, outputKey, keyField]);
  return getMonitorById(inserted.id);
}

async function getMonitorById(id) {
  return db.get('SELECT * FROM workflow_monitors WHERE id = ?', [id]);
}

async function deleteMonitor(userId, workflowId) {
  const info = await db.run('DELETE FROM workflow_monitors WHERE user_id = ? AND workflow_id = ?', [userId, workflowId]);
  return info.changes;
}

// Recent runs of a workflow that recorded a change summary (newest first) —
// the per-workflow change feed.
async function recentChangedRuns(workflowId, limit = 20) {
  return db.all(`
    SELECT id, started_at, finished_at, status, change_summary_json
    FROM runs
    WHERE workflow_id = ? AND change_summary_json IS NOT NULL
    ORDER BY id DESC
    LIMIT ?
  `, [workflowId, limit]);
}

// ── Google Sheets delivery (per-workflow) ───────────────────────────────────
async function getSheetForWorkflow(userId, workflowId) {
  return db.get('SELECT * FROM workflow_sheets WHERE user_id = ? AND workflow_id = ?', [userId, workflowId]);
}

// By workflow id alone — the pipeline already knows the run's owner.
async function getSheetByWorkflow(workflowId) {
  return db.get('SELECT * FROM workflow_sheets WHERE workflow_id = ?', [workflowId]);
}

async function upsertSheet({ userId, workflowId, isActive = true, spreadsheetId, sheetName = 'Sheet1', outputKey = null }) {
  const existing = await db.get('SELECT id FROM workflow_sheets WHERE workflow_id = ?', [workflowId]);
  if (existing) {
    await db.run(`
      UPDATE workflow_sheets
      SET is_active = ?, spreadsheet_id = ?, sheet_name = ?, output_key = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [isActive ? 1 : 0, spreadsheetId, sheetName, outputKey, existing.id]);
    return getSheetById(existing.id);
  }
  const inserted = await db.get(`
    INSERT INTO workflow_sheets (user_id, workflow_id, is_active, spreadsheet_id, sheet_name, output_key)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING id
  `, [userId, workflowId, isActive ? 1 : 0, spreadsheetId, sheetName, outputKey]);
  return getSheetById(inserted.id);
}

async function getSheetById(id) {
  return db.get('SELECT * FROM workflow_sheets WHERE id = ?', [id]);
}

async function deleteSheet(userId, workflowId) {
  const info = await db.run('DELETE FROM workflow_sheets WHERE user_id = ? AND workflow_id = ?', [userId, workflowId]);
  return info.changes;
}

// Record the outcome of the most recent delivery attempt (for the UI).
async function updateSheetStatus(workflowId, status) {
  await db.run(
    'UPDATE workflow_sheets SET last_status = ?, last_sent_at = CURRENT_TIMESTAMP WHERE workflow_id = ?',
    [String(status).slice(0, 300), workflowId]
  );
}

// ── helpers ───────────────────────────────────────────────────────────────
function truncate(s, n) {
  if (s == null) return null;
  const t = String(s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}

module.exports = {
  // runs
  createRun, finishRun, savePartialResults, getRun, getRunForUser, listRunsForUser,
  // liveness / orphan recovery
  touchRun, requestCancel, findOrphanedRuns, findRunningRuns,
  // queued runs (public API)
  createQueuedRun, findRunByIdempotencyKey, nextQueuedRuns,
  claimQueuedRun, cancelQueuedRun, startQueuedRun, listRunsForUserPage,
  // logs
  appendLog, getLogs, flushLogs,
  // repairs
  recordRepair, markRepairVerified, markAutoAdopted, listRepairsForRun, healingHistoryForWorkflow,
  // self-healing helpers
  recentSuccessfulResults, updateWorkflowSteps,
  // cross-run dataset view
  recentSuccessfulRunsWithResults,
  // change monitoring
  previousSuccessfulRunWithResults, saveChangeSummary,
  runWithResults, successfulRunsBrief,
  getMonitorForWorkflow, getMonitorByWorkflow, upsertMonitor, deleteMonitor, recentChangedRuns,
  // Google Sheets delivery
  getSheetForWorkflow, getSheetByWorkflow, upsertSheet, deleteSheet, updateSheetStatus,
  // version history / rollback
  ensureVersion, getVersionForUser, listVersionsForWorkflow, findVersionIdByContent,
  // schedules
  listSchedulesForUser, getScheduleByWorkflow, upsertSchedule,
  deleteSchedule, dueSchedules, bumpScheduleAfterRun, claimDueSchedule, getScheduleById,
  computeNextRun, normaliseWeekdays, computeNextRunCronValid,   // exported for unit tests + route validation
};
