'use strict';

/* ===========================================================================
   Plan enforcement, end-to-end through the real HTTP routes.

   entitlements.test.js proves the resolver computes the right limits. This
   proves the routes actually apply them — which is a different failure mode
   and the one that costs money: a correct entitlement nobody checks is worth
   nothing.

   The specific hole this guards is the one that existed before plans landed:
   quota lived only in routes/v1, so the entire dashboard ran unmetered and a
   free account could create unlimited workflows and run them forever simply
   by not using the public API.

   Run: node test/entitlement-gates.test.js  (from backend/)
   ========================================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the data layer at a throwaway DB BEFORE anything requires db/client.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ent-gates-test-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.sqlite');
delete process.env.DB_CLIENT;           // force sqlite regardless of shell env
process.env.SMTP_HOST = 'smtp.invalid'; // make mailer.isConfigured() true so the
process.env.SMTP_USER = 't@test';       // notifications route reaches its plan
process.env.SMTP_PASS = 'x';            // gate instead of short-circuiting on setup

const http = require('http');

const db = require('../db/client');
const app = require('../app');
const workflowsRepo = require('../db/repositories/workflows.repo');
const usageRepo = require('../db/repositories/usage.repo');
const entitlements = require('../services/entitlements.service');
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

async function makeUser(username, plan) {
  const row = await db.get(
    `INSERT INTO users (username, password_hash, plan) VALUES (?, 'x', ?) RETURNING id`,
    [username, plan]);
  return { id: row.id, token: signToken({ sub: row.id, username }) };
}

const WF_BODY = {
  name: 'test wf',
  steps: [{ id: 's1', type: 'NAVIGATE', params: { url: 'https://example.com' } }],
};

async function main() {
  await db.init();

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;

  const free = await makeUser('gate_free', 'free');
  const pro = await makeUser('gate_pro', 'pro');
  const biz = await makeUser('gate_biz', 'business');

  /* ── maxWorkflows: the limit that defines the free tier ────────────────── */
  console.log('workflow limit');
  {
    let r = await api('POST', '/api/workflows', { token: free.token, body: WF_BODY });
    ok('free: first workflow allowed', r.status === 201, `got ${r.status}`);
    const firstId = r.json.workflow.id;

    r = await api('POST', '/api/workflows', { token: free.token, body: WF_BODY });
    ok('free: second workflow → 402', r.status === 402, `got ${r.status}`);
    ok('402 names the limit', r.json.code === 'limit_reached' && r.json.limit === 1);
    ok('402 names the upgrade path', r.json.requiredPlan === 'pro');

    // Every route that can bring a workflow into existence must check, not
    // just POST /. Duplicate and template-use were the two ways around it.
    r = await api('POST', `/api/workflows/${firstId}/duplicate`, { token: free.token });
    ok('free: duplicate is gated too', r.status === 402, `got ${r.status}`);

    r = await api('POST', '/api/workflows/import', {
      token: free.token,
      body: { kind: 'scrapient.workflow', version: 1, workflow: WF_BODY },
    });
    ok('free: import is gated too', r.status === 402, `got ${r.status}`);

    r = await api('POST', '/api/workflows', { token: pro.token, body: WF_BODY });
    ok('pro: workflow allowed', r.status === 201, `got ${r.status}`);
  }

  /* ── Feature flags ─────────────────────────────────────────────────────── */
  console.log('feature gates');
  {
    const freeWf = (await api('GET', '/api/workflows', { token: free.token }))
      .json.workflows[0];
    const proWf = (await api('GET', '/api/workflows', { token: pro.token }))
      .json.workflows[0];

    let r = await api('PUT', `/api/schedules/workflow/${freeWf.id}`, {
      token: free.token, body: { intervalMinutes: 60 },
    });
    ok('free: scheduling → 402', r.status === 402, `got ${r.status}`);
    ok('402 names the feature and plan',
      r.json.code === 'feature_not_in_plan' && r.json.requiredPlan === 'pro');

    r = await api('PUT', `/api/schedules/workflow/${proWf.id}`, {
      token: pro.token, body: { intervalMinutes: 60 },
    });
    ok('pro: scheduling allowed', r.status === 200, `got ${r.status}`);

    r = await api('POST', '/api/proxies', {
      token: free.token,
      body: { label: 'p', protocol: 'http', host: '1.2.3.4', port: 8080 },
    });
    ok('free: proxies → 402', r.status === 402, `got ${r.status}`);

    r = await api('POST', '/api/api-keys', { token: free.token, body: { name: 'k' } });
    ok('free: API keys → 402', r.status === 402, `got ${r.status}`);

    r = await api('POST', '/api/webhooks', {
      token: free.token, body: { url: 'https://example.com/hook' },
    });
    ok('free: webhooks → 402', r.status === 402, `got ${r.status}`);

    r = await api('PUT', '/api/notifications', {
      token: free.token, body: { email: 'a@b.com' },
    });
    ok('free: e-mail alerts → 402', r.status === 402, `got ${r.status}`);

    r = await api('PUT', `/api/workflows/${freeWf.id}/monitor`, {
      token: free.token, body: { isActive: true },
    });
    ok('free: change monitoring → 402', r.status === 402, `got ${r.status}`);

    r = await api('POST', '/api/custom-actions', {
      token: free.token,
      body: { name: 'act', description: '', inputs: [], outputs: [], code: '' },
    });
    ok('free: custom actions → 402', r.status === 402, `got ${r.status}`);

    // Business-only, so Pro must be refused as well — a gate that only ever
    // blocks free users isn't testing the ladder, just the floor.
    r = await api('POST', '/api/api-keys', { token: pro.token, body: { name: 'k' } });
    ok('pro: API keys allowed', r.status === 201, `got ${r.status}`);
    r = await api('POST', '/api/api-keys', { token: biz.token, body: { name: 'k' } });
    ok('business: API keys allowed', r.status === 201, `got ${r.status}`);
  }

  /* ── Run quota, on the DASHBOARD path ──────────────────────────────────── */
  console.log('run quota (dashboard path — the hole that existed before plans)');
  {
    const quotaUser = await makeUser('gate_quota', 'free');
    const limit = getPlan('free').limits.monthlyRuns;

    // Burn the month's allowance without actually launching Chrome: the gate
    // reads the usage counter, so writing it directly is equivalent and
    // doesn't make the test depend on a browser.
    await usageRepo.incrementRuns(quotaUser.id, limit);
    entitlements.invalidate(quotaUser.id);

    let threw = null;
    try {
      await entitlements.assertCanRun(quotaUser.id);
    } catch (e) { threw = e; }
    ok('at quota → assertCanRun throws', !!threw);
    ok('error is a quota refusal', threw && threw.code === 'quota_exceeded');
    ok('402, not 403', threw && threw.status === 402);
    ok('names the metric and the numbers',
      threw && threw.meta.metric === 'runs' && threw.meta.limit === limit);
    ok('points at the upgrade', threw && threw.meta.requiredPlan === 'pro');

    // One under the limit must still pass — an off-by-one here bills people
    // for a run they never got.
    const underUser = await makeUser('gate_under', 'free');
    await usageRepo.incrementRuns(underUser.id, limit - 1);
    entitlements.invalidate(underUser.id);
    let ok2 = true;
    try { await entitlements.assertCanRun(underUser.id); } catch (_) { ok2 = false; }
    ok('one under the limit is allowed', ok2);
  }

  /* ── Page cap ──────────────────────────────────────────────────────────── */
  console.log('page cap');
  {
    const pageUser = await makeUser('gate_pages', 'free');
    await usageRepo.incrementPages(pageUser.id, getPlan('free').limits.monthlyPages);
    entitlements.invalidate(pageUser.id);

    let threw = null;
    try { await entitlements.assertCanRun(pageUser.id); } catch (e) { threw = e; }
    ok('over page cap blocks new runs', threw && threw.code === 'quota_exceeded');
    ok('names pages, not runs', threw && threw.meta.metric === 'pages');
  }

  /* ── Suspension outranks plan ──────────────────────────────────────────── */
  console.log('suspension');
  {
    const susp = await makeUser('gate_susp', 'business');
    await db.run(`UPDATE users SET status = 'suspended' WHERE id = ?`, [susp.id]);
    entitlements.invalidate(susp.id);

    let threw = null;
    try { await entitlements.assertCanRun(susp.id); } catch (e) { threw = e; }
    ok('suspended business account cannot run', threw && threw.code === 'account_suspended');
    // 403, not 402: paying more does not un-suspend an account, so the
    // frontend must not open the upgrade dialog for it.
    ok('403, not 402', threw && threw.status === 403);

    const r = await api('POST', '/api/workflows', { token: susp.token, body: WF_BODY });
    ok('suspended account is refused at the route too', r.status === 403, `got ${r.status}`);
  }

  /* ── Lapsed subscription ───────────────────────────────────────────────── */
  console.log('lapsed subscription');
  {
    const lapsed = await makeUser('gate_lapsed', 'pro');
    // Two workflows created while paying, then the payment fails.
    await workflowsRepo.create({ userId: lapsed.id, name: 'a', stepsJson: '[]', metaJson: null });
    await workflowsRepo.create({ userId: lapsed.id, name: 'b', stepsJson: '[]', metaJson: null });
    await db.run(`UPDATE users SET plan_status = 'past_due' WHERE id = ?`, [lapsed.id]);
    entitlements.invalidate(lapsed.id);

    // Existing data is NOT deleted — they keep both workflows and can still
    // read them. What stops is creating more and using paid features.
    let r = await api('GET', '/api/workflows', { token: lapsed.token });
    ok('past_due keeps access to existing workflows',
      r.status === 200 && r.json.workflows.length === 2);

    r = await api('POST', '/api/workflows', { token: lapsed.token, body: WF_BODY });
    ok('past_due cannot create beyond the free limit', r.status === 402, `got ${r.status}`);

    r = await api('POST', '/api/api-keys', { token: lapsed.token, body: { name: 'k' } });
    ok('past_due loses paid features', r.status === 402, `got ${r.status}`);
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
