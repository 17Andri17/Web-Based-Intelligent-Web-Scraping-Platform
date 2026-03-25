import { useState } from "react";

export function useWorkflow() {
  const [steps, setSteps] = useState([]);

  /* ========================= ADD STEP ========================= */
  // insert at index OR append if index not provided
  const addStep = (step, index = null) => {
    setSteps((prev) => {
      const newSteps = [...prev];

      if (index === null || index >= prev.length) {
        newSteps.push(step);
      } else {
        newSteps.splice(index, 0, step);
      }

      return newSteps;
    });
  };

  /* ========================= UPDATE STEP ========================= */
  const updateStep = (index, newStep) => {
    setSteps((prev) => {
      if (!prev[index]) return prev;

      const updated = [...prev];
      updated[index] = newStep;
      return updated;
    });
  };

  /* ========================= REMOVE STEP ========================= */
  const removeStep = (index) => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  };

  /* ========================= REORDER (for DnD fallback) ========================= */
  const reorderSteps = (fromIndex, toIndex) => {
    setSteps((prev) => {
      if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= prev.length ||
        toIndex >= prev.length
      ) {
        return prev;
      }

      const updated = [...prev];
      const [moved] = updated.splice(fromIndex, 1);
      updated.splice(toIndex, 0, moved);

      return updated;
    });
  };

  /* ========================= REPLACE ALL (for DnD) ========================= */
  // used directly by dnd-kit (arrayMove)
  const setAllSteps = (newSteps) => {
    setSteps(newSteps);
  };

  return {
    steps,
    setSteps: setAllSteps, // 👈 used by DnD
    addStep,
    updateStep,
    removeStep,
    reorderSteps
  };
}