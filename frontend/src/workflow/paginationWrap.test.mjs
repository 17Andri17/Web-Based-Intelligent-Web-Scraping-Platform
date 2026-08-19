/* Adding pagination moves the user's steps around. That is the kind of thing
   that has to be right the first time — a wrong answer here either loses a
   step or silently produces a scraper that returns page one and looks fine.

   Covers: which steps count as "this page", when the question is worth
   asking at all, and that wrapping never drops, duplicates or reorders
   anything.

   Run (from frontend/):  npm test  */

import assert from 'node:assert/strict';
import {
  stepsForCurrentPage, paginationChoices, stepsForChoice,
  wrapStepsInPagination, bodyKeyOf,
} from './paginationWrap.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const nav   = (id = 'nav', url = 'https://shop.test') => ({ id, type: 'NAVIGATE', params: { url } });
const list  = (id = 'list') => ({ id, type: 'EXTRACT_LIST', params: {} });
const text  = (id = 'text') => ({ id, type: 'EXTRACT_TEXT', params: {} });
const click = (id = 'click') => ({ id, type: 'CLICK', params: {} });
const pager = (id = 'pg', type = 'PAGINATE_BUTTON') => ({ id, type, kind: 'control', body: [] });
const label = (s) => s.type;
const ids = (arr) => arr.map(s => s.id);

console.log('which steps belong to the page being paginated');
test('everything after the last NAVIGATE', () => {
  const top = [nav('n1'), text('a'), list('b')];
  assert.deepEqual(ids(stepsForCurrentPage(top)), ['a', 'b']);
});
test('steps for an EARLIER page are left alone', () => {
  // The first page's steps belong to that page; only what was built against
  // the page now on screen should repeat.
  const top = [nav('n1'), list('first'), nav('n2'), text('a'), list('b')];
  assert.deepEqual(ids(stepsForCurrentPage(top)), ['a', 'b']);
});
test('with no NAVIGATE at all, every step qualifies', () => {
  assert.deepEqual(ids(stepsForCurrentPage([text('a'), list('b')])), ['a', 'b']);
});
test('a workflow that is only a NAVIGATE has nothing to offer', () => {
  assert.deepEqual(stepsForCurrentPage([nav()]), []);
});
test('an empty workflow has nothing to offer', () => {
  assert.deepEqual(stepsForCurrentPage([]), []);
  assert.deepEqual(stepsForCurrentPage(undefined), []);
});

console.log('the question is only asked when it is worth asking');
test('no candidates → no prompt at all', () => {
  assert.equal(paginationChoices([], label), null);
  assert.equal(paginationChoices(null, label), null);
});
test('one candidate → two answers, not a menu with a redundant middle', () => {
  const c = paginationChoices([list('b')], label);
  assert.equal(c.length, 2);
  assert.deepEqual(c.map(x => x.value), ['all', 'none']);
  assert.ok(c[0].label.includes('EXTRACT_LIST'), 'names the step being moved');
  assert.equal(c[0].primary, true, 'moving it in is the recommended answer');
});
test('several candidates → all / just the last / none', () => {
  const c = paginationChoices([text('a'), click('c'), list('b')], label);
  assert.deepEqual(c.map(x => x.value), ['all', 'last', 'none']);
  assert.ok(c[0].label.includes('3'), 'says how many are moving');
  assert.ok(c[1].label.includes('EXTRACT_LIST'), '"last" names the most recent step');
});
test('every answer explains its consequence', () => {
  for (const c of paginationChoices([text('a'), list('b')], label)) {
    assert.ok(c.detail && c.detail.length > 10, `${c.value} needs a consequence`);
  }
});

console.log('an answer selects the right steps');
test('all / last / none', () => {
  const cands = [text('a'), click('c'), list('b')];
  assert.deepEqual(ids(stepsForChoice('all', cands)), ['a', 'c', 'b']);
  assert.deepEqual(ids(stepsForChoice('last', cands)), ['b']);
  assert.deepEqual(stepsForChoice('none', cands), []);
});
test('a dismissed dialog moves nothing', () => {
  // confirm() resolves `false` on Escape / backdrop; that must not be read as
  // an instruction to reorganise the workflow.
  assert.deepEqual(stepsForChoice(false, [list('b')]), []);
  assert.deepEqual(stepsForChoice(undefined, [list('b')]), []);
});

console.log('wrapping keeps the workflow intact');
test('moved steps end up inside, in order, and nowhere else', () => {
  const top = [nav('n1'), text('a'), list('b')];
  const { steps } = wrapStepsInPagination(top, pager(), [top[1], top[2]]);
  assert.deepEqual(ids(steps), ['n1', 'pg']);
  assert.deepEqual(ids(steps[1].body), ['a', 'b'], 'body keeps workflow order');
});
test('nothing is lost or duplicated', () => {
  const top = [nav('n1'), text('a'), click('c'), list('b')];
  const { steps } = wrapStepsInPagination(top, pager(), [top[1], top[2], top[3]]);
  const flat = [...ids(steps.filter(s => s.type !== 'PAGINATE_BUTTON')), ...ids(steps.at(-1).body)];
  assert.deepEqual(flat.sort(), ['a', 'b', 'c', 'n1'].sort());
});
test('the steps left behind keep their order and position', () => {
  const top = [nav('n1'), list('first'), nav('n2'), text('a')];
  const { steps } = wrapStepsInPagination(top, pager(), [top[3]]);
  assert.deepEqual(ids(steps), ['n1', 'first', 'n2', 'pg']);
});
test('moving nothing leaves an empty loop appended — the old behaviour', () => {
  const top = [nav('n1'), list('b')];
  const { steps, bodyLength } = wrapStepsInPagination(top, pager(), []);
  assert.deepEqual(ids(steps), ['n1', 'b', 'pg']);
  assert.deepEqual(steps[2].body, []);
  assert.equal(bodyLength, 0);
});
test('bodyLength points past what was moved in, so new steps land after it', () => {
  const top = [nav('n1'), text('a'), list('b')];
  const { bodyLength } = wrapStepsInPagination(top, pager(), [top[1], top[2]]);
  assert.equal(bodyLength, 2);
});
test('the container passed in is not mutated', () => {
  const top = [nav('n1'), list('b')];
  const container = pager();
  wrapStepsInPagination(top, container, [top[1]]);
  assert.deepEqual(container.body, [], 'caller still holds the step it created');
  assert.deepEqual(ids(top), ['n1', 'b'], 'the original array is untouched');
});

console.log('every pagination type nests into its own body branch');
test('scroll / button / url all resolve a body key', () => {
  for (const t of ['PAGINATE_SCROLL', 'PAGINATE_BUTTON', 'PAGINATE_URL']) {
    assert.equal(bodyKeyOf({ type: t }), 'body', `${t} body branch`);
  }
});
test('an unknown type still nests rather than dropping the steps', () => {
  const top = [nav('n1'), list('b')];
  const { steps } = wrapStepsInPagination(top, { id: 'x', type: 'NOT_A_CONTROL' }, [top[1]]);
  assert.deepEqual(ids(steps.at(-1).body), ['b']);
});

console.log(`\n${passed} assertions passed`);
