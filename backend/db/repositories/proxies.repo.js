'use strict';

const db = require('../client');
const cryptoUtil = require('../../utils/crypto');

/* ===========================================================================
   proxies.repo
   ---------------------------------------------------------------------------
   Data access for the `proxies` table. Two kinds of row live here:
     - a user's own proxy    (user_id = that user,  is_shared = 0)
     - a platform-wide proxy (user_id = NULL,       is_shared = 1) — created
       by an admin (see middleware/auth.js requireAdmin), visible to every
       user as a selectable option but never editable/deletable by them.

   Passwords are encrypted at rest (utils/crypto) and only ever decrypted by
   resolveForUse — the one path that hands real credentials to Puppeteer.
   Every other read omits the password entirely.
   ========================================================================= */

function stripSecret(row) {
  if (!row) return row;
  const { password_encrypted, ...rest } = row;
  return { ...rest, hasPassword: !!password_encrypted };
}

// Own proxies + every shared/platform proxy — the full picker list for a user.
async function listAvailableForUser(userId) {
  const rows = await db.all(
    `SELECT * FROM proxies WHERE user_id = ? OR is_shared = 1 ORDER BY is_shared ASC, updated_at DESC`,
    [userId]
  );
  return rows.map(stripSecret);
}

async function listForUser(userId) {
  const rows = await db.all(
    'SELECT * FROM proxies WHERE user_id = ? ORDER BY updated_at DESC',
    [userId]
  );
  return rows.map(stripSecret);
}

async function listShared() {
  const rows = await db.all(
    'SELECT * FROM proxies WHERE is_shared = 1 ORDER BY updated_at DESC',
    []
  );
  return rows.map(stripSecret);
}

// For the edit form: only the owner (not a shared row's viewer) gets this.
async function getForUser(id, userId) {
  const row = await db.get('SELECT * FROM proxies WHERE id = ? AND user_id = ?', [id, userId]);
  return stripSecret(row);
}

async function getSharedById(id) {
  const row = await db.get('SELECT * FROM proxies WHERE id = ? AND is_shared = 1', [id]);
  return stripSecret(row);
}

async function existsForUser(id, userId) {
  const row = await db.get('SELECT id FROM proxies WHERE id = ? AND user_id = ?', [id, userId]);
  return !!row;
}

// The one path that returns real, usable credentials — for handing to
// Puppeteer at browser-launch time. Scoped so a user can only resolve a
// proxy that's either their own or shared platform-wide; this is what stops
// workflow.meta.proxy.id from being used to read someone else's private
// proxy credentials by guessing/incrementing an id.
async function resolveForUse(id, userId) {
  const row = await db.get(
    'SELECT * FROM proxies WHERE id = ? AND (user_id = ? OR is_shared = 1)',
    [id, userId]
  );
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    username: row.username || null,
    password: cryptoUtil.decrypt(row.password_encrypted),
  };
}

async function create({ userId, label, protocol, host, port, username, password, isShared }) {
  const row = await db.get(`
    INSERT INTO proxies (user_id, label, protocol, host, port, username, password_encrypted, is_shared)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `, [
    isShared ? null : userId,
    label, protocol, host, port, username || null,
    cryptoUtil.encrypt(password),
    isShared ? 1 : 0,
  ]);
  return stripSecret(row);
}

// `password === undefined` keeps the existing stored password unchanged
// (the edit form never re-displays it, so "leave blank" = "no change" —
// `null`/'' explicitly clears it).
async function update({ id, userId, label, protocol, host, port, username, password }) {
  if (password === undefined) {
    const row = await db.get(`
      UPDATE proxies
      SET label = ?, protocol = ?, host = ?, port = ?, username = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
      RETURNING *
    `, [label, protocol, host, port, username || null, id, userId]);
    return stripSecret(row);
  }
  const row = await db.get(`
    UPDATE proxies
    SET label = ?, protocol = ?, host = ?, port = ?, username = ?, password_encrypted = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
    RETURNING *
  `, [label, protocol, host, port, username || null, cryptoUtil.encrypt(password), id, userId]);
  return stripSecret(row);
}

// Admin-only update path for a shared/platform proxy (user_id IS NULL, so
// the owner-scoped `update` above can never match it).
async function updateShared({ id, label, protocol, host, port, username, password }) {
  if (password === undefined) {
    const row = await db.get(`
      UPDATE proxies
      SET label = ?, protocol = ?, host = ?, port = ?, username = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND is_shared = 1
      RETURNING *
    `, [label, protocol, host, port, username || null, id]);
    return stripSecret(row);
  }
  const row = await db.get(`
    UPDATE proxies
    SET label = ?, protocol = ?, host = ?, port = ?, username = ?, password_encrypted = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND is_shared = 1
    RETURNING *
  `, [label, protocol, host, port, username || null, cryptoUtil.encrypt(password), id]);
  return stripSecret(row);
}

async function remove(id, userId) {
  const info = await db.run('DELETE FROM proxies WHERE id = ? AND user_id = ?', [id, userId]);
  return info.changes;
}

async function removeShared(id) {
  const info = await db.run('DELETE FROM proxies WHERE id = ? AND is_shared = 1', [id]);
  return info.changes;
}

module.exports = {
  listAvailableForUser, listForUser, listShared,
  getForUser, getSharedById, existsForUser, resolveForUse,
  create, update, updateShared, remove, removeShared,
};
