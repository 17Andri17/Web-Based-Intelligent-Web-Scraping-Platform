'use strict';

const crypto = require('crypto');
const apiKeysRepo = require('../db/repositories/apiKeys.repo');
const { hashKey, looksLikeApiKey } = require('../services/apiKeys.service');

/* ===========================================================================
   Public API (/v1) request middleware: request IDs, the one error shape, and
   API-key authentication.

   Every /v1 error — auth, validation, rate limit, 404, 500 — goes through
   sendApiError so third-party developers always see:

       { "error": { "code": "…", "message": "…", "request_id": "req_…" } }

   Auth is deliberately separate from the frontend JWT middleware: programs
   hold long-lived `sk_live_…` keys, not 7-day login tokens. The key is
   hashed and looked up in api_keys; the resolved owner is attached as
   req.user so the same user_id-scoped repos the UI uses drop in unchanged.
   ========================================================================= */

function sendApiError(res, status, code, message, extraHeaders = null) {
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  }
  return res.status(status).json({
    error: { code, message, request_id: (res.req && res.req.requestId) || null },
  });
}

// Tag every /v1 request with an id, echoed in errors and the X-Request-Id
// header, so a developer's bug report can be matched to server logs.
function requestId(req, res, next) {
  req.requestId = 'req_' + crypto.randomBytes(9).toString('base64url');
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

async function requireApiKey(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) {
    return sendApiError(res, 401, 'invalid_api_key',
      'Missing API key. Send it as "Authorization: Bearer sk_live_…". Keys are created in the dashboard.');
  }
  if (!looksLikeApiKey(token)) {
    return sendApiError(res, 401, 'invalid_api_key',
      'Malformed API key. Expected a key of the form "sk_live_…". (JWT session tokens are not valid here.)');
  }
  let row;
  try {
    row = await apiKeysRepo.findActiveByHash(hashKey(token));
  } catch (err) {
    return sendApiError(res, 500, 'internal_error', 'Failed to verify the API key.');
  }
  if (!row) {
    return sendApiError(res, 401, 'invalid_api_key', 'Unknown or revoked API key.');
  }
  req.apiKey = { id: row.id, userId: row.user_id, name: row.name, prefix: row.prefix };
  req.user = { id: row.user_id };
  apiKeysRepo.touchLastUsed(row.id).catch(() => {});
  next();
}

module.exports = { requireApiKey, requestId, sendApiError };
