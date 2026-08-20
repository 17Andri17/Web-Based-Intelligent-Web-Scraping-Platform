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
    const r = await req('GET', `/api/workflows/${wf.id}/dataset?run=all`, { token });
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

  /* Run scoping. The default is the LATEST run, not the union: after a
     scrape finishes the question is almost always "did this one come out
     right?", and a union across months of history buries it. */
  console.log('run scoping');
  {
    const latest = await req('GET', `/api/workflows/${wf.id}/dataset`, { token });
    ok('the default is one run, not the union',
      latest.status === 200 && latest.json.runsConsidered === 1, JSON.stringify(latest.json.runsConsidered));
    ok('and it is the newest one', latest.json.run === latest.json.runs[0].id);
    ok('showing exactly what that run produced', latest.json.total === 2
      && latest.json.rows.map(r => r.data.name).sort().join() === 'Apple,Pear');
    ok('run a10 price is the newer value', latest.json.rows.find(r => r.data.id === 'a').data.price === '12');

    /* A single run is shown as it came out. Provenance describes accumulation
       and would be the same three values on every row — which the
       constant-column detector would then flag as noise. */
    ok('no provenance columns for a single run',
      Array.isArray(latest.json.meta) && latest.json.meta.length === 0);
    ok('and no dedupe key', latest.json.keyField === null);

    ok('the run picker is offered', Array.isArray(latest.json.runs) && latest.json.runs.length === 2);
    ok('newest first, with timestamps', latest.json.runs[0].id > latest.json.runs[1].id
      && !!latest.json.runs[0].startedAt);

    // An explicit older run.
    const oldest = latest.json.runs[1].id;
    const one = await req('GET', `/api/workflows/${wf.id}/dataset?run=${oldest}`, { token });
    ok('an explicit run id is honoured', one.json.run === oldest && one.json.total === 1);
    ok('and shows THAT run\'s values', one.json.rows[0].data.price === '10');

    // The union is still available, and still de-duplicates.
    const all = await req('GET', `/api/workflows/${wf.id}/dataset?run=all`, { token });
    ok('run=all still unions and de-dupes', all.json.run === 'all'
      && all.json.runsConsidered === 2 && all.json.total === 2);
    ok('and brings the provenance columns back', all.json.meta.includes('Times seen'));

    // Junk falls back to the latest rather than erroring.
    const junk = await req('GET', `/api/workflows/${wf.id}/dataset?run=nonsense`, { token });
    ok('an unknown run falls back to the latest', junk.json.run === latest.json.run);
    const foreignRun = await req('GET', `/api/workflows/${wf.id}/dataset?run=999999`, { token });
    ok('a run id that is not this workflow\'s falls back too', foreignRun.json.run === latest.json.run);

  }

  console.log('dedupe-key override');
  {
    // Dedupe on `name` instead — 'a' both have name Apple → still 2 (Apple, Pear).
    const r = await req('GET', `/api/workflows/${wf.id}/dataset?run=all&key=name`, { token });
    ok('key=name honored', r.status === 200 && r.json.keyField === 'name' && r.json.total === 2);

    // Whole-row dedupe: run1's a{price:10} and run2's a{price:12} differ → 3 rows.
    const rr = await req('GET', `/api/workflows/${wf.id}/dataset?run=all&key=__row__`, { token });
    ok('key=__row__ → whole-row dedupe', rr.status === 200 && rr.json.keyField === null && rr.json.total === 3,
      `total=${rr.json && rr.json.total}`);

    // An invalid key falls back to the default rather than erroring.
    const rf = await req('GET', `/api/workflows/${wf.id}/dataset?run=all&key=nope`, { token });
    ok('invalid key → falls back to default', rf.status === 200 && rf.json.keyField === 'id');
  }

  console.log('exports');
  {
    const csv = await req('GET', `/api/workflows/${wf.id}/dataset.csv?run=all`, { token, raw: true });
    ok('csv → union headers + provenance columns', csv.status === 200
      && /id,price,name,First seen,Last seen,Times seen/.test(csv.text)
      && (csv.headers.get('content-type') || '').includes('text/csv'), csv.text.split('\n')[1]);

    const xlsx = await req('GET', `/api/workflows/${wf.id}/dataset.xlsx?run=all`, { token, raw: true });
    ok('xlsx → workbook mime + PK signature', xlsx.status === 200
      && (xlsx.headers.get('content-type') || '').includes('spreadsheetml')
      && xlsx.text.startsWith('PK'));
  }

  /* Server-side view: the grid switches to these above ~2,000 rows, and its
     answers have to match what it computes itself below that line. */
  console.log('server-side filter / sort / projection');
  {
    const q = (s) => req('GET', `/api/workflows/${wf.id}/dataset?run=all&${s}`, { token });
    const names = (r) => r.json.rows.map(x => x.data.name);

    const filtered = await q(`filter=${encodeURIComponent(JSON.stringify({ price: '>6' }))}`);
    ok('numeric filter narrows the rows', filtered.status === 200
      && filtered.json.total === 1 && names(filtered)[0] === 'Apple', JSON.stringify(filtered.json.rows));
    ok('total is the POST-filter count, unfilteredTotal is not',
      filtered.json.total === 1 && filtered.json.unfilteredTotal === 2);

    const searched = await q('q=pear');
    ok('q searches across columns', searched.json.total === 1 && names(searched)[0] === 'Pear');

    const asc = await q('sort=price:asc');
    ok('sort ascending is numeric, not lexical', JSON.stringify(names(asc)) === JSON.stringify(['Pear', 'Apple']),
      JSON.stringify(names(asc)));
    const desc = await q('sort=price:desc');
    ok('sort descending flips it', JSON.stringify(names(desc)) === JSON.stringify(['Apple', 'Pear']));

    const meta = await q('sort=Times%20seen:desc');
    ok('provenance columns are sortable too', names(meta)[0] === 'Apple');
    ok('meta columns are advertised', Array.isArray(meta.json.meta) && meta.json.meta.includes('Times seen'));

    const projected = await q('columns=name');
    ok('columns= drops everything else from the payload',
      Object.keys(projected.json.rows[0].data).join() === 'name', JSON.stringify(projected.json.rows[0].data));
    ok('projection leaves provenance on the row', typeof projected.json.rows[0].timesSeen === 'number');

    const clipped = await q('cellMax=20');
    ok('cellMax leaves short values alone', clipped.json.rows.every(x => x.data.name.length < 20));

    ok('profiles describe every column', !!projected.json.profiles.price && !!projected.json.profiles['Times seen']);
    ok('profiles cover the WHOLE dataset, not the filtered page',
      filtered.json.profiles.price.total === 2 && filtered.json.total === 1);

    const bad = await q('filter=not-json&sort=nosuchcol:desc&columns=nope');
    ok('garbage params degrade to no filter, not a 500',
      bad.status === 200 && bad.json.total === 2 && Object.keys(bad.json.rows[0].data).length === 3);

    const csv = await req('GET',
      `/api/workflows/${wf.id}/dataset.csv?run=all&filter=${encodeURIComponent(JSON.stringify({ price: '>6' }))}`,
      { token, raw: true });
    ok('export honours the same filter as the screen',
      csv.status === 200 && /Apple/.test(csv.text) && !/Pear/.test(csv.text), csv.text);

    // The row detail needs the whole record even when the page it came from
    // had columns dropped and cells clipped.
    const full = await q('columns=name&cellMax=20&rowKey=k:a');
    ok('rowKey returns one full, unprojected row',
      full.status === 200 && full.json.row && full.json.row.data.price === '12'
      && full.json.row.data.id === 'a', JSON.stringify(full.json));
    const missing = await q('rowKey=k:nope');
    ok('an unknown rowKey is a 404, not an empty row', missing.status === 404);
  }

  console.log('issue filters');
  {
    const q = (s) => req('GET', `/api/workflows/${wf.id}/dataset?run=all&${s}`, { token });
    /* `colour` has to be a field the scrape USUALLY produces, or the rule
       correctly treats it as optional and nothing is anomalous. Present on
       four of five rows; 'b' is the one that lost it. */
    await seedRun(user.id, wf.id, '2026-01-04T00:00:00Z', '2026-01-04T00:01:00Z',
      { products: [{ id: 'a', price: '12', name: 'Apple', colour: 'red' },
                   { id: 'b', price: '5',  name: 'Pear' },
                   { id: 'c', price: '7',  name: 'Plum',  colour: 'purple' },
                   { id: 'd', price: '9',  name: 'Fig',   colour: 'green' },
                   { id: 'e', price: '4',  name: 'Date',  colour: 'brown' }] });

    const all = await q('');
    const colour = all.json.profiles.colour;
    ok('colour reads as a mostly-filled column', colour.fillPct >= 50 && colour.empty > 0,
      JSON.stringify(colour));

    const incomplete = await q('issue=incomplete');
    ok('issue=incomplete narrows to rows missing an expected field',
      incomplete.status === 200 && incomplete.json.total > 0
      && incomplete.json.total < incomplete.json.unfilteredTotal,
      `${incomplete.json.total} of ${incomplete.json.unfilteredTotal}`);
    ok('every returned row really is missing something',
      incomplete.json.rows.every(r => ['id', 'price', 'name', 'colour']
        .some(c => r.data[c] === undefined || r.data[c] === null || r.data[c] === '')),
      JSON.stringify(incomplete.json.rows.map(r => r.data)));

    const dupes = await q('issue=duplicates');
    ok('issue=duplicates is understood', dupes.status === 200
      && dupes.json.total <= dupes.json.unfilteredTotal);

    const unknown = await q('issue=nonsense');
    ok('an unknown issue name filters nothing', unknown.json.total === unknown.json.unfilteredTotal);
  }

  console.log('build cache');
  {
    const dsvc = require('../services/dataset.service');
    dsvc.cacheClear();
    await req('GET', `/api/workflows/${wf.id}/dataset?run=all`, { token });
    const afterFirst = dsvc.cacheSize();
    await req('GET', `/api/workflows/${wf.id}/dataset?run=all&sort=price:desc`, { token });
    ok('a second request with different view params reuses the build',
      afterFirst === 1 && dsvc.cacheSize() === 1, `size ${dsvc.cacheSize()}`);

    // A new run must invalidate it — the fingerprint changes, so must the data.
    const before = await req('GET', `/api/workflows/${wf.id}/dataset?run=all&limit=1000`, { token });
    await seedRun(user.id, wf.id, '2026-01-05T00:00:00Z', '2026-01-05T00:01:00Z',
      { products: [{ id: 'z', price: '99', name: 'Quince' }] });
    const after = await req('GET', `/api/workflows/${wf.id}/dataset?run=all&limit=1000`, { token });
    ok('a new run invalidates the cache',
      after.json.total === before.json.total + 1 && after.json.rows.some(x => x.data.name === 'Quince'),
      `${before.json.total} → ${after.json.total}`);
  }

  console.log('scoping & empties');
  {
    const foreign = await req('GET', `/api/workflows/${wf.id}/dataset`, { token: otherToken });
    ok('another user → 404', foreign.status === 404);

    // The cache is keyed by workflow, not by user; ownership is checked before
    // it is consulted. Warming it as the owner must not leak to anyone else.
    const dsvc = require('../services/dataset.service');
    dsvc.cacheClear();
    await req('GET', `/api/workflows/${wf.id}/dataset`, { token });
    const leak = await req('GET', `/api/workflows/${wf.id}/dataset`, { token: otherToken });
    ok('a warm cache still 404s for a non-owner', leak.status === 404, JSON.stringify(leak.json));

    const noAuth = await req('GET', `/api/workflows/${wf.id}/dataset`);
    ok('no token → 401', noAuth.status === 401);

    // A workflow with no successful runs → empty dataset, not an error.
    const emptyWf = await workflowsRepo.create({ userId: user.id, name: 'Empty', stepsJson: '[]', metaJson: null });
    const empty = await req('GET', `/api/workflows/${emptyWf.id}/dataset`, { token });
    ok('no runs → empty dataset (200)', empty.status === 200 && empty.json.total === 0
      && Array.isArray(empty.json.outputs) && empty.json.outputs.length === 0);
  }

  /* Seeds another run, so it goes last: everything above asserts against a
     known set of runs. A single run is NOT de-duplicated — a pagination loop
     that revisited a page must still look wrong, not be quietly repaired. */
  console.log('a single run is shown as it came out');
  {
    await seedRun(user.id, wf.id, '2026-01-06T00:00:00Z', '2026-01-06T00:01:00Z',
      { products: [{ id: 'x', price: '1', name: 'Dup' }, { id: 'x', price: '1', name: 'Dup' }] });

    const dup = await req('GET', `/api/workflows/${wf.id}/dataset`, { token });
    ok('duplicate rows survive into the view', dup.json.total === 2,
      JSON.stringify(dup.json.rows.map(r => r.data)));
    ok('and are reported as an issue',
      (dup.json.issues || []).some(i => i.kind === 'duplicates'), JSON.stringify(dup.json.issues));
    ok('while the union still collapses them',
      (await req('GET', `/api/workflows/${wf.id}/dataset?run=all&q=Dup`, { token })).json.total === 1);

    const csvOne = await req('GET', `/api/workflows/${wf.id}/dataset.csv`, { token, raw: true });
    ok('the export follows the run scope, without provenance',
      csvOne.status === 200 && /Dup/.test(csvOne.text) && !/Times seen/.test(csvOne.text),
      csvOne.text.slice(0, 120));
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
