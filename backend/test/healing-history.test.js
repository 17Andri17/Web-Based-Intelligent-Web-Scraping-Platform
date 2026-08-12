'use strict';

/* Self-healing history must be correct and must not leak.

   Two things matter here. First, scoping: the query joins `runs` to filter by
   owner, and getting that wrong would show one account another's repair
   history. Second, the rollup — the numbers are the whole point, and a wrong
   "repaired itself 4 times" is worse than no claim at all.

   Run:  node test/healing-history.test.js  */

const path = require('path');
const os = require('os');
const fs = require('fs');

// Point the DB at a throwaway file BEFORE anything opens it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-hist-'));
process.env.DB_CLIENT = 'sqlite';
process.env.DB_PATH = path.join(tmp, 'test.db');   // the var db/client.js reads
process.env.JWT_SECRET = 'test-secret';

const db = require('../db/client');
const runStore = require('../services/runStore.service');
const users = require('../db/repositories/users.repo');
const workflows = require('../db/repositories/workflows.repo');

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      ${detail ?? ''}`}`);
};

async function main() {
  await db.init();

  const aliceId = await users.create({ username: 'alice_hh', passwordHash: 'x' });
  const bobId   = await users.create({ username: 'bob_hh',   passwordHash: 'x' });

  const steps = [{ id: 'step-a', kind: 'action', type: 'EXTRACT_LIST', label: 'Products' }];
  const wfA = await workflows.create({
    userId: aliceId, name: 'Alice wf',
    stepsJson: JSON.stringify(steps), metaJson: '{}',
  });
  const wfB = await workflows.create({
    userId: bobId, name: 'Bob wf', stepsJson: '[]', metaJson: '{}',
  });

  const runA1 = await runStore.createRun({ userId: aliceId, workflowId: wfA.id });
  const runA2 = await runStore.createRun({ userId: aliceId, workflowId: wfA.id });
  const runB1 = await runStore.createRun({ userId: bobId,   workflowId: wfB.id });

  const repair = (runId, workflowId, stepId, extra = {}) => runStore.recordRepair({
    runId, workflowId, stepId,
    stepType: 'EXTRACT_LIST', attempt: 1,
    errorMessage: 'selector matched nothing',
    originalParams: '{}', suggestedParams: '{}',
    explanation: 'The product grid class changed',
    confidence: 'high',
    applied: 1,
    ...extra,
  });

  const r1 = await repair(runA1, wfA.id, 'step-a');
  const r2 = await repair(runA2, wfA.id, 'step-a');
  const r3 = await repair(runA2, wfA.id, 'step-b');
  await repair(runB1, wfB.id, 'step-z');

  await runStore.markRepairVerified(r1, true);
  await runStore.markAutoAdopted(r2);

  console.log('scoping');
  const a = await runStore.healingHistoryForWorkflow(wfA.id, aliceId);
  t('counts only this workflow', a.totals.repairs === 3, JSON.stringify(a.totals));

  const crossUser = await runStore.healingHistoryForWorkflow(wfA.id, bobId);
  t('another user reading the same workflow id gets nothing',
    crossUser.totals.repairs === 0, JSON.stringify(crossUser.totals));

  const b = await runStore.healingHistoryForWorkflow(wfB.id, bobId);
  t("Bob's own history is intact", b.totals.repairs === 1, JSON.stringify(b.totals));

  console.log('rollup');
  // Two, not one: markAutoAdopted sets verified as well, because a fix is only
  // ever adopted after it verified. The headline should reflect that rather
  // than a prettier number — an adopted repair IS a verified one.
  t('verified counts both the explicitly-verified and the auto-adopted',
    a.totals.verified === 2, String(a.totals.verified));
  t('auto-adopted is counted', a.totals.autoAdopted === 1, String(a.totals.autoAdopted));
  t('runs affected is de-duplicated', a.totals.runsAffected === 2, String(a.totals.runsAffected));

  const stepA = a.bySteps.find(s => s.stepId === 'step-a');
  const stepB = a.bySteps.find(s => s.stepId === 'step-b');
  t('per-step tallies are right', stepA && stepA.total === 2 && stepB && stepB.total === 1,
    JSON.stringify(a.bySteps));
  t('the most-repaired step sorts first', a.bySteps[0].stepId === 'step-a',
    JSON.stringify(a.bySteps.map(s => s.stepId)));

  console.log('empty + bounds');
  const emptyWf = await workflows.create({
    userId: aliceId, name: 'Never broke', stepsJson: '[]', metaJson: '{}',
  });
  const none = await runStore.healingHistoryForWorkflow(emptyWf.id, aliceId);
  t('a workflow that never broke reports zero, not an error',
    none.totals.repairs === 0 && none.bySteps.length === 0 && none.repairs.length === 0);

  const capped = await runStore.healingHistoryForWorkflow(wfA.id, aliceId, { limit: 999 });
  t('an oversized limit is clamped rather than passed to SQL',
    capped.repairs.length <= 200);

  // A window shorter than the data excludes it — the headline says "in the
  // last N days", so it has to mean that.
  const windowed = await runStore.healingHistoryForWorkflow(wfA.id, aliceId, { sinceDays: 0.0000001 });
  t('the day window actually filters', windowed.totals.repairs === 0,
    JSON.stringify(windowed.totals));

  console.log(`\n${pass} assertions passed${fail ? `, ${fail} FAILED` : ''}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
