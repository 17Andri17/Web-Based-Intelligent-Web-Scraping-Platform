'use strict';

const express = require('express');
const { requestId, requireApiKey, sendApiError } = require('../../middleware/apiKeyAuth');
const { apiRateLimit } = require('../../middleware/apiRateLimit');

/* ===========================================================================
   Public REST API — /v1 (see docs/API_ARCHITECTURE.md + docs/API_REFERENCE.md)
   ---------------------------------------------------------------------------
   The versioned, API-key-authenticated surface third-party programs integrate
   against, deliberately separate from the JWT frontend routes at /api/*.
   Order matters: request-id first (so even auth failures carry one), then key
   auth, then the per-key rate limiter (which needs the resolved key).
   ========================================================================= */

const router = express.Router();

router.use(requestId);
router.use(requireApiKey);
router.use(apiRateLimit);

router.use('/workflows', require('./workflows.routes'));
router.use('/runs', require('./runs.routes'));
router.use('/webhooks', require('./webhooks.routes'));
router.use('/usage', require('./usage.routes'));

// Unknown /v1 path → the same JSON error shape as everything else.
router.use((req, res) => {
  sendApiError(res, 404, 'not_found', `No such endpoint: ${req.method} ${req.baseUrl}${req.path}`);
});

module.exports = router;
