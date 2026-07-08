'use strict';

const db = require('../client');

/* ===========================================================================
   apiKeys.repo
   ---------------------------------------------------------------------------
   Data access for the `api_keys` table (public API credentials). Keys are
   stored as a SHA-256 hash only — hashing/generation lives in
   services/apiKeys.service.js; this module never sees the plaintext key.
   ========================================================================= */

async function create({ userId, name, keyHash, prefix }) {
  return db.get(`
    INSERT INTO api_keys (user_id, name, key_hash, prefix)
    VALUES (?, ?, ?, ?)
    RETURNING *
  `, [userId, name, keyHash, prefix]);
}

// Auth-path lookup: an active (non-revoked) key by its hash.
async function findActiveByHash(keyHash) {
  return db.get(
    'SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL',
    [keyHash]
  );
}

async function listForUser(userId) {
  return db.all(`
    SELECT id, name, prefix, last_used_at, created_at, revoked_at
    FROM api_keys
    WHERE user_id = ?
    ORDER BY id DESC
  `, [userId]);
}

async function countActiveForUser(userId) {
  const row = await db.get(
    'SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL',
    [userId]
  );
  return row ? Number(row.n) : 0;
}

// Soft revoke — the row stays for audit/attribution of past runs.
async function revoke(id, userId) {
  const info = await db.run(`
    UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL
  `, [id, userId]);
  return info.changes;
}

// Best-effort freshness marker; callers fire-and-forget.
async function touchLastUsed(id) {
  await db.run('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
}

module.exports = { create, findActiveByHash, listForUser, countActiveForUser, revoke, touchLastUsed };
