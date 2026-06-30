'use strict';

const runStore          = require('./runStore.service');
const executionPipeline = require('./executionPipeline.service');
const { resolveCustomActions, resolveSubflows } = require('../workflow/dependencyResolver');

/* ===========================================================================
   scheduler.service
   ---------------------------------------------------------------------------
   In-process schedule dispatcher. Once every TICK_MS we ask the DB for any
   schedules whose `next_run_at` has passed and try to dispatch each one.

   Dispatch is gated by an ATOMIC DB CLAIM (runStore.claimDueSchedule): the
   claim's conditional UPDATE only succeeds for the single caller that wins the
   race and pushes next_run_at into the future in the same statement. This is
   what makes the dispatcher safe to run in more than one backend process —
   two processes polling the same DB can no longer double-dispatch a slot — so
   the scheduler no longer depends on in-memory state for correctness (habit
   #1, stateless backend).

   The remaining in-memory bits are per-process resource controls, NOT
   correctness: `running` caps how many executions THIS process runs at once,
   and `inflight` is a best-effort guard so a single process doesn't overlap a
   schedule whose run outlives its interval. (Strict cross-process
   non-overlap for long runs would need a lease column — a future refinement.)
   ========================================================================= */

const TICK_MS = 30 * 1000;
const CONCURRENCY = 3;

let timer = null;
let running = 0;                // per-process concurrency cap (resource limit)
const inflight = new Set();     // best-effort same-process overlap guard

function start() {
  if (timer) return;
  // First tick after a short delay to let the server finish booting.
  timer = setTimeout(function loop() {
    tick().finally(() => {
      timer = setTimeout(loop, TICK_MS);
    });
  }, 3000);
  console.log(`[scheduler] started — polling every ${TICK_MS / 1000}s, concurrency ${CONCURRENCY}`);
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

async function tick() {
  let due;
  try {
    due = await runStore.dueSchedules();
  } catch (err) {
    console.error('[scheduler] tick query failed:', err.message);
    return;
  }
  if (!due.length) return;

  for (const sch of due) {
    if (running >= CONCURRENCY) break;
    if (inflight.has(sch.id)) continue;          // this process already runs it

    // Atomically claim the slot. The claim pushes next_run_at into the future
    // as part of its conditional UPDATE, so only the one winner dispatches —
    // even across processes. A loser (changes === 0) skips silently.
    let claimed = false;
    try {
      claimed = await runStore.claimDueSchedule(sch.id, sch.interval_minutes);
    } catch (err) {
      console.error(`[scheduler] claim failed for schedule #${sch.id}:`, err.message);
    }
    if (!claimed) continue;

    inflight.add(sch.id);
    running++;
    runOne(sch).catch(err => {
      console.error(`[scheduler] schedule #${sch.id} crashed:`, err.message);
    }).finally(() => {
      running--;
      inflight.delete(sch.id);
    });
  }
}

async function runOne(sch) {
  console.log(`[scheduler] dispatching workflow #${sch.workflow_id} (schedule #${sch.id})`);
  const steps = safeJson(sch.steps_json) || [];
  const meta  = safeJson(sch.meta_json)  || {};
  const customActions = await resolveCustomActions(steps, sch.user_id);
  const subflows      = await resolveSubflows(steps, sch.user_id, sch.workflow_id);

  try {
    await executionPipeline.executeAndPersist({
      workflow: { id: sch.workflow_id, steps, meta, customActions, subflows },
      userId: sch.user_id,
      workflowId: sch.workflow_id,
      scheduleId: sch.id,
      trigger: 'scheduled',
    });
  } catch (err) {
    console.error(`[scheduler] execution of schedule #${sch.id} threw:`, err.message);
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

module.exports = { start, stop, tick };
