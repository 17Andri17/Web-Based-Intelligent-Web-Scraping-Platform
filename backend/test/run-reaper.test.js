'use strict';

/* ===========================================================================
   Orphaned-run recovery
   ---------------------------------------------------------------------------
   Reported symptom: a run whose server stopped shows as running forever, and
   Cancel does nothing, so the job is stuck with no way out.

   The cause is that a `runs` row is only a CLAIM. Runs execute as child
   processes of the server; when the server goes, the child goes with it, but
   nothing updates the row and the in-memory canceller dies too. So the row
   says running, the UI believes it, and the button has nothing to call.

   What has to hold:
     • a run can never sit at 'running' with no live owner;
     • recovery keeps whatever it captured — an interrupted run is 'partial',
       not a write-off;
     • a run that IS genuinely alive is never reaped out from under itself.
   ========================================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-test-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.sqlite');
delete process.env.DB_CLIENT;
process.env.WS_RUN_STALE_MS = '15000';

const assert = require('assert');
const db = require('../db/client');
const migrate = require('../db/migrate');
const runStore = require('../services/runStore.service');
const runEvents = require('../services/runEvents.service');
const runReaper = require('../services/runReaper.service');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

// Backdate a heartbeat to simulate an owner that stopped responding.
async function setHeartbeat(runId, msAgo) {
  const t = new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');
  await db.run('UPDATE runs SET heartbeat_at = ? WHERE id = ?', [t, runId]);
}

(async () => {
  await migrate.run(db);
  const user = await db.get(
    "INSERT INTO users (username, password_hash) VALUES ('reaper','x') RETURNING id", []);
  const wf = await db.get(
    "INSERT INTO workflows (user_id, name, steps_json) VALUES (?, 'wf', '[]') RETURNING id", [user.id]);

  const newRun = async () => runStore.createRun({ userId: user.id, workflowId: wf.id });

  console.log('orphan recovery');

  await test('a run abandoned mid-flight is finalised, keeping its rows', async () => {
    const id = await newRun();
    await runStore.savePartialResults(id, JSON.stringify({ products: [{ n: 1 }, { n: 2 }] }), 2);
    await setHeartbeat(id, 60000);

    const n = await runReaper.reapStale();
    assert.ok(n >= 1, 'the stale run should have been reaped');

    const row = await runStore.getRun(id);
    assert.strictEqual(row.status, 'partial', 'a run that captured rows is partial, not a write-off');
    assert.strictEqual(JSON.parse(row.results_json).products.length, 2,
      'the checkpoint is promoted — it is the only copy of what it captured');
    assert.strictEqual(row.partial_results_json, null);
    assert.ok(row.finished_at, 'and it is definitively finished');
    assert.match(row.ai_summary, /2 row/, 'the summary says what was kept');
  });

  await test('a run that captured nothing is finalised as an error', async () => {
    const id = await newRun();
    await setHeartbeat(id, 60000);
    await runReaper.reapStale();
    const row = await runStore.getRun(id);
    assert.strictEqual(row.status, 'error');
    assert.strictEqual(row.error_category, 'INTERRUPTED');
  });

  await test('a run with a FRESH heartbeat is left alone', async () => {
    const id = await newRun();
    await runStore.touchRun(id);
    await runReaper.reapStale();
    assert.strictEqual((await runStore.getRun(id)).status, 'running');
  });

  await test('a run this process is actively executing is never reaped', async () => {
    // Its heartbeat may lag under load; being in the live set is the stronger
    // signal and must win, or a busy server would kill its own healthy runs.
    const id = await newRun();
    await setHeartbeat(id, 60000);
    runEvents.begin(id, { userId: user.id, workflowId: wf.id, flowTree: [] });
    try {
      await runReaper.reapStale();
      assert.strictEqual((await runStore.getRun(id)).status, 'running');
    } finally { runEvents.end(id, { status: 'success' }); }
  });

  await test('a run with no heartbeat at all is reaped once it is old enough', async () => {
    // Covers rows written before heartbeats existed.
    const id = await newRun();
    await db.run(
      "UPDATE runs SET heartbeat_at = NULL, started_at = ? WHERE id = ?",
      [new Date(Date.now() - 120000).toISOString().slice(0, 19).replace('T', ' '), id]);
    await runReaper.reapStale();
    assert.notStrictEqual((await runStore.getRun(id)).status, 'running');
  });

  await test('a brand-new run is not reaped before it has beaten once', async () => {
    const id = await newRun();
    await db.run('UPDATE runs SET heartbeat_at = NULL WHERE id = ?', [id]);
    await runReaper.reapStale();
    assert.strictEqual((await runStore.getRun(id)).status, 'running',
      'a run created moments ago must survive the sweep');
  });

  await test('watchers are released when a run is reaped', async () => {
    const id = await newRun();
    runEvents.begin(id, { userId: user.id, workflowId: wf.id, flowTree: [] });
    const seen = [];
    const h = (e) => { if (e.runId === id) seen.push(e.event); };
    runEvents.bus.on('event', h);
    await setHeartbeat(id, 60000);
    const row = await runStore.getRun(id);
    await runReaper.reap(row, 'test');
    runEvents.bus.off('event', h);
    assert.ok(seen.includes('done'),
      'an attached tab must be told, or it keeps spinning until reloaded');
  });

  console.log('\nboot recovery');

  await test('boot finalises every run left running by a dead process', async () => {
    const a = await newRun();
    const b = await newRun();
    await runStore.touchRun(a);     // fresh heartbeat — still dead, the owner is gone
    await runStore.touchRun(b);
    const n = await runReaper.reapOnBoot();
    assert.ok(n >= 2);
    assert.notStrictEqual((await runStore.getRun(a)).status, 'running');
    assert.notStrictEqual((await runStore.getRun(b)).status, 'running');
  });

  console.log('\ncancel from anywhere');

  await test('a cancel request is recorded and seen by the owning run', async () => {
    const id = await newRun();
    assert.strictEqual(await runStore.requestCancel(id, user.id), true);
    // The owner notices on its next heartbeat.
    assert.strictEqual(await runStore.touchRun(id), true,
      'touchRun reports the pending cancel so the pipeline can abort');
  });

  await test('a heartbeat with no cancel pending reports false', async () => {
    const id = await newRun();
    assert.strictEqual(await runStore.touchRun(id), false);
  });

  await test('cancel cannot be requested for someone else\'s run', async () => {
    const id = await newRun();
    assert.strictEqual(await runStore.requestCancel(id, user.id + 999), false);
  });

  await test('cancel cannot be requested for a finished run', async () => {
    const id = await newRun();
    await runStore.finishRun(id, { status: 'success', finished_at: new Date().toISOString() });
    assert.strictEqual(await runStore.requestCancel(id, user.id), false);
  });

  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall run-reaper tests passed');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
