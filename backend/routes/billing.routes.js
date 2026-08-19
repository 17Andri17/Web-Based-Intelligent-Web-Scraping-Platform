'use strict';

const express = require('express');
const billing = require('../services/billing.service');
const entitlements = require('../services/entitlements.service');
const users = require('../db/repositories/users.repo');
const { listPlans, toPublicPlan } = require('../config/plans');
const { requireAuth } = require('../middleware/auth');

/* ===========================================================================
   /api/billing — the plan catalogue, current usage, and the upgrade flow.

   GET  /plans     public: the pricing page renders from this, so the marketing
                   site and the app can never disagree about what a plan includes
   GET  /usage     authed: this month's runs/pages against the caller's limits
   POST /checkout  authed: start an upgrade
   POST /cancel    authed: cancel, keeping access until the paid period ends
   POST /resume    authed: undo a cancellation
   POST /webhook   unauthenticated by design — the provider signs the body
   ========================================================================= */

const router = express.Router();

/* Public: no auth. A visitor comparing plans has not signed up yet, and this
   is the same data the app uses, so the pricing page cannot drift from what
   is actually enforced. */
router.get('/plans', (req, res) => {
  res.json({
    plans: listPlans().map(toPublicPlan),
    // Lets the UI hide "Manage billing" and show a dev banner while the
    // provider is stubbed, rather than linking to a portal that 501s.
    provider: billing.providerName(),
    stubbed: billing.isStub(),
  });
});

router.get('/usage', requireAuth, async (req, res) => {
  res.json(await entitlements.getUsageSummary(req.user.id));
});

router.post('/checkout', requireAuth, async (req, res, next) => {
  try {
    const plan = String((req.body && req.body.plan) || '');
    const user = await users.findById(req.user.id);
    if (!user) return res.status(401).json({ error: 'Account no longer exists' });

    const result = await billing.startCheckout({
      user,
      plan,
      returnUrl: req.body && req.body.returnUrl,
    });

    // `applied: true` means the plan already changed (the stub, or a provider
    // whose checkout completed inline). The client refreshes its session
    // instead of navigating anywhere.
    res.json({
      ...result,
      user: result.applied ? await sessionPlan(req.user.id) : undefined,
    });
  } catch (err) { next(err); }
});

router.post('/cancel', requireAuth, async (req, res, next) => {
  try {
    const user = await users.findById(req.user.id);
    const out = await billing.cancel({ user });
    res.json({ ...out, user: await sessionPlan(req.user.id) });
  } catch (err) { next(err); }
});

router.post('/resume', requireAuth, async (req, res, next) => {
  try {
    const user = await users.findById(req.user.id);
    const out = await billing.resume({ user });
    res.json({ ...out, user: await sessionPlan(req.user.id) });
  } catch (err) { next(err); }
});

/* The provider's callback. Deliberately NOT behind requireAuth — the caller
   is a server, not a signed-in user. Authenticity comes from the signature
   over the raw body, which is why this route needs express.raw() rather than
   the parsed JSON body: verifying a signature against a re-serialised object
   fails on any key-order or whitespace difference.

   While billing is stubbed, parseWebhook returns null for everything and this
   always answers 400 — there is no source that could legitimately post here. */
router.post('/webhook',
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req, res) => {
    try {
      const out = await billing.handleWebhook({ rawBody: req.body, headers: req.headers });
      if (!out.ok) return res.status(400).json({ error: 'Invalid or unverified webhook.' });
      // 200 with a body the provider can log. Any 4xx/5xx makes providers
      // retry, so an event we deliberately ignored must still answer 200.
      res.json(out);
    } catch (err) {
      console.error('[billing] webhook failed:', err);
      res.status(500).json({ error: 'Webhook processing failed.' });
    }
  });

async function sessionPlan(userId) {
  const ent = await entitlements.getForUser(userId, { fresh: true });
  return {
    plan: {
      slug: ent.plan,
      name: ent.planName,
      status: ent.planStatus,
      effective: ent.effectivePlan,
      lapsed: ent.lapsed,
      features: ent.features,
      limits: ent.limits,
    },
  };
}

module.exports = router;
