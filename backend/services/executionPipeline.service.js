'use strict';

const db                = require('../db');
const runner            = require('./runner.service');
const runStore          = require('./runStore.service');
const errorClassifier   = require('./errorClassifier.service');
const repair            = require('./repair.service');
const healing           = require('./healing.service');
const healingStats      = require('./healingStats');
const { checkCompiles } = require('./codeCheck');
const llm               = require('./llm.service');
const { generateCode }  = require('../workflow/workflowCodegen');
const {
  patchStepParams, setStepParams, removeStepById, clone,
} = require('../workflow/workflowUtils');

/* ===========================================================================
   executionPipeline
   ---------------------------------------------------------------------------
   Single entry point used by every code path that executes a workflow:
   interactive runs, the scheduler, the API.

   Responsibilities:
     1. Persist a `runs` row and stream logs / step events via runStore.
     2. On a THROWN failure, classify and recover:
          CONNECTION  → retry with backoff
          HTTP        → surface to the user
          SELECTOR /
          UNKNOWN     → (interaction/wait steps) LLM selector patch, re-run
          LLM         → needs_review
     3. On a SUCCESSFUL run, inspect per-extraction record counts. A step that
        captured 0 records (or ≤1 when history shows more, or whose field is
        empty in every record) is treated as a SILENT FAILURE — exactly the
        bug where "everything passes but no data is recorded". Such steps are
        routed through the staged self-healing service, which proposes a fix,
        VERIFIES it deterministically against the captured page snapshot, and
        the pipeline then re-runs end-to-end to confirm records come back.
     4. Commit policy (per product decision): a verified fix is always applied
        to the run so data is captured; it is auto-written into the SAVED
        workflow only when confidence is high AND verification is strong —
        otherwise it is offered as a one-click proposal. Unfixable cases never
        guess: they escalate to needs_review with specifics.
   ========================================================================= */

const MAX_REPAIR_ATTEMPTS     = 3;     // total LLM repair passes per run
const MAX_HEAL_PASSES         = 4;     // empty-result healing passes per run
const MAX_CONNECTION_RETRIES  = 2;
const CONNECTION_RETRY_DELAY_MS = 4000;

const EXTRACTION_TYPES = new Set([
  'EXTRACT_TEXT', 'EXTRACT_ATTRIBUTE', 'EXTRACT_HTML', 'EXTRACT_TABLE', 'EXTRACT_LIST',
  'FOR_EACH_ELEMENTS',
]);

function nowMs() { return Date.now(); }
function ms(t0) { return Date.now() - t0; }

function emit(callbacks, event, payload) {
  if (!callbacks) return;
  const fn = callbacks[event];
  if (typeof fn === 'function') { try { fn(payload); } catch (_) {} }
}

async function executeAndPersist(arg) {
  const { userId, workflowId, scheduleId = null, trigger = 'manual', signal, callbacks } = arg;
  let currentSteps = clone(arg.workflow.steps || []);
  const meta = arg.workflow.meta || {};
  const customActions = arg.workflow.customActions || {};
  const subflows = arg.workflow.subflows || {};
  const rootWorkflowId = arg.workflow.id || arg.workflowId || null;

  const t0 = nowMs();
  const runId = runStore.createRun({ userId, workflowId, scheduleId, trigger });
  emit(callbacks, 'onStart', { runId });

  const log = (line, level = 'info') => {
    runStore.appendLog(runId, level, line);
    emit(callbacks, 'onLog', { line, level });
  };

  log(`▶ Run #${runId} started (trigger: ${trigger})`);

  // Prior successful results — baselines + "what a field used to contain".
  const priorResults = safeCall(() => runStore.recentSuccessfulResults(workflowId, 5), []);

  let lastStep = null;
  const onRunnerEvents = (events) => {
    events.on('log',       ({ line, level }) => log(line, level));
    events.on('stepBegin', (info) => { lastStep = info; emit(callbacks, 'onStepBegin', info); });
    events.on('stepError', (info) => { emit(callbacks, 'onStepError', info); });
    events.on('results',   (r)    => { emit(callbacks, 'onResults', r); });
    events.on('iteration', (info) => emit(callbacks, 'onIteration', info));
  };

  // ── Run + recovery loop ────────────────────────────────────────────────
  let attempt = 0;
  let repairAttempts = 0;          // LLM passes (legacy selector patch + healing)
  let healPasses = 0;
  let connectionRetries = 0;
  let finalResults = null;
  let lastError = null;
  let appliedAnyPatch = false;

  // Self-healing bookkeeping.
  const healLog = [];              // [{ stepId, confidence, kind, autoEligible }]
  const stepDisposition = new Map(); // stepId → 'manual' | 'healed' (avoid loops)
  let reviewMessage = null;        // set when we escalate an empty-result to manual

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    log(`── attempt ${attempt} ──`);

    const workflowForRun = { id: rootWorkflowId, steps: currentSteps, meta, customActions, subflows };
    const { events, promise } = runner.runChild(workflowForRun, { signal });
    onRunnerEvents(events);
    const result = await promise;

    if (result.success) {
      // ── Empty-result detection: a "successful" run that captured nothing ──
      const broken = detectBrokenSteps({
        stepResults: result.stepResults, snapshots: result.stepSnapshots,
        currentSteps, priorResults, stepDisposition,
      });

      if (broken.length === 0) {
        finalResults = result.results;
        log(`✅ attempt ${attempt} succeeded${appliedAnyPatch ? ' (after self-healing)' : ''}`);
        break;
      }

      // Keep the partial data we did capture, then try to heal a broken step
      // (one per pass; the loop revisits the rest). Prefer a not-yet-healed
      // step; if the only broken ones are steps we ALREADY healed, the fix
      // didn't hold end-to-end → escalate rather than loop.
      finalResults = result.results;
      const target = broken[0];
      log(`⚠ "${target.step.label || target.step.type}" captured no usable data — ${healingStats.describeBreakage(target.verdict, target.stat)}`, 'error');

      if (signal && signal.aborted) break;

      if (target.wasHealed) {
        reviewMessage = `The fix for "${target.step.label || target.step.type}" was verified against the page snapshot but did not hold on a full re-run. Manual review needed — the page may behave differently than its captured snapshot.`;
        stepDisposition.set(target.step.id, 'manual');
        lastError = emptyResultError(target, reviewMessage);
        log(`• ${reviewMessage}`, 'error');
        break;
      }
      if (!llm.isConfigured()) {
        reviewMessage = `A step captured no data and AI repair is unavailable (set LLM_API_KEY). ${healingStats.describeBreakage(target.verdict, target.stat)}`;
        stepDisposition.set(target.step.id, 'manual');
        lastError = emptyResultError(target);
        break;
      }
      if (healPasses >= MAX_HEAL_PASSES) {
        reviewMessage = `Reached the self-healing budget (${MAX_HEAL_PASSES} passes) while trying to recover empty results. ${healingStats.describeBreakage(target.verdict, target.stat)}`;
        stepDisposition.set(target.step.id, 'manual');
        lastError = emptyResultError(target);
        break;
      }

      healPasses++; repairAttempts++;
      const healed = await healAndApply({
        target, currentSteps, priorResults,
        meta, customActions, subflows, rootWorkflowId,
        runId, workflowId, attempt: repairAttempts, log,
      });

      if (healed.outcome === 'manual') {
        stepDisposition.set(target.step.id, 'manual');
        reviewMessage = healed.explanation;
        lastError = emptyResultError(target, healed.explanation);
        break;
      }

      // patch / remove-step were applied to a fresh steps copy.
      currentSteps = healed.steps;
      appliedAnyPatch = true;
      stepDisposition.set(target.step.id, 'healed');
      healLog.push({ stepId: target.step.id, confidence: healed.confidence, kind: healed.kind,
                     autoEligible: healed.autoEligible, repairId: healed.repairId });
      log(`• re-running to confirm the fix for "${target.step.label || target.step.type}"…`);
      continue; // re-run to verify end-to-end
    }

    // ── Thrown failure ─────────────────────────────────────────────────────
    const errMsg = (result.errorInfo && result.errorInfo.message) || `exited with code ${result.exitCode}`;
    const failedStep = (result.errorInfo && result.errorInfo.step) || lastStep || null;
    const category = errorClassifier.classifyError(errMsg);
    lastError = {
      message: errMsg, category, step: failedStep,
      html: result.errorInfo ? result.errorInfo.html : null,
      url:  result.errorInfo ? result.errorInfo.url  : null,
      stack: result.errorInfo ? result.errorInfo.stack : null,
      cancelled: !!(result.errorInfo && result.errorInfo.cancelled),
      preExecution: !!(result.errorInfo && result.errorInfo.preExecution),
    };

    log(`✗ attempt ${attempt} failed (${category}): ${truncate(errMsg, 300)}`, 'error');

    if (lastError.cancelled || (signal && signal.aborted)) { log('🛑 cancelled — not retrying', 'error'); break; }

    if (category === 'CONNECTION' && connectionRetries < MAX_CONNECTION_RETRIES) {
      connectionRetries++;
      const wait = CONNECTION_RETRY_DELAY_MS * connectionRetries;
      log(`↻ connection error — retrying in ${wait}ms (${connectionRetries}/${MAX_CONNECTION_RETRIES})`);
      await delay(wait);
      continue;
    }
    if (category === 'HTTP') { log('• HTTP error from target — no automatic repair possible.', 'error'); break; }
    if (category === 'LLM')  { log('• LLM service unreachable — flagging for manual review.', 'error'); break; }
    if (!errorClassifier.shouldAttemptRepair(category)) { log(`• error category "${category}" is not repairable — stopping.`, 'error'); break; }
    if (repairAttempts >= MAX_REPAIR_ATTEMPTS) { log(`• reached repair budget (${MAX_REPAIR_ATTEMPTS}) — flagging for manual review.`, 'error'); break; }

    if (!failedStep || !failedStep.id) {
      if (lastError.preExecution) {
        log('• the generated script failed to start (likely a malformed expression in a step parameter). The script output is above.', 'error');
      } else {
        log('• can\'t identify the failing step from the runtime output — flagging for manual review.', 'error');
      }
      break;
    }
    if (!llm.isConfigured()) { log('• LLM is not configured (set LLM_API_KEY) — cannot attempt repair.', 'error'); lastError.category = 'LLM'; break; }

    // An extraction step that THREW with a snapshot can use the richer staged
    // healer; everything else (clicks, waits) uses the legacy selector patch.
    const stepSnapshot = (result.stepSnapshots && result.stepSnapshots[failedStep.id]) || null;
    const snapshotHtml = (stepSnapshot && stepSnapshot.html) || lastError.html || null;

    if (EXTRACTION_TYPES.has(failedStep.type) && snapshotHtml) {
      repairAttempts++;
      const originalStep = findStep(currentSteps, failedStep.id) || { ...failedStep };
      const verdict = { brokenFields: [], reason: 'threw', count: 0 };
      const healed = await healAndApply({
        target: { step: originalStep, stat: { count: 0, fields: {} }, verdict, snapshot: { html: snapshotHtml, url: lastError.url } },
        currentSteps, priorResults, meta, customActions, subflows, rootWorkflowId,
        runId, workflowId, attempt: repairAttempts, log, errorMessage: errMsg,
      });
      if (healed.outcome === 'manual') { stepDisposition.set(failedStep.id, 'manual'); reviewMessage = healed.explanation; break; }
      currentSteps = healed.steps; appliedAnyPatch = true;
      stepDisposition.set(failedStep.id, 'healed');
      healLog.push({ stepId: failedStep.id, confidence: healed.confidence, kind: healed.kind, autoEligible: healed.autoEligible, repairId: healed.repairId });
      log('• re-running with the healed workflow…');
      continue;
    }

    // ── Legacy single-selector patch (interaction / wait steps) ────────────
    repairAttempts++;
    log(`🤖 attempting LLM repair (#${repairAttempts}) for step "${failedStep.label || failedStep.type}" (${failedStep.id})`);
    const originalStep = findStep(currentSteps, failedStep.id);
    const originalParams = originalStep ? clone(originalStep.params || {}) : null;
    const proposal = await repair.proposePatch({
      step: { ...failedStep, params: originalParams || {} },
      errorMessage: errMsg, pageHtml: snapshotHtml, pageUrl: lastError.url,
    });

    if (!proposal.ok) {
      log(`• LLM repair failed: ${proposal.code} — ${truncate(proposal.error, 200)}`, 'error');
      runStore.recordRepair({
        runId, workflowId, stepId: failedStep.id, stepType: failedStep.type, attempt: repairAttempts,
        errorMessage: errMsg, originalParams, suggestedParams: null, explanation: null, confidence: null,
        applied: false, verified: false, llmError: `${proposal.code}: ${proposal.error || ''}`.slice(0, 500),
        repairKind: 'selector',
      });
      if (proposal.code === 'NO_API_KEY' || /HTTP_4(0[19]|29)|HTTP_5\d\d/.test(proposal.code)) lastError.category = 'LLM';
      break;
    }

    log(`✎ proposed patch (confidence: ${proposal.confidence}): ${truncate(JSON.stringify(proposal.patch), 300)}`);
    if (proposal.explanation) log(`  rationale: ${truncate(proposal.explanation, 300)}`);
    runStore.recordRepair({
      runId, workflowId, stepId: failedStep.id, stepType: failedStep.type, attempt: repairAttempts,
      errorMessage: errMsg, originalParams, suggestedParams: proposal.patch,
      explanation: proposal.explanation, confidence: proposal.confidence,
      applied: true, verified: false, repairKind: 'selector',
    });
    const patched = patchStepParams(currentSteps, failedStep.id, proposal.patch);
    if (!patched.patched) { log(`• couldn't locate step ${failedStep.id} — flagging for manual review.`, 'error'); break; }
    currentSteps = patched.steps;
    appliedAnyPatch = true;
    healLog.push({ stepId: failedStep.id, confidence: proposal.confidence, kind: 'selector', autoEligible: false });
    log('• re-running with the patched workflow…');
  }

  // ── Finalise ────────────────────────────────────────────────────────────
  // Mark every applied heal/repair verified when the final run produced data
  // and that step didn't end up flagged for manual review.
  if (appliedAnyPatch) {
    const repairs = runStore.listRepairsForRun(runId);
    for (const r of repairs) {
      if (!r.applied) continue;
      if (stepDisposition.get(r.step_id) === 'manual') continue;
      if (finalResults) runStore.markRepairVerified(r.id, true);
    }
  }

  // Auto-adopt policy: write the healed steps into the SAVED workflow only
  // when the run ultimately produced data, nothing is pending manual review,
  // and EVERY applied heal was high-confidence + auto-eligible (verified).
  const anyManual = Array.from(stepDisposition.values()).includes('manual');
  const healedOk = appliedAnyPatch && !!finalResults && !anyManual;
  const autoAdopt = healedOk && healLog.length > 0 && healLog.every(h => h.autoEligible && h.confidence === 'high');

  if (healedOk && autoAdopt) {
    const changed = safeCall(() => runStore.updateWorkflowSteps(workflowId, userId, currentSteps), 0);
    if (changed) {
      log('🔒 high-confidence fix verified — applied to the saved workflow automatically.');
      for (const h of healLog) { if (h.repairId) safeCall(() => markAutoAdopted(h.repairId)); }
    }
  } else if (healedOk) {
    log('💡 fix verified for this run — review it in run history and click "Adopt AI-repaired workflow" to keep it.');
  }

  const duration = ms(t0);
  let status, aiSummary = null, finalErrorMessage = null, errorCategory = null;
  let failedStepInfo = { id: null, type: null, label: null };

  if (anyManual || (lastError && lastError.category === 'EMPTY_RESULT')) {
    // A broken step we couldn't safely heal — needs human attention even
    // though other steps may have produced data (which we still keep).
    status = 'needs_review';
    errorCategory = 'EMPTY_RESULT';
    finalErrorMessage = (lastError && lastError.message) || 'A step captured no data';
    aiSummary = reviewMessage || errorClassifier.summarise('EMPTY_RESULT', finalErrorMessage, lastError && lastError.step && lastError.step.label);
    failedStepInfo = stepInfoFrom(lastError && lastError.step);
  } else if (finalResults || lastError == null) {
    status = 'success';
    if (appliedAnyPatch) {
      aiSummary = autoAdopt
        ? `Self-healed ${healLog.length} step(s) and adopted the fix into the saved workflow; run completed successfully.`
        : `Self-healed ${healLog.length} step(s) for this run; review and adopt the fix to make it permanent.`;
    }
  } else if (lastError.cancelled) {
    status = 'cancelled'; finalErrorMessage = 'Run cancelled by user';
  } else if (lastError.category === 'CONNECTION') {
    status = 'error'; errorCategory = 'CONNECTION'; finalErrorMessage = lastError.message;
    aiSummary = errorClassifier.summarise('CONNECTION', lastError.message, lastError.step?.label);
    failedStepInfo = stepInfoFrom(lastError.step);
  } else if (lastError.category === 'HTTP') {
    status = 'error'; errorCategory = 'HTTP'; finalErrorMessage = lastError.message;
    aiSummary = errorClassifier.summarise('HTTP', lastError.message, lastError.step?.label);
    failedStepInfo = stepInfoFrom(lastError.step);
  } else if (lastError.category === 'LLM') {
    status = 'needs_review'; errorCategory = 'LLM'; finalErrorMessage = lastError.message;
    aiSummary = errorClassifier.summarise('LLM', lastError.message, lastError.step?.label);
    failedStepInfo = stepInfoFrom(lastError.step);
  } else {
    status = 'needs_review'; errorCategory = lastError.category || 'UNKNOWN'; finalErrorMessage = lastError.message;
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
    // Persist the healed steps whenever we applied a fix that wasn't already
    // auto-written into the saved workflow, so the user can adopt it later.
    patched_steps_json: (appliedAnyPatch && !autoAdopt) ? JSON.stringify(currentSteps) : null,
  });
  runStore.clearLogCounter(runId);

  const finalRow = runStore.getRun(runId);
  emit(callbacks, 'onDone', { run: finalRow });
  return finalRow;
}

/* ── self-healing helpers ─────────────────────────────────────────────────── */

// Inspect the run's per-extraction stats and return the broken steps, each
// with its runtime stat, verdict, page snapshot, and whether we already tried
// to heal it this run (wasHealed). Side-effect-free: the caller decides what
// to do. Not-yet-healed steps are returned first so they get repaired before
// we conclude that an already-applied fix failed to hold.
function detectBrokenSteps({ stepResults, snapshots, currentSteps, priorResults, stepDisposition }) {
  const byStep = aggregateStats(stepResults || []);
  const broken = [];
  for (const stat of byStep.values()) {
    if (stepDisposition.get(stat.stepId) === 'manual') continue; // already escalated
    const step = findStep(currentSteps, stat.stepId);
    if (!step) continue; // e.g. a step that lives inside a subflow definition
    const baseline = baselineFor(priorResults, stat.key);
    const verdict = healingStats.classifyStep(stat, baseline);
    if (!verdict.broken) continue;
    const snap = (snapshots && snapshots[stat.stepId]) || null;
    broken.push({ step, stat, verdict, snapshot: snap, wasHealed: stepDisposition.get(stat.stepId) === 'healed' });
  }
  // Repair fresh breakages before concluding a prior fix didn't hold.
  broken.sort((a, b) => (a.wasHealed ? 1 : 0) - (b.wasHealed ? 1 : 0));
  return broken;
}

// Propose + verify a fix for one broken step, record the repair, and (when a
// patch/remove is produced) apply it to a fresh steps copy. Returns
// { outcome:'patch'|'remove-step'|'manual', steps?, confidence, kind, autoEligible, repairId, explanation }.
async function healAndApply(ctx) {
  const { target, currentSteps, priorResults, meta, customActions, subflows, rootWorkflowId,
          runId, workflowId, attempt, log, errorMessage } = ctx;
  const { step, stat, verdict } = target;
  const snapshot = target.snapshot || {};

  const historySamples = buildHistorySamples(step, priorResults, stat);

  log(`🩺 self-healing "${step.label || step.type}" (${step.id}) — analysing the page…`);
  const outcome = await healing.healStep({
    step, verdict, snapshotHtml: snapshot.html, pageUrl: snapshot.url, historySamples, log,
  });

  const baseRepair = {
    runId, workflowId, stepId: step.id, stepType: step.type, attempt,
    errorMessage: errorMessage || healingStats.describeBreakage(verdict, stat),
    originalParams: clone(step.params || {}),
  };

  if (outcome.outcome === 'manual') {
    log(`• cannot safely heal "${step.label || step.type}": ${outcome.explanation}`, 'error');
    runStore.recordRepair({ ...baseRepair, suggestedParams: null, explanation: outcome.explanation,
      confidence: 'low', applied: false, verified: false, repairKind: 'manual',
      llmError: outcome.code || null, evidence: outcome.evidence });
    return { outcome: 'manual', explanation: outcome.explanation };
  }

  // Build the patched step tree (without mutating currentSteps).
  let next;
  if (outcome.outcome === 'remove-step') {
    next = removeStepById(currentSteps, step.id);
    log(`• "${step.label || step.type}" target disappeared — removing the step. ${outcome.explanation}`);
    runStore.recordRepair({ ...baseRepair, suggestedParams: { removed: true }, explanation: outcome.explanation,
      confidence: 'high', applied: true, verified: false, repairKind: 'remove-step', evidence: outcome.evidence });
    const repairId = lastRepairId(runId);
    if (!compilesOk({ steps: next.steps, meta, customActions, subflows, rootWorkflowId }, log)) {
      return { outcome: 'manual', explanation: 'Removing the step produced invalid generated code — escalating.' };
    }
    // Removing a whole step is more destructive than re-pointing a selector,
    // so it is never auto-written into the saved workflow — always proposed
    // for the user to confirm, even though we apply it for this run.
    return { outcome: 'remove-step', steps: next.steps, confidence: 'high', kind: 'remove-step', autoEligible: false, repairId };
  }

  // outcome === 'patch'
  const applied = applyPatch(currentSteps, step, outcome);
  if (!applied.ok) {
    runStore.recordRepair({ ...baseRepair, suggestedParams: outcome.newParams, explanation: 'Could not apply the proposed patch to the workflow tree.',
      confidence: 'low', applied: false, verified: false, repairKind: 'selector', evidence: outcome.evidence });
    return { outcome: 'manual', explanation: 'The proposed fix could not be applied to the workflow.' };
  }

  if (!compilesOk({ steps: applied.steps, meta, customActions, subflows, rootWorkflowId }, log)) {
    runStore.recordRepair({ ...baseRepair, suggestedParams: outcome.newParams, explanation: 'The patched workflow failed to compile — refusing to run an invalid fix.',
      confidence: 'low', applied: false, verified: false, repairKind: 'selector', evidence: outcome.evidence });
    return { outcome: 'manual', explanation: 'The proposed fix produced invalid generated code — manual review needed.' };
  }

  log(`✎ verified fix for "${step.label || step.type}" (confidence ${outcome.confidence}): ${truncate(outcome.explanation, 240)}`);
  runStore.recordRepair({
    ...baseRepair,
    suggestedParams: outcome.newParams,
    explanation: outcome.explanation,
    confidence: outcome.confidence,
    applied: true, verified: false,
    repairKind: outcome.droppedFields && outcome.droppedFields.length ? 'field-drop' : 'selector',
    evidence: outcome.evidence,
  });
  const repairId = lastRepairId(runId);
  return {
    outcome: 'patch', steps: applied.steps,
    confidence: outcome.confidence, kind: 'selector',
    autoEligible: outcome.confidence === 'high',
    repairId,
  };
}

// Apply a healing outcome's newParams to the right place in the tree. For
// EXTRACT_LIST / single extractions we set the step params; for the
// FOR_EACH_ELEMENTS directive we patch the loop selector + child field steps.
function applyPatch(steps, step, outcome) {
  const np = outcome.newParams || {};
  if (np.__forEach) {
    let working = clone(steps);
    // Loop container selector (merge so other loop params are preserved).
    working = patchStepParams(working, step.id, { selector: np.selector }).steps;
    // Per-field child step selectors.
    for (const [childId, patch] of Object.entries(np.__childPatches || {})) {
      working = patchStepParams(working, childId, patch).steps;
    }
    // Dropped (disappeared) child fields.
    for (const childId of np.__dropChildIds || []) {
      working = removeStepById(working, childId).steps;
    }
    return { ok: true, steps: working };
  }
  // EXTRACT_LIST → full params replace (fields may have been dropped); single
  // → also a full replace is fine since newParams carries selector/fallbacks.
  const res = step.type === 'EXTRACT_LIST'
    ? setStepParams(steps, step.id, np)
    : patchStepParams(steps, step.id, np);
  return { ok: !!res.patched, steps: res.steps };
}

// Median record count for an output key across recent successful runs.
function baselineFor(priorResults, key) {
  if (!key) return null;
  const lens = [];
  for (const res of priorResults || []) {
    if (res && Array.isArray(res[key])) lens.push(res[key].length);
  }
  if (!lens.length) return null;
  lens.sort((a, b) => a - b);
  return lens[Math.floor(lens.length / 2)];
}

// What the broken step used to extract — fed to the LLM as context. For a list
// step we return { fieldName: [values] }; for a single step we return [values].
function buildHistorySamples(step, priorResults, stat) {
  const key = stat && stat.key;
  if (!key) return null;
  const isCollection = healingStats.isCollectionType(step.type);
  if (isCollection) {
    const out = {};
    for (const res of priorResults || []) {
      const arr = res && res[key];
      if (!Array.isArray(arr)) continue;
      for (const row of arr) {
        if (!row || typeof row !== 'object') continue;
        for (const [k, v] of Object.entries(row)) {
          if (k === '_index') continue;
          if (v == null || String(v).trim() === '') continue;
          (out[k] = out[k] || []);
          if (out[k].length < 4 && !out[k].includes(v)) out[k].push(v);
        }
      }
    }
    return out;
  }
  const vals = [];
  for (const res of priorResults || []) {
    const v = res && res[key];
    if (v != null && String(v).trim() !== '' && vals.length < 4) vals.push(v);
  }
  return vals;
}

// Merge multiple STEP_RESULT emissions for the same step (e.g. an extraction
// inside a WHILE/REPEAT loop fires once per iteration). Keep the MAX count (a
// step that ever produced records isn't "no records") and sum field tallies.
function aggregateStats(list) {
  const map = new Map();
  for (const s of list) {
    if (!s || !s.stepId) continue;
    const prev = map.get(s.stepId);
    if (!prev) { map.set(s.stepId, { ...s, fields: cloneFields(s.fields) }); continue; }
    prev.count = Math.max(prev.count || 0, s.count || 0);
    for (const [name, fs] of Object.entries(s.fields || {})) {
      const p = prev.fields[name] || (prev.fields[name] = { nonEmpty: 0, total: 0 });
      p.nonEmpty += fs.nonEmpty || 0;
      p.total += fs.total || 0;
    }
  }
  return map;
}
function cloneFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = { nonEmpty: v.nonEmpty || 0, total: v.total || 0 };
  return out;
}

function compilesOk(workflow, log) {
  try {
    const code = generateCode(workflow);
    const r = checkCompiles(code);
    if (!r.ok && log) log(`• generated code did not compile after healing: ${truncate(r.error, 160)}`, 'error');
    return r.ok;
  } catch (err) {
    if (log) log(`• codegen threw after healing: ${truncate(err.message, 160)}`, 'error');
    return false;
  }
}

function emptyResultError(target, explanation) {
  return {
    message: explanation || healingStats.describeBreakage(target.verdict, target.stat),
    category: 'EMPTY_RESULT',
    step: { id: target.step.id, type: target.step.type, label: target.step.label },
    html: null, url: target.snapshot ? target.snapshot.url : null,
  };
}

function markAutoAdopted(repairId) {
  db.prepare('UPDATE run_repairs SET auto_adopted = 1, verified = 1 WHERE id = ?').run(repairId);
}
function lastRepairId(runId) {
  const row = db.prepare('SELECT id FROM run_repairs WHERE run_id = ? ORDER BY id DESC LIMIT 1').get(runId);
  return row ? row.id : null;
}

/* ── misc helpers ─────────────────────────────────────────────────────────── */

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

function safeCall(fn, fallback) { try { return fn(); } catch (_) { return fallback; } }

const CHILD_KEYS = ['body', 'then', 'else', 'try', 'catch'];
function findStep(steps, id) {
  for (const s of steps || []) {
    if (s && s.id === id) return s;
    for (const k of CHILD_KEYS) {
      if (Array.isArray(s?.[k])) { const f = findStep(s[k], id); if (f) return f; }
    }
  }
  return null;
}

module.exports = { executeAndPersist };
