'use strict';

const db = require('../client');

/* ===========================================================================
   webhooks.repo
   ---------------------------------------------------------------------------
   Data access for the `webhooks` table (public API push endpoints). `events`
   is a JSON array of subscribed event names; `secret` signs every delivery
   (see services/webhookDispatcher.service.js) so it is stored recoverable.
   ========================================================================= */

async function create({ userId, url, secret, events }) {
  return db.get(`
    INSERT INTO webhooks (user_id, url, secret, events)
    VALUES (?, ?, ?, ?)
    RETURNING *
  `, [userId, url, secret, JSON.stringify(events)]);
}

async function listForUser(userId) {
  return db.all('SELECT * FROM webhooks WHERE user_id = ? ORDER BY id DESC', [userId]);
}

async function getForUser(id, userId) {
  return db.get('SELECT * FROM webhooks WHERE id = ? AND user_id = ?', [id, userId]);
}

async function countForUser(userId) {
  const row = await db.get('SELECT COUNT(*) AS n FROM webhooks WHERE user_id = ?', [userId]);
  return row ? Number(row.n) : 0;
}

// Active endpoints subscribed to `event` for a user — the dispatcher's query.
// The LIKE filter is a cheap pre-filter on the JSON text; the dispatcher
// re-checks the parsed array before sending.
async function listActiveForEvent(userId, event) {
  return db.all(`
    SELECT * FROM webhooks
    WHERE user_id = ? AND active = 1 AND events LIKE ?
  `, [userId, `%${event}%`]);
}

async function remove(id, userId) {
  const info = await db.run('DELETE FROM webhooks WHERE id = ? AND user_id = ?', [id, userId]);
  return info.changes;
}

module.exports = { create, listForUser, getForUser, countForUser, listActiveForEvent, remove };
