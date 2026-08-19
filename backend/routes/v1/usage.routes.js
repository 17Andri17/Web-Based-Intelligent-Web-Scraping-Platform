'use strict';

const express = require('express');
const entitlements = require('../../services/entitlements.service');

/* ===========================================================================
   /v1/usage — current-period metering: runs and pages used, the limits they
   count against (null = unlimited), and the plan.

   Limits now come from the caller's actual plan (config/plans.js via
   services/entitlements.service) rather than the API_MONTHLY_RUN_QUOTA /
   API_PLAN_NAME env vars, which were instance-wide and so reported the same
   quota to every user regardless of what they were paying.

   The response keeps its original field names and shape — runs_used,
   runs_quota, pages_used, plan — because they are part of the published
   public API (docs/API_REFERENCE.md) and third-party code reads them.
   Additive fields only.
   ========================================================================= */

const router = express.Router();

router.get('/', async (req, res) => {
  const summary = await entitlements.getUsageSummary(req.user.id);
  res.json({
    object: 'usage',
    period: summary.period,
    runs_used: summary.runs.used,
    runs_quota: summary.runs.limit,
    pages_used: summary.pages.used,
    pages_quota: summary.pages.limit,
    plan: summary.effectivePlan,
    // What they subscribe to, which differs from `plan` when a payment has
    // failed: plan reports the entitlements actually in force, plan_name and
    // plan_status report the subscription. A client showing "your plan" to a
    // human wants these; a client deciding whether a call will succeed wants
    // `plan` and the quotas.
    plan_name: summary.planName,
    plan_status: summary.planStatus,
  });
});

module.exports = router;
