'use strict';

const express = require('express');
const workflows = require('../db/repositories/workflows.repo');
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

// Extract the workflow's declared input variables (variables flagged
// `input`) from its meta JSON, as a compact list the subflow picker can map
// parent data onto. Never throws on malformed meta — returns [].
function inputVarsFromMeta(metaJson) {
  if (!metaJson) return [];
  let meta;
  try { meta = JSON.parse(metaJson); } catch (_) { return []; }
  const vars = Array.isArray(meta?.variables) ? meta.variables : [];
  return vars
    .filter(v => v && typeof v === 'object' && v.input && v.name)
    .map(v => ({
      name: String(v.name),
      type: v.type || 'string',
      value: v.value == null ? '' : String(v.value),
      description: v.description ? String(v.description) : '',
    }));
}

// List all workflows for the user (summary only — no steps payload).
router.get('/', async (req, res) => {
  const rows = await workflows.listSummariesForUser(req.user.id);
  res.json({ workflows: rows.map(r => ({
    id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at,
    inputs: inputVarsFromMeta(r.meta_json),
  })) });
});

// Get full workflow by id
router.get('/:id', async (req, res) => {
  const row = await workflows.getForUser(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ workflow: serializeWorkflow(row) });
});

// Create new workflow
router.post('/', async (req, res) => {
  const v = validatePayload(req.body);
  if (typeof v === 'string') return res.status(400).json({ error: v });
  const row = await workflows.create({
    userId: req.user.id, name: v.name, stepsJson: v.stepsJson, metaJson: v.metaJson,
  });
  res.status(201).json({ workflow: serializeWorkflow(row) });
});

// Update existing workflow (overwrite)
router.put('/:id', async (req, res) => {
  const owned = await workflows.existsForUser(req.params.id, req.user.id);
  if (!owned) return res.status(404).json({ error: 'Not found' });
  const v = validatePayload(req.body);
  if (typeof v === 'string') return res.status(400).json({ error: v });
  const row = await workflows.update({
    id: req.params.id, userId: req.user.id,
    name: v.name, stepsJson: v.stepsJson, metaJson: v.metaJson,
  });
  res.json({ workflow: serializeWorkflow(row) });
});

router.delete('/:id', async (req, res) => {
  const changes = await workflows.remove(req.params.id, req.user.id);
  if (changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
