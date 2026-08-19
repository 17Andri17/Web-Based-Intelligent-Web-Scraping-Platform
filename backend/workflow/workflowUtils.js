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

// Build a LIGHT, display-only step tree for the live "Flow" tab: the same
// tree, but with each RUN_SUBFLOW's referenced steps inlined under a
// `subflowSteps` array — mirroring what the codegen actually runs (including
// stripping a subflow's leading pinned NAVIGATE) — so the Flow tab can show
// the exact steps a subflow runs, and mark iterations when it runs per-row.
//
// Only the fields the Flow renderer needs are kept (id / type / kind / label,
// plus RUN_SUBFLOW mode) so the payload stays small. Cycles are broken with a
// visited set seeded with the root workflow id, matching resolveSubflows and
// the codegen's inlining guard. `subflows` is the { [id]: { name, steps } }
// map returned by resolveSubflows.
// `opts.withSelectors` adds each step's configured selector to its node. Off
// by default and deliberately so: every watcher of every run receives this
// tree, and a selector on every node is payload nobody reads. A DEBUG run is
// the exception — its window names what the running step is targeting while
// the run moves, which is the difference between "extract list is running" and
// "extract list is looking for .product-card".
function buildFlowTree(steps, subflows = {}, rootWorkflowId = null, opts = {}) {
  const seed = new Set(rootWorkflowId != null ? [String(rootWorkflowId)] : []);
  const withSelectors = !!opts.withSelectors;

  const light = (step, visited) => {
    if (!step || typeof step !== 'object') return null;
    const node = {
      id:    step.id || null,
      type:  step.type || null,
      kind:  step.kind || 'action',
      label: step.label || '',
    };
    if (withSelectors) {
      const p = step.params || {};
      // The one selector that identifies what this step acts on, by step type.
      const sel = p.selector || p.containerSelector || p.tableSelector || null;
      if (sel) node.selector = String(sel);
      if (p.url) node.url = String(p.url);
    }
    // RUN_SUBFLOW's mode drives the iteration badge (iterate / enrich).
    if (step.type === 'RUN_SUBFLOW') {
      node.params = { mode: (step.params && step.params.mode) || 'single' };
    }
    // Control branches (body / then / else / try / catch).
    for (const k of CHILD_KEYS) {
      if (Array.isArray(step[k]) && step[k].length) {
        node[k] = step[k].map(s => light(s, visited)).filter(Boolean);
      }
    }
    // Inline the referenced subflow's steps under `subflowSteps`.
    if (step.kind === 'action' && step.type === 'RUN_SUBFLOW') {
      const wid = step.params && step.params.workflowId;
      const subId = wid != null && wid !== '' ? String(wid) : null;
      const sub = subId != null ? (subflows[subId] || subflows[wid]) : null;
      if (sub && Array.isArray(sub.steps) && subId && !visited.has(subId)) {
        const nextVisited = new Set(visited);
        nextVisited.add(subId);
        let subSteps = sub.steps;
        // Mirror codegen: a subflow's leading pinned NAVIGATE is dropped when
        // inlined (the parent supplies the URL), so it never runs — don't show
        // it. But when this step lets the subflow navigate itself
        // (selfNavigate), that leading NAVIGATE IS what runs — keep it visible.
        const selfNav = !!(step.params && step.params.selfNavigate);
        if (!selfNav && subSteps[0] && subSteps[0].kind === 'action' && subSteps[0].type === 'NAVIGATE') {
          subSteps = subSteps.slice(1);
        }
        node.subflowName = sub.name || null;
        node.subflowSteps = subSteps.map(s => light(s, nextVisited)).filter(Boolean);
      }
    }
    return node;
  };

  return (Array.isArray(steps) ? steps : []).map(s => light(s, seed)).filter(Boolean);
}

module.exports = {
  clone, walk, findStepById, patchStepParams,
  removeStepById, removeListField, setStepParams,
  collectCustomActionIds, collectSubflowIds, buildFlowTree, CHILD_KEYS,
};
