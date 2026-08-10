'use strict';

// E-mail notifications — see docs/PLATFORM_ANALYSIS.md §6.5.
//
//   notification_settings — per-USER "e-mail me when…" preferences.
//     Account-level rather than per-workflow on purpose: the question a
//     non-technical user actually has is "tell me when my scrapers break or
//     find something new", not "configure delivery for scraper #7". One row
//     per user, so the settings screen is one form.
//
//       email       — where to send. Kept here rather than on `users` because
//                     sign-in is username-based and an account may never have
//                     supplied an address; this is opt-in contact info, not
//                     an identity column.
//       on_failure  — runs that fail or land in needs_review.
//       on_change   — monitored workflows whose data changed between runs.
//
//     Delivery uses one instance-wide SMTP account (SMTP_HOST/PORT/USER/PASS),
//     mirroring how Google Sheets delivery uses one instance service account.
//     No per-user secrets are stored.

const { pk, fk } = require('../schema');

module.exports = {
  id: '0010_notification_settings',
  up(dialect) {
    const ID = pk(dialect);
    const FK = fk(dialect);

    return [
      `CREATE TABLE IF NOT EXISTS notification_settings (
         id            ${ID},
         user_id       ${FK} NOT NULL,
         is_active     INTEGER NOT NULL DEFAULT 1,
         email         TEXT NOT NULL,
         on_failure    INTEGER NOT NULL DEFAULT 1,
         on_change     INTEGER NOT NULL DEFAULT 1,
         last_status   TEXT,
         last_sent_at  TEXT,
         created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_user ON notification_settings(user_id)`,
    ];
  },
};
