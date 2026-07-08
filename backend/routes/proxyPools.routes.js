'use strict';

const express = require('express');
const pools = require('../db/repositories/proxyPools.repo');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const MAX_LABEL = 80;
const STRATEGIES = new Set(['random', 'round_robin']);

async function validate(body, { userId, isShared }) {
  const { label, strategy, memberProxyIds } = body || {};
  if (typeof label !== 'string' || !label.trim()) return 'Label is required';
  if (label.length > MAX_LABEL) return `Label too long (max ${MAX_LABEL})`;
  const strat = strategy || 'random';
  if (!STRATEGIES.has(strat)) return `Strategy must be one of: ${[...STRATEGIES].join(', ')}`;
  if (!Array.isArray(memberProxyIds) || memberProxyIds.length === 0) return 'Select at least one proxy for the pool';
  if (memberProxyIds.length > 100) return 'Too many members (max 100)';

  const usableIds = isShared
    ? await pools.filterSharedProxyIds(memberProxyIds)
    : await pools.filterUsableProxyIds(memberProxyIds, userId);
  const requested = new Set(memberProxyIds.map(Number));
  const missing = [...requested].filter((id) => !usableIds.includes(id));
  if (missing.length > 0) {
    return isShared
      ? `Proxy id(s) ${missing.join(', ')} aren't marked as shared — only shared proxies can be added to a platform pool.`
      : `Proxy id(s) ${missing.join(', ')} aren't yours and aren't shared — can't add them to your pool.`;
  }

  return { label: label.trim(), strategy: strat, memberProxyIds: usableIds };
}

function serialize(pool) {
  if (!pool) return null;
  return {
    id: pool.id,
    label: pool.label,
    strategy: pool.strategy,
    isShared: pool.isShared,
    isDefault: pool.isDefault,
    members: (pool.members || []).map((m) => ({ id: m.id, label: m.label, protocol: m.protocol, host: m.host, port: m.port, isShared: !!m.is_shared })),
    createdAt: pool.created_at,
    updatedAt: pool.updated_at,
  };
}

// ── Admin: manage the shared/platform pools ─────────────────────────────────
// Registered before /:id below so "shared" is never swallowed as an :id param.
router.post('/shared', requireAdmin, async (req, res) => {
  const v = await validate(req.body, { userId: req.user.id, isShared: true });
  if (typeof v === 'string') return res.status(400).json({ error: v });
  const row = await pools.create({ ...v, userId: null, isShared: true });
  res.status(201).json({ pool: serialize(row) });
});

router.put('/shared/:id', requireAdmin, async (req, res) => {
  const v = await validate(req.body, { userId: req.user.id, isShared: true });
  if (typeof v === 'string') return res.status(400).json({ error: v });
  const row = await pools.updateShared({ id: req.params.id, ...v, isDefault: !!req.body.isDefault });
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ pool: serialize(row) });
});

router.delete('/shared/:id', requireAdmin, async (req, res) => {
  const changes = await pools.removeShared(req.params.id);
  if (changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Everyone: own pools + the picker list (own + shared) ───────────────────
router.get('/', async (req, res) => {
  const rows = await pools.listAvailableForUser(req.user.id);
  res.json({ pools: rows.map(serialize) });
});

router.get('/:id', async (req, res) => {
  const row = await pools.getForUser(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ pool: serialize(row) });
});

router.post('/', async (req, res) => {
  const v = await validate(req.body, { userId: req.user.id, isShared: false });
  if (typeof v === 'string') return res.status(400).json({ error: v });
  const row = await pools.create({ ...v, userId: req.user.id, isShared: false });
  res.status(201).json({ pool: serialize(row) });
});

router.put('/:id', async (req, res) => {
  const owned = await pools.existsForUser(req.params.id, req.user.id);
  if (!owned) return res.status(404).json({ error: 'Not found' });
  const v = await validate(req.body, { userId: req.user.id, isShared: false });
  if (typeof v === 'string') return res.status(400).json({ error: v });
  const row = await pools.update({ id: req.params.id, userId: req.user.id, ...v });
  res.json({ pool: serialize(row) });
});

router.delete('/:id', async (req, res) => {
  const changes = await pools.remove(req.params.id, req.user.id);
  if (changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
