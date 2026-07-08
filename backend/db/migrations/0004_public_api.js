'use strict';

// Public REST API (/v1) — see docs/API_ARCHITECTURE.md.
//
//   • api_keys — long-lived programmatic credentials (`sk_live_…`), stored as
//     a SHA-256 hash (never plaintext). `prefix` keeps the first characters so
//     the dashboard can show "sk_live_a1b2…" without holding the secret.
//   • webhooks — push endpoints for run.completed / run.failed events. The
//     signing `secret` must be stored recoverable (we HMAC every delivery
//     with it), unlike key hashes.
//   • usage — per-user, per-period (YYYY-MM) metering counters, upserted on
//     each API-triggered run and read by GET /v1/usage.
//   • runs gains queue/attribution columns: API-triggered runs are created as
//     status='queued' and picked up by the worker (services/apiWorker), so
//     the trigger endpoint can return 202 immediately.

const { pk, fk } = require('../schema');

module.exports = {
  id: '0004_public_api',
  up(dialect) {
    const ID = pk(dialect);
    const FK = fk(dialect);

    return [
      `CREATE TABLE IF NOT EXISTS api_keys (
         id           ${ID},
         user_id      ${FK} NOT NULL,
         name         TEXT NOT NULL,
         key_hash     TEXT NOT NULL,
         prefix       TEXT NOT NULL,
         last_used_at TEXT,
         created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         revoked_at   TEXT,
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)`,

      `CREATE TABLE IF NOT EXISTS webhooks (
         id         ${ID},
         user_id    ${FK} NOT NULL,
         url        TEXT NOT NULL,
         secret     TEXT NOT NULL,
         events     TEXT NOT NULL DEFAULT '["run.completed","run.failed"]',
         active     INTEGER NOT NULL DEFAULT 1,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
       )`,
      `CREATE INDEX IF NOT EXISTS idx_webhooks_user ON webhooks(user_id)`,

      `CREATE TABLE IF NOT EXISTS usage (
         id         ${ID},
         user_id    ${FK} NOT NULL,
         period     TEXT NOT NULL,
         runs_used  INTEGER NOT NULL DEFAULT 0,
         pages_used INTEGER NOT NULL DEFAULT 0,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_user_period ON usage(user_id, period)`,

      // Queue + attribution columns on runs. queued_at is the enqueue time
      // (started_at is reset when the worker actually claims the run).
      `ALTER TABLE runs ADD COLUMN api_key_id ${FK}`,
      `ALTER TABLE runs ADD COLUMN inputs_json TEXT`,
      `ALTER TABLE runs ADD COLUMN idempotency_key TEXT`,
      `ALTER TABLE runs ADD COLUMN queued_at TEXT`,
      // One run per (user, Idempotency-Key): a retried POST …/runs finds the
      // original instead of double-running. Partial so NULLs don't collide.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_idempotency
         ON runs(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL`,
    ];
  },
};
