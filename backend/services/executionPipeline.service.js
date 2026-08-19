'use strict';

const runner            = require('./runner.service');
const { resolveWorkflowProxy } = require('./proxyResolver.service');
const runStore          = require('./runStore.service');
const errorClassifier   = require('./errorClassifier.service');
const repair            = require('./repair.service');
const healing           = require('./healing.service');
const healingStats      = require('./healingStats');
const { checkCompiles } = require('./codeCheck');
const llm               = require('./llm.service');
const { generateCode, resolveExecution, resolvePerf } = require('../workflow/workflowCodegen');
const webhookDispatcher = require('./webhookDispatcher.service');
const emailNotifier     = require('./emailNotifier.service');
const changeMonitor     = require('./changeMonitor.service');
const runEvents         = require('./runEvents.service');
const debugSessions     = require('./debugSession.service');
const entitlements      = require('./entitlements.service');
const usageRepo         = require('../db/repositories/usage.repo');
const { buildFlowTree } = require('../workflow/workflowUtils');
const sheetsDelivery    = require('./sheetsDelivery.service');
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
const CONNECTION_RETRY_DELAY_MS = 4000;
// How often the accumulated partial results are written to the DB while a run
// is in flight. The child already throttles its own emission; this bounds the
// write rate independently so a fast run can't hammer the database.
const PARTIAL_FLUSH_MS        = 3000;
// How often a live run proves it is still alive. Must be comfortably shorter
// than runReaper's stale threshold, so a busy event loop can't look dead.
const HEARTBEAT_MS            = 10000;

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
  // Resume payload (services/resume.service.js) — the per-step sets of items an
  // earlier run already captured, plus the rows to restore. Null for a normal run.
  const resume = arg.resume || null;
  let finalProgress = null;
  let currentSteps = clone(arg.workflow.steps || []);
  const meta = arg.workflow.meta || {};
  const customActions = arg.workflow.customActions || {};
  const subflows = arg.workflow.subflows || {};
  const rootWorkflowId = arg.workflow.id || arg.workflowId || null;

  // Resolved once per run (not per retry-attempt — a rotated-pool proxy
  // shouldn't change mid-run just because a step failed and got retried).
  // Ownership/sharing is enforced inside the resolver, so meta.proxy can't
  // be used to reach someone else's private proxy or pool. Silently
  // proceeds without a proxy on any resolution failure (deleted proxy,
  // empty pool, ...) rather than failing the whole run over it — see
  // services/proxyResolver.service.js.
  const proxy = await safeCall(() => resolveWorkflowProxy(meta, userId), null);

  // Per-workflow reliability settings. Same resolver the code generator
  // uses, so the run and the script it runs can't disagree about them.
  const execCfg = resolveExecution(meta);

  /* A debug run is a real run — metered, persisted, in the history like any
     other — that a human is standing over, stepping through and watching a
     live picture of (services/debugSession.service.js). Two things it must NOT
     do, both for the same reason: anything that silently starts the workflow
     over would strand the person watching.

       • a retry respawns a FRESH child, and with it a fresh browser. The page
         the user was looking at, their breakpoints' context, the pause they
         were parked at — all gone, replaced by a run that is already several
         steps ahead. Failing visibly is the whole point here.
       • self-healing rewrites the very selector the user is trying to
         understand, so the run they end up watching is no longer the one they
         asked about.

     Outbound side effects are suppressed further down for a third reason:
     a half-stepped run is not a result anyone subscribed to. */
  const isDebugRun = !!arg.debug;
  const maxConnectionRetries = isDebugRun ? 0 : execCfg.connectionRetries;
  // Healing off = a DETERMINISTIC run: it fails rather than quietly
  // rewriting a selector. Wanted when the output feeds something
  // downstream, where a silent change is worse than a visible gap.
  const healingEnabled = execCfg.healing && !isDebugRun;

  const t0 = nowMs();
  // Billable pages loaded by every attempt of this run. Tallied here rather
  // than per-attempt because healing re-runs are part of the same run.
  let pagesFetched = 0;

  /* ── Quota gate ──────────────────────────────────────────────────────────
     Every way to execute a workflow — the dashboard, the scheduler, a resume,
     a shard, the public API — funnels through executeAndPersist, so this is
     the one place a run can be refused. Previously quota lived only in
     routes/v1/workflows.routes.js, which meant the entire dashboard ran
     unmetered: a free account could run any workflow, any number of times,
     simply by not using the API.

     Deliberately BEFORE createRun: a refused run must not leave a runs row,
     or the history fills with rows that never executed.

     The API path is exempt here because it already checked and metered at
     enqueue time (it has to — it returns 202 before this code runs, and a
     202 followed by a silent quota failure is worse than a synchronous 402).
     Counting again here would bill an API run twice.

     The GUIDED TOUR is exempt too, and for a different reason: its run is a
     demonstration on our own practice shop, not work the user asked for.
     Charging a plan's monthly run allowance to teach someone the product —
     and doing it before they have built anything of their own — would be
     indefensible, and a free account whose allowance was already spent could
     not take the tour at all. Demo runs are therefore neither gated nor
     metered here or in the page counter below.
     -------------------------------------------------------------------- */
  const isAdoptedApiRun = !!arg.runId;
  const isDemoRun = !!arg.demo;
  if (!isAdoptedApiRun && !isDemoRun) {
    try {
      await entitlements.assertCanRun(userId);
    } catch (err) {
      if (err instanceof entitlements.EntitlementError) {
        emit(callbacks, 'onQuotaExceeded', { code: err.code, message: err.message, ...err.meta });
      }
      throw err;
    }
    // Metered on admission, not on success. A run that starts and fails still
    // consumed a browser and a slot; not counting it would let a free account
    // burn unlimited infrastructure on workflows that happen to error.
    await safeCall(() => usageRepo.incrementRuns(userId), null);
  }

  // Record the workflow version this run executes (deduped by content) so run
  // history doubles as a restorable version timeline.
  const executedVersionId = await safeCall(
    () => runStore.ensureVersion(workflowId, userId, arg.workflow.steps || [], meta, 'run'),
    null,
  );
  // API-triggered runs already have a row (created as status='queued' so the
  // trigger endpoint could return its id immediately) — adopt it instead of
  // creating a second one. Everything downstream is identical.
  let runId;
  if (arg.runId) {
    runId = arg.runId;
    await runStore.startQueuedRun(runId, executedVersionId);
  } else {
    runId = await runStore.createRun({
      userId, workflowId, scheduleId, trigger, versionId: executedVersionId,
      // A resumed run links back to the one it continues, so the pair stays
      // traceable instead of looking like two unrelated runs of the same job.
      parentRunId: arg.parentRunId || null,
    });
  }
  /* One controller for every way this run can be stopped: the caller's signal
     (the launching socket), a cancel issued from another tab or instance
     (picked up by the heartbeat), or the reaper. Registering it centrally here
     rather than in WorkflowExecutor means a scheduled or API run is just as
     cancellable as an interactive one — previously only the interactive path
     wired up a canceller at all. */
  const cancelController = new AbortController();
  const cancelSignal = cancelController.signal;
  if (signal) {
    if (signal.aborted) cancelController.abort();
    else signal.addEventListener('abort', () => cancelController.abort(), { once: true });
  }
  runEvents.registerCanceller(runId, () => cancelController.abort());

  /* The debug session opens BEFORE onStart, for the same reason onStart comes
     before begin(): onStart is where the launching tab is handed the run id,
     and the debug window it opens with that id starts connecting immediately.
     The child does not exist yet — its control channel is attached a moment
     later — but the session must, or a fast window is told there is no debug
     run to watch. Nothing can have reached a gate in the meantime. */
  if (isDebugRun) {
    const configured = resolvePerf(meta);
    safeCall(() => debugSessions.open(runId, {
      userId,
      // What this run is deliberately NOT doing, so the window can show it
      // instead of leaving the user to infer it from a log line they scrolled
      // past. `concurrency` is the one that matters: a workflow tuned to 8
      // workers behaves differently at 1, and a clean debug session must not
      // be read as proof that the parallel run is fine.
      forced: {
        concurrency: configured.concurrency,
        blockResources: configured.blockResources,
        httpFirst: configured.httpFirst,
        healing: execCfg.healing,
      },
    }), null);
  }

  // onStart FIRST: it is how the launching socket joins this run's room, and
  // it has to be in the room before begin() publishes anything or that tab
  // misses the opening events of its own run.
  emit(callbacks, 'onStart', { runId });

  // Publish this run so ANY tab can watch it — not just the socket that
  // started it, and including runs with no socket at all (scheduler, API,
  // resume, shards). The flow tree is built once here so a watcher never has
  // to reconstruct it and every run has one.
  safeCall(() => runEvents.begin(runId, {
    userId,
    workflowId,
    workflowName: arg.workflowName || null,
    trigger,
    flowTree: buildFlowTree(currentSteps, subflows, rootWorkflowId, { withSelectors: isDebugRun }),
  }), null);

  const log = (line, level = 'info') => {
    runStore.appendLog(runId, level, line);
    emit(callbacks, 'onLog', { line, level });
    runEvents.log(runId, { line, level });
  };

  /* ── Liveness ────────────────────────────────────────────────────────────
     A 'running' row means nothing on its own: if this process dies, the row
     stays running forever and the run becomes un-cancellable. The heartbeat is
     what makes the claim checkable — while it keeps arriving the run is alive;
     once it stops, runReaper finalises the row.

     The same beat carries cancels the other way. A stop issued against a run
     this process doesn't own (another tab, another instance) is recorded on
     the row and picked up here, so Cancel works from anywhere rather than only
     where the run was launched. */
  let heartbeat = null;
  const stopHeartbeat = () => { if (heartbeat) { clearInterval(heartbeat); heartbeat = null; } };
  const beat = async () => {
    try {
      const cancelRequested = await runStore.touchRun(runId);
      if (cancelRequested && !cancelSignal.aborted) {
        log('🛑 Cancel requested — stopping.', 'error');
        cancelController.abort();
      }
    } catch (_) { /* a missed beat is recoverable; the reaper is the backstop */ }
  };
  heartbeat = setInterval(beat, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();
  beat();

  log(`▶ Run #${runId} started (trigger: ${trigger})`);
  if (isDebugRun) {
    // Say plainly what is different about this run. A debug session that
    // behaves unlike a normal one without saying so would teach the user the
    // wrong thing about their own workflow — which is the one failure mode a
    // debugger cannot afford.
    log('🐞 Debug mode: images and stylesheets are loaded, steps run one at a time, the HTTP fast path is off, and nothing is retried or self-healed. Notifications, webhooks and Sheets delivery are skipped.');
  }

  // Prior successful results — baselines + "what a field used to contain".
  const priorResults = await safeCall(() => runStore.recentSuccessfulResults(workflowId, 5), []);

  // ── Partial-results checkpointing ──────────────────────────────────────
  // Deliberately fire-and-forget: a checkpoint is an optimisation, and a
  // failed one (locked DB, transient error) must never take down a healthy
  // run. `inFlight` keeps a slow write from stacking up behind itself.
  let lastPartialFlush = 0;
  let partialWrite = null;    // in-flight checkpoint write, or null
  let finishingRun = false;   // set before finishRun — stops new checkpoints
  let latestPartial = null;   // { results, rows, progress } — newest seen
  const flushPartial = () => {
    if (finishingRun || partialWrite || !latestPartial) return;
    const now = nowMs();
    if (now - lastPartialFlush < PARTIAL_FLUSH_MS) return;
    lastPartialFlush = now;
    const { results, rows, progress } = latestPartial;
    let encoded, encodedProgress = null;
    try {
      encoded = JSON.stringify(results);
      // Progress rides the same write: a run that dies must leave BOTH the
      // rows it captured and the ledger of which items produced them, or it
      // can be viewed but not resumed.
      if (progress) encodedProgress = JSON.stringify(progress);
    } catch (_) { return; }
    partialWrite = Promise.resolve(runStore.savePartialResults(runId, encoded, rows, encodedProgress))
      .catch(() => {})
      .then(() => { partialWrite = null; });
  };
  // Close the checkpoint window before the run is finalised. Without this an
  // already-dispatched write can land AFTER finishRun clears
  // partial_results_json and resurrect a stale checkpoint on a finished run.
  const stopCheckpointing = async () => {
    finishingRun = true;
    if (partialWrite) { try { await partialWrite; } catch (_) {} }
  };

  let lastStep = null;
  const onRunnerEvents = (events) => {
    events.on('log',       ({ line, level }) => log(line, level));
    events.on('stepBegin', (info) => { lastStep = info; emit(callbacks, 'onStepBegin', info); runEvents.stepBegin(runId, info); });
    events.on('stepError', (info) => { emit(callbacks, 'onStepError', info); runEvents.stepError(runId, info); });
    events.on('results',   (r)    => { emit(callbacks, 'onResults', r); runEvents.results(runId, r); });
    events.on('iteration', (info) => { emit(callbacks, 'onIteration', info); runEvents.iteration(runId, info); });
    events.on('workers',   (info) => { emit(callbacks, 'onWorkers', info); runEvents.workers(runId, info); });
    events.on('partial',   (p)    => {
      latestPartial = { results: p.results, rows: p.rows, progress: p.progress };
      flushPartial();
      emit(callbacks, 'onPartial', { rows: p.rows, times: p.times });
      runEvents.partial(runId, { rows: p.rows, times: p.times });
      /* The rows themselves go to the debug session, not through runEvents:
         every watcher of every run receives what runEvents publishes, and a
         result set can be megabytes. The debug window is one viewer that
         explicitly wants them, and it pulls the rows rather than being pushed
         them — see debugSession.noteResults. */
      if (isDebugRun) debugSessions.noteResults(runId, p.results);
    });
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
  const manualFieldsByStep = new Map(); // stepId → Set(fieldName): present-but-
  //                                       unverifiable fields left for the user.
  //                                       We don't re-heal these (avoids a loop)
  //                                       but the run is flagged needs_review.
  const manualFieldNotes = [];     // human-readable "field X in step Y" notes
  let reviewMessage = null;        // set when we escalate an empty-result to manual

  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    log(`── attempt ${attempt} ──`);
    // finalResults must reflect ONLY the final attempt's outcome. Each
    // terminal state sets it within its own iteration, so resetting here
    // prevents a healed-but-then-thrown run from carrying stale partial
    // data forward and being mis-recorded as 'success'.
    finalResults = null;
    // Same reasoning for the checkpoint: each attempt runs a FRESH child that
    // re-accumulates from zero, so carrying the previous attempt's rows over
    // would double-count them against this attempt's.
    latestPartial = null;

    const workflowForRun = { id: rootWorkflowId, steps: currentSteps, meta, customActions, subflows, proxy };
    const { events, promise, control } = runner.runChild(workflowForRun, {
      signal: cancelSignal, resume, debug: isDebugRun,
    });
    onRunnerEvents(events);
    if (isDebugRun) {
      // The session already exists (opened with the run id, above); this is
      // the child arriving to fill in its control channel.
      debugSessions.attachControl(runId, control);
      events.on('debug', (msg) => debugSessions.handleChildMessage(runId, msg));
      events.on('stepResult', (stat) => debugSessions.noteStepResult(runId, stat));
    }
    // Released on the child's exit however it exits — including a rejection,
    // which would otherwise skip every line below and strand the session (and
    // with it the user's ability to start another debug run).
    const result = await promise.finally(() => { if (isDebugRun) debugSessions.close(runId); });
    // Pages ACCUMULATE across attempts rather than being replaced. Unlike
    // results — where each attempt starts from zero and only the last one
    // counts — a healing re-run genuinely loads the pages again, and the
    // infrastructure cost of attempt 2 is just as real as attempt 1's.
    pagesFetched += Number(result.pagesFetched) || 0;
    // The child's own ledger is authoritative at exit (it includes anything
    // emitted after the last debounced checkpoint). On a resumed run, fold in
    // what the ORIGINAL run had already done — those items weren't re-scraped
    // this time, so only the union describes everything now captured.
    finalProgress = mergeProgress(resume, result.progress);

    if (result.success) {
      // ── Empty-result detection: a "successful" run that captured nothing ──
      const broken = detectBrokenSteps({
        stepResults: result.stepResults, snapshots: result.stepSnapshots,
        currentSteps, priorResults, stepDisposition, manualFieldsByStep,
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

      if (cancelSignal.aborted) break;

      if (!healingEnabled) {
        // Deterministic run: report the empty step instead of rewriting it.
        reviewMessage = `"${target.step.label || target.step.type}" captured no data, and self-healing is off for this workflow. ${healingStats.describeBreakage(target.verdict, target.stat)}`;
        stepDisposition.set(target.step.id, 'manual');
        lastError = emptyResultError(target, reviewMessage);
        log(`• ${reviewMessage}`, 'error');
        break;
      }

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
      // Fields the healer couldn't safely re-map are kept as-is and flagged:
      // record them so the confirmation re-run doesn't try to heal them again
      // (which would loop), and so we can surface them to the user.
      if (healed.manualFields && healed.manualFields.length) {
        const set = manualFieldsByStep.get(target.step.id) || new Set();
        for (const f of healed.manualFields) {
          set.add(f);
          manualFieldNotes.push(`"${f}" in "${target.step.label || target.step.type}"`);
        }
        manualFieldsByStep.set(target.step.id, set);
        log(`• field(s) ${healed.manualFields.map(f => `"${f}"`).join(', ')} left for manual review; the rest of the step is healed.`, 'error');
      }
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

    if (lastError.cancelled || cancelSignal.aborted) { log('🛑 cancelled — not retrying', 'error'); break; }

    if (category === 'CONNECTION' && connectionRetries < maxConnectionRetries) {
      connectionRetries++;
      const wait = CONNECTION_RETRY_DELAY_MS * connectionRetries;
      log(`↻ connection error — retrying in ${wait}ms (${connectionRetries}/${maxConnectionRetries})`);
      await delay(wait);
      continue;
    }
    if (category === 'HTTP') { log('• HTTP error from target — no automatic repair possible.', 'error'); break; }
    if (category === 'CAPTCHA') { log('• CAPTCHA / anti-bot challenge — selector repair can\'t help. Configure a solver (CAPTCHA_PROVIDER + CAPTCHA_API_KEY) or solve it while building the scraper.', 'error'); break; }
    if (category === 'LLM')  { log('• LLM service unreachable — flagging for manual review.', 'error'); break; }
    if (!healingEnabled) {
      log('• self-healing is off for this workflow — failing instead of rewriting the step.', 'error');
      break;
    }
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
    const extractionStep = findStep(currentSteps, failedStep.id);

    // Use the richer staged healer only for an extraction step we can actually
    // locate in the current tree (a step inside a subflow definition won't be
    // found — fall through to the legacy patch path rather than healing a
    // params-less stub).
    if (extractionStep && EXTRACTION_TYPES.has(failedStep.type) && snapshotHtml) {
      repairAttempts++;
      const verdict = { brokenFields: [], reason: 'threw', count: 0 };
      const healed = await healAndApply({
        target: { step: extractionStep, stat: { count: 0, fields: {} }, verdict, snapshot: { html: snapshotHtml, url: lastError.url } },
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
      await runStore.recordRepair({
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
    await runStore.recordRepair({
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
    const repairs = await runStore.listRepairsForRun(runId);
    for (const r of repairs) {
      if (!r.applied) continue;
      if (stepDisposition.get(r.step_id) === 'manual') continue;
      if (finalResults) await runStore.markRepairVerified(r.id, true);
    }
  }

  // Auto-adopt policy: write the healed steps into the SAVED workflow only
  // when the run ultimately produced data, nothing is pending manual review,
  // and EVERY applied heal was high-confidence + auto-eligible (verified).
  const anyManual = Array.from(stepDisposition.values()).includes('manual');
  const healedOk = appliedAnyPatch && !!finalResults && !anyManual;
  const wantAutoAdopt = healedOk && healLog.length > 0 && healLog.every(h => h.autoEligible && h.confidence === 'high');

  // `adopted` tracks whether the saved workflow was ACTUALLY updated — not
  // merely that we wanted to. If the write fails (workflow deleted / owner
  // changed) we must fall back to persisting patched_steps_json so the user
  // can still adopt the verified fix manually, rather than losing it.
  let adopted = false;
  if (wantAutoAdopt) {
    const changed = await safeCall(() => runStore.updateWorkflowSteps(workflowId, userId, currentSteps), 0);
    if (changed) {
      adopted = true;
      log('🔒 high-confidence fix verified — applied to the saved workflow automatically.');
      // Snapshot the healed state as a new restorable version so the user can
      // roll back the auto-adopt if it ever turns out wrong.
      await safeCall(() => runStore.ensureVersion(workflowId, userId, currentSteps, meta, 'auto-heal'));
      for (const h of healLog) { if (h.repairId) await safeCall(() => runStore.markAutoAdopted(h.repairId)); }
    }
  }
  if (healedOk && !adopted) {
    log('💡 fix verified for this run — review it in run history and click "Adopt AI-repaired workflow" to keep it.');
  }

  const duration = ms(t0);
  let status, aiSummary = null, finalErrorMessage = null, errorCategory = null;
  let failedStepInfo = { id: null, type: null, label: null };

  if (anyManual || (lastError && lastError.category === 'EMPTY_RESULT')) {
    // A broken step we couldn't safely heal — needs human attention even
    // though other steps may have produced data (which we still keep). Use
    // the REAL error category: a thrown selector failure that escalated to
    // manual stays 'SELECTOR'; only a genuine empty result is 'EMPTY_RESULT'.
    status = 'needs_review';
    errorCategory = (lastError && lastError.category) || 'EMPTY_RESULT';
    finalErrorMessage = (lastError && lastError.message) || 'A step captured no data';
    aiSummary = reviewMessage || errorClassifier.summarise(errorCategory, finalErrorMessage, lastError && lastError.step && lastError.step.label);
    // If we DID heal other steps, tell the user the partial fix is adoptable.
    if (appliedAnyPatch && !adopted) {
      aiSummary += ' Some steps were healed for this run — you can adopt those fixes from run history while you address the rest.';
    }
    failedStepInfo = stepInfoFrom(lastError && lastError.step);
  } else if (manualFieldNotes.length > 0) {
    // The run captured data and the list itself was healed, but one or more
    // fields couldn't be verified and were left for the user to finish. Flag
    // for review (with the data + an adoptable proposal), don't call it a
    // clean success.
    status = 'needs_review';
    errorCategory = 'EMPTY_RESULT';
    aiSummary = `Self-healed ${healLog.length} step(s); captured the data we could verify. ${manualFieldNotes.length} field(s) need a manual selector: ${manualFieldNotes.join(', ')}. Adopt the fix from run history, then point those field(s) at the right element.`;
  } else if (finalResults || lastError == null) {
    status = 'success';
    if (appliedAnyPatch) {
      aiSummary = adopted
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
  } else if (lastError.category === 'CAPTCHA') {
    // Anti-bot challenge — a human decision (solve manually / configure a
    // solver / change proxy), never an auto-repairable selector problem.
    status = 'needs_review'; errorCategory = 'CAPTCHA'; finalErrorMessage = lastError.message;
    aiSummary = errorClassifier.summarise('CAPTCHA', lastError.message, lastError.step?.label);
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

  /* ── Partial outcome ─────────────────────────────────────────────────────
     A run that died mid-flight but DID capture rows is not simply "failed" or
     "cancelled" — the data it collected is real and usually the whole point
     (think 8,000 of 10,000 product pages before a timeout). Record it as
     'partial': a distinct status, so every existing `status = 'success'`
     filter keeps its exact previous meaning and nothing silently starts
     counting incomplete data. The error message and category are preserved so
     the run still explains why it stopped.

     Deliberately NOT applied to needs_review: that status already carries its
     own results and is a call to action, which 'partial' would bury. */
  const capturedRows = latestPartial ? latestPartial.rows : 0;
  const usePartial = !finalResults && capturedRows > 0 &&
                     (status === 'error' || status === 'cancelled');
  if (usePartial) {
    const stoppedBecause = status === 'cancelled' ? 'was cancelled' : 'failed';
    status = 'partial';
    aiSummary = `Run ${stoppedBecause} before finishing, but ${capturedRows} row(s) captured up to that point were saved. `
              + (aiSummary || (finalErrorMessage ? `Stopped by: ${truncate(finalErrorMessage, 200)}` : ''));
    log(`💾 kept ${capturedRows} row(s) captured before the run stopped — saved as a partial result.`);
  }

  // Setup guidance (environment variables, providers, per-solve costs) goes to
  // the run LOG, not to aiSummary. The person reading "your scraper failed" on
  // the dashboard shouldn't be handed a shell configuration task; whoever
  // administers the instance still finds it one tab away.
  const setupHint = errorClassifier.adminHint(errorCategory, finalErrorMessage);
  if (setupHint) log(`ℹ ${setupHint}`);

  const resultsToStore = finalResults || (usePartial ? latestPartial.results : null);

  stopHeartbeat();
  await stopCheckpointing();
  // Belt-and-braces: the loop closes the session as soon as the child exits,
  // but every path out of a run must release it — a session that outlives its
  // child would block the user from starting another debug run.
  if (isDebugRun) debugSessions.close(runId);

  /* Page metering, on EVERY exit path — success, failure, and cancellation
     alike. A run cancelled after loading 900 pages consumed 900 pages, and
     billing only successful runs would make "cancel just before the end" a
     free-scraping strategy.

     Best-effort: a metering failure must not turn a finished run into a
     failed one. runs.pages_fetched (written in the finishRun patch below) is
     the durable record, so a lost increment stays reconcilable from it.

     Note this runs for the API path too. That path skipped the run increment
     because it was metered at enqueue, but its pages can only be known now
     that it has actually run. The guided tour's demo run is the one exception
     — see the quota gate above. */
  if (pagesFetched > 0 && !isDemoRun) {
    await safeCall(() => usageRepo.incrementPages(userId, pagesFetched), null);
  }

  await runStore.finishRun(runId, {
    status,
    finished_at: new Date().toISOString(),
    duration_ms: duration,
    pages_fetched: pagesFetched,
    results_json: resultsToStore ? JSON.stringify(resultsToStore) : null,
    // The in-flight checkpoint has served its purpose — it is either promoted
    // into results_json above or superseded by the complete set. Clearing it
    // keeps one authoritative copy per run instead of two diverging ones.
    partial_results_json: null,
    rows_captured: resultsToStore ? runner.countResultRows(resultsToStore) : 0,
    // Keep the per-item ledger on the finished row — it is what makes the run
    // resumable. Only written when the run actually has one, so a workflow
    // with no per-item loop never overwrites the column with null.
    ...(finalProgress ? { progress_json: JSON.stringify(finalProgress) } : {}),
    error_message: finalErrorMessage,
    error_category: errorCategory,
    failed_step_id:    failedStepInfo.id,
    failed_step_type:  failedStepInfo.type,
    failed_step_label: failedStepInfo.label,
    ai_summary: aiSummary,
    retry_count: attempt - 1,
    // Persist the healed steps whenever we applied a fix that wasn't actually
    // auto-written into the saved workflow, so the user can adopt it later.
    // Gated on `adopted` (the real outcome), not the intent, so a failed
    // auto-write still leaves a manual-adopt fallback instead of losing it.
    patched_steps_json: (appliedAnyPatch && !adopted) ? JSON.stringify(currentSteps) : null,
  });
  await runStore.flushLogs(runId);

  const finalRow = await runStore.getRun(runId);
  emit(callbacks, 'onDone', { run: finalRow });
  // Tell every watcher the run ended, with the results, so a tab that never
  // started it still lands on the same final view.
  safeCall(() => runEvents.end(runId, {
    status, run: serializeRunForWatchers(finalRow), results: resultsToStore,
  }), null);
  /* Outbound side effects. All skipped for a guided-tour run: none of these
     could have been configured on a workflow the user has never seen, and a
     practice run must not be able to e-mail them, hit their webhooks or write
     to their spreadsheet.

     Skipped for a debug run too, for the opposite reason — the workflow's
     deliveries ARE configured, and a run someone stepped through by hand,
     possibly stopping it half way, is not the result their webhook subscribers
     and spreadsheets are waiting on. */
  if (!isDemoRun && !isDebugRun) {
    // Push notification to any registered webhook endpoints (run.completed /
    // run.failed). Fire-and-forget: delivery problems must never fail a run.
    safeCall(() => webhookDispatcher.dispatchRunEvent(finalRow), null);
    // The same event by e-mail, for people who don't have a webhook URL to give.
    // No-op unless the instance has SMTP configured and the owner opted in.
    safeCall(() => emailNotifier.notifyRunFailed(finalRow), null);
    // Change monitoring: diff a successful run against the previous one, store
    // the summary, and push run.changed. Also fire-and-forget — a monitoring
    // problem must never surface to the run. No-op unless the workflow has an
    // active monitor.
    safeCall(() => changeMonitor.evaluateRun(finalRow, finalResults), null);
    // Google Sheets delivery: append a successful run's rows to the configured
    // sheet. Also fire-and-forget — a delivery problem must never surface to the
    // run. No-op unless the workflow has active sheet delivery.
    safeCall(() => sheetsDelivery.deliverRun(finalRow, finalResults), null);
  }
  return finalRow;
}

/* The subset of a finished run row a watching client needs. Deliberately not
   the whole row: results_json / partial_results_json can be megabytes and are
   delivered separately, and no watcher needs the internal bookkeeping. */
function serializeRunForWatchers(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    trigger: row.trigger,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    errorMessage: row.error_message,
    errorCategory: row.error_category,
    aiSummary: row.ai_summary,
    rowsCaptured: row.rows_captured || 0,
    retryCount: row.retry_count,
    hasPatchedWorkflow: !!row.patched_steps_json,
    failedStep: {
      id: row.failed_step_id, type: row.failed_step_type, label: row.failed_step_label,
    },
  };
}

/* Union of what an earlier (resumed-from) run captured and what this attempt
   captured. Without this, resuming a resume would forget the first run's items
   and re-scrape them: the child only ever reports what IT did, and the skipped
   items were, by definition, not done by it. */
function mergeProgress(resume, fresh) {
  const prior = (resume && resume.steps) || null;
  const now   = (fresh && fresh.steps) || null;
  // Steps the earlier run finished stay finished — this attempt skipped them
  // rather than re-running, so it never reports them itself.
  const priorDone = resume && resume.doneSteps ? Object.keys(resume.doneSteps) : [];
  const freshDone = (fresh && fresh.doneSteps) || [];
  const doneSteps = Array.from(new Set([...priorDone, ...freshDone]));

  const steps = {};
  for (const stepId of new Set([...Object.keys(prior || {}), ...Object.keys(now || {})])) {
    const a = (prior && prior[stepId]) || {};
    const b = (now && now[stepId]) || {};
    const urls = Array.from(new Set([...(a.urls || []), ...(b.urls || [])]));
    const entry = { urls };
    const key = b.outKey || a.outKey;
    if (key) entry.outKey = key;
    steps[stepId] = entry;
  }

  if (!Object.keys(steps).length && !doneSteps.length) return null;
  return doneSteps.length ? { steps, doneSteps } : { steps };
}

/* ── self-healing helpers ─────────────────────────────────────────────────── */

// Inspect the run's per-extraction stats and return the broken steps, each
// with its runtime stat, verdict, page snapshot, and whether we already tried
// to heal it this run (wasHealed). Side-effect-free: the caller decides what
// to do. Not-yet-healed steps are returned first so they get repaired before
// we conclude that an already-applied fix failed to hold.
function detectBrokenSteps({ stepResults, snapshots, currentSteps, priorResults, stepDisposition, manualFieldsByStep }) {
  const byStep = aggregateStats(stepResults || []);
  const broken = [];
  for (const stat of byStep.values()) {
    if (stepDisposition.get(stat.stepId) === 'manual') continue; // already escalated
    const step = findStep(currentSteps, stat.stepId);
    if (!step) continue; // e.g. a step that lives inside a subflow definition
    const baseline = baselineFor(priorResults, stat.key);
    const verdict = healingStats.classifyStep(stat, baseline);
    if (!verdict.broken) continue;
    // Fields already flagged for the user to fix by hand aren't re-healed —
    // otherwise the confirmation re-run would loop on the same field forever.
    const manualSet = manualFieldsByStep && manualFieldsByStep.get(stat.stepId);
    if (manualSet && manualSet.size && verdict.severity === 'field') {
      verdict.brokenFields = verdict.brokenFields.filter(f => !manualSet.has(f));
      if (verdict.brokenFields.length === 0) continue; // only manual fields empty
    }
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
    await runStore.recordRepair({ ...baseRepair, suggestedParams: null, explanation: outcome.explanation,
      confidence: 'low', applied: false, verified: false, repairKind: 'manual',
      llmError: outcome.code || null, evidence: outcome.evidence });
    return { outcome: 'manual', explanation: outcome.explanation };
  }

  // Build the patched step tree (without mutating currentSteps).
  let next;
  if (outcome.outcome === 'remove-step') {
    next = removeStepById(currentSteps, step.id);
    log(`• "${step.label || step.type}" target disappeared — removing the step. ${outcome.explanation}`);
    const repairId = await runStore.recordRepair({ ...baseRepair, suggestedParams: { removed: true }, explanation: outcome.explanation,
      confidence: 'high', applied: true, verified: false, repairKind: 'remove-step', evidence: outcome.evidence });
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
    await runStore.recordRepair({ ...baseRepair, suggestedParams: outcome.newParams, explanation: 'Could not apply the proposed patch to the workflow tree.',
      confidence: 'low', applied: false, verified: false, repairKind: 'selector', evidence: outcome.evidence });
    return { outcome: 'manual', explanation: 'The proposed fix could not be applied to the workflow.' };
  }

  if (!compilesOk({ steps: applied.steps, meta, customActions, subflows, rootWorkflowId }, log)) {
    await runStore.recordRepair({ ...baseRepair, suggestedParams: outcome.newParams, explanation: 'The patched workflow failed to compile — refusing to run an invalid fix.',
      confidence: 'low', applied: false, verified: false, repairKind: 'selector', evidence: outcome.evidence });
    return { outcome: 'manual', explanation: 'The proposed fix produced invalid generated code — manual review needed.' };
  }

  log(`✎ verified fix for "${step.label || step.type}" (confidence ${outcome.confidence}): ${truncate(outcome.explanation, 240)}`);
  const repairId = await runStore.recordRepair({
    ...baseRepair,
    suggestedParams: outcome.newParams,
    explanation: outcome.explanation,
    confidence: outcome.confidence,
    applied: true, verified: false,
    repairKind: outcome.droppedFields && outcome.droppedFields.length ? 'field-drop' : 'selector',
    evidence: outcome.evidence,
  });
  return {
    outcome: 'patch', steps: applied.steps,
    confidence: outcome.confidence, kind: 'selector',
    autoEligible: outcome.confidence === 'high',
    manualFields: outcome.manualFields || [],
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

async function safeCall(fn, fallback) { try { return await fn(); } catch (_) { return fallback; } }

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
