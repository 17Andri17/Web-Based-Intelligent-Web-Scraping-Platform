'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const MAX_NAME = 80;
const MAX_DESC = 500;
const MAX_CODE = 64 * 1024;
const INPUT_TYPES = new Set(['string', 'number', 'boolean', 'selector', 'json']);

function validate(body) {
  const { name, description, inputs, outputs, code } = body || {};
  if (typeof name !== 'string' || !name.trim()) return 'Name is required';
  if (name.length > MAX_NAME) return `Name too long (max ${MAX_NAME})`;
  if (description != null && typeof description !== 'string') return 'Description must be a string';
  if (description && description.length > MAX_DESC) return `Description too long (max ${MAX_DESC})`;
  if (!Array.isArray(inputs)) return 'Inputs must be an array';
  if (!Array.isArray(outputs)) return 'Outputs must be an array';
  if (typeof code !== 'string') return 'Code must be a string';
  if (code.length > MAX_CODE) return `Code too long (max ${MAX_CODE} chars)`;

  const seenIn = new Set();
  for (const i of inputs) {
    if (!i || typeof i.name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(i.name)) {
      return `Invalid input name: "${i?.name}". Use a valid JS identifier.`;
    }
    if (seenIn.has(i.name)) return `Duplicate input name: ${i.name}`;
    seenIn.add(i.name);
    if (!INPUT_TYPES.has(i.type)) return `Unsupported input type: ${i.type}`;
  }

  const seenOut = new Set();
  for (const o of outputs) {
    if (!o || typeof o.name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(o.name)) {
      return `Invalid output name: "${o?.name}".`;
    }
    if (seenOut.has(o.name)) return `Duplicate output name: ${o.name}`;
    seenOut.add(o.name);
  }

  return {
    name: name.trim(),
    description: (description || '').trim(),
    inputsJson: JSON.stringify(inputs),
    outputsJson: JSON.stringify(outputs),
    code,
  };
}

function serialize(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    inputs: JSON.parse(row.inputs_json || '[]'),
    outputs: JSON.parse(row.outputs_json || '[]'),
    code: row.code || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.get('/', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM custom_actions WHERE user_id = ? ORDER BY updated_at DESC'
  ).all(req.user.id);
  res.json({ customActions: rows.map(serialize) });
});

router.get('/:id', (req, res) => {
  const row = db.prepare(
    'SELECT * FROM custom_actions WHERE id = ? AND user_id = ?'
  ).get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ customAction: serialize(row) });
});

router.post('/', (req, res) => {
  const v = validate(req.body);
  if (typeof v === 'string') return res.status(400).json({ error: v });
  const info = db.prepare(`
    INSERT INTO custom_actions (user_id, name, description, inputs_json, outputs_json, code)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.user.id, v.name, v.description, v.inputsJson, v.outputsJson, v.code);
  const row = db.prepare('SELECT * FROM custom_actions WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ customAction: serialize(row) });
});

router.put('/:id', (req, res) => {
  const owned = db.prepare('SELECT id FROM custom_actions WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!owned) return res.status(404).json({ error: 'Not found' });
  const v = validate(req.body);
  if (typeof v === 'string') return res.status(400).json({ error: v });
  db.prepare(`
    UPDATE custom_actions
    SET name = ?, description = ?, inputs_json = ?, outputs_json = ?, code = ?, updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `).run(v.name, v.description, v.inputsJson, v.outputsJson, v.code, req.params.id, req.user.id);
  const row = db.prepare('SELECT * FROM custom_actions WHERE id = ?').get(req.params.id);
  res.json({ customAction: serialize(row) });
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM custom_actions WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
