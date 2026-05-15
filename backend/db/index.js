'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'app.sqlite');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS workflows (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    name        TEXT NOT NULL,
    steps_json  TEXT NOT NULL,
    meta_json   TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_workflows_user ON workflows(user_id);

  CREATE TABLE IF NOT EXISTS custom_actions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    name         TEXT NOT NULL,
    description  TEXT,
    inputs_json  TEXT NOT NULL DEFAULT '[]',
    outputs_json TEXT NOT NULL DEFAULT '[]',
    code         TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_custom_actions_user ON custom_actions(user_id);

  CREATE TABLE IF NOT EXISTS schedules (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL,
    workflow_id      INTEGER NOT NULL,
    interval_minutes INTEGER NOT NULL,
    is_active        INTEGER NOT NULL DEFAULT 1,
    anchor_at        TEXT,
    next_run_at      TEXT,
    last_run_at      TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)     REFERENCES users(id)     ON DELETE CASCADE
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_workflow ON schedules(workflow_id);
  CREATE INDEX IF NOT EXISTS idx_schedules_user ON schedules(user_id);
  CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(is_active, next_run_at);

  CREATE TABLE IF NOT EXISTS runs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL,
    workflow_id      INTEGER NOT NULL,
    schedule_id      INTEGER,
    parent_run_id    INTEGER,
    trigger          TEXT NOT NULL DEFAULT 'manual',
    status           TEXT NOT NULL DEFAULT 'running',
    started_at       TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at      TEXT,
    duration_ms      INTEGER,
    results_json     TEXT,
    error_message    TEXT,
    error_category   TEXT,
    failed_step_id   TEXT,
    failed_step_type TEXT,
    failed_step_label TEXT,
    ai_summary       TEXT,
    retry_count      INTEGER NOT NULL DEFAULT 0,
    patched_steps_json TEXT,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id)  ON DELETE CASCADE,
    FOREIGN KEY (user_id)     REFERENCES users(id)      ON DELETE CASCADE,
    FOREIGN KEY (schedule_id) REFERENCES schedules(id)  ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_runs_workflow ON runs(workflow_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_runs_user     ON runs(user_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_runs_status   ON runs(status);

  CREATE TABLE IF NOT EXISTS run_logs (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    seq    INTEGER NOT NULL,
    level  TEXT NOT NULL,
    line   TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_run_logs_run ON run_logs(run_id, seq);

  CREATE TABLE IF NOT EXISTS run_repairs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id           INTEGER NOT NULL,
    workflow_id      INTEGER NOT NULL,
    step_id          TEXT NOT NULL,
    step_type        TEXT,
    attempt          INTEGER NOT NULL,
    error_message    TEXT,
    original_params  TEXT,
    suggested_params TEXT,
    explanation      TEXT,
    confidence       TEXT,
    applied          INTEGER NOT NULL DEFAULT 0,
    verified         INTEGER NOT NULL DEFAULT 0,
    llm_error        TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (run_id)      REFERENCES runs(id)      ON DELETE CASCADE,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_run_repairs_run ON run_repairs(run_id);
`);

// Idempotent migrations for columns added after the initial schema. SQLite
// `ALTER TABLE … ADD COLUMN` errors when the column already exists, hence
// the try/catch; it's the simplest way to keep the schema additive across
// dev databases without a separate migration runner.
function addColumnIfMissing(table, column, decl) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some(c => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  } catch (_) { /* table may not exist yet */ }
}
addColumnIfMissing('runs', 'patched_steps_json', 'TEXT');
addColumnIfMissing('runs', 'failed_step_type',   'TEXT');
addColumnIfMissing('runs', 'failed_step_label',  'TEXT');
addColumnIfMissing('schedules', 'anchor_at', 'TEXT');

module.exports = db;
