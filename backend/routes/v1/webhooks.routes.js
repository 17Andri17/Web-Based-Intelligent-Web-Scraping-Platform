'use strict';

const crypto = require('crypto');
const express = require('express');
const webhooksRepo = require('../../db/repositories/webhooks.repo');
const { sendApiError } = require('../../middleware/apiKeyAuth');
const { serializeWebhook } = require('../../utils/apiSerialize');
const { parseId } = require('./helpers');

/* ===========================================================================
   /v1/webhooks — push instead of poll. Register an HTTPS endpoint and the
   platform POSTs signed run.completed / run.failed events to it (see
   services/webhookDispatcher.service.js). The signing secret (`whsec_…`) is
   returned ONCE, in the create response — store it; it's what the receiver
   uses to verify the X-Scraper-Signature header.
   ========================================================================= */

const router = express.Router();

const VALID_EVENTS = ['run.completed', 'run.failed'];
const MAX_URL_LEN = 2048;
const MAX_WEBHOOKS_PER_USER = 10;

router.post('/', async (req, res) => {
  const { url, events } = req.body || {};

  const urlError = validateUrl(url);
  if (urlError) return sendApiError(res, 400, 'invalid_request', urlError);

  let subscribed = VALID_EVENTS;
  if (events !== undefined) {
    if (!Array.isArray(events) || events.length === 0) {
      return sendApiError(res, 400, 'invalid_request',
        `"events" must be a non-empty array; valid events: ${VALID_EVENTS.join(', ')}.`);
    }
    const invalid = events.filter(e => !VALID_EVENTS.includes(e));
    if (invalid.length) {
      return sendApiError(res, 400, 'invalid_request',
        `Unknown event(s): ${invalid.join(', ')}. Valid events: ${VALID_EVENTS.join(', ')}.`);
    }
    subscribed = [...new Set(events)];
  }

  const count = await webhooksRepo.countForUser(req.user.id);
  if (count >= MAX_WEBHOOKS_PER_USER) {
    return sendApiError(res, 400, 'limit_reached',
      `You already have ${count} webhooks (max ${MAX_WEBHOOKS_PER_USER}). Delete one first.`);
  }

  const secret = 'whsec_' + crypto.randomBytes(24).toString('base64url');
  const row = await webhooksRepo.create({ userId: req.user.id, url: url.trim(), secret, events: subscribed });
  res.status(201).json(serializeWebhook(row, { includeSecret: true }));
});

router.get('/', async (req, res) => {
  const rows = await webhooksRepo.listForUser(req.user.id);
  res.json({
    object: 'list',
    data: rows.map(r => serializeWebhook(r)),
    has_more: false,
    next_cursor: null,
  });
});

router.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const changes = id ? await webhooksRepo.remove(id, req.user.id) : 0;
  if (!changes) return sendApiError(res, 404, 'not_found', 'No such webhook.');
  res.json({ id, object: 'webhook', deleted: true });
});

function validateUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return '"url" is required.';
  if (url.length > MAX_URL_LEN) return `"url" is too long (max ${MAX_URL_LEN}).`;
  let parsed;
  try { parsed = new URL(url.trim()); } catch (_) { return '"url" is not a valid URL.'; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return '"url" must use http:// or https://.';
  }
  return null;
}

module.exports = router;
