'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const workflows = require('../db/repositories/workflows.repo');

/* ===========================================================================
   tour.routes — housekeeping for the guided walkthrough
   ---------------------------------------------------------------------------
   The tour builds a working scraper on the bundled practice shop and runs it
   for real, which means it needs a persisted workflow to hang the run, its
   logs and its results off. That workflow is flagged `is_demo` and hidden
   from every listing (workflows.repo), but hiding it isn't enough: what the
   walkthrough taught with is not something the user should have to find and
   tidy up afterwards.

   So the front end calls DELETE here whenever the tour ends — finished,
   exited, or restarted from the top — and the row goes, taking its runs,
   logs, repairs and versions with it (all ON DELETE CASCADE). What survives
   is a single local flag saying the tour was completed, which is all the home
   screen needs to know.

   Idempotent on purpose: "there was nothing to clean up" is a success, not an
   error, and the client fires this on paths where it can't know.
   ========================================================================= */

const router = express.Router();
router.use(requireAuth);

router.delete('/demo-workflow', async (req, res) => {
  const removed = await workflows.removeDemoForUser(req.user.id);
  res.json({ ok: true, removed });
});

module.exports = router;
