'use strict';

// Per-workflow cooldown for failure alerts.
//
//   A broken scraper on a 5-minute schedule fails 288 times a day, and until
//   this table every one of those was its own e-mail. The volume is a billing
//   problem on a metered SMTP plan, but the real damage is subtler: 288
//   identical mails about one broken workflow is exactly how someone learns to
//   filter the sender — including the alert that actually mattered.
//
//   Keyed per (user, workflow) rather than per user, because a single
//   account-level timer would let one noisy workflow silence the alerts for
//   every other workflow that user owns.
//
//   suppressed_count carries what was swallowed during the quiet period, so
//   the next mail that does go out can say "and 41 further failures since"
//   instead of dropping them without trace.
//
//   workflow_id is a plain column with a 0 sentinel for runs that have no
//   workflow, NOT a foreign key: 0 matches no row in `workflows`, and NULL
//   would defeat the unique index (both engines allow repeated NULLs in a
//   UNIQUE index, so ad-hoc runs would accumulate a row per failure). Rows for
//   deleted workflows are a few bytes and harmless; the user_id cascade is
//   what keeps account deletion clean.
//
//   last_sent_at is written by the application as ISO-8601 with a 'Z', NOT via
//   CURRENT_TIMESTAMP. SQLite's default yields "YYYY-MM-DD HH:MM:SS" with no
//   zone marker, which Date.parse() reads as LOCAL time — which would shorten
//   or lengthen this cooldown by the server's UTC offset without any error to
//   show for it. See utils/time.js.

const { pk, fk } = require('../schema');

module.exports = {
  id: '0014_notification_throttle',
  up(dialect) {
    const ID = pk(dialect);
    const FK = fk(dialect);

    return [
      `CREATE TABLE IF NOT EXISTS notification_throttle (
         id               ${ID},
         user_id          ${FK} NOT NULL,
         workflow_id      ${FK} NOT NULL DEFAULT 0,
         last_sent_at     TEXT,
         suppressed_count INTEGER NOT NULL DEFAULT 0,
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_throttle_user_wf
         ON notification_throttle(user_id, workflow_id)`,
    ];
  },
};
