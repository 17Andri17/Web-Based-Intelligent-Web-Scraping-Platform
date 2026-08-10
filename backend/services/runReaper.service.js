'use strict';

const runStore = require('./runStore.service');
const runEvents = require('./runEvents.service');

/* ===========================================================================
   runReaper
   ---------------------------------------------------------------------------
   Nothing may sit at "running" forever.

   A run executes as a child process of this server. If the server stops — a
   restart, a deploy, a crash, someone closing the terminal — the child dies
   with it, but the `runs` row still says 'running'. Nothing is left alive to
   finish it, so the UI shows an eternal spinner and Cancel does nothing,
   because the canceller lived in the memory of the process that died. From
   the user's side the job is simply stuck, with no way out.

   Two sweeps close that:

     • At boot. This process spawns its runs as children, so if it has only
       just started, none of the runs marked running can still be alive. They
       are finalised immediately rather than waiting for a timeout.

     • Periodically, on a stale heartbeat. Covers a run whose owner is gone
       while the server stayed up, and a second instance whose process died.
       The heartbeat is the only honest liveness signal: a row is trusted to
       be running exactly as long as something keeps saying so.

   Recovery keeps the data. A killed run has usually captured rows, and those
   were check-pointed as it went (see runStore.savePartialResults), so an
   interrupted run is finalised as 'partial' with its rows promoted — the same
   outcome as a cancel. Only a run that captured nothing becomes an error.
   ========================================================================= */

// How long a run may go without a heartbeat before it is presumed dead. The
// pipeline beats every HEARTBEAT_MS (10s), so this is many missed beats —
// generous enough that a busy event loop can never cause a false positive.
const STALE_MS = (() => {
  const n = Number(process.env.WS_RUN_STALE_MS);
  return Number.isFinite(n) && n >= 15000 ? n : 90000;
})();

const SWEEP_MS = (() => {
  const n = Number(process.env.WS_RUN_REAP_INTERVAL_MS);
  return Number.isFinite(n) && n >= 5000 ? n : 30000;
})();

let timer = null;

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

/**
 * Finalise one run whose owner is gone.
 *
 * The rows it captured are already durable — either promoted into results_json
 * or sitting in the partial checkpoint — so recovery is mostly about telling
 * the truth on the row and releasing anyone watching it.
 */
async function reap(row, reason) {
  const partial = safeJson(row.partial_results_json);
  const existing = safeJson(row.results_json);
  const results = existing || partial;
  const rows = row.rows_captured || 0;
  const kept = rows > 0 || (results && Object.keys(results).length > 0);

  const status = kept ? 'partial' : 'error';
  const message = kept
    ? `${reason} The ${rows ? rows.toLocaleString() + ' row(s)' : 'rows'} captured before it stopped were kept.`
    : `${reason} No data had been captured yet.`;

  await runStore.finishRun(row.id, {
    status,
    finished_at: new Date().toISOString(),
    error_message: reason,
    error_category: 'INTERRUPTED',
    ai_summary: message,
    // Promote the checkpoint: it is the only copy of what this run captured.
    ...(results && !existing ? { results_json: JSON.stringify(results) } : {}),
    partial_results_json: null,
    cancel_requested: 0,
  });

  // Release anyone watching. Without this a tab that is attached keeps its
  // spinner until it reloads, which is the very symptom being fixed.
  try {
    const finalRow = await runStore.getRun(row.id);
    runEvents.end(row.id, {
      status,
      run: finalRow ? {
        id: finalRow.id, status: finalRow.status, finishedAt: finalRow.finished_at,
        errorMessage: finalRow.error_message, aiSummary: finalRow.ai_summary,
        rowsCaptured: finalRow.rows_captured || 0,
      } : null,
      results,
    });
  } catch (_) {}

  return status;
}

/**
 * Boot sweep: every run still marked running belongs to a process that no
 * longer exists, because this one has only just started.
 *
 * Skipped when WS_MULTI_INSTANCE is set, where another server may legitimately
 * own a live run — there the periodic stale-heartbeat sweep does the job
 * instead, just a little less promptly.
 */
async function reapOnBoot() {
  if (/^(1|true|yes|on)$/i.test(String(process.env.WS_MULTI_INSTANCE || ''))) {
    return reapStale();
  }
  let rows = [];
  try { rows = await runStore.findRunningRuns(); } catch (_) { return 0; }
  for (const row of rows) {
    try {
      await reap(row, 'The server stopped while this run was in progress.');
    } catch (_) { /* one bad row must not stop the sweep */ }
  }
  if (rows.length) {
    console.log(`[reaper] recovered ${rows.length} run(s) left running by a previous process`);
  }
  return rows.length;
}

/** Periodic sweep: runs whose heartbeat has gone stale have no live owner. */
async function reapStale() {
  let rows = [];
  try { rows = await runStore.findOrphanedRuns(STALE_MS); } catch (_) { return 0; }
  // A run this process is actively running is alive by definition, whatever
  // the row says — never reap one out from under a live pipeline.
  const live = new Set(runEvents.liveRunIds());
  const orphans = rows.filter(r => !live.has(Number(r.id)));
  for (const row of orphans) {
    try {
      await reap(row, 'This run stopped reporting progress and was presumed dead.');
    } catch (_) {}
  }
  if (orphans.length) {
    console.log(`[reaper] recovered ${orphans.length} run(s) with no live owner`);
  }
  return orphans.length;
}

function start() {
  if (timer) return;
  // Boot sweep first, so a restart clears stuck runs immediately rather than
  // after a sweep interval.
  reapOnBoot().catch(() => {});
  timer = setInterval(() => { reapStale().catch(() => {}); }, SWEEP_MS);
  if (timer.unref) timer.unref();
  console.log(`[reaper] started — checking every ${Math.round(SWEEP_MS / 1000)}s, stale after ${Math.round(STALE_MS / 1000)}s`);
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop, reap, reapOnBoot, reapStale, STALE_MS };
