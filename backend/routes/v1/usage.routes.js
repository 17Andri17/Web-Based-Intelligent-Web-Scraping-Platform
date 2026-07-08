'use strict';

const express = require('express');
const usageRepo = require('../../db/repositories/usage.repo');

/* ===========================================================================
   /v1/usage — current-period metering: runs used, the quota they count
   against (null = unlimited), and the plan name. Quota/plan are deployment
   configuration (API_MONTHLY_RUN_QUOTA / API_PLAN_NAME) until billing lands.
   ========================================================================= */

const router = express.Router();

router.get('/', async (req, res) => {
  const usage = await usageRepo.getForPeriod(req.user.id);
  const quota = Number(process.env.API_MONTHLY_RUN_QUOTA || 0);
  res.json({
    object: 'usage',
    period: usage.period,
    runs_used: usage.runs_used,
    runs_quota: quota > 0 ? quota : null,
    pages_used: usage.pages_used,
    plan: process.env.API_PLAN_NAME || 'free',
  });
});

module.exports = router;
