'use strict';

const runStore          = require('./runStore.service');
const executionPipeline = require('./executionPipeline.service');
const webhookDispatcher = require('./webhookDispatcher.service');
const workflowsRepo     = require('../db/repositories/workflows.repo');
const { resolveCustomActions, resolveSubflows } = require('../workflow/dependencyResolver');

/* ===========================================================================
   apiWorker
   ---------------------------------------------------------------------------
   Background executor for API-triggered runs. POST /v1/workflows/:id/runs
   only ENQUEUES (a runs row with status='queued') and returns 202; this
   worker polls for queued rows, claims them atomically, and pushes each
   through the same executionPipeline the UI and scheduler use — so healing,
   versioning and run history all apply to API runs for free.

   The queue is the database, not Redis: runStore.claimQueuedRun's conditional
   UPDATE guarantees exactly one claimer even across processes (the same
   stateless-dispatch pattern as scheduler.service.js), so this module can be
   started inside the web process today and moved to a dedicated worker
   process later purely as a deployment decision. Swapping in BullMQ/Redis
   later only replaces the polling, not the run lifecycle.

   Cancellation: each in-flight run holds an AbortController here, so
   POST /v1/runs/:id/cancel can stop a RUNNING run when it lives in this
   process (queued runs are cancelled straight in the DB and never start).
   ========================================================================= */

const TICK_MS      = Number(process.env.API_WORKER_POLL_MS || 3000);
const CONCURRENCY  = Number(process.env.API_WORKER_CONCURRENCY || 2);

let timer = null;
let running = 0;
const controllers = new Map(); // runId -> AbortController

function start() {
  if (timer) return;
  timer = setTimeout(function loop() {
    tick().finally(() => { timer = setTimeout(loop, TICK_MS); });
  }, 1000);
  console.log(`[apiWorker] started — polling every ${TICK_MS / 1000}s, concurrency ${CONCURRENCY}`);
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

// Abort a run currently executing in THIS process. Returns false when the
// run isn't here (finished, still queued, or owned by another process).
function cancel(runId) {
  const controller = controllers.get(Number(runId));
  if (!controller) return false;
  controller.abort();
  return true;
}

function isExecutingHere(runId) {
  return controllers.has(Number(runId));
}

async function tick() {
  if (running >= CONCURRENCY) return;
  let queued;
  try {
    queued = await runStore.nextQueuedRuns(CONCURRENCY - running);
  } catch (err) {
    console.error('[apiWorker] queue poll failed:', err.message);
    return;
  }
  for (const row of queued) {
    if (running >= CONCURRENCY) break;
    let claimed = false;
    try {
      claimed = await runStore.claimQueuedRun(row.id);
    } catch (err) {
      console.error(`[apiWorker] claim failed for run #${row.id}:`, err.message);
    }
    if (!claimed) continue; // lost to another worker or to a cancel

    running++;
    executeOne(row).catch(err => {
      console.error(`[apiWorker] run #${row.id} crashed:`, err.message);
    }).finally(() => { running--; });
  }
}

async function executeOne(row) {
  console.log(`[apiWorker] executing run #${row.id} (workflow #${row.workflow_id})`);

  // The workflow is loaded at EXECUTION time (like the scheduler does), so a
  // queued run always uses the owner's latest saved steps.
  const wf = await workflowsRepo.getForUser(row.workflow_id, row.user_id);
  if (!wf) {
    await runStore.finishRun(row.id, {
      status: 'error',
      finished_at: new Date().toISOString(),
      error_message: 'Workflow no longer exists',
      error_category: 'NOT_FOUND',
    });
    const finalRow = await runStore.getRun(row.id);
    webhookDispatcher.dispatchRunEvent(finalRow).catch(() => {});
    return;
  }

  const steps = safeJson(wf.steps_json) || [];
  const meta  = applyInputs(wf.meta_json ? safeJson(wf.meta_json) || {} : {}, safeJson(row.inputs_json));
  const customActions = await resolveCustomActions(steps, row.user_id);
  const subflows      = await resolveSubflows(steps, row.user_id, row.workflow_id);

  const controller = new AbortController();
  controllers.set(row.id, controller);
  try {
    await executionPipeline.executeAndPersist({
      runId: row.id,
      workflow: { id: row.workflow_id, steps, meta, customActions, subflows },
      userId: row.user_id,
      workflowId: row.workflow_id,
      trigger: 'api',
      signal: controller.signal,
    });
  } finally {
    controllers.delete(row.id);
  }
}

// Overlay caller-supplied run inputs onto the workflow's declared variables.
// Only variables that already exist by name are overridden — the trigger
// endpoint validated the names, and codegen ignores undeclared ones anyway.
// Values are stored back as strings; renderVariableLiteral converts them
// according to each variable's declared type (objects → JSON for 'json').
function applyInputs(meta, inputs) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return meta;
  const out = JSON.parse(JSON.stringify(meta || {}));
  if (!Array.isArray(out.variables)) return out;
  for (const variable of out.variables) {
    if (!variable || typeof variable.name !== 'string') continue;
    if (!Object.prototype.hasOwnProperty.call(inputs, variable.name)) continue;
    const value = inputs[variable.name];
    variable.value = (value !== null && typeof value === 'object')
      ? JSON.stringify(value)
      : String(value);
  }
  return out;
}

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

module.exports = { start, stop, tick, cancel, isExecutingHere, applyInputs };
