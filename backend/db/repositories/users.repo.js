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

module.exports = { findByUsername, existsByUsername, create };
