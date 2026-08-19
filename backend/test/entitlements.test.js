'use strict';

/* Unit tests for plan entitlement resolution: the effective-vs-stored plan
   rule, per-user overrides, and the null-means-unlimited convention. Pure —
   resolveFromRow and isWithinLimit take plain values, no DB.
   Run: node test/entitlements.test.js  (from backend/) */

const assert = require('assert');
const { resolveFromRow, isWithinLimit, requiredPlanFor } = require('../services/entitlements.service');
const { getPlan, listPlans, isValidPlan } = require('../config/plans');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const DAY = 86400000;
const row = (over = {}) => ({
  id: 1, plan: 'free', plan_status: 'active', plan_expires_at: null,
  plan_overrides_json: null, status: 'active', ...over,
});

console.log('catalog integrity');
test('every plan defines the same feature keys', () => {
  const plans = listPlans();
  const reference = Object.keys(plans[0].features).sort();
  for (const p of plans) {
    assert.deepEqual(Object.keys(p.features).sort(), reference,
      `${p.slug} feature keys differ from ${plans[0].slug}`);
  }
});
test('every plan defines the same limit keys', () => {
  const plans = listPlans();
  const reference = Object.keys(plans[0].limits).sort();
  for (const p of plans) {
    assert.deepEqual(Object.keys(p.limits).sort(), reference,
      `${p.slug} limit keys differ from ${plans[0].slug}`);
  }
});
test('no limit uses 0 or -1 to mean unlimited', () => {
  // 0 is a real limit ("none"); unlimited must be null. A -1 anywhere means
  // someone imported a different convention.
  for (const p of listPlans()) {
    for (const [k, v] of Object.entries(p.limits)) {
      assert.notEqual(v, -1, `${p.slug}.${k} uses -1; unlimited must be null`);
    }
  }
});
test('paid plans are strictly more generous than free on headline limits', () => {
  const free = getPlan('free').limits;
  for (const slug of ['pro', 'business']) {
    const l = getPlan(slug).limits;
    for (const k of ['monthlyRuns', 'monthlyPages', 'maxWorkflows']) {
      const better = l[k] == null || (free[k] != null && l[k] > free[k]);
      assert.ok(better, `${slug}.${k} (${l[k]}) is not above free (${free[k]})`);
    }
  }
});

console.log('isWithinLimit — the null convention');
test('null limit is unlimited, even for large counts', () => {
  assert.equal(isWithinLimit(null, 0), true);
  assert.equal(isWithinLimit(null, 999999), true);
});
test('zero limit denies everything', () => {
  // The bug this guards: treating 0 as "unlimited" would hand free users
  // scheduling, since free.maxSchedules is 0.
  assert.equal(isWithinLimit(0, 0), false);
});
test('numeric limit is exclusive of the limit itself', () => {
  assert.equal(isWithinLimit(1, 0), true);   // 0 owned, 1 allowed → may create
  assert.equal(isWithinLimit(1, 1), false);  // 1 owned of 1 → may not
});

console.log('resolveFromRow — stored vs effective plan');
test('active pro gets pro entitlements', () => {
  const e = resolveFromRow(row({ plan: 'pro', plan_status: 'active' }));
  assert.equal(e.effectivePlan, 'pro');
  assert.equal(e.lapsed, false);
  assert.equal(e.features.scheduling, true);
  assert.equal(e.limits.monthlyRuns, getPlan('pro').limits.monthlyRuns);
});
test('trialing counts as entitled', () => {
  const e = resolveFromRow(row({ plan: 'pro', plan_status: 'trialing' }));
  assert.equal(e.effectivePlan, 'pro');
  assert.equal(e.lapsed, false);
});
test('past_due pro is served FREE limits but still reports plan=pro', () => {
  // The distinction the UI depends on: show them their real tier, enforce the
  // lapsed one. Getting this backwards gives the product away.
  const e = resolveFromRow(row({ plan: 'pro', plan_status: 'past_due' }));
  assert.equal(e.plan, 'pro');
  assert.equal(e.planName, 'Pro');
  assert.equal(e.effectivePlan, 'free');
  assert.equal(e.lapsed, true);
  assert.equal(e.features.scheduling, false);
});
test('canceled but still inside the paid period keeps its entitlements', () => {
  const e = resolveFromRow(row({
    plan: 'pro', plan_status: 'active',
    plan_expires_at: new Date(Date.now() + 5 * DAY).toISOString(),
  }));
  assert.equal(e.effectivePlan, 'pro');
  assert.equal(e.lapsed, false);
});
test('expired period drops to free even while status says active', () => {
  const e = resolveFromRow(row({
    plan: 'pro', plan_status: 'active',
    plan_expires_at: new Date(Date.now() - DAY).toISOString(),
  }));
  assert.equal(e.effectivePlan, 'free');
  assert.equal(e.lapsed, true);
});
test('unknown plan slug falls back to free rather than throwing', () => {
  const e = resolveFromRow(row({ plan: 'enterprise_typo' }));
  assert.equal(e.effectivePlan, 'free');
  assert.equal(e.limits.maxWorkflows, getPlan('free').limits.maxWorkflows);
});
test('null row (deleted user mid-request) resolves to free, not a crash', () => {
  const e = resolveFromRow(null);
  assert.equal(e.effectivePlan, 'free');
  assert.equal(e.suspended, false);
});

console.log('resolveFromRow — suspension');
test('suspended is surfaced independently of plan', () => {
  const e = resolveFromRow(row({ plan: 'business', status: 'suspended' }));
  assert.equal(e.suspended, true);
  assert.equal(e.effectivePlan, 'business'); // still paid; just blocked
});

console.log('resolveFromRow — per-user overrides');
test('override raises a single limit, leaving the rest of the plan intact', () => {
  const e = resolveFromRow(row({
    plan: 'free',
    plan_overrides_json: JSON.stringify({ limits: { monthlyRuns: 10000 } }),
  }));
  assert.equal(e.limits.monthlyRuns, 10000);
  assert.equal(e.limits.maxWorkflows, getPlan('free').limits.maxWorkflows);
  assert.equal(e.hasOverrides, true);
});
test('override can grant a single feature (comping a customer)', () => {
  const e = resolveFromRow(row({
    plan: 'free',
    plan_overrides_json: JSON.stringify({ features: { scheduling: true } }),
  }));
  assert.equal(e.features.scheduling, true);
  assert.equal(e.features.publicApi, false);
});
test('overrides apply over the LAPSED plan, not the lapsed subscription', () => {
  // A past_due user with a comped run limit gets free features + the comp,
  // not their old Pro features back.
  const e = resolveFromRow(row({
    plan: 'pro', plan_status: 'past_due',
    plan_overrides_json: JSON.stringify({ limits: { monthlyRuns: 500 } }),
  }));
  assert.equal(e.limits.monthlyRuns, 500);
  assert.equal(e.features.scheduling, false);
});
test('malformed override JSON is ignored, granting nothing', () => {
  const e = resolveFromRow(row({ plan_overrides_json: '{not json' }));
  assert.equal(e.hasOverrides, false);
  assert.equal(e.limits.monthlyRuns, getPlan('free').limits.monthlyRuns);
});
test('a JSON array override is rejected (not an object)', () => {
  const e = resolveFromRow(row({ plan_overrides_json: '[1,2,3]' }));
  assert.equal(e.hasOverrides, false);
});

console.log('requiredPlanFor — upgrade prompts');
test('names the cheapest plan granting a feature', () => {
  assert.equal(requiredPlanFor('scheduling'), 'pro');
  assert.equal(requiredPlanFor('sharedProxyPool'), 'business');
  assert.equal(requiredPlanFor('captchaSolving'), 'business');
});
test('a feature free already has resolves to free', () => {
  assert.equal(requiredPlanFor('selfHealing'), 'free');
});
test('an unknown feature yields null rather than a bogus upsell', () => {
  assert.equal(requiredPlanFor('timeTravel'), null);
});

console.log('plan slugs');
test('isValidPlan accepts catalog slugs and rejects others', () => {
  assert.equal(isValidPlan('free'), true);
  assert.equal(isValidPlan('pro'), true);
  assert.equal(isValidPlan('business'), true);
  assert.equal(isValidPlan('constructor'), false); // prototype-pollution guard
  assert.equal(isValidPlan('toString'), false);
});

console.log(`\n${passed} passed`);
