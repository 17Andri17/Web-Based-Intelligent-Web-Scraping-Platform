'use strict';

// Change monitoring — see docs/PLATFORM_ANALYSIS.md §6.5.
//
//   • workflow_monitors — per-workflow "watch for changes" config. Operational
//     state (like schedules), deliberately NOT part of the workflow definition
//     / version history, so toggling monitoring never mutates a workflow
//     version or shows up in rollback. One row per workflow (unique).
//       output_key : which extracted list to watch; NULL = the primary list
//                    (auto-picked from each run's results).
//       key_field  : dedupe field rows are matched on across runs;
//                    NULL = whole-row match.
//   • runs.change_summary_json — the compact diff summary (counts + a bounded
//     sample) computed for a successful run against the previous successful
//     run of the same workflow, so the history/dashboard can show what changed
//     without recomputing. NULL when the workflow isn't monitored or there was
//     no prior run to compare against.

const { pk, fk } = require('../schema');

module.exports = {
  id: '0005_change_monitoring',
  up(dialect) {
    const ID = pk(dialect);
    const FK = fk(dialect);

    return [
      `CREATE TABLE IF NOT EXISTS workflow_monitors (
         id          ${ID},
         user_id     ${FK} NOT NULL,
         workflow_id ${FK} NOT NULL,
         is_active   INTEGER NOT NULL DEFAULT 1,
         output_key  TEXT,
         key_field   TEXT,
         created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
         FOREIGN KEY (user_id)     REFERENCES users(id)     ON DELETE CASCADE
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_monitors_workflow ON workflow_monitors(workflow_id)`,
      `CREATE INDEX IF NOT EXISTS idx_monitors_user ON workflow_monitors(user_id)`,

      `ALTER TABLE runs ADD COLUMN change_summary_json TEXT`,
    ];
  },
};
