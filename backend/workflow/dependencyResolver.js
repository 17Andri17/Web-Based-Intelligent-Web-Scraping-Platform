'use strict';

const workflowsRepo     = require('../db/repositories/workflows.repo');
const customActionsRepo = require('../db/repositories/customActions.repo');
const { collectCustomActionIds, collectSubflowIds } = require('./workflowUtils');

/* ===========================================================================
   dependencyResolver
   ---------------------------------------------------------------------------
   Resolve a workflow's codegen-time dependencies from the DB:

     • resolveCustomActions — the user-owned CUSTOM_ACTION definitions a step
       tree references, as { [id]: { name, inputs, outputs, code } }.
     • resolveSubflows — the user-owned workflows referenced (directly or
       transitively) by RUN_SUBFLOW steps, as { [id]: { id, name, steps, meta } }.

   This was previously duplicated verbatim in server.js (interactive runs) and
   scheduler.service.js (scheduled runs). Both now call this single async
   module, which talks to the repos / async DB client (migration slice 6).
   ========================================================================= */

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

async function resolveCustomActions(steps, userId) {
  const ids = collectCustomActionIds(steps);
  if (ids.length === 0) return {};
  const rows = await customActionsRepo.getManyByIds(userId, ids);
  const out = {};
  for (const r of rows) {
    out[r.id] = {
      name: r.name,
      inputs:  safeJson(r.inputs_json)  || [],
      outputs: safeJson(r.outputs_json) || [],
      code: r.code || '',
    };
  }
  return out;
}

// Breadth-first walk of RUN_SUBFLOW references. We follow subflows recursively
// so a subflow that itself runs another subflow also gets resolved; cycle
// protection is the `visited` set (seeded with the root workflow id).
async function resolveSubflows(steps, userId, rootWorkflowId = null) {
  const visited = new Set(rootWorkflowId ? [Number(rootWorkflowId)] : []);
  const out = {};
  const queue = collectSubflowIds(steps).filter(id => !visited.has(id));

  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const row = await workflowsRepo.getForUser(id, userId);
    if (!row) continue;
    const subSteps = safeJson(row.steps_json) || [];
    const subMeta  = row.meta_json ? safeJson(row.meta_json) : {};
    out[id] = { id: row.id, name: row.name, steps: subSteps, meta: subMeta };
    collectSubflowIds(subSteps).forEach(child => { if (!visited.has(child)) queue.push(child); });
  }
  return out;
}

module.exports = { resolveCustomActions, resolveSubflows };
