import { useState } from "react";

export function useWorkflow() {
  const [steps, setSteps] = useState([]);

  const addStep = (step) => {
    setSteps(prev => [...prev, step]);
  };

  const updateStep = (index, newStep) => {
    setSteps(prev => {
      const updated = [...prev];
      updated[index] = newStep;
      return updated;
    });
  };

  return {
    steps,
    addStep,
    updateStep
  };
}