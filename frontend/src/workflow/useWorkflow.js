import { useState } from "react";

/* =====================================================================
   PATH SYSTEM
   =====================================================================
   A "container path" identifies a nested array inside the step tree.
   It is an alternating array of [stepIndex, branchKey] pairs.

   Examples:
     []                           → the root steps array
     [2, 'then']                  → 'then' branch of step index 2
     [2, 'then', 0, 'body']       → 'body' of step 0 inside that 'then'

   All public functions accept (containerPath, index, ...data).
   ===================================================================== */

// Update a step anywhere in the tree by its ID (for cross-path label changes)
function updateStepById(rootSteps, id, mapper) {
  return rootSteps.map(step => {
    if (step.id === id) return mapper(step);
    const updated = { ...step };
    for (const key of Object.keys(updated)) {
      if (Array.isArray(updated[key])) {
        updated[key] = updateStepById(updated[key], id, mapper);
      }
    }
    return updated;
  });
}

const BRANCH_KEYS = ['body','then','else','try','catch'];

/** Find a step by ID → returns { containerPath, index } or null */
export function findStepLocation(steps, stepId, containerPath = []) {
  for (let i = 0; i < (steps || []).length; i++) {
    if (steps[i].id === stepId) return { containerPath, index: i };
    for (const key of BRANCH_KEYS) {
      if (Array.isArray(steps[i][key])) {
        const found = findStepLocation(steps[i][key], stepId, [...containerPath, i, key]);
        if (found) return found;
      }
    }
  }
  return null;
}

/** How many steps move together when `stepId` is dragged: the step itself
    plus every CONTIGUOUS following sibling flagged `attach` ("stuck to the
    previous step" — e.g. a Close Cookie Banner right after its Navigate). */
export function attachedGroupSize(rootSteps, stepId) {
  const loc = findStepLocation(rootSteps, stepId);
  if (!loc) return 1;
  const container = getContainer(rootSteps, loc.containerPath);
  if (!container || !Array.isArray(container)) return 1;
  let n = 1;
  while (loc.index + n < container.length && container[loc.index + n]?.attach) n++;
  return n;
}

// Read: navigate to the nested array at containerPath inside rootSteps.
// Returns null (never throws) when path is stale/invalid.
export function getContainer(rootSteps, containerPath) {
  let cursor = rootSteps;
  try {
    for (let i = 0; i < containerPath.length; i += 2) {
      const stepIdx  = containerPath[i];
      const branchKey = containerPath[i + 1];
      if (!cursor || !Array.isArray(cursor) || cursor[stepIdx] == null) return null;
      cursor = cursor[stepIdx][branchKey];
    }
    return cursor;
  } catch(e) {
    return null;
  }
}

// Write: return a new rootSteps where the array at containerPath has been
// replaced by updater(currentArray).
function updateContainer(rootSteps, containerPath, updater) {
  if (containerPath.length === 0) {
    return updater([...rootSteps]);
  }

  const [stepIdx, branchKey, ...restPath] = containerPath;

  return rootSteps.map((step, i) => {
    if (i !== stepIdx) return step;
    return {
      ...step,
      [branchKey]: updateContainer(step[branchKey] ?? [], restPath, updater),
    };
  });
}

// Write: update a single step at (containerPath, index) using mapper.
function updateStepAt(rootSteps, containerPath, index, mapper) {
  return updateContainer(rootSteps, containerPath, (arr) =>
    arr.map((s, i) => (i === index ? mapper(s) : s))
  );
}

/** Pure move: relocate the step with `stepId` (plus `count - 1` following
    siblings, moved as one block) to (targetContainerPath, targetIndex).
    Returns the new tree, or `prev` unchanged when the move is invalid
    (unknown step, target inside the moved block, stale path). Exported for
    tests; the hook's moveStepById wraps it in setSteps. */
export function moveStepInTree(prev, stepId, targetContainerPath, targetIndex, count = 1) {
  try {
    const srcLoc = findStepLocation(prev, stepId);
    if (!srcLoc) return prev;

    const clone = JSON.parse(JSON.stringify(prev));
    const srcContainer = getContainer(clone, srcLoc.containerPath);
    if (!srcContainer || !Array.isArray(srcContainer)) return prev;
    const n = Math.max(1, Math.min(count, srcContainer.length - srcLoc.index));
    const removed = srcContainer.splice(srcLoc.index, n);
    if (removed.length === 0) return prev;

    // After removing the block, any path that traverses the same array
    // PAST it gets that index shifted down by n. A path THROUGH the
    // removed block means "drop the group inside itself" — abort.
    const adj = [...targetContainerPath];
    let samePrefix = true;
    for (let i = 0; i < srcLoc.containerPath.length; i++) {
      if (adj[i] !== srcLoc.containerPath[i]) { samePrefix = false; break; }
    }
    const levelIdx = srcLoc.containerPath.length; // slot in adj holding the src array's step-index
    if (samePrefix && levelIdx < adj.length && typeof adj[levelIdx] === 'number') {
      if (adj[levelIdx] >= srcLoc.index && adj[levelIdx] < srcLoc.index + n) return prev;
      if (adj[levelIdx] >= srcLoc.index + n) adj[levelIdx] -= n;
    }

    const container = getContainer(clone, adj);
    if (!container || !Array.isArray(container)) return prev;

    let idx = (targetIndex !== null && targetIndex !== undefined) ? targetIndex : container.length;
    if (container === srcContainer && idx > srcLoc.index) {
      // Same-array move: slots past the removed block shift down by n;
      // a slot inside the (now removed) block collapses to its old spot.
      idx = idx >= srcLoc.index + n ? idx - n : srcLoc.index;
    }
    idx = Math.max(0, Math.min(idx, container.length));
    container.splice(idx, 0, ...removed);
    return clone;
  } catch (e) { console.warn('moveStepInTree failed:', e); return prev; }
}

/* =====================================================================
   HOOK
   ===================================================================== */
export function useWorkflow() {
  const [steps, setSteps] = useState([]);

  // ── ADD ─────────────────────────────────────────────────────────────
  // If index is null / undefined, step is appended; otherwise inserted before index.
  const addStep = (step, containerPath = [], index = null) => {
    setSteps(prev =>
      updateContainer(prev, containerPath, (arr) => {
        const next = [...arr];
        if (index === null || index === undefined || index >= next.length) {
          next.push(step);
        } else {
          next.splice(index, 0, step);
        }
        return next;
      })
    );
  };

  // ── UPDATE ──────────────────────────────────────────────────────────
  // Replace the step at (containerPath, index) with newStep.
  const updateStep = (containerPath, index, newStep) => {
    setSteps(prev => updateStepAt(prev, containerPath, index, () => newStep));
  };

  // ── DELETE ──────────────────────────────────────────────────────────
  const deleteStep = (containerPath, index) => {
    setSteps(prev =>
      updateContainer(prev, containerPath, (arr) =>
        arr.filter((_, i) => i !== index)
      )
    );
  };

  // ── REORDER (DnD within same container) ─────────────────────────────
  const reorderSteps = (containerPath, fromIndex, toIndex) => {
    setSteps(prev =>
      updateContainer(prev, containerPath, (arr) => {
        const next = [...arr];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        return next;
      })
    );
  };

  // ── UPDATE CONTROL PARAMS ────────────────────────────────────────────
  // Update just the params of a control/action step without replacing it entirely.
  const updateParams = (containerPath, index, newParams) => {
    setSteps(prev =>
      updateStepAt(prev, containerPath, index, (step) => ({
        ...step,
        params: { ...step.params, ...newParams },
      }))
    );
  };

  // ── UPDATE LABEL BY ID (for DataPreviewPanel naming) ──────────────────
  const updateLabelById = (id, label) => {
    setSteps(prev => updateStepById(prev, id, step => ({ ...step, label })));
  };

  // Update specific params fields on any step by ID (used by CompactWorkflowSidebar)
  const updateParamsById = (id, paramsPatch) => {
    setSteps(prev => updateStepById(prev, id, step => ({
      ...step,
      params: { ...(step.params || {}), ...paramsPatch },
    })));
  };

  // Insert a step at a specific containerPath + index (null = end)
  const addStepAt = (step, containerPath, index) => {
    setSteps(prev => {
      try {
        const clone = JSON.parse(JSON.stringify(prev));
        const container = getContainer(clone, containerPath);
        if (!container || !Array.isArray(container)) return prev;
        const idx = (index !== null && index !== undefined) ? index : container.length;
        container.splice(Math.max(0, Math.min(idx, container.length)), 0, step);
        return clone;
      } catch(e) { console.warn('addStepAt failed:', e); return prev; }
    });
  };

  // Move a step (by ID) to a new location — remove then insert. `count` > 1
  // moves the step plus its (count - 1) following siblings as one block:
  // that's how attached steps (step.attach) travel with their leader.
  // Handles same-container moves too (indices past the removed block shift
  // down by `count`), so drag & drop can route every move through here.
  const moveStepById = (stepId, targetContainerPath, targetIndex, count = 1) => {
    setSteps(prev => moveStepInTree(prev, stepId, targetContainerPath, targetIndex, count));
  };

  // Toggle the "stuck to the previous step" flag (see attachedGroupSize).
  const setAttachById = (id, attach) => {
    setSteps(prev => updateStepById(prev, id, step => {
      const next = { ...step };
      if (attach) next.attach = true;
      else delete next.attach;
      return next;
    }));
  };

  // ── REPLACE ALL (DnD at root level via arrayMove) ────────────────────
  const setAllSteps = (newSteps) => setSteps(newSteps);

  // Count total steps recursively (for the badge in the tab bar).
  // Only walk the known control branches — Object.values picks up
  // unrelated arrays like `previewElements` on FOR_EACH, which would
  // inflate the count by the number of matched DOM elements.
  const countAll = (arr) =>
    (arr || []).reduce((sum, step) => {
      if (step.kind === 'control') {
        const childCount = BRANCH_KEYS.reduce(
          (s, key) => s + (Array.isArray(step[key]) ? countAll(step[key]) : 0),
          0
        );
        return sum + 1 + childCount;
      }
      return sum + 1;
    }, 0);

  return {
    steps,
    totalCount: countAll(steps),
    setSteps:      setAllSteps,
    addStep,
    updateStep,
    deleteStep,
    reorderSteps,
    updateParams,
    updateLabelById,
    updateParamsById,
    addStepAt,
    moveStepById,
    setAttachById,
  };
}