'use strict';

// Adds proxy rotation: a "pool" is a named collection of existing `proxies`
// rows (see 0002_proxies.js) that a workflow can point at instead of a
// single proxy, resolved to a different member on each run. Same own/shared
// split as individual proxies — user_id NULL + is_shared = platform pool.
//
// last_used_proxy_id is round-robin bookkeeping: the id most recently
// handed out from this pool, so the next pick can advance past it rather
// than re-picking the same one. ON DELETE SET NULL so deleting that proxy
// doesn't orphan the pointer — the next pick just starts over.

const { pk, fk } = require('../schema');

module.exports = {
  id: '0003_proxy_pools',
  up(dialect) {
    const ID = pk(dialect);
    const FK = fk(dialect);

    return [
      `CREATE TABLE IF NOT EXISTS proxy_pools (
         id                  ${ID},
         user_id             ${FK},
         label               TEXT NOT NULL,
         strategy            TEXT NOT NULL DEFAULT 'random',
         is_shared           INTEGER NOT NULL DEFAULT 0,
         is_default          INTEGER NOT NULL DEFAULT 0,
         last_used_proxy_id  ${FK},
         created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
         FOREIGN KEY (last_used_proxy_id) REFERENCES proxies(id) ON DELETE SET NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_proxy_pools_user ON proxy_pools(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_proxy_pools_shared ON proxy_pools(is_shared)`,

      `CREATE TABLE IF NOT EXISTS proxy_pool_members (
         pool_id  ${FK} NOT NULL,
         proxy_id ${FK} NOT NULL,
         PRIMARY KEY (pool_id, proxy_id),
         FOREIGN KEY (pool_id)  REFERENCES proxy_pools(id) ON DELETE CASCADE,
         FOREIGN KEY (proxy_id) REFERENCES proxies(id)     ON DELETE CASCADE
       )`,
      `CREATE INDEX IF NOT EXISTS idx_proxy_pool_members_proxy ON proxy_pool_members(proxy_id)`,
    ];
  },
};
