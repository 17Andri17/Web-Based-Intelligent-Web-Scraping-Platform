'use strict';

// Resume support — see backend/services/resume.service.js.
//
//   progress_json — per-step record of which items a run actually finished,
//                   shaped { steps: { <stepId>: { urls: [...] } } }.
//
// Why a separate column instead of deriving it from results_json: a subflow
// result carries its own `_sourceUrl`, but __enrichRows relocates that key
// depending on the merge strategy (top-level for flat/explode, prefixed for
// prefix, nested for nest) and a user field-transform can drop it outright.
// Recording completions explicitly keeps resume correct regardless of what the
// workflow does to the shape of its own output.
//
// Written alongside the partial-results checkpoint (same debounce), so a run
// that dies mid-flight leaves behind both the rows it captured AND the exact
// set of items those rows came from.

module.exports = {
  id: '0009_run_progress',
  up() {
    return [
      `ALTER TABLE runs ADD COLUMN progress_json TEXT`,
    ];
  },
};
