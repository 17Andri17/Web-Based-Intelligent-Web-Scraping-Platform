'use strict';

const db = require('../client');

/* ===========================================================================
   notifications.repo
   ---------------------------------------------------------------------------
   Data access for `notification_settings` — one row per user holding where to
   e-mail them and which events they want. See migration 0010.
   ========================================================================= */

async function getForUser(userId) {
  return db.get('SELECT * FROM notification_settings WHERE user_id = ?', [userId]);
}

/* Create or replace the user's settings. One row per user is enforced by a
   unique index, so this reads-then-writes rather than relying on dialect-
   specific upsert syntax (the same DB layer serves SQLite and Postgres). */
async function save({ userId, email, onFailure, onChange, isActive }) {
  const existing = await getForUser(userId);
  const params = [
    isActive ? 1 : 0,
    String(email),
    onFailure ? 1 : 0,
    onChange ? 1 : 0,
  ];
  if (existing) {
    return db.get(`
      UPDATE notification_settings
         SET is_active = ?, email = ?, on_failure = ?, on_change = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?
      RETURNING *
    `, [...params, userId]);
  }
  return db.get(`
    INSERT INTO notification_settings (is_active, email, on_failure, on_change, user_id)
    VALUES (?, ?, ?, ?, ?)
    RETURNING *
  `, [...params, userId]);
}

async function remove(userId) {
  const info = await db.run('DELETE FROM notification_settings WHERE user_id = ?', [userId]);
  return info.changes;
}

/* The dispatcher's query: the user's settings if they are active AND opted in
   to this event. Returns null otherwise, so the caller sends nothing.
   `event` is a webhook event name, so both delivery channels stay driven by
   one vocabulary (services/webhookEvents). */
async function activeForEvent(userId, event) {
  const row = await getForUser(userId);
  if (!row || !row.is_active || !row.email) return null;
  if (event === 'run.failed'  && !row.on_failure) return null;
  if (event === 'run.changed' && !row.on_change)  return null;
  // run.completed is deliberately not an e-mail event: a scraper that works is
  // not news, and mailing every successful run is how people start ignoring
  // the alerts that matter.
  if (event !== 'run.failed' && event !== 'run.changed') return null;
  return row;
}

async function markSent(userId, status) {
  await db.run(`
    UPDATE notification_settings
       SET last_status = ?, last_sent_at = CURRENT_TIMESTAMP
     WHERE user_id = ?
  `, [String(status).slice(0, 200), userId]);
}

/* ── Failure-alert cooldown (migration 0014) ────────────────────────────────
   A workflow that is broken stays broken, and every failure produces the same
   e-mail. These three calls let the notifier mail the first one, stay quiet
   for a cooldown, and then report how many it swallowed — see
   services/emailNotifier.service.js.

   Keyed per (user, workflow): one flapping workflow must not mute the rest.
   ------------------------------------------------------------------------ */

function wfKey(workflowId) {
  // 0 is the bucket for runs with no workflow — see the migration for why this
  // is a sentinel rather than NULL.
  return Number(workflowId) || 0;
}

async function getThrottle(userId, workflowId) {
  return db.get(
    'SELECT * FROM notification_throttle WHERE user_id = ? AND workflow_id = ?',
    [userId, wfKey(workflowId)]
  );
}

/* Record one failure that was NOT mailed. Returns the running tally so the
   caller can log it; the row is created on first suppression. */
async function countSuppressed(userId, workflowId) {
  const wf = wfKey(workflowId);
  const existing = await getThrottle(userId, wf);
  if (existing) {
    await db.run(`
      UPDATE notification_throttle
         SET suppressed_count = suppressed_count + 1
       WHERE user_id = ? AND workflow_id = ?
    `, [userId, wf]);
    return Number(existing.suppressed_count || 0) + 1;
  }
  await db.run(`
    INSERT INTO notification_throttle (user_id, workflow_id, last_sent_at, suppressed_count)
    VALUES (?, ?, NULL, 1)
  `, [userId, wf]);
  return 1;
}

/* Open a fresh quiet period: stamp now and clear the tally. Written as an ISO
   string with a 'Z' rather than CURRENT_TIMESTAMP — that distinction is
   load-bearing here, see the migration and utils/time.js. */
async function markAlertSent(userId, workflowId) {
  const wf = wfKey(workflowId);
  const now = new Date().toISOString();
  const existing = await getThrottle(userId, wf);
  if (existing) {
    await db.run(`
      UPDATE notification_throttle
         SET last_sent_at = ?, suppressed_count = 0
       WHERE user_id = ? AND workflow_id = ?
    `, [now, userId, wf]);
    return;
  }
  await db.run(`
    INSERT INTO notification_throttle (user_id, workflow_id, last_sent_at, suppressed_count)
    VALUES (?, ?, ?, 0)
  `, [userId, wf, now]);
}

module.exports = {
  getForUser, save, remove, activeForEvent, markSent,
  getThrottle, countSuppressed, markAlertSent,
};
