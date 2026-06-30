'use strict';

/* ===========================================================================
   scripts/db-smoke.js
   ---------------------------------------------------------------------------
   End-to-end smoke test for the async data layer + migration runner + the
   first migrated slice (users.repo). Runs against a throwaway SQLite file so
   it never touches the real app database.

   Run with: npm run test:db   (or: node scripts/db-smoke.js)

   To smoke-test Postgres instead:
     DB_CLIENT=postgres DATABASE_URL=postgres://... node scripts/db-smoke.js
   ========================================================================= */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Use a unique throwaway DB unless the caller explicitly targets Postgres.
const usingPg = (process.env.DB_CLIENT || '').toLowerCase() === 'postgres';
let tmpFile = null;
if (!usingPg) {
  tmpFile = path.join(os.tmpdir(), `db-smoke-${process.pid}-${Date.now()}.sqlite`);
  process.env.DB_PATH = tmpFile;
}

const db            = require('../db/client');
const users         = require('../db/repositories/users.repo');
const workflows     = require('../db/repositories/workflows.repo');
const customActions = require('../db/repositories/customActions.repo');
const runStore      = require('../services/runStore.service');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  ✓ ' + msg);
}

async function main() {
  console.log(`[db-smoke] dialect = ${db.dialect}`);

  // 1. init() must build the schema + record the baseline migration.
  await db.init();
  const migs = await db.all('SELECT id FROM schema_migrations', []);
  assert(migs.some(m => m.id === '0001_baseline'), 'baseline migration recorded');

  // init() is idempotent — a second call must not throw or re-apply.
  await db.init();
  assert(true, 'init() is idempotent');

  // 2. Insert via the repo and read the generated id back (RETURNING id path).
  const uname = 'smoke_' + Math.random().toString(36).slice(2, 10);
  const id = await users.create({ username: uname, passwordHash: 'hash123' });
  assert(typeof id === 'number' && id > 0, `create() returned numeric id (${id})`);

  // 3. existsByUsername / findByUsername round-trip.
  assert(await users.existsByUsername(uname) === true, 'existsByUsername true for created user');
  assert(await users.existsByUsername('nope_' + uname) === false, 'existsByUsername false for missing user');

  const row = await users.findByUsername(uname);
  assert(row && row.id === id && row.username === uname, 'findByUsername returns the row');
  assert(row.password_hash === 'hash123', 'password_hash round-trips');

  // 4. run() reports changes; UPDATE path works.
  const upd = await db.run('UPDATE users SET password_hash = ? WHERE id = ?', ['newhash', id]);
  assert(upd.changes === 1, 'run() reports changes = 1 on UPDATE');

  // 5. tx() commits.
  await db.tx(async (t) => {
    await t.run('UPDATE users SET password_hash = ? WHERE id = ?', ['txhash', id]);
  });
  const after = await users.findByUsername(uname);
  assert(after.password_hash === 'txhash', 'tx() commits writes');

  // 6. tx() rolls back on throw.
  try {
    await db.tx(async (t) => {
      await t.run('UPDATE users SET password_hash = ? WHERE id = ?', ['willrollback', id]);
      throw new Error('boom');
    });
  } catch (_) { /* expected */ }
  const afterRollback = await users.findByUsername(uname);
  assert(afterRollback.password_hash === 'txhash', 'tx() rolls back on error');

  // ── workflows repo (slice 2) ──────────────────────────────────────────────
  const wf = await workflows.create({
    userId: id, name: 'WF one', stepsJson: '[{"kind":"action"}]', metaJson: '{"v":1}',
  });
  assert(wf && typeof wf.id === 'number' && wf.id > 0, `workflows.create returns row with id (${wf.id})`);
  assert(wf.steps_json === '[{"kind":"action"}]', 'workflow steps_json round-trips');

  assert(await workflows.existsForUser(wf.id, id) === true, 'existsForUser true for owner');
  assert(await workflows.existsForUser(wf.id, id + 9999) === false, 'existsForUser false for non-owner');

  const got = await workflows.getForUser(wf.id, id);
  assert(got && got.name === 'WF one', 'getForUser returns the workflow');

  const list = await workflows.listSummariesForUser(id);
  assert(list.some(r => r.id === wf.id), 'listSummariesForUser includes the workflow');

  const wfUpd = await workflows.update({
    id: wf.id, userId: id, name: 'WF renamed', stepsJson: '[]', metaJson: null,
  });
  assert(wfUpd && wfUpd.name === 'WF renamed' && wfUpd.steps_json === '[]', 'update returns updated row');

  const delChanges = await workflows.remove(wf.id, id);
  assert(delChanges === 1, 'remove reports 1 change');
  assert(await workflows.getForUser(wf.id, id) === undefined, 'workflow gone after remove');

  // ── custom actions repo (slice 3) ─────────────────────────────────────────
  const ca = await customActions.create({
    userId: id, name: 'doThing', description: 'd',
    inputsJson: '[{"name":"x","type":"string"}]', outputsJson: '[]', code: 'return 1;',
  });
  assert(ca && typeof ca.id === 'number' && ca.id > 0, `customActions.create returns row with id (${ca.id})`);
  assert(ca.code === 'return 1;' && ca.inputs_json === '[{"name":"x","type":"string"}]', 'custom action fields round-trip');

  assert(await customActions.existsForUser(ca.id, id) === true, 'CA existsForUser true for owner');
  assert(await customActions.existsForUser(ca.id, id + 9999) === false, 'CA existsForUser false for non-owner');

  const caGot = await customActions.getForUser(ca.id, id);
  assert(caGot && caGot.name === 'doThing', 'CA getForUser returns the row');

  const caList = await customActions.listForUser(id);
  assert(caList.some(r => r.id === ca.id), 'CA listForUser includes the row');

  const caUpd = await customActions.update({
    id: ca.id, userId: id, name: 'doThing2', description: 'd2',
    inputsJson: '[]', outputsJson: '[]', code: 'return 2;',
  });
  assert(caUpd && caUpd.name === 'doThing2' && caUpd.code === 'return 2;', 'CA update returns updated row');

  const caDel = await customActions.remove(ca.id, id);
  assert(caDel === 1, 'CA remove reports 1 change');
  assert(await customActions.getForUser(ca.id, id) === undefined, 'custom action gone after remove');

  // ── runStore (slice 4): runs, logs, repairs, versions, schedules ──────────
  const rwf = await workflows.create({ userId: id, name: 'RunWF', stepsJson: '[]', metaJson: null });

  const verId = await runStore.ensureVersion(rwf.id, id, [{ a: 1 }], { m: 1 }, 'run');
  assert(typeof verId === 'number' && verId > 0, 'ensureVersion returns id');
  assert(await runStore.ensureVersion(rwf.id, id, [{ a: 1 }], { m: 1 }, 'run') === verId, 'ensureVersion dedupes by content hash');

  const runId = await runStore.createRun({ userId: id, workflowId: rwf.id, trigger: 'manual', versionId: verId });
  assert(typeof runId === 'number' && runId > 0, 'createRun returns id');

  // DB-backed log sequence (no in-memory counter).
  runStore.appendLog(runId, 'info', 'line one');
  runStore.appendLog(runId, 'error', 'line two');
  await runStore.flushLogs(runId);
  const logs = await runStore.getLogs(runId);
  assert(logs.length === 2 && logs[0].seq === 1 && logs[1].seq === 2, 'log seq is sequential from the DB');
  assert(logs[0].line === 'line one' && logs[1].level === 'error', 'log rows round-trip in order');

  const repId = await runStore.recordRepair({
    runId, workflowId: rwf.id, stepId: 's1', stepType: 'EXTRACT_TEXT', attempt: 1,
    errorMessage: 'e', originalParams: { a: 1 }, suggestedParams: { a: 2 },
    explanation: 'x', confidence: 'high', applied: true,
  });
  assert(typeof repId === 'number' && repId > 0, 'recordRepair returns id');
  await runStore.markRepairVerified(repId, true);
  await runStore.markAutoAdopted(repId);
  const reps = await runStore.listRepairsForRun(runId);
  assert(reps.length === 1 && reps[0].verified === 1 && reps[0].auto_adopted === 1, 'repair verified + auto_adopted persisted');

  await runStore.finishRun(runId, {
    status: 'success', finished_at: new Date().toISOString(), duration_ms: 5,
    results_json: JSON.stringify({ items: [1, 2] }),
  });
  assert((await runStore.getRun(runId)).status === 'success', 'finishRun updates status');
  const recent = await runStore.recentSuccessfulResults(rwf.id, 5);
  assert(recent.length === 1 && recent[0].items.length === 2, 'recentSuccessfulResults parses results_json');
  assert((await runStore.listRunsForUser(id, { workflowId: rwf.id })).some(r => r.id === runId), 'listRunsForUser includes the run');

  // schedules
  const sch = await runStore.upsertSchedule({ userId: id, workflowId: rwf.id, intervalMinutes: 10, isActive: true });
  assert(sch && sch.workflow_id === rwf.id && sch.is_active === 1, 'upsertSchedule creates an active schedule');
  const sch2 = await runStore.upsertSchedule({ userId: id, workflowId: rwf.id, intervalMinutes: 20, isActive: false });
  assert(sch2.id === sch.id && sch2.interval_minutes === 20 && sch2.is_active === 0, 'upsertSchedule updates the existing row');
  assert((await runStore.getScheduleByWorkflow(id, rwf.id)).id === sch.id, 'getScheduleByWorkflow returns it');
  assert((await runStore.listSchedulesForUser(id)).some(s => s.id === sch.id && s.workflow_name === 'RunWF'), 'listSchedulesForUser joins workflow name');
  await runStore.bumpScheduleAfterRun(sch.id, 20);
  assert((await runStore.getScheduleById(sch.id)).last_run_at != null, 'bumpScheduleAfterRun sets last_run_at');
  await runStore.upsertSchedule({ userId: id, workflowId: rwf.id, intervalMinutes: 10, isActive: true });
  const due = await runStore.dueSchedules(new Date(Date.now() + 24 * 3600 * 1000));
  assert(due.some(s => s.workflow_id === rwf.id), 'dueSchedules returns the active, past-due schedule');

  // Atomic claim (slice 5): force the slot past-due, then claim twice. The
  // first claim wins; the second must fail because the first pushed
  // next_run_at into the future within the same conditional UPDATE.
  await db.run('UPDATE schedules SET next_run_at = ? WHERE id = ?',
    [new Date(Date.now() - 1000).toISOString(), sch.id]);
  assert(await runStore.claimDueSchedule(sch.id, 10) === true, 'claimDueSchedule claims a past-due slot');
  assert(await runStore.claimDueSchedule(sch.id, 10) === false, 'duplicate claim of the same slot fails (atomic dedup)');

  assert(await runStore.deleteSchedule(id, rwf.id) === 1, 'deleteSchedule removes it');

  // FK cascade: removing the workflow clears its runs/logs/repairs/versions.
  await workflows.remove(rwf.id, id);
  assert((await runStore.getRun(runId)) === undefined, 'run cascade-deleted with its workflow');

  // cleanup
  await db.run('DELETE FROM users WHERE id = ?', [id]);
  await db.close();

  console.log('\n[db-smoke] PASS');
}

main()
  .catch((err) => {
    console.error('\n[db-smoke] FAIL:', err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    if (tmpFile) {
      for (const f of [tmpFile, tmpFile + '-wal', tmpFile + '-shm']) {
        try { fs.unlinkSync(f); } catch (_) {}
      }
    }
  });
