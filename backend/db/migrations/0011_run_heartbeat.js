'use strict';

// Orphaned-run recovery — see backend/services/runReaper.service.js.
//
// A run executes as a child process of the server. If the server stops (crash,
// restart, deploy) while a run is in flight, the child dies with it — but the
// `runs` row still says 'running' and nothing is left alive to finish it. The
// run then shows as running forever, and Cancel does nothing because the
// in-memory canceller died with the process that held it.
//
//   heartbeat_at     — refreshed by the owning process while the run executes.
//                      A 'running' row whose heartbeat has gone stale has no
//                      live owner, so it can be safely finalised.
//   cancel_requested — set when a cancel arrives for a run this process does
//                      not own. The owning process notices on its next
//                      heartbeat and aborts, so cancelling works from any tab
//                      (and any instance) rather than only the one that
//                      happened to launch it.

module.exports = {
  id: '0011_run_heartbeat',
  up() {
    return [
      `ALTER TABLE runs ADD COLUMN heartbeat_at TEXT`,
      `ALTER TABLE runs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0`,
    ];
  },
};
