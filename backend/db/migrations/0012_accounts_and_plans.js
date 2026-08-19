'use strict';

/* ===========================================================================
   0012_accounts_and_plans
   ---------------------------------------------------------------------------
   Turns the single-user local install into a multi-tenant, monetisable
   product. Three concerns, one migration because they're interdependent:

   1. IDENTITY. `users` grows an `email` (the real identity for a hosted
      product — OAuth returns an email, billing needs an email) alongside the
      existing `username`, which stays as the display handle. Existing rows
      keep a NULL email until their owner supplies one; the unique index is
      partial so those NULLs don't collide.

      `password_hash` stays NOT NULL because SQLite cannot drop a NOT NULL
      constraint without a full table rebuild, and rebuilding the users table
      (which six other tables reference with ON DELETE CASCADE) on a live
      database is a far worse trade than a sentinel. OAuth-only accounts store
      OAUTH_ONLY_HASH — a string that is not a valid bcrypt hash, so
      bcrypt.compare can never return true for it — and routes/auth.routes.js
      additionally rejects it explicitly before comparing. See
      db/repositories/users.repo.js.

   2. PLANS. The plan *catalog* (limits, features, prices) lives in code at
      config/plans.js, not in a table: it's deployment configuration that
      changes by deploy, and keeping it in code means entitlement changes are
      reviewable in git rather than an untracked UPDATE. What lives here is
      only the per-user assignment — which plan, what billing state, and an
      optional per-user override blob so an admin can comp or grandfather an
      account without inventing a new tier.

   3. GOVERNANCE. `status` lets an admin suspend an account without deleting
      it (deleting cascades away every workflow and run). `admin_audit`
      records who did what to whom, because plan and suspension changes are
      exactly the actions you want a trail for when a customer disputes one.
      Note admin_audit deliberately does NOT cascade-delete with its target
      user: the record of deleting a user must outlive the user.
   ========================================================================= */

const { pk, fk } = require('../schema');

module.exports = {
  id: '0012_accounts_and_plans',
  up(dialect) {
    const ID = pk(dialect);
    const FK = fk(dialect);

    return [
      // ── Identity ────────────────────────────────────────────────────────
      `ALTER TABLE users ADD COLUMN email TEXT`,
      `ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`,
      // Partial unique index: pre-existing username-only accounts have a NULL
      // email and must not collide with each other. Both engines support the
      // WHERE clause on a unique index.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
         ON users(email) WHERE email IS NOT NULL`,

      // ── Plan assignment & billing state ─────────────────────────────────
      // plan          — slug into config/plans.js ('free' | 'pro' | 'business')
      // plan_status   — 'active' | 'trialing' | 'past_due' | 'canceled'.
      //                 Kept separate from `plan` so a past_due Pro user can be
      //                 shown their real tier while being served free limits.
      // plan_since    — when the current plan took effect (for support/audit).
      // plan_expires_at — set on cancellation: keep serving the paid plan until
      //                 the period they already paid for ends, then fall back.
      // plan_overrides_json — admin-granted deltas merged over the catalog
      //                 entry (e.g. {"monthly_runs": 10000}). NULL for almost
      //                 everyone; see services/entitlements.service.js.
      `ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'`,
      `ALTER TABLE users ADD COLUMN plan_status TEXT NOT NULL DEFAULT 'active'`,
      `ALTER TABLE users ADD COLUMN plan_since TEXT`,
      `ALTER TABLE users ADD COLUMN plan_expires_at TEXT`,
      `ALTER TABLE users ADD COLUMN plan_overrides_json TEXT`,

      // Billing-provider linkage. Nullable and provider-agnostic on purpose —
      // services/billing.service.js is a stub today and these hold whatever
      // the real provider's customer/subscription identifiers turn out to be.
      `ALTER TABLE users ADD COLUMN billing_provider TEXT`,
      `ALTER TABLE users ADD COLUMN billing_customer_id TEXT`,
      `ALTER TABLE users ADD COLUMN billing_subscription_id TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_users_billing_customer
         ON users(billing_customer_id)`,

      // ── Account governance ──────────────────────────────────────────────
      // 'active' | 'suspended'. Suspension blocks sign-in and run execution
      // but preserves the account's data, unlike a delete (which cascades).
      `ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
      `ALTER TABLE users ADD COLUMN suspended_reason TEXT`,
      `ALTER TABLE users ADD COLUMN last_login_at TEXT`,

      // ── OAuth identities ────────────────────────────────────────────────
      // One row per (provider, provider_account_id). A user may link several
      // providers to one account; linking is keyed on a *verified* email —
      // see routes/oauth.routes.js for why unverified emails must never link.
      `CREATE TABLE IF NOT EXISTS oauth_accounts (
         id                  ${ID},
         user_id             ${FK} NOT NULL,
         provider            TEXT NOT NULL,
         provider_account_id TEXT NOT NULL,
         email               TEXT,
         display_name        TEXT,
         avatar_url          TEXT,
         created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_provider_account
         ON oauth_accounts(provider, provider_account_id)`,
      `CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_accounts(user_id)`,

      // ── Admin audit trail ───────────────────────────────────────────────
      // No FK on target_user_id: a 'user.delete' entry must survive the row it
      // describes, and an ON DELETE CASCADE here would erase exactly the
      // records an audit log exists to keep.
      `CREATE TABLE IF NOT EXISTS admin_audit (
         id             ${ID},
         admin_user_id  ${FK} NOT NULL,
         action         TEXT NOT NULL,
         target_user_id ${FK},
         details_json   TEXT,
         created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
      `CREATE INDEX IF NOT EXISTS idx_admin_audit_created
         ON admin_audit(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_admin_audit_target
         ON admin_audit(target_user_id)`,

      // ── Metering ────────────────────────────────────────────────────────
      // usage(runs_used, pages_used) already exists from 0004. Only dashboard
      // runs were never counted — that's a code fix, not a schema one. What is
      // missing is a per-run page count to aggregate from, so the numbers on
      // the usage screen can be traced back to individual runs rather than
      // being an opaque counter.
      `ALTER TABLE runs ADD COLUMN pages_fetched INTEGER NOT NULL DEFAULT 0`,
    ];
  },
};
