'use strict';

/* /api/workflows/:id/bulk-run route tests — boots the real app against a
   throwaway SQLite DB. Verifies queued runs are created per input row, inputs
   validation, the row cap, ownership scoping, and that the created runs carry
   their inputs (the pipeline reads them via inputs_json).
   The API worker is NOT started here, so the queued runs are never executed —
   we assert the queue rows directly.
   Run: node test/bulk-run-api.test.js  (from backend/) */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-run-test-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.sqlite');
delete process.env.DB_CLIENT;

const http = require('http');
const db = require('../db/client');
const app = require('../app');
const workflowsRepo = require('../db/repositories/workflows.repo');
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
  return { status: res.status, json };
}

async function main() {
  await db.init();
  await require('../db/migrate').run(db);
  const user  = await db.get(`INSERT INTO users (username, password_hash, plan) VALUES ('bk', 'x', 'business') RETURNING id`);
  const other = await db.get(`INSERT INTO users (username, password_hash, plan) VALUES ('bkother', 'x', 'business') RETURNING id`);
  const token = signToken({ sub: user.id, username: 'bk' });
  const otherToken = signToken({ sub: other.id, username: 'bkother' });

  const meta = { variables: [{ name: 'query' }, { name: 'limit' }] };
  const wf = await workflowsRepo.create({ userId: user.id, name: 'Search', stepsJson: '[]', metaJson: JSON.stringify(meta) });

  console.log('validation');
  {
    const empty = await req('POST', `/api/workflows/${wf.id}/bulk-run`, { token, body: { rows: [] } });
    ok('empty rows → 400', empty.status === 400);
    const notArr = await req('POST', `/api/workflows/${wf.id}/bulk-run`, { token, body: { rows: 'nope' } });
    ok('non-array rows → 400', notArr.status === 400);
    const unknown = await req('POST', `/api/workflows/${wf.id}/bulk-run`, { token, body: { rows: [{ nope: 'x' }] } });
    ok('unknown variable → 400 naming the row', unknown.status === 400 && /Row 1/.test(unknown.json.error));
    const nullVal = await req('POST', `/api/workflows/${wf.id}/bulk-run`, { token, body: { rows: [{ query: 'ok' }, { query: null }] } });
    ok('null value in row 2 → 400 naming the row', nullVal.status === 400 && /Row 2/.test(nullVal.json.error));
    const tooMany = await req('POST', `/api/workflows/${wf.id}/bulk-run`, { token, body: { rows: Array.from({ length: 501 }, () => ({ query: 'x' })) } });
    ok('over the row cap → 400', tooMany.status === 400);
    const foreign = await req('POST', `/api/workflows/${wf.id}/bulk-run`, { token: otherToken, body: { rows: [{ query: 'x' }] } });
    ok('another user → 404', foreign.status === 404);
  }

  console.log('enqueue');
  {
    const rows = [{ query: 'shoes', limit: '10' }, { query: 'boots' }, { query: 'hats', limit: '5' }];
    const r = await req('POST', `/api/workflows/${wf.id}/bulk-run`, { token, body: { rows } });
    ok('bulk → 202 with created count', r.status === 202 && r.json.created === 3 && r.json.runIds.length === 3);

    // The queued runs exist, are trigger='bulk', status='queued', carry inputs.
    const queued = await db.all(`SELECT id, status, trigger, inputs_json FROM runs WHERE workflow_id = ? ORDER BY id ASC`, [wf.id]);
    ok('3 queued runs created', queued.length === 3 && queued.every(q => q.status === 'queued' && q.trigger === 'bulk'));
    const first = JSON.parse(queued[0].inputs_json);
    ok('first run carries its inputs', first.query === 'shoes' && first.limit === '10');
    const second = JSON.parse(queued[1].inputs_json);
    ok('second run carries its partial inputs', second.query === 'boots' && second.limit === undefined);

    // The run detail endpoint surfaces inputs for the history UI.
    const detail = await req('GET', `/api/runs/${queued[0].id}`, { token });
    ok('run detail exposes inputs', detail.status === 200 && detail.json.run.inputs && detail.json.run.inputs.query === 'shoes');
  }

  console.log('run-with-inputs (single row)');
  {
    const r = await req('POST', `/api/workflows/${wf.id}/bulk-run`, { token, body: { rows: [{ query: 'once' }] } });
    ok('single-row bulk = run-with-inputs → 202, 1 run', r.status === 202 && r.json.created === 1);
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
