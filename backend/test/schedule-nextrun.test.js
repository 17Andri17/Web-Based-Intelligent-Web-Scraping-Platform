'use strict';

/* Unit tests for schedule next-run computation: interval, anchor, weekday
   filter, and cron. Pure — no DB.
   Run: node test/schedule-nextrun.test.js  (from backend/) */

const assert = require('assert');
const { computeNextRun, normaliseWeekdays, computeNextRunCronValid } = require('../services/runStore.service');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const MIN = 60 * 1000;

console.log('interval (existing behaviour preserved)');
test('no anchor → now + interval', () => {
  const now = new Date('2026-07-25T12:00:00Z'); // Saturday
  const next = computeNextRun(null, 30, { now });
  assert.equal(next.getTime(), now.getTime() + 30 * MIN);
});
test('future anchor → the anchor itself', () => {
  const now = new Date('2026-07-25T12:00:00Z');
  const anchor = new Date('2026-07-25T18:00:00Z').toISOString();
  assert.equal(computeNextRun(anchor, 60, { now }).toISOString(), anchor);
});
test('past anchor → next slot strictly in the future', () => {
  const now = new Date('2026-07-25T12:10:00Z');
  const anchor = new Date('2026-07-25T12:00:00Z').toISOString();
  const next = computeNextRun(anchor, 60, { now }); // hourly from 12:00 → 13:00
  assert.equal(next.toISOString(), '2026-07-25T13:00:00.000Z');
});

console.log('normaliseWeekdays');
test('array of days → sorted CSV', () => {
  assert.equal(normaliseWeekdays([5, 1, 3, 1]), '1,3,5');
});
test('all 7 days → null (no constraint)', () => {
  assert.equal(normaliseWeekdays([0,1,2,3,4,5,6]), null);
});
test('empty → null; junk filtered', () => {
  assert.equal(normaliseWeekdays([]), null);
  assert.equal(normaliseWeekdays([9, -1, 'x', 2]), '2');
});

console.log('weekday filter');
test('a daily slot that lands on an excluded day is pushed to an allowed one', () => {
  // Sat 2026-07-25 12:00. Interval 1 day, weekdays = Mon-Fri (1..5).
  const now = new Date('2026-07-25T12:00:00Z'); // Saturday
  const anchor = new Date('2026-07-25T12:00:00Z').toISOString();
  const next = computeNextRun(anchor, 60 * 24, { now, weekdaysCsv: '1,2,3,4,5' });
  // +1 day = Sun (still excluded) → +1 day = Mon 27th
  assert.equal(next.getDay(), 1, `expected Monday, got day ${next.getDay()} (${next.toISOString()})`);
});
test('an allowed-day slot is returned unchanged', () => {
  const now = new Date('2026-07-27T08:00:00Z'); // Monday
  const anchor = new Date('2026-07-27T09:00:00Z').toISOString();
  const next = computeNextRun(anchor, 60 * 24, { now, weekdaysCsv: '1,2,3,4,5' });
  assert.equal(next.toISOString(), anchor); // Monday 09:00, allowed
});

console.log('cron');
test('valid cron drives next-run and ignores interval', () => {
  const now = new Date('2026-07-25T12:00:00Z'); // Saturday
  // 0 9 * * 1  → 09:00 on Mondays
  const next = computeNextRun(null, 5, { now, cron: '0 9 * * 1' });
  assert.equal(next.getDay(), 1, `expected Monday, got ${next.toISOString()}`);
  assert.equal(next.getHours(), 9); // local hour (cron-parser uses local tz)
});
test('invalid cron falls back to interval, never wedges', () => {
  const now = new Date('2026-07-25T12:00:00Z');
  const next = computeNextRun(null, 15, { now, cron: 'not a cron' });
  assert.equal(next.getTime(), now.getTime() + 15 * MIN);
});
test('cron validity check', () => {
  assert.equal(computeNextRunCronValid('*/10 * * * *'), true);
  assert.equal(computeNextRunCronValid('nonsense'), false);
});

console.log(`\n${passed} assertions passed`);
