'use strict';

/* Export / import / duplicate route tests — boots the real app against a
   throwaway SQLite DB. Covers the export envelope, a cross-account import that
   remaps custom-action ids, duplicate-within-account, validation, and scoping.
   Run: node test/workflow-portability.test.js  (from backend/) */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-portability-test-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.sqlite');
delete process.env.DB_CLIENT;

const http = require('http');
const db = require('../db/client');
const app = require('../app');
const workflowsRepo = require('../db/repositories/workflows.repo');
const customActionsRepo = require('../db/repositories/customActions.repo');
const { signToken } = require('../middleware/auth');

let BASE;
let passed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); process.exitCode = 1; throw new Error(`FAILED: ${name}`); }
}

async function req(method, pathname, { token, body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}

async function main() {
  await db.init();
  await require('../db/migrate').run(db);

  const alice = await db.get(`INSERT INTO users (username, password_hash, plan) VALUES ('alice', 'x', 'business') RETURNING id`);
  const bob   = await db.get(`INSERT INTO users (username, password_hash, plan) VALUES ('bob', 'x', 'business') RETURNING id`);
  const aliceTok = signToken({ sub: alice.id, username: 'alice' });
  const bobTok   = signToken({ sub: bob.id, username: 'bob' });

  // Alice has a custom action (id A) and a workflow that uses it (nested in an IF).
  const action = await customActionsRepo.create({
    userId: alice.id, name: 'clean-price', description: 'strip currency',
    inputsJson: '[{"name":"raw"}]', outputsJson: '[]', code: 'return raw.replace(/[^0-9.]/g,"");',
  });
  const steps = [
    { id: 's1', kind: 'action', type: 'CUSTOM_ACTION', params: { actionId: action.id } },
    { id: 's2', kind: 'control', type: 'IF', then: [
      { id: 's3', kind: 'action', type: 'CUSTOM_ACTION', params: { actionId: action.id } },
    ], else: [] },
  ];
  const meta = { startUrl: 'https://x.com', variables: [{ name: 'q', value: 'shoe' }], proxyId: 99 };
  const wf = await workflowsRepo.create({
    userId: alice.id, name: 'Prices', stepsJson: JSON.stringify(steps), metaJson: JSON.stringify(meta),
  });

  let envelope;
  console.log('export');
  {
    const r = await req('GET', `/api/workflows/${wf.id}/export`, { token: aliceTok });
    ok('export → 200 JSON envelope', r.status === 200 && r.json.format === 'scraper-workflow' && r.json.version === 1);
    ok('bundles the referenced custom action', r.json.customActions.length === 1 && r.json.customActions[0].name === 'clean-price');
    ok('strips the per-user proxy binding', r.json.meta.proxyId === undefined && r.json.meta.proxy === undefined);
    ok('keeps variables + start url', r.json.meta.startUrl === 'https://x.com' && r.json.meta.variables[0].name === 'q');
    const foreign = await req('GET', `/api/workflows/${wf.id}/export`, { token: bobTok });
    ok('another user cannot export it → 404', foreign.status === 404);
    envelope = r.json;
  }

  console.log('import into another account (remap)');
  {
    const r = await req('POST', `/api/workflows/import`, { token: bobTok, body: envelope });
    ok('import → 201 new workflow', r.status === 201 && r.json.workflow.id && /imported/i.test(r.json.workflow.name));
    ok('recreated the bundled custom action once', r.json.createdCustomActions.length === 1);

    // Bob now owns a 'clean-price' action, and his imported steps point at HIS id.
    const bobActions = await customActionsRepo.listForUser(bob.id);
    ok('bob owns the recreated action', bobActions.length === 1 && bobActions[0].name === 'clean-price');
    const bobActionId = bobActions[0].id;

    const bobWf = await workflowsRepo.getForUser(r.json.workflow.id, bob.id);
    const bobSteps = JSON.parse(bobWf.steps_json);
    ok('top-level actionId remapped to bob\'s id', bobSteps[0].params.actionId === bobActionId);
    ok('NESTED actionId remapped too', bobSteps[1].then[0].params.actionId === bobActionId);
    ok('proxy not carried into the import', !JSON.parse(bobWf.meta_json).proxyId);

    // Importing again reuses the existing 'clean-price' (no duplicate created).
    const again = await req('POST', `/api/workflows/import`, { token: bobTok, body: envelope });
    ok('second import reuses the action (none created)', again.json.createdCustomActions.length === 0);
    ok('still only one action for bob', (await customActionsRepo.listForUser(bob.id)).length === 1);
  }

  console.log('import validation');
  {
    ok('bad format → 400', (await req('POST', `/api/workflows/import`, { token: bobTok, body: { format: 'x', version: 1, steps: [] } })).status === 400);
    ok('missing steps → 400', (await req('POST', `/api/workflows/import`, { token: bobTok, body: { format: 'scraper-workflow', version: 1 } })).status === 400);
    ok('future version → 400', (await req('POST', `/api/workflows/import`, { token: bobTok, body: { format: 'scraper-workflow', version: 99, steps: [] } })).status === 400);
    ok('not an envelope → 400', (await req('POST', `/api/workflows/import`, { token: bobTok, body: [1, 2] })).status === 400);
  }

  console.log('duplicate (same account)');
  {
    const r = await req('POST', `/api/workflows/${wf.id}/duplicate`, { token: aliceTok });
    ok('duplicate → 201 named "(copy)"', r.status === 201 && /\(copy\)$/.test(r.json.workflow.name));
    const dup = await workflowsRepo.getForUser(r.json.workflow.id, alice.id);
    const dupSteps = JSON.parse(dup.steps_json);
    ok('same-account copy keeps the original actionId (still valid)', dupSteps[0].params.actionId === action.id);
    ok('same-account copy keeps meta incl. proxy', JSON.parse(dup.meta_json).proxyId === 99);
    const foreign = await req('POST', `/api/workflows/${wf.id}/duplicate`, { token: bobTok });
    ok('another user cannot duplicate it → 404', foreign.status === 404);
  }

  console.log(`\n${passed} checks passed ✅`);
}

const server = http.createServer(app);
server.listen(0, '127.0.0.1', async () => {
  BASE = `http://127.0.0.1:${server.address().port}`;
  try { await main(); }
  catch (e) { console.error(e); process.exitCode = 1; }
  finally { server.close(); try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {} }
});
