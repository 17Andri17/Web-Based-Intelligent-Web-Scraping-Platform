'use strict';

/* ===========================================================================
   The guided tour's practice run must cost nothing and leave nothing behind.

   The walkthrough builds a real scraper on the bundled practice shop and runs
   it for real, because a tour that fakes the payoff teaches nothing. But the
   machinery that makes a run possible — a persisted workflow, a runs row,
   logs, results — is the same machinery that puts a card on someone's home
   screen and a tick on their monthly allowance. Left alone it would charge a
   new user a run to be taught the product, and hand them back a scraper
   pointed at a shop that does not exist.

   So the tour's workflow is flagged is_demo and is:
     • invisible in every listing of "your workflows" and "your runs",
     • uncounted against the plan's workflow limit,
     • unmetered and ungated when it runs,
     • deleted, with everything hanging off it, when the tour ends.

   Each of those is asserted below, because each one silently regresses the
   moment someone adds a new listing query and forgets the flag.

   Run: node test/tour-demo.test.js  (from backend/)
   ========================================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the data layer at a throwaway DB BEFORE anything requires db/client.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tour-demo-test-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.sqlite');
delete process.env.DB_CLIENT;           // force sqlite regardless of shell env

const http = require('http');

const db = require('../db/client');
const app = require('../app');
const workflowsRepo = require('../db/repositories/workflows.repo');
const runStore = require('../services/runStore.service');
const usageRepo = require('../db/repositories/usage.repo');
const { signToken } = require('../middleware/auth');

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

async function makeUser(username, plan = 'free') {
  const row = await db.get(
    `INSERT INTO users (username, password_hash, plan) VALUES (?, 'x', ?) RETURNING id`,
    [username, plan]);
  return { id: row.id, token: signToken({ sub: row.id, username }) };
}

const STEPS = [{ id: 's1', type: 'NAVIGATE', params: { url: 'http://localhost/demo/shop.html' } }];

async function main() {
  await db.init();

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;

  const user = await makeUser('tour_user');

  /* ── The hidden workflow ──────────────────────────────────────────────── */
  console.log('the practice workflow is not one of the user\'s scrapers');
  const demo = await workflowsRepo.create({
    userId: user.id, name: 'Guided tour practice',
    stepsJson: JSON.stringify(STEPS), metaJson: null, isDemo: true,
  });
  ok('created with is_demo set', Number(demo.is_demo) === 1, `is_demo=${demo.is_demo}`);

  {
    const list = await workflowsRepo.listSummariesForUser(user.id);
    ok('hidden from the workflows list', list.length === 0, `saw ${list.length}`);

    const page = await workflowsRepo.listSummariesForUserPage(user.id, { limit: 20 });
    ok('hidden from the public API listing', page.length === 0, `saw ${page.length}`);

    ok('not counted against the workflow limit', (await workflowsRepo.countForUser(user.id)) === 0);

    const r = await api('GET', '/api/workflows', { token: user.token });
    ok('hidden over HTTP too', r.status === 200 && r.json.workflows.length === 0,
      `status ${r.status}, ${r.json && r.json.workflows && r.json.workflows.length} rows`);
  }

  // A free plan allows exactly one workflow. The tour must not be the one
  // that uses it up — someone who takes the walkthrough first would then be
  // unable to create anything of their own.
  {
    const r = await api('POST', '/api/workflows', {
      token: user.token, body: { name: 'my real scraper', steps: STEPS },
    });
    ok('a free user can still create their own workflow afterwards', r.status === 201, `got ${r.status}`);
  }

  /* ── Its runs are not the user's run history ──────────────────────────── */
  console.log('the practice run is not in their history');
  const real = (await workflowsRepo.listSummariesForUser(user.id))[0];
  const demoRunId = await runStore.createRun({
    userId: user.id, workflowId: demo.id, trigger: 'manual', status: 'success',
  });
  const realRunId = await runStore.createRun({
    userId: user.id, workflowId: real.id, trigger: 'manual', status: 'success',
  });

  {
    const runs = await runStore.listRunsForUser(user.id);
    ok('demo run hidden from the run list', !runs.some(r => r.id === demoRunId));
    ok('the real run is still there', runs.some(r => r.id === realRunId));

    const page = await runStore.listRunsForUserPage(user.id, { limit: 50 });
    ok('demo run hidden from the paged listing (/api/runs/active, /v1/runs)',
      !page.some(r => r.id === demoRunId));
    ok('the real run is still in the paged listing', page.some(r => r.id === realRunId));

    // Asking about a specific workflow is exempt — the caller already knows
    // which workflow it named — so the tour's own UI can still read its run.
    const own = await runStore.listRunsForUser(user.id, { workflowId: demo.id });
    ok('naming the demo workflow explicitly still returns its run', own.length === 1);

    const r = await api('GET', '/api/runs', { token: user.token });
    ok('hidden over HTTP too', r.status === 200 && !r.json.runs.some(x => x.id === demoRunId),
      `status ${r.status}`);
  }

  /* ── It costs nothing ─────────────────────────────────────────────────── */
  console.log('the practice run costs nothing');
  {
    // executeAndPersist skips both the gate and the meter when arg.demo is
    // set; nothing else in the pipeline touches the usage counters, so an
    // untouched period row is the whole claim.
    const used = await usageRepo.getForPeriod(user.id);
    ok('no runs metered by the demo path', Number(used.runs_used || 0) === 0,
      `runs_used=${used.runs_used}`);
    ok('no pages metered by the demo path', Number(used.pages_fetched || 0) === 0,
      `pages_fetched=${used.pages_fetched}`);

    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'executionPipeline.service.js'), 'utf8');
    ok('the quota gate is skipped for demo runs',
      /const isDemoRun = !!arg\.demo;[\s\S]{0,200}if \(!isAdoptedApiRun && !isDemoRun\)/.test(src));
    ok('page metering is skipped for demo runs',
      /if \(pagesFetched > 0 && !isDemoRun\)/.test(src));

    // Every outbound side effect must sit INSIDE the block that excludes demo
    // runs, not merely somewhere after it — so the block is delimited by
    // matching braces rather than by a character budget a future edit would
    // blow. The condition is matched loosely because other run kinds are
    // excluded from delivery too (a debug run, for one); what this test owns
    // is only that a demo run is among them.
    const guardMatch = src.match(/if \(!isDemoRun[^)]*\) \{/);
    ok('the outbound side effects are guarded', !!guardMatch);
    const guard = guardMatch ? guardMatch[0] : 'if (!isDemoRun) {';
    const start = guardMatch ? guardMatch.index : -1;
    let depth = 0, end = start;
    for (let i = start + guard.length - 1; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { end = i; break; }
    }
    const guarded = src.slice(start, end);
    for (const call of ['webhookDispatcher.dispatchRunEvent',
                        'emailNotifier.notifyRunFailed',
                        'changeMonitor.evaluateRun',
                        'sheetsDelivery.deliverRun']) {
      ok(`a demo run cannot trigger ${call.split('.')[0]}`, guarded.includes(call));
    }
  }

  /* ── Finishing the tour leaves nothing behind ─────────────────────────── */
  console.log('finishing the tour deletes it');
  {
    await runStore.appendLog(demoRunId, 'info', 'practice run log line');
    await runStore.flushLogs(demoRunId);

    const r = await api('DELETE', '/api/tour/demo-workflow', { token: user.token });
    ok('cleanup endpoint reports what it removed', r.status === 200 && r.json.removed === 1,
      `status ${r.status}, removed ${r.json && r.json.removed}`);

    ok('the workflow is gone', !(await workflowsRepo.findDemoForUser(user.id)));
    ok('its run went with it', !(await runStore.getRun(demoRunId)));
    const logs = await db.all('SELECT id FROM run_logs WHERE run_id = ?', [demoRunId]);
    ok('its logs went with it', logs.length === 0, `${logs.length} orphaned log rows`);

    ok('the user\'s own workflow is untouched', !!(await workflowsRepo.getForUser(real.id, user.id)));
    ok('the user\'s own run is untouched', !!(await runStore.getRun(realRunId)));

    // The client fires this on paths where it cannot know whether there is
    // anything to clean up, so "nothing to do" must not be an error.
    const again = await api('DELETE', '/api/tour/demo-workflow', { token: user.token });
    ok('cleaning up twice is not an error', again.status === 200 && again.json.removed === 0);
  }

  /* ── One per user ─────────────────────────────────────────────────────── */
  console.log('restarting the tour reuses one hidden row');
  {
    const other = await makeUser('tour_other');
    await workflowsRepo.create({ userId: user.id, name: 'Guided tour practice',
      stepsJson: '[]', metaJson: null, isDemo: true });
    await workflowsRepo.create({ userId: other.id, name: 'Guided tour practice',
      stepsJson: '[]', metaJson: null, isDemo: true });

    ok('each user finds their own', (await workflowsRepo.findDemoForUser(user.id)).user_id === user.id);
    const r = await api('DELETE', '/api/tour/demo-workflow', { token: user.token });
    ok('cleanup is scoped to the caller', r.json.removed === 1);
    ok('the other user\'s practice workflow survives', !!(await workflowsRepo.findDemoForUser(other.id)));
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
