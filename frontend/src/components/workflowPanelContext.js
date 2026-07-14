import React from "react";

// Shared context for the workflow editor: the step tree, workflow variables,
// captured extraction outputs, and the available-workflows list. Lives in its
// own module so WorkflowPanel and helper components (ConditionBuilder, field
// renderers) can consume it without a circular import.
export const WPCtx = React.createContext(null);
