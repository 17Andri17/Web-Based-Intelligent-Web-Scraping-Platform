'use strict';

// The guided tour builds a real, runnable scraper on the bundled DemoMart
// shop — and running it needs somewhere to hang the run row, the logs and the
// captured results, because the whole execution pipeline is built around a
// persisted workflow.
//
// That workflow is a teaching prop, not the user's work, so it is flagged
// here instead of being an ordinary row:
//
//   is_demo — 1 for the tour's throwaway workflow. Demo rows are hidden from
//             every list the user sees, their runs are neither metered nor
//             counted against the plan, and the row (with its runs, logs and
//             versions, which all cascade) is deleted the moment the tour is
//             finished or abandoned.
//
// One per user at most; see workflows.repo.findDemoForUser.

module.exports = {
  id: '0015_demo_workflows',
  up() {
    return [
      `ALTER TABLE workflows ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0`,
      `CREATE INDEX IF NOT EXISTS idx_workflows_demo ON workflows(user_id, is_demo)`,
    ];
  },
};
