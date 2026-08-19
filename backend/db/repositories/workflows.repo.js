'use strict';

const db = require('../client');

/* ===========================================================================
   workflows.repo
   ---------------------------------------------------------------------------
   Data access for the `workflows` table (migration slice 2). Routes call these
   instead of writing SQL. Functions return raw DB rows; callers handle
   JSON (de)serialisation. See docs/SCALING_AND_DB_MIGRATION.md.

   ── Demo workflows (is_demo = 1) ──────────────────────────────────────────
   The guided tour needs a persisted workflow to run against (the execution
   pipeline hangs runs, logs and results off one), but what it builds is a
   teaching prop on the bundled practice shop — not something the user made.
   So it is flagged and then hidden EVERYWHERE the user's own scrapers are
   listed or counted, and deleted outright when the tour ends.

   Every list/count below therefore filters `is_demo = 0`. getForUser and
   existsForUser deliberately do NOT: the tour's own run path looks its
   workflow up by id, and the ownership check must still pass for it.
   ========================================================================= */

// Appended to a WHERE clause so a demo workflow never shows up as one of the
// user's own. Written out rather than implied so the intent survives edits.
const NOT_DEMO = 'is_demo = 0';

// Summary list for the workflows menu. Includes meta_json (but NOT the steps
// payload) so callers can surface a workflow's declared input variables — the
// RUN_SUBFLOW picker maps parent data onto them — without a second fetch.
async function listSummariesForUser(userId) {
  return db.all(`
    SELECT id, name, created_at, updated_at, meta_json
    FROM workflows
    WHERE user_id = ? AND ${NOT_DEMO}
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
      WHERE user_id = ? AND ${NOT_DEMO} AND id < ?
      ORDER BY id DESC
      LIMIT ?
    `, [userId, beforeId, limit]);
  }
  return db.all(`
    SELECT id, name, created_at, updated_at
    FROM workflows
    WHERE user_id = ? AND ${NOT_DEMO}
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
async function create({ userId, name, stepsJson, metaJson, isDemo = false }) {
  return db.get(`
    INSERT INTO workflows (user_id, name, steps_json, meta_json, is_demo)
    VALUES (?, ?, ?, ?, ?)
    RETURNING *
  `, [userId, name, stepsJson, metaJson, isDemo ? 1 : 0]);
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

// Plan enforcement: how many workflows this user already owns. COUNT rather
// than listSummariesForUser().length so checking the limit doesn't pull every
// workflow's JSON out of the database to throw it away.
async function countForUser(userId) {
  const row = await db.get(`SELECT COUNT(*) AS n FROM workflows WHERE user_id = ? AND ${NOT_DEMO}`, [userId]);
  return row ? Number(row.n) : 0;
}

/* ── The guided tour's throwaway workflow ─────────────────────────────────
   At most one per user: the tour reuses it across restarts rather than
   littering the table with a new hidden row every time someone reopens the
   walkthrough. */

async function findDemoForUser(userId) {
  return db.get(
    'SELECT * FROM workflows WHERE user_id = ? AND is_demo = 1 ORDER BY id DESC',
    [userId]
  );
}

// Drop the tour's workflow and everything hanging off it — runs, logs,
// repairs and versions all cascade — so finishing (or abandoning) the tour
// leaves the account exactly as it was. Safe to call when there is none.
async function removeDemoForUser(userId) {
  const info = await db.run('DELETE FROM workflows WHERE user_id = ? AND is_demo = 1', [userId]);
  return info.changes;
}

module.exports = {
  listSummariesForUser, listSummariesForUserPage, getForUser, existsForUser,
  create, update, remove, updateStepsAndMeta, restore, countForUser,
  findDemoForUser, removeDemoForUser,
};
