'use strict';

const fs   = require('fs');
const path = require('path');

/* ===========================================================================
   db/client.js
   ---------------------------------------------------------------------------
   Async data-access layer that speaks either SQLite (better-sqlite3) or
   Postgres (pg), selected by the DB_CLIENT env var (default: sqlite).

   The whole point of this module is that the rest of the app talks to ONE
   async interface and never cares which engine is underneath:

       await db.init();                          // schema + migrations
       await db.get(sql, params)  -> row | undefined
       await db.all(sql, params)  -> row[]
       await db.run(sql, params)  -> { changes, lastID }
       await db.get('INSERT … RETURNING id', p) -> { id }
       await db.tx(async (t) => { … })           // transaction
       db.dialect                                // 'sqlite' | 'postgres'

   Portability rules enforced here (see docs/SCALING_AND_DB_MIGRATION.md):
     • SQL uses `?` placeholders; we translate to `$1,$2,…` for Postgres.
     • Booleans and `undefined` are normalised to 1/0 and NULL so the same
       params array works on both engines.
     • Inserts that need an id use `… RETURNING id` (works on SQLite ≥3.35,
       which better-sqlite3 bundles, and on Postgres).
   ========================================================================= */

const DIALECT = (process.env.DB_CLIENT || 'sqlite').toLowerCase() === 'postgres'
  ? 'postgres'
  : 'sqlite';

// ── shared param normalisation ───────────────────────────────────────────
// SQLite (better-sqlite3) rejects `undefined` and JS booleans; Postgres
// rejects JS booleans bound to integer columns. Coerce both up-front so a
// single params array is valid on either engine.
function normaliseParams(params) {
  if (!params) return [];
  return params.map((p) => {
    if (p === undefined) return null;
    if (p === true) return 1;
    if (p === false) return 0;
    return p;
  });
}

// Translate `?` placeholders to Postgres `$1,$2,…`, skipping any `?` that
// appears inside a single-quoted string literal. (We don't use the Postgres
// jsonb `?` operator anywhere, so this is sufficient.)
function toPgPlaceholders(sql) {
  let out = '';
  let i = 0;
  let n = 0;
  let inStr = false;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      inStr = !inStr;
      out += c;
    } else if (c === '?' && !inStr) {
      out += '$' + (++n);
    } else {
      out += c;
    }
    i++;
  }
  return out;
}

/* ===========================================================================
   SQLite backend
   ========================================================================= */
function createSqliteBackend() {
  const Database = require('better-sqlite3');

  const DATA_DIR = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'app.sqlite');

  const sqlite = new Database(DB_PATH);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  // Compiled-statement cache — better-sqlite3.prepare is cheap but these run
  // hot, so we memoise per SQL string.
  const stmtCache = new Map();
  function prep(sql) {
    let s = stmtCache.get(sql);
    if (!s) { s = sqlite.prepare(sql); stmtCache.set(sql, s); }
    return s;
  }

  function get(sql, params) {
    return prep(sql).get(...normaliseParams(params));
  }
  function all(sql, params) {
    return prep(sql).all(...normaliseParams(params));
  }
  function run(sql, params) {
    const info = prep(sql).run(...normaliseParams(params));
    return { changes: info.changes, lastID: numericId(info.lastInsertRowid) };
  }

  async function tx(fn) {
    sqlite.prepare('BEGIN').run();
    try {
      const t = {
        get: async (sql, p) => get(sql, p),
        all: async (sql, p) => all(sql, p),
        run: async (sql, p) => run(sql, p),
        dialect: 'sqlite',
      };
      const result = await fn(t);
      sqlite.prepare('COMMIT').run();
      return result;
    } catch (err) {
      try { sqlite.prepare('ROLLBACK').run(); } catch (_) {}
      throw err;
    }
  }

  function close() { sqlite.close(); }

  return {
    dialect: 'sqlite',
    get: async (sql, p) => get(sql, p),
    all: async (sql, p) => all(sql, p),
    run: async (sql, p) => run(sql, p),
    tx,
    close: async () => close(),
  };
}

function numericId(v) {
  // better-sqlite3 returns BigInt for large rowids; normalise to Number.
  if (typeof v === 'bigint') return Number(v);
  return v == null ? null : v;
}

/* ===========================================================================
   Postgres backend
   ========================================================================= */
function createPostgresBackend() {
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch (_) {
    throw new Error(
      "DB_CLIENT=postgres but the 'pg' package isn't installed. Run `npm install pg`."
    );
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Modest defaults; tune per deployment.
    max: Number(process.env.PG_POOL_MAX || 10),
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });

  async function query(executor, sql, params) {
    const res = await executor.query(toPgPlaceholders(sql), normaliseParams(params));
    return res;
  }

  function backendFor(executor) {
    return {
      dialect: 'postgres',
      get: async (sql, p) => (await query(executor, sql, p)).rows[0],
      all: async (sql, p) => (await query(executor, sql, p)).rows,
      run: async (sql, p) => {
        const res = await query(executor, sql, p);
        return {
          changes: res.rowCount,
          // Populated only when the statement used `RETURNING id`.
          lastID: res.rows && res.rows[0] ? res.rows[0].id : null,
        };
      },
    };
  }

  const top = backendFor(pool);

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(backendFor(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    dialect: 'postgres',
    get: top.get,
    all: top.all,
    run: top.run,
    tx,
    close: async () => pool.end(),
  };
}

/* ===========================================================================
   Public client
   ========================================================================= */
const backend = DIALECT === 'postgres' ? createPostgresBackend() : createSqliteBackend();

let initPromise = null;
async function init() {
  // Idempotent: schema/migrations only run once per process.
  if (!initPromise) {
    const migrate = require('./migrate');
    initPromise = migrate.run(module.exports).then(() => {
      console.log(`[db] ready (${DIALECT})`);
    });
  }
  return initPromise;
}

module.exports = {
  dialect: backend.dialect,
  init,
  get: backend.get,
  all: backend.all,
  run: backend.run,
  tx: backend.tx,
  close: backend.close,
};
