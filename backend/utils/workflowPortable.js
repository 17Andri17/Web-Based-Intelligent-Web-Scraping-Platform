'use strict';

/* ===========================================================================
   workflowPortable
   ---------------------------------------------------------------------------
   Export / import of workflows as a self-contained JSON envelope, and the
   custom-action ID remapping that makes an import portable across accounts.

   An export bundles the workflow's steps, its meta (with the per-user proxy
   binding stripped — it means nothing elsewhere), and the DEFINITIONS of any
   custom actions the steps reference. On import those definitions are recreated
   in the target account (or reused when a same-named one already exists) and
   the CUSTOM_ACTION.actionId references in the steps are remapped to the new
   ids — so a workflow exported from one account runs in another.

   Subflows (RUN_SUBFLOW → another workflow) are NOT deep-bundled in v1: the
   reference is preserved (works when re-imported into the same account) but
   won't resolve across accounts; callers surface that as a note.
   ========================================================================= */

const { clone, walk } = require('../workflow/workflowUtils');

const EXPORT_FORMAT = 'scraper-workflow';
const EXPORT_VERSION = 1;

// Runtime bindings that don't transfer (a proxy id references one user's proxy).
function stripMetaForExport(meta) {
  const m = meta && typeof meta === 'object' ? { ...meta } : {};
  delete m.proxy;
  delete m.proxyId;
  return m;
}

function buildEnvelope({ name, steps, meta, customActions }) {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    name: name || 'Workflow',
    steps: Array.isArray(steps) ? steps : [],
    meta: stripMetaForExport(meta || {}),
    // [{ id, name, description, inputs, outputs, code }]
    customActions: Array.isArray(customActions) ? customActions : [],
  };
}

// Validate an incoming envelope. Returns { ok } or { ok:false, error }.
function validateEnvelope(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return { ok: false, error: 'Not a valid workflow file.' };
  if (env.format !== EXPORT_FORMAT) {
    return { ok: false, error: `Unrecognized file${env.format ? ` (format "${env.format}")` : ''} — expected a ${EXPORT_FORMAT} export.` };
  }
  if (!Number.isInteger(env.version) || env.version < 1 || env.version > EXPORT_VERSION) {
    return { ok: false, error: `Unsupported export version ${env.version}. This build reads up to v${EXPORT_VERSION}.` };
  }
  if (!Array.isArray(env.steps)) return { ok: false, error: 'File has no steps.' };
  return { ok: true };
}

/* Ensure every bundled custom action referenced by `steps` exists in the target
   account, and return NEW steps with actionId references remapped.
     bundled        : [{ id, name, description, inputs, outputs, code }]
     existingByName : Map(name -> row)  — mutated as new ones are created
     createAction   : async (def) -> newRow  (must return { id })
   Returns { steps, created:[names], missing:[oldIds referenced but not bundled] } */
async function remapCustomActions(steps, bundled, existingByName, createAction) {
  const bundledById = new Map((bundled || []).map(a => [String(a.id), a]));
  const remapped = clone(steps);

  const referenced = new Set();
  walk(remapped, (s) => {
    if (s.kind === 'action' && s.type === 'CUSTOM_ACTION' && s.params && s.params.actionId != null) {
      referenced.add(String(s.params.actionId));
    }
  });

  const idMap = new Map();      // oldId(string) -> newId
  const created = [];
  const missing = [];
  for (const oldId of referenced) {
    const def = bundledById.get(oldId);
    if (!def) { missing.push(oldId); continue; } // not bundled — leave the ref as-is
    const existing = existingByName.get(def.name);
    if (existing) { idMap.set(oldId, existing.id); continue; }
    const row = await createAction(def);
    idMap.set(oldId, row.id);
    existingByName.set(def.name, row);
    created.push(def.name);
  }

  walk(remapped, (s) => {
    if (s.kind === 'action' && s.type === 'CUSTOM_ACTION' && s.params) {
      const k = String(s.params.actionId);
      if (idMap.has(k)) s.params.actionId = idMap.get(k);
    }
  });

  return { steps: remapped, created, missing };
}

// Filesystem-safe base name for the downloaded file.
function exportFileName(name) {
  const base = String(name || 'workflow').replace(/[^a-zA-Z0-9-_ ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'workflow';
  return `${base}.workflow.json`;
}

module.exports = {
  EXPORT_FORMAT, EXPORT_VERSION,
  stripMetaForExport, buildEnvelope, validateEnvelope, remapCustomActions, exportFileName,
};
