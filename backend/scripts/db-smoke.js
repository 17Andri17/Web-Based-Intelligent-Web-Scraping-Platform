'use strict';

/* ===========================================================================
   scripts/db-smoke.js
   ---------------------------------------------------------------------------
   End-to-end smoke test for the async data layer + migration runner + the
   first migrated slice (users.repo). Runs against a throwaway SQLite file so
   it never touches the real app database.

   Run with: npm run test:db   (or: node scripts/db-smoke.js)

   To smoke-test Postgres instead:
     DB_CLIENT=postgres DATABASE_URL=postgres://... node scripts/db-smoke.js
   ========================================================================= */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Use a unique throwaway DB unless the caller explicitly targets Postgres.
const usingPg = (process.env.DB_CLIENT || '').toLowerCase() === 'postgres';
let tmpFile = null;
if (!usingPg) {
  tmpFile = path.join(os.tmpdir(), `db-smoke-${process.pid}-${Date.now()}.sqlite`);
  process.env.DB_PATH = tmpFile;
}

const db    = require('../db/client');
const users = require('../db/repositories/users.repo');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  ✓ ' + msg);
}

async function main() {
  console.log(`[db-smoke] dialect = ${db.dialect}`);

  // 1. init() must build the schema + record the baseline migration.
  await db.init();
  const migs = await db.all('SELECT id FROM schema_migrations', []);
  assert(migs.some(m => m.id === '0001_baseline'), 'baseline migration recorded');

  // init() is idempotent — a second call must not throw or re-apply.
  await db.init();
  assert(true, 'init() is idempotent');

  // 2. Insert via the repo and read the generated id back (RETURNING id path).
  const uname = 'smoke_' + Math.random().toString(36).slice(2, 10);
  const id = await users.create({ username: uname, passwordHash: 'hash123' });
  assert(typeof id === 'number' && id > 0, `create() returned numeric id (${id})`);

  // 3. existsByUsername / findByUsername round-trip.
  assert(await users.existsByUsername(uname) === true, 'existsByUsername true for created user');
  assert(await users.existsByUsername('nope_' + uname) === false, 'existsByUsername false for missing user');

  const row = await users.findByUsername(uname);
  assert(row && row.id === id && row.username === uname, 'findByUsername returns the row');
  assert(row.password_hash === 'hash123', 'password_hash round-trips');

  // 4. run() reports changes; UPDATE path works.
  const upd = await db.run('UPDATE users SET password_hash = ? WHERE id = ?', ['newhash', id]);
  assert(upd.changes === 1, 'run() reports changes = 1 on UPDATE');

  // 5. tx() commits.
  await db.tx(async (t) => {
    await t.run('UPDATE users SET password_hash = ? WHERE id = ?', ['txhash', id]);
  });
  const after = await users.findByUsername(uname);
  assert(after.password_hash === 'txhash', 'tx() commits writes');

  // 6. tx() rolls back on throw.
  try {
    await db.tx(async (t) => {
      await t.run('UPDATE users SET password_hash = ? WHERE id = ?', ['willrollback', id]);
      throw new Error('boom');
    });
  } catch (_) { /* expected */ }
  const afterRollback = await users.findByUsername(uname);
  assert(afterRollback.password_hash === 'txhash', 'tx() rolls back on error');

  // cleanup
  await db.run('DELETE FROM users WHERE id = ?', [id]);
  await db.close();

  console.log('\n[db-smoke] PASS');
}

main()
  .catch((err) => {
    console.error('\n[db-smoke] FAIL:', err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    if (tmpFile) {
      for (const f of [tmpFile, tmpFile + '-wal', tmpFile + '-shm']) {
        try { fs.unlinkSync(f); } catch (_) {}
      }
    }
  });
