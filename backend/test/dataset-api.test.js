'use strict';

/* ===========================================================================
   Cross-run dataset HTTP test — boots the real Express app against a throwaway
   SQLite DB and exercises GET /api/workflows/:id/dataset (+ .csv/.xlsx):
   accumulation across runs, dedupe-key default & override, provenance columns,
   exports, and ownership scoping.

   Run with:  node test/dataset-api.test.js
   ========================================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-api-test-'));
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

async function req(method, pathname, { token, raw = false } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (raw) return { status: res.status, text: await res.text(), headers: res.headers };
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text, headers: res.headers };
}

async function seedRun(userId, workflowId, startedAt, finishedAt, results) {
  await db.run(
    `INSERT INTO runs (user_id, workflow_id, status, started_at, finished_at, results_json)
     VALUES (?, ?, 'success', ?, ?, ?)`,
    [userId, workflowId, startedAt, finishedAt, JSON.stringify(results)]
  );
}

async function main() {
  await db.init();
  const migrate = require('../db/migrate');
  await migrate.run(db);

  const user = await db.get(`INSERT INTO users (username, password_hash, plan) VALUES ('dsuser', 'x', 'business') RETURNING id`);
  const other = await db.get(`INSERT INTO users (username, password_hash, plan) VALUES ('dsother', 'x', 'business') RETURNING id`);
  const token = signToken({ sub: user.id, username: 'dsuser' });
  const otherToken = signToken({ sub: other.id, username: 'dsother' });

  // Workflow whose COLLECT_LIST de-dupes on `id`.
  const wf = await workflowsRepo.create({
    userId: user.id, name: 'Products',
    stepsJson: JSON.stringify([{ type: 'COLLECT_LIST', params: { keyField: 'id' } }]),
    metaJson: null,
  });

  // Two runs: 'a' appears in both (price changes), 'b' only in the newer run.
  await seedRun(user.id, wf.id, '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z',
    { products: [{ id: 'a', price: '10', name: 'Apple' }] });
  await seedRun(user.id, wf.id, '2026-01-02T00:00:00Z', '2026-01-02T00:01:00Z',
    { products: [{ id: 'a', price: '12', name: 'Apple' }, { id: 'b', price: '5', name: 'Pear' }] });

  console.log('dataset JSON');
  {
    const r = await req('GET', `/api/workflows/${wf.id}/dataset`, { token });
    ok('200 + output/keyField/columns', r.status === 200
      && r.json.output === 'products' && r.json.keyField === 'id'
      && JSON.stringify(r.json.columns) === JSON.stringify(['id', 'price', 'name']),
      JSON.stringify(r.json));
    ok('2 unique rows across 2 runs', r.json.total === 2 && r.json.runsConsidered === 2);
    const a = r.json.rows.find(x => x.key === 'k:a');
    ok('row a: latest value + provenance', a.data.price === '12' && a.timesSeen === 2
      && a.firstSeenAt === '2026-01-01T00:00:00Z' && a.lastSeenAt === '2026-01-02T00:01:00Z');
    const b = r.json.rows.find(x => x.key === 'k:b');
    ok('row b: seen once, later first-seen', b.timesSeen === 1 && b.firstSeenAt === '2026-01-02T00:00:00Z');
    ok('keyOptions offered for the dedupe selector', Array.isArray(r.json.keyOptions) && r.json.keyOptions.includes('name'));
  }

  console.log('dedupe-key override');
  {
    // Dedupe on `name` instead — 'a' both have name Apple → still 2 (Apple, Pear).
    const r = await req('GET', `/api/workflows/${wf.id}/dataset?key=name`, { token });
    ok('key=name honored', r.status === 200 && r.json.keyField === 'name' && r.json.total === 2);

    // Whole-row dedupe: run1's a{price:10} and run2's a{price:12} differ → 3 rows.
    const rr = await req('GET', `/api/workflows/${wf.id}/dataset?key=__row__`, { token });
    ok('key=__row__ → whole-row dedupe', rr.status === 200 && rr.json.keyField === null && rr.json.total === 3,
      `total=${rr.json && rr.json.total}`);

    // An invalid key falls back to the default rather than erroring.
    const rf = await req('GET', `/api/workflows/${wf.id}/dataset?key=nope`, { token });
    ok('invalid key → falls back to default', rf.status === 200 && rf.json.keyField === 'id');
  }

  console.log('exports');
  {
    const csv = await req('GET', `/api/workflows/${wf.id}/dataset.csv`, { token, raw: true });
    ok('csv → union headers + provenance columns', csv.status === 200
      && /id,price,name,First seen,Last seen,Times seen/.test(csv.text)
      && (csv.headers.get('content-type') || '').includes('text/csv'), csv.text.split('\n')[1]);

    const xlsx = await req('GET', `/api/workflows/${wf.id}/dataset.xlsx`, { token, raw: true });
    ok('xlsx → workbook mime + PK signature', xlsx.status === 200
      && (xlsx.headers.get('content-type') || '').includes('spreadsheetml')
      && xlsx.text.startsWith('PK'));
  }

  console.log('scoping & empties');
  {
    const foreign = await req('GET', `/api/workflows/${wf.id}/dataset`, { token: otherToken });
    ok('another user → 404', foreign.status === 404);

    const noAuth = await req('GET', `/api/workflows/${wf.id}/dataset`);
    ok('no token → 401', noAuth.status === 401);

    // A workflow with no successful runs → empty dataset, not an error.
    const emptyWf = await workflowsRepo.create({ userId: user.id, name: 'Empty', stepsJson: '[]', metaJson: null });
    const empty = await req('GET', `/api/workflows/${emptyWf.id}/dataset`, { token });
    ok('no runs → empty dataset (200)', empty.status === 200 && empty.json.total === 0
      && Array.isArray(empty.json.outputs) && empty.json.outputs.length === 0);
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
