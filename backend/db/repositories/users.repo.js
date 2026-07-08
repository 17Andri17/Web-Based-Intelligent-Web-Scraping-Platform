'use strict';

const db = require('../client');

/* ===========================================================================
   users.repo
   ---------------------------------------------------------------------------
   All data access for the `users` table goes through here. This is the first
   slice migrated onto the async dual-backend client (see
   docs/SCALING_AND_DB_MIGRATION.md). Routes no longer write SQL directly.
   ========================================================================= */

async function findByUsername(username) {
  return db.get(
    'SELECT id, username, password_hash FROM users WHERE username = ?',
    [username]
  );
}

async function existsByUsername(username) {
  const row = await db.get('SELECT 1 AS one FROM users WHERE username = ?', [username]);
  return !!row;
}

// Inserts a user and returns the new id. Uses RETURNING id so the same code
// path works on both SQLite (≥3.35) and Postgres.
async function create({ username, passwordHash }) {
  const row = await db.get(
    'INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id',
    [username, passwordHash]
  );
  return row.id;
}

// Called once at server startup (see server.js) to make the ADMIN_USERNAMES
// env var the single source of truth for who can manage the shared/platform
// proxy pool. A no-op when the var is unset — so a deploy that forgets to
// set it doesn't silently strip admin rights granted some other way. When
// it IS set, this is a full sync: listed usernames become admins, anyone
// else loses admin (declarative, so removing a name from the list revokes
// access on the next restart without a manual DB edit).
async function syncAdminsFromUsernames(usernames) {
  const list = (usernames || []).map((u) => String(u).trim()).filter(Boolean);
  if (list.length === 0) return;
  const placeholders = list.map(() => '?').join(',');
  await db.run(`UPDATE users SET is_admin = 1 WHERE username IN (${placeholders})`, list);
  await db.run(`UPDATE users SET is_admin = 0 WHERE username NOT IN (${placeholders})`, list);
}

module.exports = { findByUsername, existsByUsername, create, syncAdminsFromUsernames };
