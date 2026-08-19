'use strict';

/* ===========================================================================
   Public API (/v1) smoke test — boots the real Express app against a
   throwaway SQLite database and exercises the full surface over HTTP:
   auth, workflows, run trigger (inputs / quota / idempotency), run
   status/data/logs/cancel, pagination, webhooks (including signed delivery),
   usage, rate limiting, and error shapes.

   Run with:  node test/api-v1.test.js
   No browser is needed: triggering only ENQUEUES a run. The worker is not
   started here; queue mechanics are exercised through runStore directly.
   ========================================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the data layer at a throwaway DB BEFORE anything requires db/client.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'api-v1-test-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.sqlite');
delete process.env.DB_CLIENT; // force sqlite regardless of shell env
process.env.API_RATE_LIMIT_PER_MIN = '0'; // off by default; enabled per-test

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

const db = require('../db/client');
const app = require('../app');
const runStore = require('../services/runStore.service');
const apiWorker = require('../services/apiWorker.service');
const webhookDispatcher = require('../services/webhookDispatcher.service');
const apiKeysRepo = require('../db/repositories/apiKeys.repo');
const workflowsRepo = require('../db/repositories/workflows.repo');
const { generateKey } = require('../services/apiKeys.service');
const { signToken } = require('../middleware/auth');
const entitlements = require('../services/entitlements.service');
const { getPlan } = require('../config/plans');

let BASE; // http://127.0.0.1:<port>
let passed = 0;

function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
    throw new Error(`FAILED: ${name}`);
  }
}

async function api(method, pathname, { key, body, headers = {} } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text, headers: res.headers };
}

async function main() {
  await db.init();

  // ── fixtures: user, API key, workflow with a declared variable ──────────
  // On the 'pro' plan because the public API is a paid feature (config/plans.js).
  // A free-plan user gets 402 plan_required on every trigger, which is correct
  // behaviour but not what these tests are exercising — the free-plan refusal
  // has its own case in the quota section below.
  const user = await db.get(
    `INSERT INTO users (username, password_hash, plan) VALUES ('apitester', 'x', 'pro') RETURNING id`);
  const { key, keyHash, prefix } = generateKey();
  await apiKeysRepo.create({ userId: user.id, name: 'test key', keyHash, prefix });

  const otherUser = await db.get(
    `INSERT INTO users (username, password_hash) VALUES ('someoneelse', 'x') RETURNING id`);
  const foreignWf = await workflowsRepo.create({
    userId: otherUser.id, name: 'not yours', stepsJson: '[]', metaJson: null,
  });

  const wf = await workflowsRepo.create({
    userId: user.id,
    name: 'Search products',
    stepsJson: JSON.stringify([{ id: 's1', type: 'NAVIGATE', params: { url: 'https://example.com' } }]),
    metaJson: JSON.stringify({
      startUrl: 'https://example.com',
      variables: [{ name: 'query', type: 'string', value: 'default', description: 'search term' }],
    }),
  });
  const wf2 = await workflowsRepo.create({
    userId: user.id, name: 'Second workflow', stepsJson: '[]', metaJson: null,
  });

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;

  // ── auth ─────────────────────────────────────────────────────────────────
  console.log('auth');
  {
    let r = await api('GET', '/v1/workflows');
    ok('missing key → 401 invalid_api_key', r.status === 401 && r.json.error.code === 'invalid_api_key');
    ok('error carries request_id', typeof r.json.error.request_id === 'string' && r.json.error.request_id.startsWith('req_'));

    r = await api('GET', '/v1/workflows', { key: 'not-a-key' });
    ok('malformed key → 401', r.status === 401 && r.json.error.code === 'invalid_api_key');

    const jwt = signToken({ sub: user.id, username: 'apitester' });
    r = await api('GET', '/v1/workflows', { key: jwt });
    ok('JWT rejected on /v1 → 401', r.status === 401);

    r = await api('GET', '/v1/workflows', { key: 'sk_live_' + 'a'.repeat(32) });
    ok('unknown key → 401', r.status === 401);
  }

  // ── workflows (read-only) ────────────────────────────────────────────────
  console.log('workflows');
  {
    let r = await api('GET', '/v1/workflows', { key });
    ok('list → 200 list envelope', r.status === 200 && r.json.object === 'list' && Array.isArray(r.json.data));
    ok('list scoped to owner', r.json.data.every(w => w.id !== foreignWf.id) && r.json.data.length === 2);

    r = await api('GET', '/v1/workflows?limit=1', { key });
    ok('pagination: limit=1 has_more + cursor', r.json.data.length === 1 && r.json.has_more === true && r.json.next_cursor);
    const r2 = await api('GET', `/v1/workflows?limit=10&cursor=${r.json.next_cursor}`, { key });
    ok('pagination: second page has the rest', r2.json.data.length === 1 && r2.json.has_more === false);

    r = await api('GET', `/v1/workflows/${wf.id}`, { key });
    ok('get one → variables exposed', r.status === 200 && r.json.variables[0].name === 'query');
    ok('steps NOT exposed', !('steps' in r.json));

    r = await api('GET', `/v1/workflows/${foreignWf.id}`, { key });
    ok('foreign workflow → 404', r.status === 404);

    r = await api('GET', '/v1/workflows/abc', { key });
    ok('malformed id → 404', r.status === 404);
  }

  // ── trigger runs ─────────────────────────────────────────────────────────
  console.log('trigger');
  let firstRunId;
  {
    let r = await api('POST', `/v1/workflows/${wf.id}/runs`, { key });
    ok('trigger → 202 queued', r.status === 202 && r.json.status === 'queued' && r.json.object === 'run');
    firstRunId = r.json.id;

    r = await api('POST', `/v1/workflows/${wf.id}/runs`, { key, body: { inputs: { query: 'headphones' } } });
    ok('trigger with inputs → 202', r.status === 202);
    const stored = await runStore.getRun(r.json.id);
    ok('inputs persisted on run row', JSON.parse(stored.inputs_json).query === 'headphones');

    r = await api('POST', `/v1/workflows/${wf.id}/runs`, { key, body: { inputs: { nope: 1 } } });
    ok('unknown input → 400 invalid_inputs', r.status === 400 && r.json.error.code === 'invalid_inputs');

    r = await api('POST', `/v1/workflows/${wf.id}/runs`, { key, body: { inputs: { query: null } } });
    ok('null input value → 400 invalid_inputs', r.status === 400 && r.json.error.code === 'invalid_inputs');

    r = await api('POST', `/v1/workflows/${foreignWf.id}/runs`, { key });
    ok('trigger foreign workflow → 404', r.status === 404);

    // idempotency
    const idem = 'test-key-123';
    const a = await api('POST', `/v1/workflows/${wf.id}/runs`, { key, headers: { 'Idempotency-Key': idem } });
    const b = await api('POST', `/v1/workflows/${wf.id}/runs`, { key, headers: { 'Idempotency-Key': idem } });
    ok('idempotent replay returns same run', a.status === 202 && b.status === 202 && a.json.id === b.json.id);
    const c = await api('POST', `/v1/workflows/${wf2.id}/runs`, { key, headers: { 'Idempotency-Key': idem } });
    ok('same key on other workflow → 409 idempotency_conflict', c.status === 409 && c.json.error.code === 'idempotency_conflict');

    r = await api('POST', `/v1/workflows/${wf.id}/runs`, { key, headers: { 'Idempotency-Key': 'x'.repeat(300) } });
    ok('oversized Idempotency-Key → 400', r.status === 400);

    // malformed JSON body goes through the app-level /v1 error handler
    const raw = await fetch(`${BASE}/v1/workflows/${wf.id}/runs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: '{ not json',
    });
    const rawJson = await raw.json();
    ok('malformed JSON → 400 invalid_request', raw.status === 400 && rawJson.error.code === 'invalid_request');
  }

  // ── usage + quota ────────────────────────────────────────────────────────
  console.log('usage');
  {
    // 3 enqueued runs so far — the idempotent replay deliberately does NOT
    // increment usage (the caller retried, we didn't run anything twice).
    let r = await api('GET', '/v1/usage', { key });
    ok('usage counts triggered runs', r.status === 200 && r.json.runs_used === 3);
    // Quota now comes from the caller's plan (config/plans.js) rather than the
    // instance-wide API_MONTHLY_RUN_QUOTA env var, which reported the same
    // number to every user regardless of what they paid.
    ok('quota reflects the plan', r.json.plan === 'pro'
      && r.json.runs_quota === getPlan('pro').limits.monthlyRuns);

    // Drive the account over quota via a per-user override rather than by
    // enqueuing 3,000 runs. This exercises plan_overrides_json — the mechanism
    // the admin panel uses to comp or cap an individual account.
    await db.run(
      `UPDATE users SET plan_overrides_json = ? WHERE id = ?`,
      [JSON.stringify({ limits: { monthlyRuns: 3 } }), user.id]);
    entitlements.invalidate(user.id);

    r = await api('POST', `/v1/workflows/${wf.id}/runs`, { key });
    ok('over quota → 402 over_quota', r.status === 402 && r.json.error.code === 'over_quota');

    await db.run(`UPDATE users SET plan_overrides_json = NULL WHERE id = ?`, [user.id]);
    entitlements.invalidate(user.id);
  }

  // ── the API itself is a paid feature ────────────────────────────────────
  console.log('plan gating');
  {
    // A free-plan account holding a valid API key must still be refused: the
    // key authenticates, the plan is what authorises. This is the hole that
    // previously let any account use the API for free.
    const freeUser = await db.get(
      `INSERT INTO users (username, password_hash) VALUES ('freeloader', 'x') RETURNING id`);
    const freeKey = generateKey();
    await apiKeysRepo.create({
      userId: freeUser.id, name: 'free key',
      keyHash: freeKey.keyHash, prefix: freeKey.prefix,
    });
    const freeWf = await workflowsRepo.create({
      userId: freeUser.id, name: 'free wf', stepsJson: '[]', metaJson: null,
    });

    let r = await api('POST', `/v1/workflows/${freeWf.id}/runs`, { key: freeKey.key });
    ok('free plan → 402 plan_required', r.status === 402 && r.json.error.code === 'plan_required');

    // …but reading usage still works, so the account can see why it was
    // refused and what it would need to upgrade to.
    r = await api('GET', '/v1/usage', { key: freeKey.key });
    ok('free plan can still read usage', r.status === 200 && r.json.plan === 'free');
    ok('free quota is the free plan\'s', r.json.runs_quota === getPlan('free').limits.monthlyRuns);
  }

  // ── runs: list / get / logs / data / cancel ─────────────────────────────
  console.log('runs');
  {
    let r = await api('GET', '/v1/runs', { key });
    ok('list runs → newest first', r.status === 200 && r.json.data.length === 3 && r.json.data[0].id > r.json.data[2].id);

    r = await api('GET', `/v1/runs?status=queued&workflow_id=${wf.id}&limit=2`, { key });
    ok('filters + limit apply', r.status === 200 && r.json.data.length === 2 && r.json.has_more === true);
    const page2 = await api('GET', `/v1/runs?status=queued&workflow_id=${wf.id}&limit=2&cursor=${r.json.next_cursor}`, { key });
    ok('cursor page 2', page2.json.data.length >= 1 && page2.json.data.every(x => x.id < Number(r.json.next_cursor)));

    r = await api('GET', '/v1/runs?status=bogus', { key });
    ok('bad status filter → 400', r.status === 400);

    r = await api('GET', `/v1/runs/${firstRunId}`, { key });
    ok('get run → queued, no started_at', r.status === 200 && r.json.status === 'queued' && r.json.started_at === null && r.json.queued_at);

    // no data yet
    r = await api('GET', `/v1/runs/${firstRunId}/data`, { key });
    ok('data before finish → 404 no_data', r.status === 404 && r.json.error.code === 'no_data');

    // simulate the worker finishing the run with results + logs
    await runStore.appendLog(firstRunId, 'info', 'hello from test');
    await runStore.flushLogs(firstRunId);
    await runStore.finishRun(firstRunId, {
      status: 'success',
      finished_at: new Date().toISOString(),
      duration_ms: 1234,
      results_json: JSON.stringify({ products: [{ title: 'A "quoted" name', price: '9,99' }, { title: 'B', price: '5' }] }),
    });

    r = await api('GET', `/v1/runs/${firstRunId}`, { key });
    ok('finished run → success + has_data', r.json.status === 'success' && r.json.has_data === true);

    r = await api('GET', `/v1/runs/${firstRunId}/data`, { key });
    ok('data json → wrapped results', r.status === 200 && r.json.object === 'run.data' && r.json.data.products.length === 2);

    const csv = await api('GET', `/v1/runs/${firstRunId}/data?format=csv`, { key });
    ok('data csv → section + escaping', csv.status === 200 && csv.text.startsWith('# products')
      && csv.text.includes('"A ""quoted"" name"') && csv.text.includes('"9,99"'));

    const xlsx = await api('GET', `/v1/runs/${firstRunId}/data?format=xlsx`, { key });
    // .xlsx is a zip — bytes 0x50 0x4B ("PK") survive res.text() decoding.
    ok('data xlsx → workbook mime + PK zip signature', xlsx.status === 200
      && (xlsx.headers.get('content-type') || '').includes('spreadsheetml')
      && xlsx.text.startsWith('PK'));

    const badFmt = await api('GET', `/v1/runs/${firstRunId}/data?format=pdf`, { key });
    ok('data invalid format → 400', badFmt.status === 400 && badFmt.json.error.code === 'invalid_request');

    r = await api('GET', `/v1/runs/${firstRunId}/logs`, { key });
    ok('logs returned', r.status === 200 && r.json.data.some(l => l.line === 'hello from test'));

    // cancel: queued run dies before starting
    const cancellable = await api('POST', `/v1/workflows/${wf.id}/runs`, { key });
    r = await api('POST', `/v1/runs/${cancellable.json.id}/cancel`, { key });
    ok('cancel queued → cancelled', r.status === 200 && r.json.status === 'cancelled');
    const claimed = await runStore.claimQueuedRun(cancellable.json.id);
    ok('cancelled run cannot be claimed by worker', claimed === false);

    r = await api('POST', `/v1/runs/${firstRunId}/cancel`, { key });
    ok('cancel finished run → 409 not_cancellable', r.status === 409 && r.json.error.code === 'not_cancellable');

    // claim semantics: a queued run is claimed exactly once
    const q = await api('POST', `/v1/workflows/${wf.id}/runs`, { key });
    ok('claim wins once', (await runStore.claimQueuedRun(q.json.id)) === true);
    ok('second claim loses', (await runStore.claimQueuedRun(q.json.id)) === false);
    ok('cancel after claim loses', (await runStore.cancelQueuedRun(q.json.id, user.id)) === false);
  }

  // ── worker input overlay ─────────────────────────────────────────────────
  console.log('worker');
  {
    const meta = { startUrl: 'x', variables: [
      { name: 'query', type: 'string', value: 'default' },
      { name: 'limit', type: 'number', value: '10' },
    ] };
    const merged = apiWorker.applyInputs(meta, { query: 'shoes', limit: 25 });
    ok('inputs overlay declared variables', merged.variables[0].value === 'shoes' && merged.variables[1].value === '25');
    ok('original meta untouched', meta.variables[0].value === 'default');
  }

  // ── webhooks ─────────────────────────────────────────────────────────────
  console.log('webhooks');
  {
    let r = await api('POST', '/v1/webhooks', { key, body: { url: 'not a url' } });
    ok('invalid url → 400', r.status === 400);

    r = await api('POST', '/v1/webhooks', { key, body: { url: 'https://example.com/hook', events: ['run.finished'] } });
    ok('unknown event → 400', r.status === 400);

    // a real local receiver to capture + verify a signed delivery
    let received = null;
    const receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        received = { headers: req.headers, body };
        res.writeHead(200); res.end();
      });
    });
    await new Promise(rs => receiver.listen(0, '127.0.0.1', rs));
    const hookUrl = `http://127.0.0.1:${receiver.address().port}/hook`;

    r = await api('POST', '/v1/webhooks', { key, body: { url: hookUrl, events: ['run.completed'] } });
    ok('create webhook → 201 + secret shown once', r.status === 201 && r.json.secret.startsWith('whsec_'));
    const secret = r.json.secret;
    const webhookId = r.json.id;

    const list = await api('GET', '/v1/webhooks', { key });
    ok('list webhooks hides secret', list.json.data.length === 1 && !('secret' in list.json.data[0]));

    // dispatch for a finished run and verify the HMAC end-to-end
    const runRow = await runStore.getRun(firstRunId);
    await webhookDispatcher.dispatchRunEvent(runRow);
    ok('delivery received', received !== null && received.headers['x-scraper-event'] === 'run.completed');
    const sig = received.headers['x-scraper-signature'];
    const [, t, v1] = sig.match(/^t=(\d+),v1=([0-9a-f]+)$/);
    const expected = crypto.createHmac('sha256', secret).update(`${t}.${received.body}`).digest('hex');
    ok('signature verifies', v1 === expected);
    const evt = JSON.parse(received.body);
    ok('event payload carries the run', evt.type === 'run.completed' && evt.data.run.id === firstRunId);

    // failed runs don't hit a completed-only endpoint
    received = null;
    await webhookDispatcher.dispatchRunEvent({ ...runRow, status: 'error' });
    await new Promise(rs => setTimeout(rs, 200));
    ok('unsubscribed event not delivered', received === null);

    r = await api('DELETE', `/v1/webhooks/${webhookId}`, { key });
    ok('delete webhook', r.status === 200 && r.json.deleted === true);
    receiver.close();
  }

  // ── rate limiting ────────────────────────────────────────────────────────
  console.log('rate limit');
  {
    const fresh = generateKey();
    await apiKeysRepo.create({ userId: user.id, name: 'rl key', keyHash: fresh.keyHash, prefix: fresh.prefix });
    process.env.API_RATE_LIMIT_PER_MIN = '3';
    let last;
    for (let i = 0; i < 4; i++) last = await api('GET', '/v1/usage', { key: fresh.key });
    ok('4th request over limit=3 → 429', last.status === 429 && last.json.error.code === 'rate_limited');
    ok('Retry-After + X-RateLimit-* headers', last.headers.get('retry-after') !== null
      && last.headers.get('x-ratelimit-limit') === '3' && last.headers.get('x-ratelimit-remaining') === '0');
    process.env.API_RATE_LIMIT_PER_MIN = '0';
  }

  // ── dashboard key management (/api/api-keys, JWT) ────────────────────────
  console.log('key management');
  {
    const jwt = signToken({ sub: user.id, username: 'apitester' });
    const auth = { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' };

    let res = await fetch(`${BASE}/api/api-keys`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'ci key' }) });
    let json = await res.json();
    ok('create key via dashboard → 201 + plaintext once', res.status === 201 && json.key.startsWith('sk_live_'));
    const newKey = json.key, newKeyId = json.apiKey.id;

    let v1 = await api('GET', '/v1/usage', { key: newKey });
    ok('new key works on /v1', v1.status === 200);

    res = await fetch(`${BASE}/api/api-keys`, { headers: auth });
    json = await res.json();
    ok('list keys shows prefix, never plaintext', json.apiKeys.length === 3
      && json.apiKeys.every(k => k.prefix.length === 12 && !('key' in k)));

    res = await fetch(`${BASE}/api/api-keys/${newKeyId}`, { method: 'DELETE', headers: auth });
    ok('revoke key', res.status === 200);
    v1 = await api('GET', '/v1/usage', { key: newKey });
    ok('revoked key → 401', v1.status === 401);
  }

  // ── misc error shape ─────────────────────────────────────────────────────
  console.log('errors');
  {
    const r = await api('GET', '/v1/nope', { key });
    ok('unknown endpoint → 404 JSON shape', r.status === 404 && r.json.error.code === 'not_found');
  }

  server.close();
  await db.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`\nAll ${passed} checks passed ✅`);
}

main().catch(err => {
  console.error('\nTest run failed:', err.message);
  process.exit(1);
});
