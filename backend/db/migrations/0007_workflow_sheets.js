'use strict';

// Google Sheets delivery — see docs/PLATFORM_ANALYSIS.md §6.6.2.
//
//   workflow_sheets — per-workflow "append results to a Google Sheet" config.
//     Operational state (like schedules/monitors), one row per workflow.
//       spreadsheet_id — the target sheet's ID (parsed from an ID or URL).
//       sheet_name     — the tab to append to (default "Sheet1").
//       output_key     — which extracted list to send; NULL = the primary list.
//     Auth is a single instance-wide service account (GOOGLE_SERVICE_ACCOUNT_JSON);
//     the user shares each sheet with that account's e-mail. No per-row secrets.

const { pk, fk } = require('../schema');

module.exports = {
  id: '0007_workflow_sheets',
  up(dialect) {
    const ID = pk(dialect);
    const FK = fk(dialect);

    return [
      `CREATE TABLE IF NOT EXISTS workflow_sheets (
         id             ${ID},
         user_id        ${FK} NOT NULL,
         workflow_id    ${FK} NOT NULL,
         is_active      INTEGER NOT NULL DEFAULT 1,
         spreadsheet_id TEXT NOT NULL,
         sheet_name     TEXT NOT NULL DEFAULT 'Sheet1',
         output_key     TEXT,
         last_status    TEXT,
         last_sent_at   TEXT,
         created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
         FOREIGN KEY (user_id)     REFERENCES users(id)     ON DELETE CASCADE
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_sheets_workflow ON workflow_sheets(workflow_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sheets_user ON workflow_sheets(user_id)`,
    ];
  },
};
