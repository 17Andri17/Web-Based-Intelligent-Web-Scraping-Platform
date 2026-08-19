'use strict';

const express = require('express');
const workflowsRepo = require('../../db/repositories/workflows.repo');
const usageRepo = require('../../db/repositories/usage.repo');
const entitlements = require('../../services/entitlements.service');
const runStore = require('../../services/runStore.service');
const { sendApiError } = require('../../middleware/apiKeyAuth');
const { serializeRun, serializeWorkflow, serializeWorkflowSummary } = require('../../utils/apiSerialize');
const { parseId, parseLimit, parseCursor, pageEnvelope, isUniqueViolation, safeJson } = require('./helpers');
const { validateInputs } = require('../../utils/workflowInputs');

/* ===========================================================================
   /v1/workflows — read-only discovery + the trigger endpoint.

   Workflows are BUILT in the visual UI; the API only lists them (so callers
   can discover runnable ids), shows their declared input variables, and
   triggers runs. POST /:id/runs is async by design: it checks quota,
   validates inputs, creates a status='queued' run row, and returns 202
   immediately — apiWorker executes it in the background.
   ========================================================================= */

const router = express.Router();

const MAX_INPUTS_BYTES = 16 * 1024;
const MAX_IDEMPOTENCY_KEY_LEN = 255;

router.get('/', async (req, res) => {
  const limit = parseLimit(req.query.limit);
  if (limit === null) return sendApiError(res, 400, 'invalid_request', '"limit" must be a positive integer.');
  const cursor = parseCursor(req.query.cursor);
  if (cursor === null) return sendApiError(res, 400, 'invalid_request', '"cursor" is not a valid cursor from a previous response.');

  const rows = await workflowsRepo.listSummariesForUserPage(req.user.id, {
    limit: limit + 1, beforeId: cursor ?? null,
  });
  res.json(pageEnvelope(rows, limit, serializeWorkflowSummary));
});

router.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const row = id && await workflowsRepo.getForUser(id, req.user.id);
  if (!row) return sendApiError(res, 404, 'not_found', 'No such workflow.');
  res.json(serializeWorkflow(row));
});

// Trigger a run → 202 { id, status: "queued", … }
router.post('/:id/runs', async (req, res) => {
  const id = parseId(req.params.id);
  const workflow = id && await workflowsRepo.getForUser(id, req.user.id);
  if (!workflow) return sendApiError(res, 404, 'not_found', 'No such workflow.');

  // ── inputs: optional overrides for the workflow's declared variables ────
  const inputs = req.body ? req.body.inputs : undefined;
  if (inputs !== undefined) {
    const inputsJson = JSON.stringify(inputs);
    if (Buffer.byteLength(inputsJson, 'utf8') > MAX_INPUTS_BYTES) {
      return sendApiError(res, 400, 'invalid_inputs', `"inputs" is too large (max ${MAX_INPUTS_BYTES / 1024}KB).`);
    }
    const meta = workflow.meta_json ? safeJson(workflow.meta_json) || {} : {};
    const err = validateInputs(meta, inputs);
    if (err) return sendApiError(res, 400, 'invalid_inputs', err);
  }

  // ── plan + quota ────────────────────────────────────────────────────────
  // The public API is itself a paid feature, so this checks two things: that
  // the caller's plan includes API access at all, and that they're within
  // their monthly run/page quota. Both come from their actual plan now, not
  // the instance-wide API_MONTHLY_RUN_QUOTA env var.
  //
  // Checked HERE rather than relying on the pipeline's gate because this
  // endpoint returns 202 and hands off to a background worker — by the time
  // the pipeline runs there is no request left to answer with a 402.
  try {
    await entitlements.assertFeature(req.user.id, 'publicApi', 'The REST API');
    await entitlements.assertCanRun(req.user.id);
  } catch (err) {
    if (err instanceof entitlements.EntitlementError) {
      // 'over_quota' is the code third-party clients already handle
      // (docs/API_REFERENCE.md); keep it for quota and use a distinct code
      // for "your plan doesn't include this" so they can be told apart.
      const code = err.code === 'quota_exceeded' ? 'over_quota'
        : err.code === 'account_suspended' ? 'account_suspended'
        : 'plan_required';
      return sendApiError(res, err.status, code, err.message);
    }
    throw err;
  }

  // ── idempotency ─────────────────────────────────────────────────────────
  const idempotencyKey = normalizeIdempotencyKey(req.headers['idempotency-key']);
  if (idempotencyKey === null) {
    return sendApiError(res, 400, 'invalid_request',
      `"Idempotency-Key" must be a non-empty string of at most ${MAX_IDEMPOTENCY_KEY_LEN} characters.`);
  }
  if (idempotencyKey) {
    const existing = await runStore.findRunByIdempotencyKey(req.user.id, idempotencyKey);
    if (existing) return replayOrConflict(res, existing, id);
  }

  // ── enqueue ─────────────────────────────────────────────────────────────
  let runId;
  try {
    runId = await runStore.createQueuedRun({
      userId: req.user.id,
      workflowId: id,
      apiKeyId: req.apiKey.id,
      inputsJson: inputs !== undefined ? JSON.stringify(inputs) : null,
      idempotencyKey: idempotencyKey || null,
    });
  } catch (err) {
    // Two concurrent requests with the same Idempotency-Key: the loser's
    // INSERT hits the unique index — replay the winner's run.
    if (idempotencyKey && isUniqueViolation(err)) {
      const existing = await runStore.findRunByIdempotencyKey(req.user.id, idempotencyKey);
      if (existing) return replayOrConflict(res, existing, id);
    }
    throw err;
  }

  await usageRepo.incrementRuns(req.user.id);
  const run = await runStore.getRunForUser(runId, req.user.id);
  res.status(202).json(serializeRun(run));
});

// A replayed Idempotency-Key returns the ORIGINAL run (202, like the first
// response) — unless it was used with a different workflow, which is a
// caller bug worth surfacing loudly (409) instead of silently returning a
// run they didn't ask for.
function replayOrConflict(res, existingRun, workflowId) {
  if (existingRun.workflow_id !== workflowId) {
    return sendApiError(res, 409, 'idempotency_conflict',
      `This Idempotency-Key was already used to trigger workflow ${existingRun.workflow_id}.`);
  }
  return res.status(202).json(serializeRun(existingRun));
}

function normalizeIdempotencyKey(raw) {
  if (raw === undefined) return undefined;
  const value = String(raw).trim();
  if (!value || value.length > MAX_IDEMPOTENCY_KEY_LEN) return null;
  return value;
}

module.exports = router;
