'use strict';

const db                = require('../db');
const runner            = require('./runner.service');
const runStore          = require('./runStore.service');
const errorClassifier   = require('./errorClassifier.service');
const repair            = require('./repair.service');
const llm               = require('./llm.service');
const { patchStepParams, clone } = require('../workflow/workflowUtils');

/* ===========================================================================
   executionPipeline
   ---------------------------------------------------------------------------
   Single entry point used by every code path that wants to execute a
   workflow: socket-initiated interactive runs, the scheduler, and the API.

   Responsibilities:
     1. Persist a `runs` row.
     2. Stream logs / step events into run_logs via runStore.
     3. On failure, classify the error and decide a recovery strategy:
          CONNECTION  → automatic retry with linear backoff
          HTTP        → mark run as 'error', surface to user
          SELECTOR /
          UNKNOWN     → ask the LLM for a patch, apply to a workflow copy,
                        re-run. Patches accumulate across retries so a fix
                        for step A persists when re-running to expose B.
          LLM         → mark 'needs_review'.
     4. Finalise the run with status / summary / patched_steps_json.

   The `callbacks` argument lets a caller forward live events to a socket
   (interactive run) without having to know anything about persistence.
   ========================================================================= */

const MAX_REPAIR_ATTEMPTS = 3;          // total LLM repair passes per run
const MAX_CONNECTION_RETRIES = 2;       // retries on transient network errors
const CONNECTION_RETRY_DELAY_MS = 4000;

function nowMs() { return Date.now(); }

function ms(t0) { return Date.now() - t0; }

function emit(callbacks, event, payload) {
  if (!callbacks) return;
  const fn = callbacks[event];
  if (typeof fn === 'function') {
    try { fn(payload); } catch (_) {}
  }
}

/**
 * Execute a workflow start-to-finish, persisting everything, applying the
 * auto-repair pipeline on failure.
 *
 * @param {Object} arg
 * @param {Object} arg.workflow       - { steps, meta, customActions }
 * @param {number} arg.userId
 * @param {number} arg.workflowId
 * @param {number} [arg.scheduleId]
 * @param {string} [arg.trigger]      - 'manual' | 'scheduled' | 'repair'
 * @param {AbortSignal} [arg.signal]
 * @param {Object} [arg.callbacks]    - { onStart, onLog, onStepBegin, onStepError, onResults, onDone }
 *
 * @returns {Promise<Object>}  - the finalised run row
 */
async function executeAndPersist(arg) {
  const { userId, workflowId, scheduleId = null, trigger = 'manual', signal, callbacks } = arg;
  let currentSteps = clone(arg.workflow.steps || []);
  const meta = arg.workflow.meta || {};
  const customActions = arg.workflow.customActions || {};

  const t0 = nowMs();
  const runId = runStore.createRun({ userId, workflowId, scheduleId, trigger });
  emit(callbacks, 'onStart', { runId });

  const log = (line, level = 'info') => {
    runStore.appendLog(runId, level, line);
    emit(callbacks, 'onLog', { line, level });
  };

  log(`▶ Run #${runId} started (trigger: ${trigger})`);

  // Track which step is active so we can correlate STEP_BEGIN events
  let lastStep = null;
  const onRunnerEvents = (events) => {
    events.on('log',       ({ line, level }) => log(line, level));
    events.on('stepBegin', (info) => { lastStep = info; emit(callbacks, 'onStepBegin', info); });
    events.on('stepError', (info) => { emit(callbacks, 'onStepError', info); });
    events.on('results',   (r)    => { emit(callbacks, 'onResults', r); });
  };

  // ── Run + retry loop ─────────────────────────────────────────────────────
  let attempt = 0;
  let repairAttempts = 0;
  let connectionRetries = 0;
  let finalResults = null;
  let lastError = null;       // { message, category, step, html, url, stack }
  let appliedAnyPatch = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    log(`── attempt ${attempt} ──`);

    const workflowForRun = { steps: currentSteps, meta, customActions };
    const { events, promise } = runner.runChild(workflowForRun, { signal });
    onRunnerEvents(events);

    const result = await promise;

    if (result.success) {
      finalResults = result.results;
      log(`✅ attempt ${attempt} succeeded${appliedAnyPatch ? ' (after auto-repair)' : ''}`);
      break;
    }

    // Determine error info
    const errMsg = (result.errorInfo && result.errorInfo.message) || `exited with code ${result.exitCode}`;
    const failedStep = (result.errorInfo && result.errorInfo.step) || lastStep || null;
    const category = errorClassifier.classifyError(errMsg);
    lastError = {
      message: errMsg,
      category,
      step: failedStep,
      html: result.errorInfo ? result.errorInfo.html : null,
      url:  result.errorInfo ? result.errorInfo.url  : null,
      stack: result.errorInfo ? result.errorInfo.stack : null,
      cancelled: !!(result.errorInfo && result.errorInfo.cancelled),
      preExecution: !!(result.errorInfo && result.errorInfo.preExecution),
    };

    log(`✗ attempt ${attempt} failed (${category}): ${truncate(errMsg, 300)}`, 'error');

    if (lastError.cancelled || (signal && signal.aborted)) {
      log('🛑 cancelled — not retrying', 'error');
      break;
    }

    // ── Recovery strategy ─────────────────────────────────────────────────
    if (category === 'CONNECTION' && connectionRetries < MAX_CONNECTION_RETRIES) {
      connectionRetries++;
      const wait = CONNECTION_RETRY_DELAY_MS * connectionRetries;
      log(`↻ connection error — retrying in ${wait}ms (${connectionRetries}/${MAX_CONNECTION_RETRIES})`);
      await delay(wait);
      continue;
    }

    if (category === 'HTTP') {
      log('• HTTP error from target — no automatic repair possible. Surfacing to the user.', 'error');
      break;
    }

    if (category === 'LLM') {
      log('• LLM service unreachable — flagging for manual review.', 'error');
      break;
    }

    if (!errorClassifier.shouldAttemptRepair(category)) {
      log(`• error category "${category}" is not repairable — stopping.`, 'error');
      break;
    }

    if (repairAttempts >= MAX_REPAIR_ATTEMPTS) {
      log(`• reached repair budget (${MAX_REPAIR_ATTEMPTS} attempts) — flagging for manual review.`, 'error');
      break;
    }

    if (!failedStep || !failedStep.id) {
      // preExecution = the generated script crashed before any STEP_BEGIN
      // fired (typically a SyntaxError from a malformed expression in a
      // user-typed param). Tell the user exactly that so they don't go
      // looking for a step to fix.
      if (lastError && lastError.preExecution) {
        log('• the generated script failed to start (likely a malformed expression in a step parameter, e.g. an unescaped {{variable}} inside a JS expression field). The script output is above.', 'error');
      } else {
        log('• can\'t identify the failing step from the runtime output — flagging for manual review.', 'error');
      }
      break;
    }

    if (!llm.isConfigured()) {
      log('• LLM is not configured (set LLM_API_KEY) — cannot attempt repair.', 'error');
      lastError.category = 'LLM';
      break;
    }

    repairAttempts++;
    log(`🤖 attempting LLM repair (#${repairAttempts}) for step "${failedStep.label || failedStep.type}" (${failedStep.id})`);

    // Find the step in the (possibly already patched) workflow tree.
    const originalStep = findStep(currentSteps, failedStep.id);
    const originalParams = originalStep ? clone(originalStep.params || {}) : null;

    const proposal = await repair.proposePatch({
      step: { ...failedStep, params: originalParams || {} },
      errorMessage: errMsg,
      pageHtml: lastError.html,
      pageUrl: lastError.url,
    });

    if (!proposal.ok) {
      log(`• LLM repair failed: ${proposal.code} — ${truncate(proposal.error, 200)}`, 'error');
      runStore.recordRepair({
        runId, workflowId,
        stepId: failedStep.id, stepType: failedStep.type, attempt: repairAttempts,
        errorMessage: errMsg,
        originalParams,
        suggestedParams: null,
        explanation: null,
        confidence: null,
        applied: false,
        verified: false,
        llmError: `${proposal.code}: ${proposal.error || ''}`.slice(0, 500),
      });
      // If the LLM is unreachable, escalate to manual review and stop.
      if (proposal.code === 'NO_API_KEY' || /HTTP_4(0[19]|29)|HTTP_5\d\d/.test(proposal.code)) {
        lastError.category = 'LLM';
      }
      break;
    }

    log(`✎ proposed patch (confidence: ${proposal.confidence}): ${truncate(JSON.stringify(proposal.patch), 300)}`);
    if (proposal.explanation) log(`  rationale: ${truncate(proposal.explanation, 300)}`);

    runStore.recordRepair({
      runId, workflowId,
      stepId: failedStep.id, stepType: failedStep.type, attempt: repairAttempts,
      errorMessage: errMsg,
      originalParams,
      suggestedParams: proposal.patch,
      explanation: proposal.explanation,
      confidence: proposal.confidence,
      applied: true,
      verified: false,
    });

    const patched = patchStepParams(currentSteps, failedStep.id, proposal.patch);
    if (!patched.patched) {
      log(`• couldn't locate step ${failedStep.id} in workflow tree (was it removed?) — flagging for manual review.`, 'error');
      break;
    }
    currentSteps = patched.steps;
    appliedAnyPatch = true;

    log('• re-running with the patched workflow…');
    // Loop iterates to retry with the patched steps
  }

  // ── Finalise ────────────────────────────────────────────────────────────
  if (lastError && appliedAnyPatch) {
    // Mark verification: every prior repair whose step did NOT fail again
    // counts as verified.
    const repairs = runStore.listRepairsForRun(runId);
    const finalFailStepId = lastError && lastError.step && lastError.step.id;
    for (const r of repairs) {
      if (r.applied && r.step_id !== finalFailStepId && finalResults) {
        runStore.markRepairVerified(r.id, true);
      } else if (r.applied && r.step_id !== finalFailStepId && !finalResults) {
        // The fix held but the run eventually failed at a different step.
        runStore.markRepairVerified(r.id, true);
      }
    }
  }

  const duration = ms(t0);
  let status;
  let aiSummary = null;
  let finalErrorMessage = null;
  let errorCategory = null;
  let failedStepInfo = { id: null, type: null, label: null };

  if (finalResults || (lastError == null)) {
    status = 'success';
    if (appliedAnyPatch) {
      aiSummary = `Auto-repaired ${repairAttempts} step(s) via LLM; run completed successfully.`;
    }
  } else if (lastError.cancelled) {
    status = 'cancelled';
    finalErrorMessage = 'Run cancelled by user';
  } else if (lastError.category === 'CONNECTION') {
    status = 'error';
    errorCategory = 'CONNECTION';
    finalErrorMessage = lastError.message;
    aiSummary = errorClassifier.summarise('CONNECTION', lastError.message, lastError.step?.label);
    failedStepInfo = stepInfoFrom(lastError.step);
  } else if (lastError.category === 'HTTP') {
    status = 'error';
    errorCategory = 'HTTP';
    finalErrorMessage = lastError.message;
    aiSummary = errorClassifier.summarise('HTTP', lastError.message, lastError.step?.label);
    failedStepInfo = stepInfoFrom(lastError.step);
  } else if (lastError.category === 'LLM') {
    status = 'needs_review';
    errorCategory = 'LLM';
    finalErrorMessage = lastError.message;
    aiSummary = errorClassifier.summarise('LLM', lastError.message, lastError.step?.label);
    failedStepInfo = stepInfoFrom(lastError.step);
  } else {
    // SELECTOR / UNKNOWN that we couldn't repair
    status = 'needs_review';
    errorCategory = lastError.category || 'UNKNOWN';
    finalErrorMessage = lastError.message;
    aiSummary = appliedAnyPatch
      ? `Tried ${repairAttempts} AI repair pass(es) but the workflow still fails. Review the failing step manually.`
      : errorClassifier.summarise(errorCategory, lastError.message, lastError.step?.label);
    failedStepInfo = stepInfoFrom(lastError.step);
  }

  runStore.finishRun(runId, {
    status,
    finished_at: new Date().toISOString(),
    duration_ms: duration,
    results_json: finalResults ? JSON.stringify(finalResults) : null,
    error_message: finalErrorMessage,
    error_category: errorCategory,
    failed_step_id:    failedStepInfo.id,
    failed_step_type:  failedStepInfo.type,
    failed_step_label: failedStepInfo.label,
    ai_summary: aiSummary,
    retry_count: attempt - 1,
    patched_steps_json: appliedAnyPatch ? JSON.stringify(currentSteps) : null,
  });
  runStore.clearLogCounter(runId);

  const finalRow = runStore.getRun(runId);
  emit(callbacks, 'onDone', { run: finalRow });
  return finalRow;
}

/* ── helpers ───────────────────────────────────────────────────────────── */

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function truncate(s, n) {
  if (s == null) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function stepInfoFrom(step) {
  if (!step) return { id: null, type: null, label: null };
  return { id: step.id || null, type: step.type || null, label: step.label || null };
}

const CHILD_KEYS = ['body', 'then', 'else', 'try', 'catch'];
function findStep(steps, id) {
  for (const s of steps || []) {
    if (s && s.id === id) return s;
    for (const k of CHILD_KEYS) {
      if (Array.isArray(s?.[k])) {
        const f = findStep(s[k], id);
        if (f) return f;
      }
    }
  }
  return null;
}

module.exports = { executeAndPersist };
