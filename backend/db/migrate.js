'use strict';

const fs   = require('fs');
const path = require('path');

/* ===========================================================================
   db/migrate.js
   ---------------------------------------------------------------------------
   A deliberately tiny migration runner. It replaces the ad-hoc
   `addColumnIfMissing` calls in the legacy db/index.js with an ordered,
   recorded set of migrations that work against either SQLite or Postgres.

   A migration is a module in db/migrations/ exporting:
       { id: '0001_something', up(dialect) -> string[] }
   where `up` returns the ordered SQL statements to apply. Files are applied
   in filename order; each is recorded in `schema_migrations` so it runs once.

   Everything runs through the async db client, so the same code path works
   for both engines.
   ========================================================================= */

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function loadMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.js'))
    .sort()                               // filename order == apply order
    .map(f => {
      const mod = require(path.join(MIGRATIONS_DIR, f));
      if (!mod || !mod.id || typeof mod.up !== 'function') {
        throw new Error(`Invalid migration "${f}": must export { id, up(dialect) }`);
      }
      return mod;
    });
}

async function ensureMigrationsTable(db) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * Apply every not-yet-applied migration in order. Each migration runs inside
 * a transaction together with the row that records it, so a partially applied
 * migration can't be marked done.
 */
async function run(db) {
  await ensureMigrationsTable(db);

  const appliedRows = await db.all('SELECT id FROM schema_migrations', []);
  const applied = new Set(appliedRows.map(r => r.id));

  const migrations = loadMigrations();
  for (const m of migrations) {
    if (applied.has(m.id)) continue;

    const stmts = m.up(db.dialect) || [];
    await db.tx(async (t) => {
      for (const sql of stmts) {
        await t.run(sql, []);
      }
      await t.run('INSERT INTO schema_migrations (id) VALUES (?)', [m.id]);
    });
    console.log(`[migrate] applied ${m.id}`);
  }
}

module.exports = { run, loadMigrations };
