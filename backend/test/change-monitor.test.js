'use strict';

/* ===========================================================================
   Change monitoring test — boots the real Express app against a throwaway
   SQLite DB and exercises the whole feature end to end:
     • monitor CRUD over HTTP (PUT/GET/DELETE /api/workflows/:id/monitor)
     • changeMonitor.evaluateRun: baseline first run, then a real diff stored
       on the run row (change_summary_json)
     • the change feed returned by GET .../monitor
     • run.changed webhook delivery with a verified HMAC signature
     • ownership scoping
   The pipeline itself needs a browser, so evaluateRun is driven directly
   against seeded runs — the same call the pipeline makes fire-and-forget.

   Run with:  node test/change-monitor.test.js
   ========================================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'change-monitor-test-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.sqlite');
delete process.env.DB_CLIENT;

const http = require('http');
const crypto = require('crypto');

const db = require('../db/client');
const app = require('../app');
const workflowsRepo = require('../db/repositories/workflows.repo');
const webhooksRepo = require('../db/repositories/webhooks.repo');
const runStore = require('../services/runStore.service');
const changeMonitor = require('../services/changeMonitor.service');
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

async function seedRun(userId, workflowId, results) {
  const row = await db.get(
    `INSERT INTO runs (user_id, workflow_id, status, started_at, finished_at, results_json)
     VALUES (?, ?, 'success', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?) RETURNING id`,
    [userId, workflowId, JSON.stringify(results)]
  );
  return runStore.getRun(row.id);
}

async function main() {
  await db.init();
  await require('../db/migrate').run(db);

  const user = await db.get(`INSERT INTO users (username, password_hash) VALUES ('mon', 'x') RETURNING id`);
  const other = await db.get(`INSERT INTO users (username, password_hash) VALUES ('monother', 'x') RETURNING id`);
  const token = signToken({ sub: user.id, username: 'mon' });
  const otherToken = signToken({ sub: other.id, username: 'monother' });
  const wf = await workflowsRepo.create({ userId: user.id, name: 'Prices', stepsJson: '[]', metaJson: null });

  console.log('monitor CRUD');
  {
    const before = await req('GET', `/api/workflows/${wf.id}/monitor`, { token });
    ok('no monitor yet → null', before.status === 200 && before.json.monitor === null);

    const put = await req('PUT', `/api/workflows/${wf.id}/monitor`, { token, body: { isActive: true, keyField: 'id' } });
    ok('PUT creates an active monitor', put.status === 200 && put.json.monitor.isActive === true && put.json.monitor.keyField === 'id');

    const foreign = await req('PUT', `/api/workflows/${wf.id}/monitor`, { token: otherToken, body: { isActive: true } });
    ok('another user cannot configure it → 404', foreign.status === 404);
  }

  console.log('evaluateRun — baseline then diff');
  {
    // First run: baseline, no prior to compare, no alert.
    const run1 = await seedRun(user.id, wf.id, { products: [{ id: 'a', price: '10' }, { id: 'b', price: '20' }] });
    const s1 = await changeMonitor.evaluateRun(run1, { products: [{ id: 'a', price: '10' }, { id: 'b', price: '20' }] });
    ok('first run is a baseline', s1 && s1.baseline === true && s1.comparedToRunId === null);
    const r1 = await runStore.getRun(run1.id);
    ok('baseline summary stored on run', !!r1.change_summary_json);

    // Second run: b's price changed, c added, (nothing removed).
    const currB = { products: [{ id: 'a', price: '10' }, { id: 'b', price: '25' }, { id: 'c', price: '30' }] };
    const run2 = await seedRun(user.id, wf.id, currB);
    const s2 = await changeMonitor.evaluateRun(run2, currB);
    ok('diff: 1 changed, 1 added', s2 && !s2.baseline && s2.counts.changed === 1 && s2.counts.added === 1 && s2.counts.removed === 0, JSON.stringify(s2 && s2.counts));
    ok('diff compares to the previous run', s2.comparedToRunId === run1.id);
    ok('changed sample names the field', s2.sample.changed[0].key === 'b' && s2.sample.changed[0].fields.includes('price'));
  }

  console.log('change feed');
  {
    const feed = await req('GET', `/api/workflows/${wf.id}/monitor`, { token });
    ok('feed lists runs with summaries, newest first', feed.status === 200 && feed.json.changes.length === 2);
    ok('newest feed item has the diff counts', feed.json.changes[0].summary.counts.added === 1);
  }

  console.log('run.changed webhook');
  {
    // Register a run.changed webhook pointing at a local receiver.
    const secret = 'whsec_' + crypto.randomBytes(12).toString('base64url');
    let received = null;
    const receiver = http.createServer((rq, rs) => {
      let b = ''; rq.on('data', c => b += c); rq.on('end', () => { received = { headers: rq.headers, body: b }; rs.writeHead(200); rs.end(); });
    });
    await new Promise(rs => receiver.listen(0, '127.0.0.1', rs));
    const hookUrl = `http://127.0.0.1:${receiver.address().port}/hook`;
    const wh = await webhooksRepo.create({ userId: user.id, url: hookUrl, secret, events: ['run.changed'] });

    // A change should deliver run.changed to the receiver.
    const prev = { products: [{ id: 'a', price: '1' }] };
    const curr = { products: [{ id: 'a', price: '2' }] };
    await seedRun(user.id, wf.id, prev);
    const run = await seedRun(user.id, wf.id, curr);
    await changeMonitor.evaluateRun(run, curr);
    await new Promise(rs => setTimeout(rs, 150));

    ok('run.changed delivered', received !== null && received.headers['x-scraper-event'] === 'run.changed');
    const sig = received.headers['x-scraper-signature'];
    const m = sig.match(/^t=(\d+),v1=([0-9a-f]+)$/);
    const expected = crypto.createHmac('sha256', secret).update(`${m[1]}.${received.body}`).digest('hex');
    ok('signature verifies', m[2] === expected);
    const evt = JSON.parse(received.body);
    ok('payload carries run + change summary', evt.type === 'run.changed' && evt.data.run.id === run.id
      && evt.data.changes.counts.changed === 1);

    // An unchanged run must NOT deliver anything.
    received = null;
    const same = { products: [{ id: 'a', price: '2' }] };
    const runSame = await seedRun(user.id, wf.id, same);
    await changeMonitor.evaluateRun(runSame, same);
    await new Promise(rs => setTimeout(rs, 150));
    ok('no webhook when nothing changed', received === null);

    await webhooksRepo.remove(wh.id, user.id);
    receiver.close();
  }

  console.log('disable + delete');
  {
    // Disabling stops evaluation (no summary written).
    await req('PUT', `/api/workflows/${wf.id}/monitor`, { token, body: { isActive: false } });
    const run = await seedRun(user.id, wf.id, { products: [{ id: 'z', price: '9' }] });
    const s = await changeMonitor.evaluateRun(run, { products: [{ id: 'z', price: '9' }] });
    ok('inactive monitor → not evaluated', s === null);
    const r = await runStore.getRun(run.id);
    ok('no summary written while inactive', r.change_summary_json == null);

    const del = await req('DELETE', `/api/workflows/${wf.id}/monitor`, { token });
    ok('DELETE removes the monitor', del.status === 200 && del.json.ok === true);
    const gone = await req('DELETE', `/api/workflows/${wf.id}/monitor`, { token });
    ok('DELETE again → 404', gone.status === 404);
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
