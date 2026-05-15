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

module.exports = { clone, walk, findStepById, patchStepParams, collectCustomActionIds, CHILD_KEYS };
