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

// Read: navigate to the nested array at containerPath inside rootSteps.
export function getContainer(rootSteps, containerPath) {
  let cursor = rootSteps;
  for (let i = 0; i < containerPath.length; i += 2) {
    const stepIdx  = containerPath[i];
    const branchKey = containerPath[i + 1];
    cursor = cursor[stepIdx][branchKey];
  }
  return cursor;
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

  // ── REPLACE ALL (DnD at root level via arrayMove) ────────────────────
  const setAllSteps = (newSteps) => setSteps(newSteps);

  // Count total steps recursively (for the badge in the tab bar)
  const countAll = (arr) =>
    (arr || []).reduce((sum, step) => {
      if (step.kind === 'control') {
        const branches = Object.values(step).filter(Array.isArray);
        return sum + 1 + branches.reduce((s, b) => s + countAll(b), 0);
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
  };
}