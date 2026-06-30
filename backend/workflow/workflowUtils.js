'use strict';

/* ===========================================================================
   Pure functional helpers over the workflow step tree.

   Steps form a tree with branches under `body`, `then`, `else`, `try`, `catch`.
   ========================================================================= */

const CHILD_KEYS = ['body', 'then', 'else', 'try', 'catch'];

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// Walk every step, invoking visit(step, parentArray, indexInParent). Returns
// nothing — callers usually mutate via the parentArray reference.
function walk(steps, visit, parentArray = steps) {
  if (!Array.isArray(steps)) return;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s) continue;
    visit(s, parentArray, i);
    for (const k of CHILD_KEYS) {
      if (Array.isArray(s[k])) walk(s[k], visit, s[k]);
    }
  }
}

function findStepById(steps, id) {
  if (!id) return null;
  let found = null;
  walk(steps, (s) => { if (!found && s.id === id) found = s; });
  return found;
}

// Returns a new top-level steps array with the matching step's params merged
// with `patch`. If no step is found, returns the steps unchanged.
function patchStepParams(steps, stepId, patch) {
  const copy = clone(steps);
  let patched = false;
  walk(copy, (s) => {
    if (!patched && s.id === stepId) {
      s.params = { ...(s.params || {}), ...(patch || {}) };
      patched = true;
    }
  });
  return { steps: copy, patched };
}

// Remove the step with the given id from the tree. Returns a new steps array
// plus the removed step (or null) so the caller can tell the user exactly
// what was dropped. Used by self-healing when a targeted element genuinely
// disappeared from the page and the step can no longer extract anything.
function removeStepById(steps, stepId) {
  const copy = clone(steps);
  let removed = null;
  (function prune(arr) {
    if (!Array.isArray(arr)) return;
    for (let i = arr.length - 1; i >= 0; i--) {
      const s = arr[i];
      if (!s) continue;
      if (!removed && s.id === stepId) { removed = s; arr.splice(i, 1); continue; }
      for (const k of CHILD_KEYS) if (Array.isArray(s[k])) prune(s[k]);
    }
  })(copy);
  return { steps: copy, removed };
}

// Drop a single field from an EXTRACT_LIST step's `params.fields` map (the
// "this one field disappeared, keep the rest" healing path). Returns the new
// steps array and the dropped field spec (or null if nothing changed).
function removeListField(steps, stepId, fieldName) {
  const copy = clone(steps);
  let dropped = null;
  walk(copy, (s) => {
    if (dropped || s.id !== stepId) return;
    const fields = s.params && s.params.fields;
    if (fields && Object.prototype.hasOwnProperty.call(fields, fieldName)) {
      dropped = fields[fieldName];
      delete fields[fieldName];
    }
  });
  return { steps: copy, dropped };
}

// Replace the whole params object of a step (used when healing rewrites the
// container selector AND the per-item field selectors in one shot). Returns
// { steps, patched }.
function setStepParams(steps, stepId, newParams) {
  const copy = clone(steps);
  let patched = false;
  walk(copy, (s) => {
    if (!patched && s.id === stepId) {
      s.params = { ...(newParams || {}) };
      patched = true;
    }
  });
  return { steps: copy, patched };
}

// Walk every CUSTOM_ACTION step and collect referenced ids. Used by the
// scheduler so it can resolve the user's custom action definitions before
// dispatching to the runner.
function collectCustomActionIds(steps) {
  const ids = new Set();
  walk(steps, (s) => {
    if (s.kind === 'action' && s.type === 'CUSTOM_ACTION') {
      const id = s.params && s.params.actionId;
      if (id != null) ids.add(id);
    }
  });
  return Array.from(ids);
}

// Collect the workflow ids referenced by RUN_SUBFLOW steps (one level — the
// caller recurses into fetched subflows). Mirrors collectCustomActionIds.
function collectSubflowIds(steps) {
  const ids = new Set();
  walk(steps, (s) => {
    if (s.kind === 'action' && s.type === 'RUN_SUBFLOW') {
      const id = s.params && Number(s.params.workflowId);
      if (Number.isFinite(id) && id > 0) ids.add(id);
    }
  });
  return Array.from(ids);
}

module.exports = {
  clone, walk, findStepById, patchStepParams,
  removeStepById, removeListField, setStepParams,
  collectCustomActionIds, collectSubflowIds, CHILD_KEYS,
};
