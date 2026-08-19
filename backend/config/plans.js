'use strict';

/* ===========================================================================
   config/plans.js
   ---------------------------------------------------------------------------
   The plan catalog: the single source of truth for what each tier may do.

   This is code, not a table, on purpose. Limits change by deploy, not by
   customer action, and keeping them in git means "why did this user get 3000
   runs?" is answerable from history rather than from an untracked UPDATE.
   Per-user exceptions (comps, grandfathering, a support gesture) are handled
   by users.plan_overrides_json, which services/entitlements.service.js merges
   over the entry below — so the catalog never needs a bespoke tier.

   ── Adding a limit ────────────────────────────────────────────────────────
   Numeric limits use `null` to mean UNLIMITED, never 0 and never -1. 0 is a
   real, meaningful limit (an entitlement nobody has), so overloading it would
   make "unlimited" and "none" indistinguishable in the exact place that
   matters. Every consumer must therefore null-check before comparing; the
   helpers in entitlements.service.js do this for you — prefer them over
   reading these numbers directly.

   ── Adding a feature flag ─────────────────────────────────────────────────
   Add it to EVERY plan explicitly, including `false` entries. A flag that is
   merely absent from `free` reads as undefined, which is falsy today but
   silently becomes a bug the moment someone writes `!== false`. Explicit
   false is self-documenting and diffable.
   ========================================================================= */

// Currency is presentational only — the amount actually charged is whatever
// the billing provider's price object says. These exist so the pricing page
// and the upgrade prompts don't hard-code numbers in JSX.
const CURRENCY = 'EUR';

const PLANS = {
  free: {
    slug: 'free',
    name: 'Free',
    tagline: 'Build one scraper and see it work.',
    price: { monthly: 0, yearly: 0, currency: CURRENCY },
    order: 0,
    // Not offered for purchase — assigned on signup and on downgrade.
    purchasable: false,

    limits: {
      maxWorkflows: 1,
      monthlyRuns: 50,
      // Fair-use ceiling so a single paginated run can't consume a month of
      // Chrome time. Sized at ~10 pages/run: generous for a demo, and a user
      // who hits it is exactly the user who should be on Pro.
      monthlyPages: 500,
      concurrentRuns: 1,
      maxSchedules: 0,
      maxProxies: 0,
      maxApiKeys: 0,
      maxWebhooks: 0,
      // How long run history and results are kept. Deliberately short on free:
      // storage is a real cost and history is a genuine paid-tier value.
      runRetentionDays: 7,
      // Cap on rows returned per run. Free users can prove the tool works
      // without being able to use it as a production extraction pipeline.
      maxRowsPerRun: 100,
    },

    features: {
      scheduling: false,
      proxies: false,
      sharedProxyPool: false,
      publicApi: false,
      webhooks: false,
      emailAlerts: false,
      changeMonitoring: false,
      sheetsDelivery: false,
      captchaSolving: false,
      // Self-healing stays ON for free. It is the single thing this product
      // does that Browse AI and Octoparse do not, and a free user who never
      // sees a scraper repair itself has no reason to pay for one that does.
      // The demo IS the pitch.
      selfHealing: true,
      apiDiscovery: true,
      codeExport: true,
      customActions: false,
      prioritySupport: false,
    },
  },

  pro: {
    slug: 'pro',
    name: 'Pro',
    tagline: 'Run real scrapers on a schedule.',
    price: { monthly: 29, yearly: 290, currency: CURRENCY },
    order: 1,
    purchasable: true,
    // Shown with a highlight on the pricing page.
    featured: true,

    limits: {
      maxWorkflows: 20,
      monthlyRuns: 3000,
      // ~50 pages/run — comfortably above what a scheduled list+detail scrape
      // consumes, so the cap is invisible to honest use.
      monthlyPages: 150000,
      concurrentRuns: 3,
      maxSchedules: 20,
      maxProxies: 10,
      maxApiKeys: 5,
      maxWebhooks: 5,
      runRetentionDays: 30,
      maxRowsPerRun: null,
    },

    features: {
      scheduling: true,
      proxies: true,
      sharedProxyPool: false,
      publicApi: true,
      webhooks: true,
      emailAlerts: true,
      changeMonitoring: true,
      sheetsDelivery: true,
      captchaSolving: false,
      selfHealing: true,
      apiDiscovery: true,
      codeExport: true,
      customActions: true,
      prioritySupport: false,
    },
  },

  business: {
    slug: 'business',
    name: 'Business',
    tagline: 'Scale up, with the hard sites handled.',
    price: { monthly: 99, yearly: 990, currency: CURRENCY },
    order: 2,
    purchasable: true,

    limits: {
      maxWorkflows: null,
      monthlyRuns: 20000,
      monthlyPages: 1000000,
      concurrentRuns: 10,
      maxSchedules: null,
      maxProxies: null,
      maxApiKeys: null,
      maxWebhooks: null,
      runRetentionDays: 90,
      maxRowsPerRun: null,
    },

    features: {
      scheduling: true,
      proxies: true,
      // The platform-managed rotating pool — the reason this tier exists for
      // anyone scraping sites that block datacentre IPs.
      sharedProxyPool: true,
      publicApi: true,
      webhooks: true,
      emailAlerts: true,
      changeMonitoring: true,
      sheetsDelivery: true,
      captchaSolving: true,
      selfHealing: true,
      apiDiscovery: true,
      codeExport: true,
      customActions: true,
      prioritySupport: true,
    },
  },
};

const DEFAULT_PLAN = 'free';

// Plan served when a paid subscription lapses. Not a separate tier: the user
// keeps their data and their real `plan` value, but is served these limits
// until they pay. Anything over the free cap (e.g. their 14 workflows) becomes
// read-only rather than deleted — see entitlements.service.js.
const LAPSED_PLAN = 'free';

// plan_status values that mean "serve the paid entitlements". Anything else
// falls back to LAPSED_PLAN. 'trialing' counts as paid; 'past_due' does not,
// which is what makes a failed renewal actually bite.
const ENTITLED_STATUSES = new Set(['active', 'trialing']);

function getPlan(slug) {
  return PLANS[slug] || null;
}

// Every plan, ordered for display on the pricing page.
function listPlans() {
  return Object.values(PLANS).sort((a, b) => a.order - b.order);
}

function isValidPlan(slug) {
  return Object.prototype.hasOwnProperty.call(PLANS, slug);
}

// The public shape of a plan — safe to serialise to the pricing page and to
// an unauthenticated visitor. Currently everything in a plan is public, but
// routing it through one function means adding an internal-only field later
// (a provider price id, a cost basis) can't leak by default.
function toPublicPlan(plan) {
  return {
    slug: plan.slug,
    name: plan.name,
    tagline: plan.tagline,
    price: plan.price,
    order: plan.order,
    purchasable: plan.purchasable,
    featured: !!plan.featured,
    limits: { ...plan.limits },
    features: { ...plan.features },
  };
}

module.exports = {
  PLANS,
  DEFAULT_PLAN,
  LAPSED_PLAN,
  ENTITLED_STATUSES,
  CURRENCY,
  getPlan,
  listPlans,
  isValidPlan,
  toPublicPlan,
};
