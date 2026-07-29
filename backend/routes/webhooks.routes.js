'use strict';

const crypto = require('crypto');
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const webhooksRepo = require('../db/repositories/webhooks.repo');
const { serializeWebhook } = require('../utils/apiSerialize');
const { WEBHOOK_EVENTS, WEBHOOK_EVENT_LABELS } = require('../services/webhookEvents');

/* ===========================================================================
   /api/webhooks — the dashboard-facing (JWT-authenticated) management surface
   for push endpoints. The public /v1/webhooks routes cover programmatic access
   with API keys; this mirrors them for the logged-in UI so a non-technical
   user can register a Slack/ntfy/Discord/own-server endpoint and choose which
   events (incl. run.changed from change monitoring) to receive — without
   touching the API.

   Same store, same signing model, same event set (services/webhookEvents).
   The signing secret (whsec_…) is returned ONCE on create.
   ========================================================================= */

const router = express.Router();
router.use(requireAuth);

const MAX_URL_LEN = 2048;
const MAX_WEBHOOKS_PER_USER = 10;

// Expose the catalogue so the UI can render event checkboxes with descriptions.
router.get('/events', (req, res) => {
  res.json({ events: WEBHOOK_EVENTS.map(e => ({ event: e, label: WEBHOOK_EVENT_LABELS[e] || e })) });
});

router.get('/', async (req, res) => {
  const rows = await webhooksRepo.listForUser(req.user.id);
  res.json({ webhooks: rows.map(r => serializeWebhook(r)) });
});

router.post('/', async (req, res) => {
  const { url, events } = req.body || {};

  const urlError = validateUrl(url);
  if (urlError) return res.status(400).json({ error: urlError });

  let subscribed = WEBHOOK_EVENTS;
  if (events !== undefined) {
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: `Pick at least one event. Valid: ${WEBHOOK_EVENTS.join(', ')}.` });
    }
    const invalid = events.filter(e => !WEBHOOK_EVENTS.includes(e));
    if (invalid.length) {
      return res.status(400).json({ error: `Unknown event(s): ${invalid.join(', ')}.` });
    }
    subscribed = [...new Set(events)];
  }

  const count = await webhooksRepo.countForUser(req.user.id);
  if (count >= MAX_WEBHOOKS_PER_USER) {
    return res.status(400).json({ error: `You already have ${count} webhooks (max ${MAX_WEBHOOKS_PER_USER}). Delete one first.` });
  }

  const secret = 'whsec_' + crypto.randomBytes(24).toString('base64url');
  const row = await webhooksRepo.create({ userId: req.user.id, url: url.trim(), secret, events: subscribed });
  // secret shown exactly once, like API keys
  res.status(201).json({ webhook: serializeWebhook(row, { includeSecret: true }) });
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const changes = id ? await webhooksRepo.remove(id, req.user.id) : 0;
  if (!changes) return res.status(404).json({ error: 'No such webhook' });
  res.json({ ok: true });
});

function validateUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return 'A URL is required.';
  if (url.length > MAX_URL_LEN) return `URL is too long (max ${MAX_URL_LEN}).`;
  let parsed;
  try { parsed = new URL(url.trim()); } catch (_) { return 'That is not a valid URL.'; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'URL must start with http:// or https://.';
  }
  return null;
}

module.exports = router;
