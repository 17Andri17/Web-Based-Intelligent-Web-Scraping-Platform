'use strict';

const db = require('../client');

/* ===========================================================================
   authTokens.repo
   ---------------------------------------------------------------------------
   Storage for the single-use e-mail tokens (see migration 0013). Only ever
   sees the HASH — the plaintext token never reaches this layer, so it cannot
   be logged from here or accidentally selected into a response.
   ========================================================================= */

const KIND_PASSWORD_RESET = 'password_reset';
const KIND_EMAIL_VERIFY   = 'email_verify';

/* created_at is written EXPLICITLY as an ISO-8601 UTC string rather than left
   to the column's CURRENT_TIMESTAMP default.

   SQLite's CURRENT_TIMESTAMP produces "2026-08-14 12:34:56" — UTC, but with
   no timezone marker and a space instead of a 'T'. Date.parse() reads that
   shape as LOCAL time, so on any server that isn't on UTC the value comes
   back skewed by the offset. For the resend cooldown that skew is silently
   one-directional: east of UTC the token looks older than it is and the
   cooldown never triggers at all.

   Writing the timestamp ourselves makes it unambiguous on both engines. The
   column default stays as a backstop for any other writer. */
async function create({ userId, kind, tokenHash, email = null, expiresAt }) {
  await db.run(
    `INSERT INTO auth_tokens (user_id, kind, token_hash, email, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, kind, tokenHash, email, expiresAt, new Date().toISOString()]
  );
}

async function findByHash(tokenHash) {
  return db.get('SELECT * FROM auth_tokens WHERE token_hash = ?', [tokenHash]);
}

async function markUsed(id) {
  // Guarded on used_at IS NULL so two concurrent submissions of the same
  // token can't both succeed — the second updates zero rows and is rejected
  // by the caller. Without this a reset link works twice if double-clicked.
  const info = await db.run(
    `UPDATE auth_tokens SET used_at = CURRENT_TIMESTAMP
      WHERE id = ? AND used_at IS NULL`,
    [id]
  );
  return info.changes > 0;
}

/**
 * Void every outstanding token of one kind for a user.
 *
 * Run on ISSUE, so requesting a second reset link invalidates the first (a
 * user who requests twice expects the newest mail to be the live one), and on
 * successful CONSUME, so a password change can't be undone by an older link
 * still sitting in the mailbox.
 */
async function invalidateForUser(userId, kind) {
  await db.run(
    `UPDATE auth_tokens SET used_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND kind = ? AND used_at IS NULL`,
    [userId, kind]
  );
}

// Most recent issue time, for the resend cooldown.
async function lastIssuedAt(userId, kind) {
  const row = await db.get(
    `SELECT created_at FROM auth_tokens
      WHERE user_id = ? AND kind = ?
      ORDER BY id DESC LIMIT 1`,
    [userId, kind]
  );
  return row ? row.created_at : null;
}

// Retention: a used or expired token has no further purpose. Kept for a grace
// period rather than deleted immediately so "this link has expired" can still
// be distinguished from "this link was never valid" for a while.
async function pruneExpired(graceDays = 7) {
  const cutoff = new Date(Date.now() - graceDays * 86400000).toISOString();
  const info = await db.run('DELETE FROM auth_tokens WHERE expires_at < ?', [cutoff]);
  return info.changes || 0;
}

module.exports = {
  KIND_PASSWORD_RESET,
  KIND_EMAIL_VERIFY,
  create,
  findByHash,
  markUsed,
  invalidateForUser,
  lastIssuedAt,
  pruneExpired,
};
