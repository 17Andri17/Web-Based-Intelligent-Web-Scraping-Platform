'use strict';

const pipeline = require('../services/executionPipeline.service');

/* ===========================================================================
   WorkflowExecutor (socket-attached wrapper)
   ---------------------------------------------------------------------------
   Public API kept stable for server.js: executeWorkflow(workflow, socket).

   Internally we just forward to the execution pipeline, which:
     - Persists the run to the DB (runs / run_logs / run_repairs)
     - Implements the retry + LLM-repair recovery strategy
     - Streams events back to us via callbacks, which we replay on the socket

   The socket events emitted from here mirror the previous shape so the
   frontend doesn't need to change:
     executionStarted        ({ runId })
     executionLog            ({ line, level })
     executionDone           ({ success, results, exitCode, status, runId, run })
     executionStepBegin      ({ id, type, label, kind })
     executionStepError      ({ step, message, html?, url? })
   ========================================================================= */

async function executeWorkflow(workflow, socket, opts = {}) {
  const userId     = opts.userId     ?? socket?.user?.id;
  const workflowId = opts.workflowId ?? null;

  if (!userId || !workflowId) {
    // Without persistence context we can still run, but we'd lose the
    // history. The caller (server.js) is responsible for resolving the
    // workflowId before invoking us; refuse politely if it didn't.
    socket?.emit('executionLog', { line: '❌ Refusing to execute: missing workflow context (save the workflow first to enable history & retries).', level: 'error' });
    socket?.emit('executionDone', { success: false, results: null, exitCode: -1, error: 'workflow not saved' });
    return { success: false };
  }

  // Per-socket cancellation: the frontend emits 'cancelExecution' to stop.
  const controller = new AbortController();
  const onCancel = () => controller.abort();
  socket?.once?.('cancelExecution', onCancel);

  try {
    const run = await pipeline.executeAndPersist({
      workflow,
      userId,
      workflowId,
      scheduleId: null,
      trigger: 'manual',
      signal: controller.signal,
      callbacks: {
        onStart: ({ runId }) => {
          socket?.emit('executionStarted', { runId });
        },
        onLog: (entry) => socket?.emit('executionLog', entry),
        onStepBegin: (info) => socket?.emit('executionStepBegin', info),
        onStepError: (info) => socket?.emit('executionStepError', info),
        onIteration: (info) => socket?.emit('executionIteration', info),
        onResults:   (r) => socket?.emit('executionResults', r),
        onDone: ({ run }) => {
          const results = run.results_json ? safeJson(run.results_json) : null;
          socket?.emit('executionDone', {
            success: run.status === 'success',
            status:  run.status,
            results,
            exitCode: run.status === 'success' ? 0 : 1,
            runId: run.id,
            run:    serializeRun(run),
          });
        },
      },
    });
    return { success: run.status === 'success', run };
  } catch (err) {
    socket?.emit('executionLog', { line: `❌ Executor error: ${err.message}`, level: 'error' });
    socket?.emit('executionDone', { success: false, results: null, exitCode: -1, error: err.message });
    return { success: false };
  } finally {
    socket?.off?.('cancelExecution', onCancel);
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

function serializeRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    trigger: row.trigger,
    startedAt:  row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    errorMessage:  row.error_message,
    errorCategory: row.error_category,
    aiSummary:     row.ai_summary,
    failedStep: {
      id:    row.failed_step_id,
      type:  row.failed_step_type,
      label: row.failed_step_label,
    },
    retryCount: row.retry_count,
    hasPatchedWorkflow: !!row.patched_steps_json,
  };
}

module.exports = { executeWorkflow };
