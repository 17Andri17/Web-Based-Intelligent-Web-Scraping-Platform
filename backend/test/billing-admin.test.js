'use strict';

/* ===========================================================================
   Billing (stubbed provider) and the admin panel.

   The interesting assertions here are the refusals, not the happy paths:
   the stub must not be reachable in production, an admin must not be able to
   lock themselves or everyone else out, and a plan change must take effect
   immediately rather than after the entitlements cache expires.

   Run: node test/billing-admin.test.js  (from backend/)
   ========================================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-admin-test-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.sqlite');
delete process.env.DB_CLIENT;
process.env.AUTH_RATE_LIMIT = '0';
delete process.env.NODE_ENV;               // the stub's prod guard is asserted below
delete process.env.BILLING_PROVIDER;       // → 'stub'

const http = require('http');

const db = require('../db/client');
const app = require('../app');
const users = require('../db/repositories/users.repo');
const usageRepo = require('../db/repositories/usage.repo');
const entitlements = require('../services/entitlements.service');
const billing = require('../services/billing.service');
const { signToken } = require('../middleware/auth');
const { getPlan } = require('../config/plans');

let BASE;
let passed = 0;

function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
    throw new Error(`FAILED: ${name}`);
  }
}

async function api(method, pathname, { token, body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}

async function makeUser(username, { plan = 'free', isAdmin = false } = {}) {
  const row = await db.get(
    `INSERT INTO users (username, password_hash, email, plan, is_admin)
     VALUES (?, 'x', ?, ?, ?) RETURNING id`,
    [username, `${username}@test.local`, plan, isAdmin ? 1 : 0]);
  return { id: row.id, username, token: signToken({ sub: row.id, username }) };
}

async function main() {
  await db.init();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;

  /* ── Public plan catalogue ─────────────────────────────────────────────── */
  console.log('plan catalogue');
  {
    // Unauthenticated: the pricing page renders before anyone signs up.
    const r = await api('GET', '/api/billing/plans');
    ok('plans are public', r.status === 200, `got ${r.status}`);
    ok('all three tiers are listed', r.json.plans.length === 3);
    ok('ordered cheapest first', r.json.plans[0].slug === 'free'
      && r.json.plans[2].slug === 'business');
    ok('carries the price the pricing page renders', r.json.plans[1].price.monthly === 29);
    ok('reports that billing is stubbed', r.json.stubbed === true);
    ok('free is not purchasable', r.json.plans[0].purchasable === false);
  }

  /* ── Upgrade ───────────────────────────────────────────────────────────── */
  console.log('checkout');
  {
    const u = await makeUser('buyer');

    let r = await api('GET', '/api/billing/usage', { token: u.token });
    ok('usage starts on free limits',
      r.status === 200 && r.json.runs.limit === getPlan('free').limits.monthlyRuns);

    r = await api('POST', '/api/billing/checkout', { token: u.token, body: { plan: 'pro' } });
    ok('checkout succeeds', r.status === 200, `got ${r.status} ${r.text}`);
    ok('stub applies the plan inline', r.json.applied === true);
    ok('response carries the new plan', r.json.user.plan.slug === 'pro');

    // The cache must be invalidated by the plan change: a customer who pays
    // and is still blocked is the worst ticket this product can generate.
    const ent = await entitlements.getForUser(u.id);
    ok('entitlements update immediately, not after the cache TTL',
      ent.effectivePlan === 'pro' && ent.features.scheduling === true);

    r = await api('GET', '/api/billing/usage', { token: u.token });
    ok('usage now reports pro limits',
      r.json.runs.limit === getPlan('pro').limits.monthlyRuns);

    r = await api('POST', '/api/billing/checkout', { token: u.token, body: { plan: 'pro' } });
    ok('buying the plan you already have → 409', r.status === 409, `got ${r.status}`);

    r = await api('POST', '/api/billing/checkout', { token: u.token, body: { plan: 'free' } });
    ok('"buying" free → 400', r.status === 400);

    r = await api('POST', '/api/billing/checkout', { token: u.token, body: { plan: 'enterprise' } });
    ok('unknown plan → 400', r.status === 400);

    r = await api('POST', '/api/billing/checkout', { body: { plan: 'pro' } });
    ok('checkout requires auth', r.status === 401);
  }

  /* ── Cancel keeps access until the period ends ─────────────────────────── */
  console.log('cancellation');
  {
    const u = await makeUser('canceller', { plan: 'pro' });

    let r = await api('POST', '/api/billing/cancel', { token: u.token });
    ok('cancel succeeds', r.status === 200, `got ${r.status} ${r.text}`);
    ok('an end date is returned', !!r.json.effectiveUntil);

    // The whole point: they paid for this month, so they keep it.
    const ent = await entitlements.getForUser(u.id, { fresh: true });
    ok('still entitled until the paid period ends', ent.effectivePlan === 'pro');
    ok('…and not marked lapsed', ent.lapsed === false);

    r = await api('POST', '/api/billing/resume', { token: u.token });
    ok('resume clears the end date', r.status === 200);
    ok('…and the plan continues',
      (await entitlements.getForUser(u.id, { fresh: true })).effectivePlan === 'pro');

    const free = await makeUser('nothing-to-cancel');
    r = await api('POST', '/api/billing/cancel', { token: free.token });
    ok('cancelling with no subscription → 409', r.status === 409);
  }

  /* ── Webhook events ────────────────────────────────────────────────────── */
  console.log('webhook event handling');
  {
    const u = await makeUser('webhooked', { plan: 'pro' });
    await users.setBillingLinkage(u.id, {
      provider: 'stub', customerId: 'cus_test_1', subscriptionId: 'sub_1',
    });

    // applyEvent is provider-agnostic by design, so it can be driven directly
    // with the normalised shape any adapter is required to produce.
    let out = await billing.applyEvent({ type: 'subscription.past_due', customerId: 'cus_test_1' });
    ok('past_due is applied', out.ok && out.status === 'past_due');

    let ent = await entitlements.getForUser(u.id, { fresh: true });
    ok('past_due is served FREE limits', ent.effectivePlan === 'free');
    ok('…while still reporting the real plan to the UI', ent.plan === 'pro');
    ok('…and flagged as lapsed', ent.lapsed === true);

    out = await billing.applyEvent({
      type: 'subscription.active', customerId: 'cus_test_1', plan: 'business',
    });
    ok('a successful payment restores entitlement', out.ok && out.plan === 'business');
    ent = await entitlements.getForUser(u.id, { fresh: true });
    ok('…to the new tier', ent.effectivePlan === 'business');

    out = await billing.applyEvent({ type: 'subscription.active', customerId: 'cus_unknown' });
    ok('an unknown customer is acknowledged, not errored', out.ok && out.ignored === 'unknown_customer');

    // The endpoint itself must reject anything unverified while stubbed —
    // there is no legitimate source that could post to it.
    const r = await api('POST', '/api/billing/webhook', { body: { type: 'anything' } });
    ok('unverified webhook → 400', r.status === 400, `got ${r.status}`);
  }

  /* ── The stub must not be reachable in production ──────────────────────── */
  console.log('stub production guard');
  {
    process.env.NODE_ENV = 'production';
    let threw = null;
    try { billing.assertStubIsSafe(); } catch (e) { threw = e; }
    ok('stub refuses to run in production', !!threw);
    ok('…with a 503, not a silent no-op', threw && threw.status === 503);

    const u = await makeUser('prod-buyer');
    const r = await api('POST', '/api/billing/checkout', { token: u.token, body: { plan: 'pro' } });
    ok('checkout is refused in production', r.status === 503, `got ${r.status}`);
    ok('…and the plan did NOT change',
      (await entitlements.getForUser(u.id, { fresh: true })).effectivePlan === 'free');

    // An explicit opt-out exists for staging environments that set
    // NODE_ENV=production but genuinely want the stub.
    process.env.BILLING_ALLOW_STUB_IN_PROD = '1';
    let threw2 = null;
    try { billing.assertStubIsSafe(); } catch (e) { threw2 = e; }
    ok('the explicit override re-enables it', threw2 === null);

    delete process.env.BILLING_ALLOW_STUB_IN_PROD;
    delete process.env.NODE_ENV;
  }

  /* ── Admin access control ──────────────────────────────────────────────── */
  console.log('admin access control');
  {
    const plain = await makeUser('not-an-admin');
    let r = await api('GET', '/api/admin/stats', { token: plain.token });
    ok('non-admin → 403', r.status === 403, `got ${r.status}`);

    r = await api('GET', '/api/admin/users');
    ok('anonymous → 401', r.status === 401);

    const admin = await makeUser('root', { isAdmin: true });
    r = await api('GET', '/api/admin/stats', { token: admin.token });
    ok('admin → 200', r.status === 200, `got ${r.status}`);
    ok('stats count users', r.json.totalUsers > 0);
    ok('stats count paid users', r.json.paidUsers > 0);

    // requireAdmin re-reads the DB, so a demotion bites immediately rather
    // than waiting out the 7-day token.
    await users.setAdmin(plain.id, true);
    r = await api('GET', '/api/admin/stats', { token: plain.token });
    ok('promotion takes effect without re-login', r.status === 200);
    await users.setAdmin(plain.id, false);
    r = await api('GET', '/api/admin/stats', { token: plain.token });
    ok('demotion takes effect without re-login', r.status === 403);
  }

  /* ── Admin: managing a user ────────────────────────────────────────────── */
  console.log('admin user management');
  {
    const admin = await makeUser('root2', { isAdmin: true });
    const victim = await makeUser('customer', { plan: 'free' });
    await usageRepo.incrementRuns(victim.id, 7);

    let r = await api('GET', '/api/admin/users', { token: admin.token });
    ok('lists users', r.status === 200 && r.json.users.length > 0);
    const listed = r.json.users.find((u) => u.username === 'customer');
    ok('…with this period\'s usage joined in', listed && listed.usage.runsUsed === 7);

    r = await api('GET', '/api/admin/users?search=custom', { token: admin.token });
    ok('search filters', r.json.users.length === 1 && r.json.users[0].username === 'customer');

    r = await api('GET', `/api/admin/users/${victim.id}`, { token: admin.token });
    ok('detail resolves EFFECTIVE entitlements, not just the plan column',
      r.status === 200 && r.json.user.entitlements.effectivePlan === 'free');
    ok('…and includes usage history', Array.isArray(r.json.usageHistory));

    // Plan change
    r = await api('PUT', `/api/admin/users/${victim.id}/plan`, {
      token: admin.token, body: { plan: 'business' },
    });
    ok('admin can change a plan', r.status === 200 && r.json.user.plan === 'business');
    ok('…and it takes effect immediately',
      (await entitlements.getForUser(victim.id)).effectivePlan === 'business');

    r = await api('PUT', `/api/admin/users/${victim.id}/plan`, {
      token: admin.token, body: { plan: 'nonsense' },
    });
    ok('unknown plan → 400', r.status === 400);

    // Comp
    r = await api('PUT', `/api/admin/users/${victim.id}/overrides`, {
      token: admin.token, body: { overrides: { limits: { monthlyRuns: 99999 } } },
    });
    ok('admin can comp extra quota', r.status === 200);
    ok('…and the override is in force',
      (await entitlements.getForUser(victim.id, { fresh: true })).limits.monthlyRuns === 99999);

    r = await api('PUT', `/api/admin/users/${victim.id}/overrides`, {
      token: admin.token, body: { overrides: { nonsense: true } },
    });
    ok('an override with no limits/features → 400', r.status === 400);

    r = await api('PUT', `/api/admin/users/${victim.id}/overrides`, {
      token: admin.token, body: { overrides: null },
    });
    ok('overrides can be cleared', r.status === 200);
    ok('…restoring the plan\'s own limits',
      (await entitlements.getForUser(victim.id, { fresh: true })).limits.monthlyRuns
        === getPlan('business').limits.monthlyRuns);

    // Suspend
    r = await api('PUT', `/api/admin/users/${victim.id}/status`, {
      token: admin.token, body: { status: 'suspended', reason: 'abuse' },
    });
    ok('admin can suspend', r.status === 200 && r.json.user.status === 'suspended');
    ok('…and the suspension is enforced',
      (await entitlements.getForUser(victim.id, { fresh: true })).suspended === true);

    r = await api('GET', '/api/auth/me', { token: victim.token });
    ok('a suspended user is locked out on their next request', r.status === 403);

    r = await api('PUT', `/api/admin/users/${victim.id}/status`, {
      token: admin.token, body: { status: 'active' },
    });
    ok('…and can be restored', r.status === 200 && r.json.user.status === 'active');
  }

  /* ── Admin: the lock-yourself-out rails ────────────────────────────────── */
  console.log('admin safety rails');
  {
    const admin = await makeUser('soleadmin', { isAdmin: true });
    // Every other admin created above still exists, so make this the only one
    // to exercise the last-admin rails.
    await db.run(`UPDATE users SET is_admin = 0 WHERE id <> ?`, [admin.id]);
    ok('precondition: exactly one admin', (await users.countAdmins()) === 1);

    let r = await api('PUT', `/api/admin/users/${admin.id}/admin`, {
      token: admin.token, body: { isAdmin: false },
    });
    ok('cannot demote yourself', r.status === 409, `got ${r.status}`);

    r = await api('PUT', `/api/admin/users/${admin.id}/status`, {
      token: admin.token, body: { status: 'suspended' },
    });
    ok('cannot suspend yourself', r.status === 409);

    r = await api('DELETE', `/api/admin/users/${admin.id}?confirm=soleadmin`, { token: admin.token });
    ok('cannot delete yourself', r.status === 409);

    ok('…and you are still an admin afterwards', (await users.countAdmins()) === 1);

    // The last-admin rail, exercised via a second admin demoting the first.
    const other = await makeUser('second-admin', { isAdmin: true });
    r = await api('PUT', `/api/admin/users/${admin.id}/admin`, {
      token: other.token, body: { isAdmin: false },
    });
    ok('another admin CAN demote you when others remain', r.status === 200);

    r = await api('PUT', `/api/admin/users/${other.id}/admin`, {
      token: other.token, body: { isAdmin: false },
    });
    ok('…but the last admin cannot be removed', r.status === 409);
  }

  /* ── Admin: deletion demands confirmation ──────────────────────────────── */
  console.log('admin deletion');
  {
    const admin = await makeUser('deleter', { isAdmin: true });
    const doomed = await makeUser('goodbye');

    let r = await api('DELETE', `/api/admin/users/${doomed.id}`, { token: admin.token });
    ok('delete without confirmation → 400', r.status === 400);
    ok('…naming the required confirmation', r.json.code === 'confirmation_required');
    ok('…and the user still exists', !!(await users.findById(doomed.id)));

    r = await api('DELETE', `/api/admin/users/${doomed.id}?confirm=wrong`, { token: admin.token });
    ok('wrong confirmation → 400', r.status === 400);

    r = await api('DELETE', `/api/admin/users/${doomed.id}?confirm=goodbye`, { token: admin.token });
    ok('correct confirmation deletes', r.status === 200);
    ok('…and the user is gone', !(await users.findById(doomed.id)));

    // The audit entry must survive the row it describes — that is the whole
    // reason admin_audit has no FK to users.
    r = await api('GET', '/api/admin/audit', { token: admin.token });
    const entry = r.json.entries.find((e) => e.action === 'user.delete');
    ok('the deletion is in the audit log', !!entry);
    ok('…and still names the deleted user', entry.targetUsername === 'goodbye');
    ok('…and who did it', entry.adminUsername === 'deleter');
  }

  console.log(`\nAll ${passed} checks passed ✅`);
  server.close();
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
