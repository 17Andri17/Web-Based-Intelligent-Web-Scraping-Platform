'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const apiKeysRepo = require('../db/repositories/apiKeys.repo');
const entitlements = require('../services/entitlements.service');
const { generateKey } = require('../services/apiKeys.service');

/* ===========================================================================
   /api/api-keys — dashboard management of public-API keys.

   JWT-authed (the logged-in user), NOT part of the public /v1 surface: keys
   are created and revoked from the dashboard, never via the API itself, so a
   leaked key can't mint more keys (see docs/API_ARCHITECTURE.md).

   The plaintext key appears exactly once: in the POST response. Only its
   SHA-256 hash and display prefix are stored.
   ========================================================================= */

const router = express.Router();
router.use(requireAuth);

const MAX_NAME_LEN = 80;
const MAX_ACTIVE_KEYS = 20;

function serialize(row) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

router.get('/', async (req, res) => {
  const rows = await apiKeysRepo.listForUser(req.user.id);
  res.json({ apiKeys: rows.map(serialize) });
});

router.post('/', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (name.length > MAX_NAME_LEN) return res.status(400).json({ error: `Name too long (max ${MAX_NAME_LEN})` });

  // An API key is only useful if the plan grants API access, so refuse to
  // mint one that would 402 on first use — a key that cannot be used is a
  // worse experience than a clear "upgrade to get API access" here.
  await entitlements.assertFeature(req.user.id, 'publicApi', 'The REST API');

  const active = await apiKeysRepo.countActiveForUser(req.user.id);
  // Two ceilings: the plan's, and MAX_ACTIVE_KEYS as an absolute backstop that
  // applies even to unlimited plans (an account with 10,000 live keys is an
  // incident, not a customer).
  await entitlements.assertWithinLimit(req.user.id, 'maxApiKeys', active, 'API keys');
  if (active >= MAX_ACTIVE_KEYS) {
    return res.status(400).json({ error: `You already have ${active} active keys (max ${MAX_ACTIVE_KEYS}). Revoke one first.` });
  }

  const { key, keyHash, prefix } = generateKey();
  const row = await apiKeysRepo.create({ userId: req.user.id, name, keyHash, prefix });
  // `key` is shown this once and never again — we only store its hash.
  res.status(201).json({ apiKey: serialize(row), key });
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Not found' });
  const changes = await apiKeysRepo.revoke(id, req.user.id);
  if (!changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
