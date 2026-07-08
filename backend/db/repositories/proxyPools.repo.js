'use strict';

const db = require('../client');
const cryptoUtil = require('../../utils/crypto');

/* ===========================================================================
   proxyPools.repo
   ---------------------------------------------------------------------------
   A pool is a named collection of existing `proxies` rows (see
   proxies.repo.js) that a workflow can point at instead of a single proxy —
   pickProxyForUse resolves a DIFFERENT member on each call, which is what
   gives a workflow a fresh exit IP per run instead of hammering the same
   one (the actual problem this was built for: a burned/rate-limited IP
   getting a fresh CAPTCHA on every request regardless of solving it).

   Same own/shared split as individual proxies: user_id NULL + is_shared =
   platform pool, manageable only by an admin. A shared pool can additionally
   be flagged is_default — "platform automatic" mode (pickFromDefaultSharedPool)
   resolves to whichever pool has that flag, with no per-user choice needed.
   This is the seam a future plan-based selector would replace: swap "the
   platform default pool" for "the pool assigned to this user's plan"
   without touching any caller.
   ========================================================================= */

function stripPool(row) {
  if (!row) return row;
  return { ...row, isShared: !!row.is_shared, isDefault: !!row.is_default };
}

async function attachMembers(pool) {
  if (!pool) return pool;
  const members = await db.all(
    `SELECT p.id, p.label, p.protocol, p.host, p.port, p.is_shared
     FROM proxy_pool_members m JOIN proxies p ON p.id = m.proxy_id
     WHERE m.pool_id = ? ORDER BY p.id ASC`,
    [pool.id]
  );
  return { ...pool, members };
}

// Own pools + every shared/platform pool — the full picker list for a user.
async function listAvailableForUser(userId) {
  const rows = await db.all(
    `SELECT * FROM proxy_pools WHERE user_id = ? OR is_shared = 1 ORDER BY is_shared ASC, updated_at DESC`,
    [userId]
  );
  return Promise.all(rows.map(stripPool).map(attachMembers));
}

async function getForUser(id, userId) {
  const row = await db.get('SELECT * FROM proxy_pools WHERE id = ? AND user_id = ?', [id, userId]);
  return attachMembers(stripPool(row));
}

async function existsForUser(id, userId) {
  const row = await db.get('SELECT id FROM proxy_pools WHERE id = ? AND user_id = ?', [id, userId]);
  return !!row;
}

// Which of the requested proxy ids the given user is actually allowed to put
// in a pool: their own proxies, or any shared one. Silently drops anything
// else rather than erroring — the route layer surfaces a clear message when
// the filtered set doesn't match what was requested.
async function filterUsableProxyIds(proxyIds, userId) {
  const ids = [...new Set((proxyIds || []).map(Number).filter(Number.isInteger))];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT id FROM proxies WHERE id IN (${placeholders}) AND (user_id = ? OR is_shared = 1)`,
    [...ids, userId]
  );
  return rows.map(r => r.id);
}

// Same, but for a SHARED pool: members must themselves be shared proxies —
// otherwise a platform pool could secretly route every user's traffic
// through one admin's private proxy.
async function filterSharedProxyIds(proxyIds) {
  const ids = [...new Set((proxyIds || []).map(Number).filter(Number.isInteger))];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.all(`SELECT id FROM proxies WHERE id IN (${placeholders}) AND is_shared = 1`, ids);
  return rows.map(r => r.id);
}

async function setMembers(poolId, proxyIds) {
  await db.tx(async (t) => {
    await t.run('DELETE FROM proxy_pool_members WHERE pool_id = ?', [poolId]);
    for (const proxyId of proxyIds) {
      await t.run('INSERT INTO proxy_pool_members (pool_id, proxy_id) VALUES (?, ?)', [poolId, proxyId]);
    }
  });
}

async function create({ userId, label, strategy, isShared, memberProxyIds }) {
  const row = await db.get(`
    INSERT INTO proxy_pools (user_id, label, strategy, is_shared)
    VALUES (?, ?, ?, ?)
    RETURNING *
  `, [isShared ? null : userId, label, strategy, isShared ? 1 : 0]);
  await setMembers(row.id, memberProxyIds);
  return getForUser(row.id, userId).then((r) => r || attachMembers(stripPool(row)));
}

async function update({ id, userId, label, strategy, memberProxyIds }) {
  const row = await db.get(`
    UPDATE proxy_pools SET label = ?, strategy = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
    RETURNING *
  `, [label, strategy, id, userId]);
  if (!row) return null;
  await setMembers(id, memberProxyIds);
  return attachMembers(stripPool(row));
}

async function updateShared({ id, label, strategy, memberProxyIds, isDefault }) {
  // At most one default shared pool — clearing every other one first keeps
  // this a plain UPDATE instead of needing a partial-unique-index dance
  // that behaves differently across SQLite/Postgres versions.
  await db.tx(async (t) => {
    if (isDefault) await t.run('UPDATE proxy_pools SET is_default = 0 WHERE is_shared = 1 AND id != ?', [id]);
    await t.run(
      `UPDATE proxy_pools SET label = ?, strategy = ?, is_default = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_shared = 1`,
      [label, strategy, isDefault ? 1 : 0, id]
    );
  });
  const row = await db.get('SELECT * FROM proxy_pools WHERE id = ? AND is_shared = 1', [id]);
  if (!row) return null;
  await setMembers(id, memberProxyIds);
  return attachMembers(stripPool(row));
}

async function remove(id, userId) {
  const info = await db.run('DELETE FROM proxy_pools WHERE id = ? AND user_id = ?', [id, userId]);
  return info.changes;
}

async function removeShared(id) {
  const info = await db.run('DELETE FROM proxy_pools WHERE id = ? AND is_shared = 1', [id]);
  return info.changes;
}

function toResolved(proxyRow) {
  if (!proxyRow) return null;
  return {
    id: proxyRow.id,
    label: proxyRow.label,
    protocol: proxyRow.protocol,
    host: proxyRow.host,
    port: proxyRow.port,
    username: proxyRow.username || null,
    password: cryptoUtil.decrypt(proxyRow.password_encrypted),
  };
}

// Advances the pool's rotation and returns the picked proxy, fully resolved
// (decrypted password — same shape as proxies.repo.resolveForUse). A single
// atomic UPDATE ... RETURNING does the "read current position, compute the
// next member, persist it" round-robin step — no separate transaction
// needed, so there's no window for two concurrent picks (e.g. two scheduled
// runs firing close together) to race each other into reading the same
// last_used_proxy_id before either write lands.
async function _pickFromPoolRow(pool) {
  if (!pool) return null;
  if (pool.strategy === 'round_robin') {
    const updated = await db.get(`
      UPDATE proxy_pools
      SET last_used_proxy_id = COALESCE(
        (SELECT proxy_id FROM proxy_pool_members WHERE pool_id = ? AND proxy_id > COALESCE(
           (SELECT last_used_proxy_id FROM proxy_pools WHERE id = ?), 0
         ) ORDER BY proxy_id ASC LIMIT 1),
        (SELECT proxy_id FROM proxy_pool_members WHERE pool_id = ? ORDER BY proxy_id ASC LIMIT 1)
      )
      WHERE id = ?
      RETURNING last_used_proxy_id
    `, [pool.id, pool.id, pool.id, pool.id]);
    if (!updated || updated.last_used_proxy_id == null) return null; // empty pool
    const proxyRow = await db.get('SELECT * FROM proxies WHERE id = ?', [updated.last_used_proxy_id]);
    return toResolved(proxyRow);
  }

  // 'random' (default): no state to persist, so a plain random pick.
  const proxyRow = await db.get(
    `SELECT p.* FROM proxy_pool_members m JOIN proxies p ON p.id = m.proxy_id
     WHERE m.pool_id = ? ORDER BY RANDOM() LIMIT 1`,
    [pool.id]
  );
  return toResolved(proxyRow);
}

// Ownership-scoped: only resolves a pool the user owns or that's shared —
// this is what stops a workflow's stored poolId from being used to rotate
// through someone else's private pool.
async function pickProxyForUse(poolId, userId) {
  const pool = await db.get(
    'SELECT * FROM proxy_pools WHERE id = ? AND (user_id = ? OR is_shared = 1)',
    [poolId, userId]
  );
  return _pickFromPoolRow(pool);
}

// "Use platform proxies (automatic)" — no pool id needed from the caller.
async function pickFromDefaultSharedPool() {
  let pool = await db.get('SELECT * FROM proxy_pools WHERE is_shared = 1 AND is_default = 1 LIMIT 1', []);
  if (!pool) {
    // No admin has designated a default yet — fall back to the only shared
    // pool if there's exactly one, so "automatic" still works out of the
    // box for a single-pool platform setup. Ambiguous with 2+ un-designated
    // pools: return null rather than guessing which one "automatic" means.
    const candidates = await db.all('SELECT * FROM proxy_pools WHERE is_shared = 1 LIMIT 2', []);
    if (candidates.length === 1) pool = candidates[0];
  }
  return _pickFromPoolRow(pool);
}

module.exports = {
  listAvailableForUser, getForUser, existsForUser,
  filterUsableProxyIds, filterSharedProxyIds,
  create, update, updateShared, remove, removeShared,
  pickProxyForUse, pickFromDefaultSharedPool,
};
