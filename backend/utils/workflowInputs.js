'use strict';

/* ===========================================================================
   workflowInputs
   ---------------------------------------------------------------------------
   Validation for per-run variable overrides ("inputs"), shared by the public
   /v1 trigger and the internal bulk-run / run-with-inputs routes so all three
   accept and reject inputs identically. An input object maps a workflow's
   declared variable names to override values; unknown names and nulls are
   rejected (omit a variable to use its default). Application of the overrides
   onto meta.variables lives in apiWorker.applyInputs.
   ========================================================================= */

// The set of variable names a workflow declares in its meta.
function declaredVariableNames(meta) {
  const vars = meta && Array.isArray(meta.variables) ? meta.variables : [];
  return new Set(
    vars.filter(v => v && typeof v.name === 'string' && v.name.trim()).map(v => v.name)
  );
}

// Validate one inputs object against a workflow's declared variables.
// Returns an error string, or null when the inputs are acceptable.
function validateInputs(meta, inputs) {
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) {
    return '"inputs" must be an object mapping variable names to values.';
  }
  const declared = declaredVariableNames(meta);
  const unknown = Object.keys(inputs).filter(k => !declared.has(k));
  if (unknown.length) {
    const available = declared.size
      ? `Declared variables: ${[...declared].join(', ')}.`
      : 'This workflow declares no variables.';
    return `Unknown input(s): ${unknown.join(', ')}. ${available}`;
  }
  const nulls = Object.keys(inputs).filter(k => inputs[k] === null);
  if (nulls.length) {
    return `Input(s) must not be null: ${nulls.join(', ')}. Omit a variable to use its default value.`;
  }
  return null;
}

module.exports = { declaredVariableNames, validateInputs };
