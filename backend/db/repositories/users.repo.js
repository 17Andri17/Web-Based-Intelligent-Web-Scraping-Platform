'use strict';

const db = require('../client');

/* ===========================================================================
   users.repo
   ---------------------------------------------------------------------------
   All data access for the `users` table goes through here. This is the first
   slice migrated onto the async dual-backend client (see
   docs/SCALING_AND_DB_MIGRATION.md). Routes no longer write SQL directly.
   ========================================================================= */

/* ── OAuth-only accounts ────────────────────────────────────────────────────
   users.password_hash is NOT NULL and cannot be made nullable on SQLite
   without rebuilding a table that six others reference by foreign key (see
   migrations/0012_accounts_and_plans.js). Accounts that sign in only through
   Google or GitHub therefore store this sentinel.

   It is deliberately not a valid bcrypt hash: bcrypt.compare() against it
   returns false for every input, so even if a caller forgets the explicit
   guard, the failure mode is "cannot log in" rather than "logs in". Callers
   should still use isOAuthOnly() and reject before comparing, so the user
   gets "use Google to sign in" instead of "invalid credentials".
   ------------------------------------------------------------------------ */
const OAUTH_ONLY_HASH = '!oauth-only-no-password';

function isOAuthOnly(row) {
  return !row || !row.password_hash || row.password_hash === OAUTH_ONLY_HASH;
}

// Columns safe to return to the account's own owner. Excludes password_hash
// and the billing provider ids (which are internal linkage, not user data).
const SELF_COLUMNS = `
  id, username, email, email_verified, is_admin, status, suspended_reason,
  plan, plan_status, plan_since, plan_expires_at, created_at, last_login_at
`;

/* ── Lookup ─────────────────────────────────────────────────────────────── */

async function findByUsername(username) {
  return db.get(
    'SELECT id, username, email, password_hash, status, is_admin FROM users WHERE username = ?',
    [username]
  );
}

// Email lookup is case-insensitive: users do not reliably reproduce the
// casing they signed up with, and Google may return a differently-cased
// address than the one typed at registration. Storage normalises to
// lowercase (see normaliseEmail) so this compares like with like.
async function findByEmail(email) {
  if (!email) return null;
  return db.get(
    'SELECT id, username, email, email_verified, password_hash, status, is_admin FROM users WHERE email = ?',
    [normaliseEmail(email)]
  );
}

async function findById(id) {
  return db.get(`SELECT ${SELF_COLUMNS} FROM users WHERE id = ?`, [id]);
}

// SELF_COLUMNS deliberately omits password_hash, so callers that need to know
// whether an account can sign in with a password use this rather than
// reaching for a row that will never carry the column.
async function hasPassword(userId) {
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', [userId]);
  return !!row && !isOAuthOnly(row);
}

// The hash itself, for the one caller that must compare against it.
async function getPasswordHash(userId) {
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', [userId]);
  return row ? row.password_hash : null;
}

async function existsByUsername(username) {
  const row = await db.get('SELECT 1 AS one FROM users WHERE username = ?', [username]);
  return !!row;
}

async function existsByEmail(email) {
  if (!email) return false;
  const row = await db.get('SELECT 1 AS one FROM users WHERE email = ?', [normaliseEmail(email)]);
  return !!row;
}

function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/* ── Creation ───────────────────────────────────────────────────────────── */

// Inserts a user and returns the new id. Uses RETURNING id so the same code
// path works on both SQLite (≥3.35) and Postgres.
async function create({ username, passwordHash, email = null, emailVerified = false, plan = 'free' }) {
  const row = await db.get(
    `INSERT INTO users (username, password_hash, email, email_verified, plan, plan_since)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) RETURNING id`,
    [username, passwordHash, email ? normaliseEmail(email) : null, emailVerified ? 1 : 0, plan]
  );
  return row.id;
}

// An account created by an OAuth sign-in: no password, email already verified
// by the provider. Kept as its own function rather than a flag on create() so
// the sentinel password is written in exactly one place.
async function createOAuthUser({ username, email, plan = 'free' }) {
  const row = await db.get(
    `INSERT INTO users (username, password_hash, email, email_verified, plan, plan_since)
     VALUES (?, ?, ?, 1, ?, CURRENT_TIMESTAMP) RETURNING id`,
    [username, OAUTH_ONLY_HASH, normaliseEmail(email), plan]
  );
  return row.id;
}

/* ── Mutation ───────────────────────────────────────────────────────────── */

async function setEmail(userId, email, verified = false) {
  await db.run(
    'UPDATE users SET email = ?, email_verified = ? WHERE id = ?',
    [normaliseEmail(email), verified ? 1 : 0, userId]
  );
}

async function setPasswordHash(userId, passwordHash) {
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
}

async function touchLastLogin(userId) {
  await db.run('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [userId]);
}

/**
 * Assign a plan. Callers MUST invalidate the entitlements cache afterwards
 * (services/entitlements.service.js → invalidate(userId)); this repo does not
 * import that service to avoid a require cycle, so the responsibility sits
 * with services/billing.service.js and the admin routes, which are the only
 * two places that legitimately change a plan.
 */
async function setPlan(userId, { plan, status = 'active', expiresAt = null }) {
  await db.run(
    `UPDATE users
        SET plan = ?, plan_status = ?, plan_expires_at = ?, plan_since = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [plan, status, expiresAt, userId]
  );
}

async function setPlanStatus(userId, status, expiresAt = null) {
  await db.run(
    'UPDATE users SET plan_status = ?, plan_expires_at = ? WHERE id = ?',
    [status, expiresAt, userId]
  );
}

async function setBillingLinkage(userId, { provider, customerId, subscriptionId }) {
  await db.run(
    `UPDATE users
        SET billing_provider = ?, billing_customer_id = ?, billing_subscription_id = ?
      WHERE id = ?`,
    [provider || null, customerId || null, subscriptionId || null, userId]
  );
}

async function findByBillingCustomerId(customerId) {
  if (!customerId) return null;
  return db.get('SELECT id, username, email, plan FROM users WHERE billing_customer_id = ?', [customerId]);
}

// `overrides` is the parsed object (or null to clear) — stringified here so
// callers never hand-roll the JSON shape entitlements.service expects.
async function setPlanOverrides(userId, overrides) {
  await db.run(
    'UPDATE users SET plan_overrides_json = ? WHERE id = ?',
    [overrides ? JSON.stringify(overrides) : null, userId]
  );
}

async function setStatus(userId, status, reason = null) {
  await db.run(
    'UPDATE users SET status = ?, suspended_reason = ? WHERE id = ?',
    [status, status === 'suspended' ? reason : null, userId]
  );
}

async function setAdmin(userId, isAdmin) {
  await db.run('UPDATE users SET is_admin = ? WHERE id = ?', [isAdmin ? 1 : 0, userId]);
}

async function remove(userId) {
  // Every owned table declares ON DELETE CASCADE, so this is sufficient —
  // but SQLite only honours that with foreign_keys=ON, which db/client.js
  // sets per connection. admin_audit deliberately has no FK, so the record of
  // this deletion survives it.
  await db.run('DELETE FROM users WHERE id = ?', [userId]);
}

/* ── Admin listing ──────────────────────────────────────────────────────── */

/**
 * Paginated user list for the admin panel, with the current period's usage
 * joined in so the table can show "42/50 runs" without an N+1.
 *
 * `search` matches username or email. It is passed as a bound parameter with
 * the wildcards added here — never interpolated — so a search string cannot
 * alter the query.
 */
async function listForAdmin({ search = '', plan = '', status = '', limit = 50, offset = 0, period } = {}) {
  const where = [];
  const params = [];

  if (search) {
    where.push('(u.username LIKE ? OR u.email LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like);
  }
  if (plan) { where.push('u.plan = ?'); params.push(plan); }
  if (status) { where.push('u.status = ?'); params.push(status); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // The usage join is period-scoped via a bound parameter rather than a
  // correlated subquery so it stays one indexed lookup per user.
  const rows = await db.all(
    `SELECT u.id, u.username, u.email, u.email_verified, u.is_admin, u.status,
            u.suspended_reason, u.plan, u.plan_status, u.plan_expires_at,
            u.plan_overrides_json, u.created_at, u.last_login_at,
            COALESCE(g.runs_used, 0)  AS runs_used,
            COALESCE(g.pages_used, 0) AS pages_used,
            (SELECT COUNT(*) FROM workflows w WHERE w.user_id = u.id) AS workflow_count
       FROM users u
       LEFT JOIN usage g ON g.user_id = u.id AND g.period = ?
       ${whereSql}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?`,
    [period, ...params, limit, offset]
  );

  const countRow = await db.get(
    `SELECT COUNT(*) AS total FROM users u ${whereSql}`,
    params
  );

  return { rows, total: countRow ? Number(countRow.total) : 0 };
}

// Headline numbers for the admin dashboard. One query rather than five so the
// panel's first paint isn't five round-trips.
async function adminStats(period) {
  const row = await db.get(
    `SELECT
       (SELECT COUNT(*) FROM users)                                    AS total_users,
       (SELECT COUNT(*) FROM users WHERE plan <> 'free')               AS paid_users,
       (SELECT COUNT(*) FROM users WHERE status = 'suspended')         AS suspended_users,
       (SELECT COUNT(*) FROM users WHERE created_at >= ?)              AS new_users_30d,
       (SELECT COUNT(*) FROM workflows)                                AS total_workflows,
       (SELECT COALESCE(SUM(runs_used), 0) FROM usage WHERE period = ?) AS runs_this_period`,
    [new Date(Date.now() - 30 * 86400000).toISOString(), period]
  );
  return row || {};
}

/* ── Admin bootstrap ────────────────────────────────────────────────────────
   ADMIN_USERNAMES seeds the first admin so a fresh deploy has someone who can
   reach the admin panel at all.

   BEHAVIOUR CHANGE (0012): this used to be a full declarative sync — names in
   the list were granted admin and *everyone else was demoted* on every boot.
   That is incompatible with an admin panel: any promotion made through the UI
   would be silently reverted by the next restart, which is a confusing and
   hard-to-diagnose failure.

   It is now grant-only. The database is the source of truth for who is an
   admin; the env var only ever adds. To revoke, use the admin panel (or
   `UPDATE users SET is_admin = 0`), and remove the name from the env var so
   the next restart doesn't re-grant it.
   ------------------------------------------------------------------------ */
async function grantAdminByUsernames(usernames) {
  const list = (usernames || []).map((u) => String(u).trim()).filter(Boolean);
  if (list.length === 0) return 0;
  const placeholders = list.map(() => '?').join(',');
  await db.run(
    `UPDATE users SET is_admin = 1 WHERE username IN (${placeholders}) AND is_admin = 0`,
    list
  );
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM users WHERE username IN (${placeholders}) AND is_admin = 1`,
    list
  );
  return row ? Number(row.n) : 0;
}

async function countAdmins() {
  const row = await db.get('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1', []);
  return row ? Number(row.n) : 0;
}

module.exports = {
  OAUTH_ONLY_HASH,
  isOAuthOnly,
  normaliseEmail,

  findByUsername,
  findByEmail,
  findById,
  hasPassword,
  getPasswordHash,
  existsByUsername,
  existsByEmail,

  create,
  createOAuthUser,

  setEmail,
  setPasswordHash,
  touchLastLogin,
  setPlan,
  setPlanStatus,
  setPlanOverrides,
  setBillingLinkage,
  findByBillingCustomerId,
  setStatus,
  setAdmin,
  remove,

  listForAdmin,
  adminStats,
  grantAdminByUsernames,
  countAdmins,

  // Deprecated alias — see grantAdminByUsernames for why the full sync was
  // dropped. Kept so an out-of-tree caller fails loudly rather than silently
  // demoting every admin.
  syncAdminsFromUsernames: grantAdminByUsernames,
};
