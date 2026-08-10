'use strict';

// Durable partial results — see docs/PLATFORM_ANALYSIS.md §5.4.
//
// Before this, a run's data existed only in the child process's memory and was
// serialised exactly once, at the end, as a single WORKFLOW_RESULTS: line. A
// crash / timeout / OOM / cancel anywhere before that line lost EVERYTHING the
// run had scraped. On a long job (thousands of detail pages) that is hours of
// work thrown away.
//
// The generated script now emits incremental RESULT_CHUNK: deltas as it goes;
// the parent accumulates them and check-points here. Because the data is out of
// the child by then, it survives even SIGKILL.
//
//   • partial_results_json — the accumulated results as of the last checkpoint.
//                            Written periodically DURING the run and cleared on
//                            a clean finish (results_json is authoritative then).
//   • rows_captured        — running row count, so run lists can show progress
//                            without parsing the JSON blob.
//
// A run that dies mid-flight is finished with status 'partial' and its
// accumulated data promoted into results_json.

module.exports = {
  id: '0008_partial_results',
  up() {
    return [
      `ALTER TABLE runs ADD COLUMN partial_results_json TEXT`,
      `ALTER TABLE runs ADD COLUMN rows_captured INTEGER NOT NULL DEFAULT 0`,
    ];
  },
};
