'use strict';

// Adds proxy server support: a `proxies` table (a user's own proxies, plus
// platform-wide shared ones with user_id NULL) and an `is_admin` flag on
// `users` so an admin account can manage the shared pool. See
// backend/db/repositories/proxies.repo.js.

const { pk, fk } = require('../schema');

module.exports = {
  id: '0002_proxies',
  up(dialect) {
    const ID = pk(dialect);
    const FK = fk(dialect);

    return [
      `ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`,

      `CREATE TABLE IF NOT EXISTS proxies (
         id                 ${ID},
         user_id            ${FK},
         label              TEXT NOT NULL,
         protocol           TEXT NOT NULL DEFAULT 'http',
         host               TEXT NOT NULL,
         port               INTEGER NOT NULL,
         username           TEXT,
         password_encrypted TEXT,
         is_shared          INTEGER NOT NULL DEFAULT 0,
         created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
       )`,
      `CREATE INDEX IF NOT EXISTS idx_proxies_user ON proxies(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_proxies_shared ON proxies(is_shared)`,
    ];
  },
};
