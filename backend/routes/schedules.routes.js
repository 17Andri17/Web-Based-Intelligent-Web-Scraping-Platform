'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const runStore = require('../services/runStore.service');

const router = express.Router();
router.use(requireAuth);

const MIN_INTERVAL = 5;          // 5 minutes — anything shorter just thrashes
const MAX_INTERVAL = 60 * 24 * 7; // a week

function serialize(s) {
  if (!s) return null;
  return {
    id:              s.id,
    workflowId:      s.workflow_id,
    workflowName:    s.workflow_name || null,
    intervalMinutes: s.interval_minutes,
    isActive:        s.is_active === 1,
    anchorAt:        s.anchor_at || null,
    nextRunAt:       s.next_run_at,
    lastRunAt:       s.last_run_at,
    createdAt:       s.created_at,
    updatedAt:       s.updated_at,
  };
}

router.get('/', (req, res) => {
  const list = runStore.listSchedulesForUser(req.user.id);
  res.json({ schedules: list.map(serialize) });
});

router.get('/workflow/:workflowId', (req, res) => {
  const wf = db.prepare('SELECT id, name FROM workflows WHERE id = ? AND user_id = ?')
              .get(req.params.workflowId, req.user.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });
  const s = runStore.getScheduleByWorkflow(req.user.id, req.params.workflowId);
  res.json({ schedule: s ? serialize({ ...s, workflow_name: wf.name }) : null });
});

router.put('/workflow/:workflowId', (req, res) => {
  const workflowId = Number(req.params.workflowId);
  const wf = db.prepare('SELECT id, name FROM workflows WHERE id = ? AND user_id = ?')
              .get(workflowId, req.user.id);
  if (!wf) return res.status(404).json({ error: 'Workflow not found' });

  const { intervalMinutes, isActive, startAtIso } = req.body || {};
  const im = Number(intervalMinutes);
  if (!Number.isFinite(im) || im < MIN_INTERVAL || im > MAX_INTERVAL) {
    return res.status(400).json({ error: `intervalMinutes must be between ${MIN_INTERVAL} and ${MAX_INTERVAL}` });
  }

  let anchorAtIso = null;
  if (startAtIso != null && startAtIso !== '') {
    const t = Date.parse(startAtIso);
    if (Number.isNaN(t)) {
      return res.status(400).json({ error: 'startAtIso must be a valid ISO date string' });
    }
    anchorAtIso = new Date(t).toISOString();
  }

  const saved = runStore.upsertSchedule({
    userId: req.user.id,
    workflowId,
    intervalMinutes: im,
    isActive: isActive !== false,
    anchorAtIso,
  });
  res.json({ schedule: serialize({ ...saved, workflow_name: wf.name }) });
});

router.delete('/workflow/:workflowId', (req, res) => {
  const changes = runStore.deleteSchedule(req.user.id, Number(req.params.workflowId));
  if (!changes) return res.status(404).json({ error: 'No schedule for this workflow' });
  res.json({ ok: true });
});

module.exports = router;
