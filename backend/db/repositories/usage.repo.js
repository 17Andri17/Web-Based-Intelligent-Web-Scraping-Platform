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

async function getForPeriod(userId, period = currentPeriod()) {
  const row = await db.get(
    'SELECT * FROM usage WHERE user_id = ? AND period = ?',
    [userId, period]
  );
  return row || { user_id: userId, period, runs_used: 0, pages_used: 0, updated_at: null };
}

module.exports = { currentPeriod, incrementRuns, getForPeriod };
