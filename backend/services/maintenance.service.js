'use strict';

const db = require('../db/client');

/* ===========================================================================
   maintenance.service
   ---------------------------------------------------------------------------
   Periodic housekeeping so a long-lived local instance doesn't grow without
   bound. Two retention policies, both configurable via env and both safe to
   run repeatedly:

     • run_logs older than RUN_LOG_RETENTION_DAYS are deleted (default 30).
       Logs are the bulkiest per-run data and are rarely needed once a run is
       old; the run row itself (status, results, AI summary) is kept.

     • per workflow, only the most recent RUN_RESULTS_RETENTION_COUNT runs
       keep their results_json / patched_steps_json (default 100). Older runs
       stay in history (so counts/sparklines are intact) but shed their heavy
       JSON blobs.

   Set either value to 0 to disable that policy. Runs once shortly after boot,
   then every RETENTION_SWEEP_HOURS (default 24).
   ========================================================================= */

const SWEEP_MS = (() => {
  const h = Number(process.env.RETENTION_SWEEP_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 24) * 60 * 60 * 1000;
})();

function logRetentionDays() {
  const n = Number(process.env.RUN_LOG_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}
function resultsRetentionCount() {
  const n = Number(process.env.RUN_RESULTS_RETENTION_COUNT);
  return Number.isFinite(n) && n >= 0 ? n : 100;
}

let timer = null;

async function sweep() {
  // Spent auth tokens (password reset, e-mail verification). They stop being
  // usable the moment they expire, so this is housekeeping rather than a
  // security control — but an unbounded table of dead credentials is still
  // worth not accumulating. The grace period keeps recently-expired rows so
  // "this link has expired" stays distinguishable from "no such link".
  try {
    const authTokens = require('../db/repositories/authTokens.repo');
    const removed = await authTokens.pruneExpired(7);
    if (removed) console.log(`[maintenance] pruned ${removed} expired auth token(s)`);
  } catch (err) {
    console.error('[maintenance] auth token prune failed:', err.message);
  }

  const days = logRetentionDays();
  if (days > 0) {
    try {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      // Delete logs for runs that finished before the cutoff. Join via a
      // subquery so we only touch logs of old, finished runs.
      const info = await db.run(
        `DELETE FROM run_logs WHERE run_id IN (
           SELECT id FROM runs WHERE finished_at IS NOT NULL AND finished_at < ?
         )`,
        [cutoff]
      );
      if (info && info.changes) console.log(`[maintenance] pruned ${info.changes} run_log row(s) older than ${days}d`);
    } catch (err) {
      console.error('[maintenance] log prune failed:', err.message);
    }
  }

  const keep = resultsRetentionCount();
  if (keep > 0) {
    try {
      // For each workflow, null out heavy JSON on all but the newest `keep`
      // runs. Portable across SQLite/Postgres (correlated subquery counting
      // newer runs for the same workflow).
      const info = await db.run(
        `UPDATE runs SET results_json = NULL, patched_steps_json = NULL
         WHERE (results_json IS NOT NULL OR patched_steps_json IS NOT NULL)
           AND (
             SELECT COUNT(*) FROM runs AS newer
             WHERE newer.workflow_id = runs.workflow_id AND newer.id > runs.id
           ) >= ?`,
        [keep]
      );
      if (info && info.changes) console.log(`[maintenance] shed results JSON from ${info.changes} old run(s) (keeping newest ${keep}/workflow)`);
    } catch (err) {
      console.error('[maintenance] results prune failed:', err.message);
    }
  }
}

function start() {
  if (timer) return;
  // First sweep 60s after boot so it doesn't compete with startup work.
  timer = setTimeout(function loop() {
    sweep().finally(() => { timer = setTimeout(loop, SWEEP_MS); });
  }, 60 * 1000);
  console.log(`[maintenance] started — retention sweep every ${SWEEP_MS / 3600000}h`);
}

function stop() { if (timer) clearTimeout(timer); timer = null; }

module.exports = { start, stop, sweep };
