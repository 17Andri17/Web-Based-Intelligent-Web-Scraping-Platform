'use strict';

const db                = require('../db');
const runStore          = require('./runStore.service');
const executionPipeline = require('./executionPipeline.service');
const { collectCustomActionIds } = require('../workflow/workflowUtils');

/* ===========================================================================
   scheduler.service
   ---------------------------------------------------------------------------
   In-process schedule dispatcher. Once every TICK_MS we ask the DB for any
   schedules whose `next_run_at` has passed, and we fire one execution per
   schedule. Concurrency is limited per process: at most CONCURRENCY
   workflows run at once; the rest wait for the next tick.

   We deliberately don't use node-cron / agenda / Bull here — the
   requirements are modest, all data is in SQLite, and an in-process
   poller is a few dozen lines and easy to reason about. Multiple backend
   processes would race on dispatch, but this project is single-instance
   for now.
   ========================================================================= */

const TICK_MS = 30 * 1000;
const CONCURRENCY = 3;

let timer = null;
let running = 0;
const inflight = new Set();    // schedule ids currently being executed

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
    due = runStore.dueSchedules();
  } catch (err) {
    console.error('[scheduler] tick query failed:', err.message);
    return;
  }
  if (!due.length) return;

  for (const sch of due) {
    if (running >= CONCURRENCY) break;
    if (inflight.has(sch.id)) continue;          // already running this one
    inflight.add(sch.id);
    running++;

    // Bump next_run_at NOW so a long-running execution doesn't stack up
    // multiple due ticks on the same schedule.
    try { runStore.bumpScheduleAfterRun(sch.id, sch.interval_minutes); } catch (_) {}

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
  const customActions = resolveCustomActionsForUser(steps, sch.user_id);

  try {
    await executionPipeline.executeAndPersist({
      workflow: { steps, meta, customActions },
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

function resolveCustomActionsForUser(steps, userId) {
  const ids = collectCustomActionIds(steps);
  if (ids.length === 0) return {};
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, name, inputs_json, outputs_json, code
     FROM custom_actions
     WHERE user_id = ? AND id IN (${placeholders})`
  ).all(userId, ...ids);
  const out = {};
  for (const r of rows) {
    out[r.id] = {
      name: r.name,
      inputs:  safeJson(r.inputs_json)  || [],
      outputs: safeJson(r.outputs_json) || [],
      code: r.code || '',
    };
  }
  return out;
}

module.exports = { start, stop, tick };
