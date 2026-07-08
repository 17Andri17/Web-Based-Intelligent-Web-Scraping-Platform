'use strict';

const express = require('express');
const proxies = require('../db/repositories/proxies.repo');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const MAX_LABEL = 80;
const MAX_HOST = 255;
const MAX_USERNAME = 200;
const MAX_PASSWORD = 500;
const PROTOCOLS = new Set(['http', 'https', 'socks5']);

function validate(body) {
  const { label, protocol, host, port, username, password } = body || {};
  if (typeof label !== 'string' || !label.trim()) return 'Label is required';
  if (label.length > MAX_LABEL) return `Label too long (max ${MAX_LABEL})`;
  if (!PROTOCOLS.has(protocol)) return `Protocol must be one of: ${[...PROTOCOLS].join(', ')}`;
  if (typeof host !== 'string' || !host.trim()) return 'Host is required';
  if (host.length > MAX_HOST) return `Host too long (max ${MAX_HOST})`;
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return 'Port must be an integer between 1 and 65535';
  if (username != null && (typeof username !== 'string' || username.length > MAX_USERNAME)) return `Username too long (max ${MAX_USERNAME})`;
  if (password != null && (typeof password !== 'string' || password.length > MAX_PASSWORD)) return `Password too long (max ${MAX_PASSWORD})`;
  // Chrome's native SOCKS5 proxy support doesn't do SOCKS5 username/password
  // auth (page.authenticate() only handles HTTP(S) proxy auth challenges) —
  // reject rather than silently save credentials that will never be used.
  if (protocol === 'socks5' && (username || password)) {
    return 'SOCKS5 proxies with a username/password are not supported — Chrome only authenticates HTTP/HTTPS proxies this way. Use an IP-allowlisted SOCKS5 proxy instead.';
  }

  return {
    label: label.trim(),
    protocol,
    host: host.trim(),
    port: portNum,
    username: username ? username.trim() : null,
    // Explicit undefined (field omitted) means "leave password unchanged"
    // on update — only coerce to null when the caller sent an empty string.
    password: password === undefined ? undefined : (password || null),
  };
}

function serialize(row, viewerId) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    username: row.username || null,
    hasPassword: !!row.hasPassword,
    isShared: !!row.is_shared,
    scope: row.is_shared ? 'shared' : (row.user_id === viewerId ? 'own' : 'other'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Admin: manage the shared/platform pool ─────────────────────────────────
// Registered before the /:id routes below so "shared" is never swallowed as
// an :id param.
router.post('/shared', requireAdmin, async (req, res) => {
  const v = validate(req.body);
  if (typeof v === 'string') return res.status(400).json({ error: v });
  const row = await proxies.create({ ...v, userId: null, isShared: true });
  res.status(201).json({ proxy: serialize(row, req.user.id) });
});

router.put('/shared/:id', requireAdmin, async (req, res) => {
  const v = validate(req.body);
  if (typeof v === 'string') return res.status(400).json({ error: v });
  const row = await proxies.updateShared({ id: req.params.id, ...v });
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ proxy: serialize(row, req.user.id) });
});

router.delete('/shared/:id', requireAdmin, async (req, res) => {
  const changes = await proxies.removeShared(req.params.id);
  if (changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Everyone: own proxies + the picker list (own + shared) ─────────────────
router.get('/', async (req, res) => {
  const rows = await proxies.listAvailableForUser(req.user.id);
  res.json({ proxies: rows.map((r) => serialize(r, req.user.id)) });
});

router.get('/:id', async (req, res) => {
  const row = await proxies.getForUser(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ proxy: serialize(row, req.user.id) });
});

router.post('/', async (req, res) => {
  const v = validate(req.body);
  if (typeof v === 'string') return res.status(400).json({ error: v });
  const row = await proxies.create({ ...v, userId: req.user.id, isShared: false });
  res.status(201).json({ proxy: serialize(row, req.user.id) });
});

router.put('/:id', async (req, res) => {
  const owned = await proxies.existsForUser(req.params.id, req.user.id);
  if (!owned) return res.status(404).json({ error: 'Not found' });
  const v = validate(req.body);
  if (typeof v === 'string') return res.status(400).json({ error: v });
  const row = await proxies.update({ id: req.params.id, userId: req.user.id, ...v });
  res.json({ proxy: serialize(row, req.user.id) });
});

router.delete('/:id', async (req, res) => {
  const changes = await proxies.remove(req.params.id, req.user.id);
  if (changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
