'use strict';

const express = require('express');
const users = require('../db/repositories/users.repo');
const usageRepo = require('../db/repositories/usage.repo');
const oauthAccounts = require('../db/repositories/oauthAccounts.repo');
const audit = require('../db/repositories/adminAudit.repo');
const entitlements = require('../services/entitlements.service');
const billing = require('../services/billing.service');
const { listPlans, toPublicPlan, isValidPlan } = require('../config/plans');
const { requireAuth, requireAdmin } = require('../middleware/auth');

/* ===========================================================================
   /api/admin — operator tools.

   Every route is behind requireAuth + requireAdmin, applied at the router so
   a new route cannot be added unprotected by forgetting a middleware.
   requireAdmin re-reads is_admin from the database on each request rather
   than trusting the token, so a demotion takes effect immediately instead of
   waiting out a 7-day JWT.

   Three rails run through everything below, each guarding a way an operator
   can lock themselves or the platform out:

     • You cannot act destructively on your own account (demote, suspend,
       delete). Losing your own access mid-session is the single most likely
       operational mistake here.
     • The last admin cannot be removed or suspended. An install with zero
       admins has no way back in through the UI at all.
     • Everything that changes another account is written to admin_audit.
   ========================================================================= */

const router = express.Router();
router.use(requireAuth, requireAdmin);

const MAX_PAGE = 200;

function parsePaging(q) {
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(q.limit) || 50));
  const offset = Math.max(0, Number(q.offset) || 0);
  return { limit, offset };
}

/* ── Dashboard ──────────────────────────────────────────────────────────── */
router.get('/stats', async (req, res) => {
  const period = usageRepo.currentPeriod();
  const stats = await users.adminStats(period);
  res.json({
    period,
    totalUsers: Number(stats.total_users || 0),
    paidUsers: Number(stats.paid_users || 0),
    suspendedUsers: Number(stats.suspended_users || 0),
    newUsers30d: Number(stats.new_users_30d || 0),
    totalWorkflows: Number(stats.total_workflows || 0),
    runsThisPeriod: Number(stats.runs_this_period || 0),
    plans: listPlans().map(toPublicPlan),
    billingProvider: billing.providerName(),
    billingStubbed: billing.isStub(),
  });
});

/* ── User list ──────────────────────────────────────────────────────────── */
router.get('/users', async (req, res) => {
  const { limit, offset } = parsePaging(req.query);
  const { rows, total } = await users.listForAdmin({
    search: String(req.query.search || '').trim(),
    plan: String(req.query.plan || '').trim(),
    status: String(req.query.status || '').trim(),
    period: usageRepo.currentPeriod(),
    limit, offset,
  });
  res.json({ users: rows.map(serializeUser), total, limit, offset });
});

/* ── One user, in detail ────────────────────────────────────────────────── */
router.get('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  const row = await users.findById(id);
  if (!row) return res.status(404).json({ error: 'User not found' });

  const [ent, periods, linked, auditRows] = await Promise.all([
    entitlements.getForUser(id, { fresh: true }),
    usageRepo.listPeriodsForUser(id, 12),
    oauthAccounts.listForUser(id),
    audit.list({ targetUserId: id, limit: 50 }),
  ]);

  res.json({
    user: {
      ...serializeUser(row),
      // The resolved view: what this account can ACTUALLY do right now,
      // including any override and any lapse. It is the answer to the support
      // question "why can't they schedule?", which reading the plan column
      // alone would get wrong.
      entitlements: {
        effectivePlan: ent.effectivePlan,
        lapsed: ent.lapsed,
        hasOverrides: !!ent.hasOverrides,
        limits: ent.limits,
        features: ent.features,
      },
    },
    usageHistory: periods,
    linkedProviders: linked.map((l) => ({
      provider: l.provider, email: l.email, linkedAt: l.created_at,
    })),
    audit: auditRows.map(serializeAudit),
  });
});

/* ── Change a plan ──────────────────────────────────────────────────────── */
router.put('/users/:id/plan', async (req, res) => {
  const id = Number(req.params.id);
  const { plan, status = 'active', expiresAt = null } = req.body || {};

  if (!isValidPlan(plan)) return res.status(400).json({ error: 'Unknown plan.' });
  if (!['active', 'trialing', 'past_due', 'canceled'].includes(status)) {
    return res.status(400).json({ error: 'Unknown plan status.' });
  }

  const target = await users.findById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Routed through billing.applyPlan rather than the repo directly, so an
  // admin change invalidates the entitlements cache by exactly the same path
  // a provider webhook does.
  await billing.applyPlan(id, { plan, status, expiresAt });
  await audit.record({
    adminUserId: req.user.id, action: 'user.plan', targetUserId: id,
    details: { from: target.plan, to: plan, status, expiresAt },
  });

  res.json({ ok: true, user: serializeUser(await users.findById(id)) });
});

/* ── Comp or cap an individual account ──────────────────────────────────────
   plan_overrides_json merges over the plan's catalogue entry, so a support
   gesture ("here, have 5,000 extra runs") never requires inventing a tier.
   Body: { limits?: {...}, features?: {...} } or null to clear. */
router.put('/users/:id/overrides', async (req, res) => {
  const id = Number(req.params.id);
  const target = await users.findById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const body = req.body || {};
  let overrides = null;

  if (body.overrides !== null && body.overrides !== undefined) {
    const o = body.overrides;
    if (typeof o !== 'object' || Array.isArray(o)) {
      return res.status(400).json({ error: 'overrides must be an object or null.' });
    }
    // Only these two keys are honoured by entitlements.service; anything else
    // would be silently ignored, which is worse than being rejected.
    const clean = {};
    if (o.limits && typeof o.limits === 'object' && !Array.isArray(o.limits)) clean.limits = o.limits;
    if (o.features && typeof o.features === 'object' && !Array.isArray(o.features)) clean.features = o.features;
    if (!clean.limits && !clean.features) {
      return res.status(400).json({ error: 'overrides must contain "limits" and/or "features".' });
    }
    overrides = clean;
  }

  await users.setPlanOverrides(id, overrides);
  entitlements.invalidate(id);
  await audit.record({
    adminUserId: req.user.id, action: 'user.overrides', targetUserId: id,
    details: { overrides },
  });

  res.json({ ok: true, user: serializeUser(await users.findById(id)) });
});

/* ── Suspend / restore ──────────────────────────────────────────────────── */
router.put('/users/:id/status', async (req, res) => {
  const id = Number(req.params.id);
  const { status, reason = null } = req.body || {};
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'status must be "active" or "suspended".' });
  }

  const target = await users.findById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (status === 'suspended') {
    if (id === req.user.id) {
      return res.status(409).json({ error: 'You cannot suspend your own account.' });
    }
    if (target.is_admin && (await users.countAdmins()) <= 1) {
      return res.status(409).json({ error: 'Cannot suspend the last remaining admin.' });
    }
  }

  await users.setStatus(id, status, reason);
  entitlements.invalidate(id);
  await audit.record({
    adminUserId: req.user.id,
    action: status === 'suspended' ? 'user.suspend' : 'user.restore',
    targetUserId: id, details: { reason },
  });

  res.json({ ok: true, user: serializeUser(await users.findById(id)) });
});

/* ── Promote / demote ───────────────────────────────────────────────────── */
router.put('/users/:id/admin', async (req, res) => {
  const id = Number(req.params.id);
  const makeAdmin = !!(req.body && req.body.isAdmin);

  const target = await users.findById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (!makeAdmin) {
    // Demoting yourself would end the session that is doing the demoting,
    // and demoting the last admin locks everyone out of this panel.
    if (id === req.user.id) {
      return res.status(409).json({ error: 'You cannot remove your own admin access.' });
    }
    if (target.is_admin && (await users.countAdmins()) <= 1) {
      return res.status(409).json({ error: 'Cannot remove the last remaining admin.' });
    }
  }

  await users.setAdmin(id, makeAdmin);
  await audit.record({
    adminUserId: req.user.id,
    action: makeAdmin ? 'user.promote' : 'user.demote',
    targetUserId: id,
  });

  res.json({ ok: true, user: serializeUser(await users.findById(id)) });
});

/* ── Delete ─────────────────────────────────────────────────────────────────
   Cascades through every owned table (workflows, runs, schedules, proxies,
   keys, webhooks). Irreversible, so it demands the username as confirmation —
   the same shape GitHub uses for repository deletion, and for the same
   reason: an id in a URL is far too easy to get wrong. */
router.delete('/users/:id', async (req, res) => {
  const id = Number(req.params.id);

  if (id === req.user.id) {
    return res.status(409).json({ error: 'You cannot delete your own account here.' });
  }

  const target = await users.findById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const confirm = (req.query.confirm || (req.body && req.body.confirm) || '').toString();
  if (confirm !== target.username) {
    return res.status(400).json({
      error: `Type the username "${target.username}" to confirm deletion.`,
      code: 'confirmation_required',
    });
  }

  if (target.is_admin && (await users.countAdmins()) <= 1) {
    return res.status(409).json({ error: 'Cannot delete the last remaining admin.' });
  }

  // Audited BEFORE the delete: the target row (and the username the log
  // should carry) is about to stop existing.
  await audit.record({
    adminUserId: req.user.id, action: 'user.delete', targetUserId: id,
    details: { username: target.username, email: target.email, plan: target.plan },
  });
  await users.remove(id);
  entitlements.invalidate(id);

  res.json({ ok: true });
});

/* ── Audit log ──────────────────────────────────────────────────────────── */
router.get('/audit', async (req, res) => {
  const { limit, offset } = parsePaging(req.query);
  const rows = await audit.list({
    limit, offset,
    targetUserId: req.query.userId ? Number(req.query.userId) : null,
  });
  res.json({ entries: rows.map(serializeAudit) });
});

/* ── Serialisers ────────────────────────────────────────────────────────── */

function serializeUser(row) {
  if (!row) return null;
  let overrides = null;
  if (row.plan_overrides_json) {
    try { overrides = JSON.parse(row.plan_overrides_json); } catch (_) { overrides = null; }
  }
  return {
    id: row.id,
    username: row.username,
    email: row.email || null,
    emailVerified: !!row.email_verified,
    isAdmin: !!row.is_admin,
    status: row.status,
    suspendedReason: row.suspended_reason || null,
    plan: row.plan,
    planStatus: row.plan_status,
    planExpiresAt: row.plan_expires_at || null,
    overrides,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || null,
    // Present only on the list query, which joins them in.
    ...(row.runs_used !== undefined ? {
      usage: {
        runsUsed: Number(row.runs_used || 0),
        pagesUsed: Number(row.pages_used || 0),
        workflowCount: Number(row.workflow_count || 0),
      },
    } : {}),
  };
}

function serializeAudit(row) {
  let details = null;
  if (row.details_json) {
    try { details = JSON.parse(row.details_json); } catch (_) { details = null; }
  }
  return {
    id: row.id,
    action: row.action,
    adminUsername: row.admin_username || null,
    targetUserId: row.target_user_id,
    // Falls back to the username captured in details for a deleted user,
    // whose join now resolves to nothing.
    targetUsername: row.target_username || (details && details.username) || null,
    details,
    createdAt: row.created_at,
  };
}

module.exports = router;
