'use strict';

const db = require('../client');

/* ===========================================================================
   customActions.repo
   ---------------------------------------------------------------------------
   Data access for the `custom_actions` table (migration slice 3). Note: the
   scheduler and server.js also read custom_actions directly for codegen-time
   resolution — those reads move onto the client in later slices (6/7). This
   slice covers the CRUD routes.
   ========================================================================= */

async function listForUser(userId) {
  return db.all(
    'SELECT * FROM custom_actions WHERE user_id = ? ORDER BY updated_at DESC',
    [userId]
  );
}

async function getForUser(id, userId) {
  return db.get('SELECT * FROM custom_actions WHERE id = ? AND user_id = ?', [id, userId]);
}

// Fetch several owned custom actions by id (used for codegen-time resolution).
async function getManyByIds(userId, ids) {
  if (!ids || ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.all(
    `SELECT id, name, inputs_json, outputs_json, code
     FROM custom_actions
     WHERE user_id = ? AND id IN (${placeholders})`,
    [userId, ...ids]
  );
}

async function existsForUser(id, userId) {
  const row = await db.get('SELECT id FROM custom_actions WHERE id = ? AND user_id = ?', [id, userId]);
  return !!row;
}

async function create({ userId, name, description, inputsJson, outputsJson, code }) {
  return db.get(`
    INSERT INTO custom_actions (user_id, name, description, inputs_json, outputs_json, code)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING *
  `, [userId, name, description, inputsJson, outputsJson, code]);
}

async function update({ id, userId, name, description, inputsJson, outputsJson, code }) {
  return db.get(`
    UPDATE custom_actions
    SET name = ?, description = ?, inputs_json = ?, outputs_json = ?, code = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
    RETURNING *
  `, [name, description, inputsJson, outputsJson, code, id, userId]);
}

async function remove(id, userId) {
  const info = await db.run('DELETE FROM custom_actions WHERE id = ? AND user_id = ?', [id, userId]);
  return info.changes;
}

module.exports = { listForUser, getForUser, getManyByIds, existsForUser, create, update, remove };
