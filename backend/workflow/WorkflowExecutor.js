'use strict';

const pipeline = require('../services/executionPipeline.service');
const runEvents = require('../services/runEvents.service');

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
  // Progress now reaches this socket through the run's room (server.js bridges
  // runEvents → rooms), so the callbacks below no longer emit it themselves —
  // that would deliver every line twice to the launching tab. They remain for
  // the two things that are per-caller rather than per-run: joining the room
  // as soon as the run id exists, and cancellation.
  const onRunId = typeof opts.onRunId === 'function' ? opts.onRunId : null;
  // The guided tour's practice run. Still a real execution against a real
  // workflow row — it just isn't the user's work, so it is neither charged to
  // their plan nor allowed to trigger their webhooks / e-mails / sheets.
  const demo = !!opts.demo;
  // Debug Mode: the same run, stepped through by hand with a live picture of
  // the browser (see services/debugSession.service.js). Real in every way that
  // is recorded — it just isn't allowed to deliver, and doesn't retry.
  const debug = !!opts.debug;

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
      workflowName: opts.workflowName || null,
      demo,
      debug,
      callbacks: {
        // Join the room BEFORE any progress is published, so the launching tab
        // misses nothing between the run row being created and its first log.
        // Also register the abort by run id, so any watching tab can stop it —
        // not only the connection that happened to launch it.
        onStart: ({ runId }) => {
          if (onRunId) onRunId(runId);
          runEvents.registerCanceller(runId, () => controller.abort());
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

module.exports = { executeWorkflow };
