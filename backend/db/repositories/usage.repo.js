'use strict';

const db = require('../client');

/* ===========================================================================
   usage.repo
   ---------------------------------------------------------------------------
   Per-user, per-period metering counters for the public API. `period` is a
   calendar month as 'YYYY-MM' (UTC). The upsert relies on the unique index
   on (user_id, period); the unqualified column on the right-hand side of
   DO UPDATE refers to the existing row on both SQLite and Postgres.
   ========================================================================= */

function currentPeriod(now = new Date()) {
  return now.toISOString().slice(0, 7); // 'YYYY-MM'
}

async function incrementRuns(userId, by = 1, period = currentPeriod()) {
  await db.run(`
    INSERT INTO usage (user_id, period, runs_used, pages_used)
    VALUES (?, ?, ?, 0)
    ON CONFLICT (user_id, period)
    DO UPDATE SET runs_used = runs_used + ?, updated_at = CURRENT_TIMESTAMP
  `, [userId, period, by, by]);
}

// Pages are metered separately from runs because they're counted at a
// different time: a run increments runs_used the moment it's admitted, but
// pages_used can only be known once the run has actually fetched them. A run
// that is admitted and then fails still consumed a run; it may have consumed
// no pages.
async function incrementPages(userId, by = 1, period = currentPeriod()) {
  if (!by || by < 0) return;
  await db.run(`
    INSERT INTO usage (user_id, period, runs_used, pages_used)
    VALUES (?, ?, 0, ?)
    ON CONFLICT (user_id, period)
    DO UPDATE SET pages_used = pages_used + ?, updated_at = CURRENT_TIMESTAMP
  `, [userId, period, by, by]);
}

async function getForPeriod(userId, period = currentPeriod()) {
  const row = await db.get(
    'SELECT * FROM usage WHERE user_id = ? AND period = ?',
    [userId, period]
  );
  return row || { user_id: userId, period, runs_used: 0, pages_used: 0, updated_at: null };
}

// Usage across every period for one user — the admin panel's per-user detail
// view. Newest first, capped: an account that has been active for years
// shouldn't return an unbounded row set to render a summary table.
async function listPeriodsForUser(userId, limit = 12) {
  return db.all(
    `SELECT period, runs_used, pages_used, updated_at
       FROM usage WHERE user_id = ?
      ORDER BY period DESC
      LIMIT ?`,
    [userId, limit]
  );
}

module.exports = {
  currentPeriod,
  incrementRuns,
  incrementPages,
  getForPeriod,
  listPeriodsForUser,
};
