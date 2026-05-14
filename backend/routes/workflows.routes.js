'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const MAX_NAME_LEN = 120;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2 MB cap per workflow

function serializeWorkflow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    steps: JSON.parse(row.steps_json),
    meta: row.meta_json ? JSON.parse(row.meta_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validatePayload(body) {
  const { name, steps, meta } = body || {};
  if (typeof name !== 'string' || !name.trim()) return 'Name is required';
  if (name.length > MAX_NAME_LEN) return `Name too long (max ${MAX_NAME_LEN})`;
  if (!Array.isArray(steps)) return 'Steps must be an array';
  const stepsJson = JSON.stringify(steps);
  if (Buffer.byteLength(stepsJson, 'utf8') > MAX_PAYLOAD_BYTES) return 'Workflow too large';
  const metaJson = meta == null ? null : JSON.stringify(meta);
  return { name: name.trim(), stepsJson, metaJson };
}

// List all workflows for the user (summary only — no steps payload)
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT id, name, created_at, updated_at
    FROM workflows
    WHERE user_id = ?
    ORDER BY updated_at DESC
  `).all(req.user.id);
  res.json({ workflows: rows.map(r => ({
    id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at,
  })) });
});

// Get full workflow by id
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM workflows WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ workflow: serializeWorkflow(row) });
});

// Create new workflow
router.post('/', (req, res) => {
  const v = validatePayload(req.body);
  if (typeof v === 'string') return res.status(400).json({ error: v });
  const info = db.prepare(`
    INSERT INTO workflows (user_id, name, steps_json, meta_json)
    VALUES (?, ?, ?, ?)
  `).run(req.user.id, v.name, v.stepsJson, v.metaJson);
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ workflow: serializeWorkflow(row) });
});

// Update existing workflow (overwrite)
router.put('/:id', (req, res) => {
  const owned = db.prepare('SELECT id FROM workflows WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!owned) return res.status(404).json({ error: 'Not found' });
  const v = validatePayload(req.body);
  if (typeof v === 'string') return res.status(400).json({ error: v });
  db.prepare(`
    UPDATE workflows
    SET name = ?, steps_json = ?, meta_json = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `).run(v.name, v.stepsJson, v.metaJson, req.params.id, req.user.id);
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(req.params.id);
  res.json({ workflow: serializeWorkflow(row) });
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM workflows WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
