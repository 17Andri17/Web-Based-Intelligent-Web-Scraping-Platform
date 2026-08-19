'use strict';

const users = require('../db/repositories/users.repo');
const entitlements = require('./entitlements.service');
const { getPlan, isValidPlan, DEFAULT_PLAN } = require('../config/plans');

/* ===========================================================================
   billing.service
   ---------------------------------------------------------------------------
   The seam between "which plan is this user on" and "who took their money".

   Everything above this file — entitlements, route guards, the admin panel —
   talks about plans and never about a payment provider. Everything below is
   one provider adapter. Swapping the stub for Paddle, Stripe or Lemon
   Squeezy should touch this file and nothing else.

   ── Why a stub at all ─────────────────────────────────────────────────────
   The provider decision is deferred, but the plan machinery, the upgrade UI
   and the admin panel all need something to call. The stub implements the
   real interface and changes the plan directly, so every code path except
   the payment itself is exercised and tested now rather than discovered
   later.

   ── The safety rail ───────────────────────────────────────────────────────
   A stub that grants paid plans for free is a catastrophic thing to leave
   reachable in production. It refuses to load unless the deployment is
   explicitly non-production or BILLING_ALLOW_STUB_IN_PROD is set — see
   assertStubIsSafe(). This is checked at call time, not just at boot, so it
   cannot be bypassed by an env var that changes after start.

   ── Adding a real provider ────────────────────────────────────────────────
   Implement the Provider interface below and register it in PROVIDERS. The
   contract is deliberately small:

     createCheckout({ user, plan, returnUrl })  -> { url, applied? }
     createPortalSession({ user, returnUrl })   -> { url }
     cancelSubscription({ user })               -> { effectiveUntil }
     resumeSubscription({ user })               -> {}
     parseWebhook({ rawBody, headers })         -> normalised event | null

   parseWebhook returns one of the normalised events applyEvent() understands,
   so provider-specific payload shapes never leak past this file.
   ========================================================================= */

function providerName() {
  return (process.env.BILLING_PROVIDER || 'stub').toLowerCase();
}

function isStub() {
  return providerName() === 'stub';
}

/**
 * Guard against shipping the stub live. Thrown as a 500-shaped error rather
 * than silently downgrading, because a checkout that quietly does nothing is
 * harder to diagnose than one that fails loudly.
 */
function assertStubIsSafe() {
  if (!isStub()) return;
  const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const allowed = String(process.env.BILLING_ALLOW_STUB_IN_PROD || '') === '1';
  if (isProd && !allowed) {
    const err = new Error(
      'Billing is not configured. Set BILLING_PROVIDER to a real provider before accepting payments.');
    err.status = 503;
    err.code = 'billing_not_configured';
    throw err;
  }
}

/* ── Plan transitions ───────────────────────────────────────────────────────
   The single place a plan actually changes. Everything that can move a user
   between plans — checkout, cancellation, a provider webhook, an admin
   action — routes through here so the entitlements cache is always
   invalidated and the change is always recorded the same way.
   ------------------------------------------------------------------------ */
async function applyPlan(userId, { plan, status = 'active', expiresAt = null }) {
  if (!isValidPlan(plan)) throw new Error(`Unknown plan: ${plan}`);
  await users.setPlan(userId, { plan, status, expiresAt });
  // Without this the user keeps their old entitlements for up to the cache
  // TTL — which for an upgrade means paying and still being blocked.
  entitlements.invalidate(userId);
  return { plan, status, expiresAt };
}

/* ── Providers ──────────────────────────────────────────────────────────── */

const stubProvider = {
  name: 'stub',
  displayName: 'Development stub',

  // A real provider returns a hosted checkout URL and the plan changes later,
  // when the webhook lands. The stub has nowhere to send the user, so it
  // applies the change immediately and says so with `applied: true` — the
  // frontend uses that flag to decide between redirecting and just
  // refreshing the session.
  async createCheckout({ user, plan, returnUrl }) {
    assertStubIsSafe();
    await applyPlan(user.id, { plan, status: 'active', expiresAt: null });
    await users.setBillingLinkage(user.id, {
      provider: 'stub',
      customerId: `stub_cus_${user.id}`,
      subscriptionId: `stub_sub_${user.id}_${Date.now()}`,
    });
    return { url: returnUrl || null, applied: true, plan };
  },

  async createPortalSession() {
    assertStubIsSafe();
    const err = new Error('There is no billing portal while billing is stubbed.');
    err.status = 501;
    throw err;
  },

  // Cancellation keeps the paid plan until the end of the period the customer
  // already paid for. The stub fakes a 30-day period so the "cancelled but
  // still entitled" state — the one most likely to be got wrong — is
  // reachable and testable.
  async cancelSubscription({ user }) {
    assertStubIsSafe();
    const effectiveUntil = new Date(Date.now() + 30 * 86400000).toISOString();
    await users.setPlanStatus(user.id, 'active', effectiveUntil);
    entitlements.invalidate(user.id);
    return { effectiveUntil };
  },

  async resumeSubscription({ user }) {
    assertStubIsSafe();
    await users.setPlanStatus(user.id, 'active', null);
    entitlements.invalidate(user.id);
    return {};
  },

  // The stub has no webhook source, so anything arriving at the endpoint is
  // rejected rather than trusted.
  async parseWebhook() {
    return null;
  },
};

const PROVIDERS = { stub: stubProvider };

function provider() {
  const p = PROVIDERS[providerName()];
  if (!p) {
    const err = new Error(`Unknown BILLING_PROVIDER "${providerName()}".`);
    err.status = 500;
    throw err;
  }
  return p;
}

/* ── Normalised webhook events ──────────────────────────────────────────────
   Whatever a provider sends, parseWebhook reduces it to one of:

     { type: 'subscription.active',   customerId, plan, subscriptionId }
     { type: 'subscription.past_due', customerId }
     { type: 'subscription.canceled', customerId, effectiveUntil }

   applyEvent is then provider-agnostic, which is what keeps a provider swap
   from rippling into the rest of the app.
   ------------------------------------------------------------------------ */
async function applyEvent(event) {
  if (!event || !event.customerId) return { ok: false, reason: 'no_customer' };

  const user = await users.findByBillingCustomerId(event.customerId);
  // An unknown customer is normal, not an error: providers send events for
  // test objects and for customers created by other environments sharing the
  // same account. Acknowledge so the provider stops retrying.
  if (!user) return { ok: true, ignored: 'unknown_customer' };

  switch (event.type) {
    case 'subscription.active':
      await applyPlan(user.id, { plan: event.plan, status: 'active', expiresAt: null });
      if (event.subscriptionId) {
        await users.setBillingLinkage(user.id, {
          provider: providerName(),
          customerId: event.customerId,
          subscriptionId: event.subscriptionId,
        });
      }
      return { ok: true, userId: user.id, plan: event.plan };

    case 'subscription.past_due':
      // The plan column is left alone on purpose. The user keeps reading
      // "Pro — payment failed" while being served free limits, which is both
      // more honest and more likely to get them to fix their card than
      // silently demoting them.
      await users.setPlanStatus(user.id, 'past_due', null);
      entitlements.invalidate(user.id);
      return { ok: true, userId: user.id, status: 'past_due' };

    case 'subscription.canceled':
      // Still entitled until the paid period ends; entitlements.service
      // reads plan_expires_at and drops them to free once it passes.
      await users.setPlanStatus(user.id, 'active', event.effectiveUntil || new Date().toISOString());
      entitlements.invalidate(user.id);
      return { ok: true, userId: user.id, until: event.effectiveUntil };

    default:
      return { ok: true, ignored: event.type };
  }
}

/* ── Public API used by routes ──────────────────────────────────────────── */

async function startCheckout({ user, plan, returnUrl }) {
  const target = getPlan(plan);
  if (!target) {
    const err = new Error('Unknown plan.');
    err.status = 400;
    throw err;
  }
  if (!target.purchasable) {
    const err = new Error(`The ${target.name} plan cannot be purchased.`);
    err.status = 400;
    throw err;
  }
  const current = await entitlements.getForUser(user.id, { fresh: true });
  if (current.plan === plan && !current.lapsed) {
    const err = new Error(`You are already on the ${target.name} plan.`);
    err.status = 409;
    throw err;
  }
  return provider().createCheckout({ user, plan, returnUrl });
}

async function cancel({ user }) {
  const current = await entitlements.getForUser(user.id, { fresh: true });
  if (current.plan === DEFAULT_PLAN) {
    const err = new Error('There is no paid subscription to cancel.');
    err.status = 409;
    throw err;
  }
  return provider().cancelSubscription({ user });
}

async function resume({ user }) {
  return provider().resumeSubscription({ user });
}

async function portal({ user, returnUrl }) {
  return provider().createPortalSession({ user, returnUrl });
}

async function handleWebhook({ rawBody, headers }) {
  const event = await provider().parseWebhook({ rawBody, headers });
  if (!event) return { ok: false, reason: 'unverified' };
  return applyEvent(event);
}

module.exports = {
  providerName,
  isStub,
  assertStubIsSafe,
  applyPlan,
  applyEvent,
  startCheckout,
  cancel,
  resume,
  portal,
  handleWebhook,
  // Exported for tests and for a future provider module to reuse.
  PROVIDERS,
};
