'use strict';

const db = require('../client');

/* ===========================================================================
   workflows.repo
   ---------------------------------------------------------------------------
   Data access for the `workflows` table (migration slice 2). Routes call these
   instead of writing SQL. Functions return raw DB rows; callers handle
   JSON (de)serialisation. See docs/SCALING_AND_DB_MIGRATION.md.
   ========================================================================= */

// Summary list for the workflows menu. Includes meta_json (but NOT the steps
// payload) so callers can surface a workflow's declared input variables — the
// RUN_SUBFLOW picker maps parent data onto them — without a second fetch.
async function listSummariesForUser(userId) {
  return db.all(`
    SELECT id, name, created_at, updated_at, meta_json
    FROM workflows
    WHERE user_id = ?
    ORDER BY updated_at DESC
  `, [userId]);
}

// Cursor-paginated summary list (id DESC) for the public API. `beforeId`
// returns workflows strictly older than that id.
async function listSummariesForUserPage(userId, { limit = 20, beforeId = null } = {}) {
  if (beforeId != null) {
    return db.all(`
      SELECT id, name, created_at, updated_at
      FROM workflows
      WHERE user_id = ? AND id < ?
      ORDER BY id DESC
      LIMIT ?
    `, [userId, beforeId, limit]);
  }
  return db.all(`
    SELECT id, name, created_at, updated_at
    FROM workflows
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT ?
  `, [userId, limit]);
}

async function getForUser(id, userId) {
  return db.get('SELECT * FROM workflows WHERE id = ? AND user_id = ?', [id, userId]);
}

async function existsForUser(id, userId) {
  const row = await db.get('SELECT id FROM workflows WHERE id = ? AND user_id = ?', [id, userId]);
  return !!row;
}

// Insert and return the full new row in one round-trip (RETURNING * works on
// SQLite ≥3.35 and Postgres).
async function create({ userId, name, stepsJson, metaJson }) {
  return db.get(`
    INSERT INTO workflows (user_id, name, steps_json, meta_json)
    VALUES (?, ?, ?, ?)
    RETURNING *
  `, [userId, name, stepsJson, metaJson]);
}

// Overwrite an owned workflow and return the updated row (or undefined if the
// row doesn't exist / isn't owned by the user).
async function update({ id, userId, name, stepsJson, metaJson }) {
  return db.get(`
    UPDATE workflows
    SET name = ?, steps_json = ?, meta_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
    RETURNING *
  `, [name, stepsJson, metaJson, id, userId]);
}

async function remove(id, userId) {
  const info = await db.run('DELETE FROM workflows WHERE id = ? AND user_id = ?', [id, userId]);
  return info.changes;
}

// Overwrite an owned workflow's steps + meta (without touching its name).
// Used to persist the latest editor state on an ad-hoc run. Returns the
// updated row, or undefined if not owned.
async function updateStepsAndMeta({ id, userId, stepsJson, metaJson }) {
  return db.get(`
    UPDATE workflows
    SET steps_json = ?, meta_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
    RETURNING *
  `, [stepsJson, metaJson, id, userId]);
}

// Restore an owned workflow to a prior version's steps (and meta, if the
// version captured it). Returns the updated row, or undefined if not owned.
async function restore({ id, userId, stepsJson, metaJson }) {
  return db.get(`
    UPDATE workflows
    SET steps_json = ?, meta_json = COALESCE(?, meta_json), updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
    RETURNING *
  `, [stepsJson, metaJson, id, userId]);
}

module.exports = {
  listSummariesForUser, listSummariesForUserPage, getForUser, existsForUser,
  create, update, remove, updateStepsAndMeta, restore,
};
