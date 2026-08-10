'use strict';

const runStore = require('./runStore.service');

/* ===========================================================================
   resume
   ---------------------------------------------------------------------------
   Continue a run that stopped early instead of starting it over.

   The general problem — "restart a workflow from where it died" — is not
   solvable in general: a run that logged in, filled a form and clicked through
   three pages has browser state that cannot be reconstructed from a URL. But
   the case that actually matters for a big scrape IS solvable, exactly, and
   it's the common one: a loop that walks a list of detail-page URLs is a pure
   map over that list. Re-running it minus the URLs already captured yields
   precisely the same result as never having stopped.

   So resume is offered only where it is provably correct:

     • The run must have stopped with rows captured ('partial'), or failed
       after capturing some.
     • It must carry a progress ledger — the per-step set of items it actually
       finished (runs.progress_json, written from the ITER_DONE markers).
     • The workflow must be UNCHANGED since that run. Steps are content-hashed
       into workflow_versions, so this is an exact check, not a guess: a
       resumed run must execute the same workflow the partial rows came from,
       or the two halves of the output would not belong together.

   Everything before the loop re-runs normally. That is deliberate — the list
   of URLs is regenerated from the live site rather than trusted from before,
   so a resume picks up items added since, and matching by URL (not by index)
   means a shifted list can't misalign anything.
   ========================================================================= */

const RESUMABLE_STATUSES = new Set(['partial', 'error', 'cancelled']);

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

/**
 * Can this run be resumed, and if not, why not? The reason is shown to the
 * user, so it says what to do rather than just refusing.
 *
 * @returns {{ resumable: boolean, reason?: string, items?: number, steps?: number }}
 */
function eligibility(run, currentVersionId) {
  if (!run) return { resumable: false, reason: 'Run not found.' };

  if (run.status === 'success') {
    return { resumable: false, reason: 'This run finished successfully — there is nothing left to resume.' };
  }
  if (run.status === 'running' || run.status === 'queued') {
    return { resumable: false, reason: 'This run is still going.' };
  }
  if (!RESUMABLE_STATUSES.has(run.status)) {
    return { resumable: false, reason: `A ${run.status} run can't be resumed.` };
  }

  const progress = safeJson(run.progress_json);
  const steps = (progress && progress.steps) || null;
  const doneSteps = (progress && progress.doneSteps) || [];
  const hasItems = steps && Object.keys(steps).length > 0;
  if (!hasItems && doneSteps.length === 0) {
    return {
      resumable: false,
      reason: 'This run has no progress to resume from. Resume works for workflows that walk a list '
            + 'of pages (a subflow over URLs, or For-Each-Row opening each row\'s link) — those record which '
            + 'items finished. Other workflows have to be re-run.',
    };
  }

  // The partial rows and the new rows must come from the same workflow, or
  // they don't describe the same thing. version_id is a content hash of the
  // steps (runStore.ensureVersion), so this compares what actually ran.
  if (currentVersionId != null && run.version_id != null && currentVersionId !== run.version_id) {
    return {
      resumable: false,
      reason: 'The workflow has been edited since this run. Resuming would mix rows captured by two different '
            + 'versions, so run it fresh instead.',
    };
  }

  let items = 0;
  for (const s of Object.values(steps || {})) items += (s && Array.isArray(s.urls) ? s.urls.length : 0);
  if (items === 0 && doneSteps.length === 0) {
    return { resumable: false, reason: 'This run did not finish any items, so a resume would just be a fresh run.' };
  }

  return {
    resumable: true,
    items,
    steps: Object.keys(steps || {}).length,
    // Whole steps that won't run again — worth surfacing, since skipping a
    // finished pagination pass is often the bigger saving.
    completedSteps: doneSteps.length,
  };
}

/**
 * Build the payload handed to the generated script (runner writes it to the
 * WS_RESUME_FILE sidecar):
 *
 *   { steps: { <stepId>: { urls: [...already done...], rows: [...restore...] } } }
 *
 * `urls` are skipped; `rows` are pushed into the output before the loop runs,
 * so the resumed run's output is the previous rows followed by the new ones —
 * in the same order the un-interrupted run would have produced.
 */
function buildPayload(run) {
  const progress = safeJson(run && run.progress_json);
  if (!progress) return null;

  const results = safeJson(run.results_json) || {};

  const steps = {};
  for (const [stepId, state] of Object.entries(progress.steps || {})) {
    const urls = Array.isArray(state && state.urls) ? state.urls : [];
    if (!urls.length) continue;
    // Which result key the loop writes into is reported once per loop, in its
    // ITER_START marker, so restoring rows never has to guess.
    const key = state && state.outKey;
    const rows = key && Array.isArray(results[key]) ? results[key] : [];
    steps[stepId] = { urls, rows };
  }

  /* Steps that finished outright. Those are skipped wholesale rather than
     re-executed, with their captured output restored from the run's results —
     so a completed pagination pass isn't repeated just to rebuild a list the
     previous run already produced.

     `values` is the whole result set: a done step's output lives under its own
     key, and the generated guard picks the keys it needs by name. */
  const doneSteps = {};
  for (const stepId of (progress.doneSteps || [])) doneSteps[stepId] = true;

  const hasWork = Object.keys(steps).length || Object.keys(doneSteps).length;
  if (!hasWork) return null;
  return { steps, doneSteps, values: results };
}

/**
 * Load a run, check it can be resumed, and produce the payload.
 * @returns {{ ok: boolean, reason?: string, run?: object, payload?: object, info?: object }}
 */
async function prepare(runId, userId, currentVersionId) {
  const run = await runStore.getRunForUser(runId, userId);
  if (!run) return { ok: false, reason: 'Run not found.' };

  const check = eligibility(run, currentVersionId);
  if (!check.resumable) return { ok: false, reason: check.reason, run };

  const payload = buildPayload(run);
  if (!payload) return { ok: false, reason: 'Could not rebuild this run\'s progress.', run };

  return { ok: true, run, payload, info: check };
}

module.exports = { prepare, eligibility, buildPayload, RESUMABLE_STATUSES };
