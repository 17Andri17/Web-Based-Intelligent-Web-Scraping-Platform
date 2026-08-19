'use strict';

const db = require('../db/client');
const usage = require('../db/repositories/usage.repo');
const {
  getPlan,
  DEFAULT_PLAN,
  LAPSED_PLAN,
  ENTITLED_STATUSES,
} = require('../config/plans');

/* ===========================================================================
   entitlements.service
   ---------------------------------------------------------------------------
   Answers one question everywhere in the app: "is this user allowed to do
   this, right now?"

   Every gate in the codebase goes through here rather than reading
   users.plan directly, for two reasons:

     • The effective plan is not the stored plan. A past_due Pro subscriber
       has plan='pro' (so the UI can say "your Pro plan needs attention") but
       is served free limits until they pay. Reading users.plan directly gets
       that backwards, and gets it backwards in the direction that gives away
       the product.

     • Per-user overrides exist. plan_overrides_json lets an admin comp a
       customer without inventing a tier. Code that reads the catalog directly
       silently ignores them.

   ── The unlimited convention ──────────────────────────────────────────────
   A null limit means unlimited. Callers must not compare against it — use
   isWithinLimit()/assertWithinLimit() rather than `count < limits.maxX`,
   because `5 < null` is false in JavaScript and would deny an unlimited user.
   That specific bug is why these helpers exist.
   ========================================================================= */

class EntitlementError extends Error {
  /**
   * @param {string} code    machine-readable: 'feature_not_in_plan' | 'limit_reached' | 'quota_exceeded' | 'account_suspended'
   * @param {string} message human-readable, shown directly to the user
   * @param {object} meta    { requiredPlan, limit, current, resource, ... } for the upgrade prompt
   */
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'EntitlementError';
    this.code = code;
    this.meta = meta;
    // 402 for "pay us and this works", 403 for "this account is blocked".
    // The distinction matters to the frontend: 402 opens the upgrade dialog,
    // 403 does not.
    this.status = code === 'account_suspended' ? 403 : 402;
  }
}

/* ── Cache ──────────────────────────────────────────────────────────────────
   Entitlements are read on hot paths (every run, every workflow save), so an
   uncached DB round-trip per check adds up. The cache is explicitly
   invalidated by everything that can change a plan (billing webhooks, admin
   actions, signup) and additionally expires on a short TTL so a second
   process — a worker, a second app instance behind a load balancer — cannot
   serve a stale plan for longer than that.

   TTL is deliberately short. The failure mode of a stale entitlement is a
   customer who paid and is still blocked, which is the worst support ticket
   this product can generate.
   ------------------------------------------------------------------------ */
const CACHE_TTL_MS = 5000;
const cache = new Map(); // userId -> { value, expiresAt }

function invalidate(userId) {
  cache.delete(String(userId));
}

function invalidateAll() {
  cache.clear();
}

function parseOverrides(json) {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    // A malformed override must not take the request down, and must not
    // silently grant anything either — fall back to the catalog.
    return null;
  }
}

/**
 * Resolve a user row into the entitlements actually in force.
 * Exported separately from getForUser so callers that already hold the row
 * (the admin list, /api/auth/me) don't re-query.
 */
function resolveFromRow(row) {
  if (!row) {
    const plan = getPlan(DEFAULT_PLAN);
    return {
      userId: null,
      plan: DEFAULT_PLAN,
      planStatus: 'active',
      planName: plan.name,
      effectivePlan: DEFAULT_PLAN,
      lapsed: false,
      suspended: false,
      limits: { ...plan.limits },
      features: { ...plan.features },
    };
  }

  const storedSlug = row.plan || DEFAULT_PLAN;
  const storedPlan = getPlan(storedSlug) || getPlan(DEFAULT_PLAN);
  const status = row.plan_status || 'active';

  // A cancelled subscription keeps its entitlements until the period the
  // customer already paid for runs out. plan_expires_at in the future means
  // "cancelled but still paid up"; in the past means the period ended.
  const expiresAt = row.plan_expires_at ? Date.parse(row.plan_expires_at) : null;
  const expired = expiresAt != null && Number.isFinite(expiresAt) && expiresAt <= Date.now();

  const entitled = ENTITLED_STATUSES.has(status) && !expired;
  const effective = entitled ? storedPlan : getPlan(LAPSED_PLAN);

  const overrides = parseOverrides(row.plan_overrides_json);

  // Overrides apply on top of the *effective* plan, so comping a user extra
  // runs does not accidentally resurrect a lapsed subscription's features.
  const limits = { ...effective.limits, ...(overrides && overrides.limits) };
  const features = { ...effective.features, ...(overrides && overrides.features) };

  return {
    userId: row.id,
    plan: storedSlug,            // what they bought — show this in the UI
    planStatus: status,
    planName: storedPlan.name,
    effectivePlan: effective.slug, // what they get — enforce this
    lapsed: !entitled,
    suspended: row.status === 'suspended',
    hasOverrides: !!overrides,
    limits,
    features,
  };
}

async function getForUser(userId, { fresh = false } = {}) {
  const key = String(userId);
  if (!fresh) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
  }

  const row = await db.get(
    `SELECT id, plan, plan_status, plan_expires_at, plan_overrides_json, status
       FROM users WHERE id = ?`,
    [userId]
  );
  const value = resolveFromRow(row);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/* ── Feature gates ───────────────────────────────────────────────────────── */

function hasFeature(ent, feature) {
  return ent.features[feature] === true;
}

// The cheapest plan that grants `feature` — drives "Upgrade to Pro to unlock
// scheduling" rather than a bare "not allowed".
function requiredPlanFor(feature) {
  const { listPlans } = require('../config/plans');
  const match = listPlans().find((p) => p.features[feature] === true);
  return match ? match.slug : null;
}

async function assertFeature(userId, feature, label) {
  const ent = await getForUser(userId);
  if (ent.suspended) {
    throw new EntitlementError('account_suspended',
      'This account is suspended. Contact support@scrapient.app.');
  }
  if (hasFeature(ent, feature)) return ent;

  const required = requiredPlanFor(feature);
  const requiredName = required ? getPlan(required).name : null;
  const what = label || feature;
  throw new EntitlementError('feature_not_in_plan',
    requiredName
      ? `${what} is available on the ${requiredName} plan.`
      : `${what} is not available on your plan.`,
    { feature, requiredPlan: required, currentPlan: ent.effectivePlan });
}

/* ── Countable limits (workflows, schedules, proxies, API keys, webhooks) ── */

function isWithinLimit(limit, current) {
  if (limit == null) return true;     // null === unlimited
  return current < limit;
}

/**
 * Assert the user may create one more of `resource`.
 * @param {number} current how many they already have
 */
async function assertWithinLimit(userId, limitKey, current, label) {
  const ent = await getForUser(userId);
  if (ent.suspended) {
    throw new EntitlementError('account_suspended',
      'This account is suspended. Contact support@scrapient.app.');
  }

  const limit = ent.limits[limitKey];
  if (isWithinLimit(limit, current)) return ent;

  const what = label || limitKey;
  // Find the cheapest plan that would actually help, so we never tell someone
  // on Business to "upgrade" when they've hit a ceiling no tier lifts.
  const { listPlans } = require('../config/plans');
  const better = listPlans().find(
    (p) => p.order > (getPlan(ent.effectivePlan) || {}).order
        && (p.limits[limitKey] == null || p.limits[limitKey] > limit)
  );

  throw new EntitlementError('limit_reached',
    better
      ? `You've reached your plan's limit of ${limit} ${what}. The ${better.name} plan allows ${better.limits[limitKey] == null ? 'unlimited' : better.limits[limitKey]}.`
      : `You've reached the limit of ${limit} ${what}.`,
    { limitKey, limit, current, requiredPlan: better ? better.slug : null,
      currentPlan: ent.effectivePlan });
}

/* ── Metered quota (monthly runs and pages) ──────────────────────────────── */

/**
 * Check the user may start a run. Called by every path that starts one —
 * the dashboard, the scheduler, and the public API — which is the fix for
 * quota previously living only on /v1 while the UI ran unmetered.
 *
 * Returns the entitlements plus the current period's usage so callers can
 * surface "42 of 50 runs used" without a second query.
 */
async function assertCanRun(userId) {
  const ent = await getForUser(userId);
  if (ent.suspended) {
    throw new EntitlementError('account_suspended',
      'This account is suspended. Contact support@scrapient.app.');
  }

  const used = await usage.getForPeriod(userId);
  const runLimit = ent.limits.monthlyRuns;
  const pageLimit = ent.limits.monthlyPages;

  if (runLimit != null && used.runs_used >= runLimit) {
    throw new EntitlementError('quota_exceeded',
      `Monthly run limit reached (${used.runs_used}/${runLimit}). Your quota resets on the 1st.`,
      { metric: 'runs', used: used.runs_used, limit: runLimit,
        period: used.period, currentPlan: ent.effectivePlan,
        requiredPlan: nextPlanAbove(ent.effectivePlan) });
  }

  if (pageLimit != null && used.pages_used >= pageLimit) {
    throw new EntitlementError('quota_exceeded',
      `Monthly page limit reached (${used.pages_used}/${pageLimit}). Your quota resets on the 1st.`,
      { metric: 'pages', used: used.pages_used, limit: pageLimit,
        period: used.period, currentPlan: ent.effectivePlan,
        requiredPlan: nextPlanAbove(ent.effectivePlan) });
  }

  return { entitlements: ent, usage: used };
}

function nextPlanAbove(slug) {
  const { listPlans } = require('../config/plans');
  const current = getPlan(slug);
  if (!current) return null;
  const next = listPlans().find((p) => p.order > current.order && p.purchasable);
  return next ? next.slug : null;
}

/**
 * The usage summary shown on the account screen and returned by /v1/usage.
 * Percentages are pre-computed here so the frontend and the public API can't
 * drift on how "unlimited" renders.
 */
async function getUsageSummary(userId) {
  const ent = await getForUser(userId);
  const used = await usage.getForPeriod(userId);

  const pct = (u, limit) => (limit == null || limit === 0 ? null : Math.min(100, Math.round((u / limit) * 100)));

  return {
    period: used.period,
    plan: ent.plan,
    planName: ent.planName,
    planStatus: ent.planStatus,
    effectivePlan: ent.effectivePlan,
    lapsed: ent.lapsed,
    runs: {
      used: used.runs_used,
      limit: ent.limits.monthlyRuns,
      percent: pct(used.runs_used, ent.limits.monthlyRuns),
    },
    pages: {
      used: used.pages_used,
      limit: ent.limits.monthlyPages,
      percent: pct(used.pages_used, ent.limits.monthlyPages),
    },
    features: ent.features,
    limits: ent.limits,
  };
}

module.exports = {
  EntitlementError,
  getForUser,
  resolveFromRow,
  invalidate,
  invalidateAll,
  hasFeature,
  requiredPlanFor,
  assertFeature,
  isWithinLimit,
  assertWithinLimit,
  assertCanRun,
  getUsageSummary,
  nextPlanAbove,
};
