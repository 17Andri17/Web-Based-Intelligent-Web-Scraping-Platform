'use strict';

/* Deterministic check of the guided tour's step logic. Loads the frontend
   tour script (frontend/src/tours/basicsTour.js) via vm and asserts the step
   shapes, ordering, targets, and — the part that actually breaks in practice —
   that each step's advance condition fires exactly when the expected editor
   state occurs, and not one state earlier.

   Also asserts the two things the tour's UX rests on and which are easy to
   regress silently:
     • ONE target per step. Overlapping highlights were unreadable, so the
       schema no longer has a multi-highlight field at all.
     • Every step that changes the workflow can undo itself, or Back is a lie.

   The on-screen behaviour still needs a live run; the "when does each step
   complete" logic is verified here.
   Run: node test/tour-basics.test.js  (from backend/) */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadTour() {
  const p = path.join(__dirname, '..', '..', 'frontend', 'src', 'tours', 'basicsTour.js');
  const src = fs.readFileSync(p, 'utf8').replace(/^export\s+/gm, '');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${src}\n;this.__api = { makeBasicsTour };`, sandbox, { filename: p });
  return sandbox.__api.makeBasicsTour;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const DEMO_URL = 'http://localhost:3001/demo/shop.html';
const makeBasicsTour = loadTour();
const steps = makeBasicsTour({ demoUrl: DEMO_URL });
const byId = Object.fromEntries(steps.map(s => [s.id, s]));
const gate = (id, state) => byId[id].gate(state);
const hint = (id, state) => byId[id].hint(state);

console.log('shape + order');
test('expected step sequence', () => {
  assert.deepEqual(steps.map(s => s.id), [
    'welcome',
    'open-page', 'browse', 'back-to-start',
    'select-mode', 'pick-product', 'pick-second',
    'use-ai', 'add-ai', 'add-field', 'clean-rating',
    'pagination', 'pagination-add',
    'review', 'preview-data', 'run', 'finish',
  ]);
});
test('short enough to finish in one sitting', () => {
  assert.ok(steps.length <= 18, `${steps.length} steps is too many for a first run`);
});
test('every step has a title and body', () => {
  for (const s of steps) { assert.ok(s.title, `${s.id} title`); assert.ok(s.body, `${s.id} body`); }
});
test('exactly one target per step — no multi-highlight anywhere', () => {
  for (const s of steps) {
    assert.ok(!('highlights' in s), `${s.id} still declares multiple highlights`);
    const t = s.target;
    assert.ok(t === null || typeof t === 'string' || (t && typeof t.canvas === 'string'),
      `${s.id} target must be null, a selector, or { canvas }`);
  }
});
test('forced steps have a target, an advance condition, and waiting text', () => {
  for (const s of steps) {
    if (s.soft) continue;
    assert.ok(s.target, `${s.id} needs a target`);
    assert.ok(typeof s.gate === 'function' || s.domGate, `${s.id} needs gate or domGate`);
    assert.ok(s.waiting, `${s.id} needs waiting text`);
  }
});
test('soft steps are the opener, the workflow review and the finale', () => {
  assert.deepEqual(steps.filter(s => s.soft).map(s => s.id), ['welcome', 'review', 'finish']);
});
test('soft steps never force-wait (they advance on Next)', () => {
  for (const s of steps.filter(x => x.soft)) assert.ok(!s.waiting, `${s.id} should not force-wait`);
});
test('plain language — no jargon', () => {
  const bad = /\b(advanced|css|xpath|selector|dom)\b/i;
  for (const s of steps) {
    assert.ok(!bad.test(s.title || ''), `${s.id} title has jargon`);
    assert.ok(!bad.test(s.body || ''), `${s.id} body has jargon`);
  }
});

console.log('rollback');
test('every step that changes the workflow can undo itself', () => {
  for (const id of ['select-mode', 'add-ai', 'pagination-add']) {
    assert.equal(typeof byId[id].undo, 'function', `${id} needs undo() for Back to mean anything`);
  }
});
test('add-ai undo removes the list step it added', () => {
  const removed = [];
  byId['add-ai'].undo({ removeStepsOfType: (t) => removed.push(...t) });
  assert.deepEqual(removed, ['EXTRACT_LIST', 'COLLECT_LIST']);
});
test('pagination-add undo removes every pagination step', () => {
  let patterns = null;
  byId['pagination-add'].undo({ removeStepsOfType: (t) => { patterns = t; } });
  // The tour runs inside a vm realm, so `instanceof RegExp` is false here even
  // for a genuine regex — brand-check it the cross-realm way instead.
  const isRegExp = (p) => Object.prototype.toString.call(p) === '[object RegExp]';
  assert.ok(patterns.some(p => isRegExp(p) && p.test('PAGINATE_URL')), 'matches PAGINATE_*');
});
test('select-mode undo puts the user back in Navigate', () => {
  let mode = null;
  byId['select-mode'].undo({ setMode: (m) => { mode = m; } });
  assert.equal(mode, 'navigation');
});
test('the optional steps are the two column tweaks, and only those', () => {
  assert.deepEqual(steps.filter(s => s.optional).map(s => s.id), ['add-field', 'clean-rating']);
});
test('clean-rating undo strips the pipeline it added', () => {
  let cleared = null;
  byId['clean-rating'].undo({ clearFieldTransforms: (f) => { cleared = f; } });
  assert.equal(cleared, 'rating');
});

console.log('key targets');
test('the practice shop is opened from the address bar', () => {
  assert.equal(byId['open-page'].target, '[data-tour="go"]');
  const seen = [];
  byId['open-page'].onEnter({ goStream: () => seen.push('stream'), prefillUrl: (u) => seen.push(u) });
  assert.deepEqual(seen, ['stream', DEMO_URL]);
});
test('navigate + return target the page menu and the orange back button', () => {
  assert.deepEqual(byId['browse'].target, { canvas: 'nav.categories a[data-cat="audio"]' });
  assert.equal(byId['back-to-start'].target, '[data-tour="url-back"]');
});
test('the list is built from two product cards, then the AI buttons', () => {
  assert.deepEqual(byId['pick-product'].target, { canvas: '.product-card' });
  assert.deepEqual(byId['pick-second'].target, { canvas: '.product-card:nth-of-type(2)' });
  assert.equal(byId['use-ai'].target, '[data-tour="use-ai"]');
  assert.equal(byId['use-ai'].domGate, '[data-tour="add-ai"]');
  assert.equal(byId['add-ai'].target, '[data-tour="add-ai"]');
});
test('the manual column is added with the fields editor’s pick button', () => {
  assert.equal(byId['add-field'].target, '[data-tour="pick-field"]');
});
test('the clean-up step points at the rating row’s own Clean button', () => {
  assert.equal(byId['clean-rating'].target, '[data-tour="clean-field-rating"]');
});

console.log('gates advance on the right state (and not before)');
test('every gate answers with a real boolean', () => {
  // A gate that returns `undefined` for "not yet" still works by accident,
  // but it makes every assertion below a truthiness test rather than an
  // equality one — and hides the difference between "no" and "I read a field
  // that does not exist".
  for (const s of steps.filter(x => typeof x.gate === 'function')) {
    assert.strictEqual(typeof s.gate({}), 'boolean', `${s.id} gate returned a non-boolean`);
  }
});
test('open-page waits for the shop’s front page', () => {
  assert.equal(gate('open-page', { onDemoBase: false }), false);
  assert.equal(gate('open-page', { onDemoBase: true }), true);
});
test('browse / back-to-start follow the page around', () => {
  assert.equal(gate('browse', { onDemoAudio: false }), false);
  assert.equal(gate('browse', { onDemoAudio: true }), true);
  assert.equal(gate('back-to-start', { onDemoBase: true }), true);
});
test('select-mode: only in selection mode', () => {
  assert.equal(gate('select-mode', { mode: 'navigation' }), false);
  assert.equal(gate('select-mode', { mode: 'selection' }), true);
});
test('pick-product needs the whole card, not a line inside it', () => {
  assert.equal(gate('pick-product', { selInsideCard: true, selIsCard: false }), false);
  assert.equal(gate('pick-product', { selIsCard: true }), true);
  assert.equal(gate('pick-product', { selMultiCards: true }), true);
});
test('pick-second needs the multi-card selection', () => {
  assert.equal(gate('pick-second', { selMultiCards: false }), false);
  assert.equal(gate('pick-second', { selMultiCards: true }), true);
});
test('add-ai needs an Extract List step; use-ai advances on the DOM', () => {
  assert.equal(typeof byId['use-ai'].gate, 'undefined');
  assert.equal(gate('add-ai', { hasExtractList: false }), false);
  assert.equal(gate('add-ai', { hasExtractList: true }), true);
});
test('add-field waits for the stock column AND for picking to be switched off', () => {
  assert.equal(gate('add-field', { hasStockField: false, listFieldPickActive: true }), false);
  // The column exists but the user is still in pick mode: not done, because
  // their next click on the page would add another column by accident.
  assert.equal(gate('add-field', { hasStockField: true, listFieldPickActive: true }), false);
  assert.equal(gate('add-field', { hasStockField: true, listFieldPickActive: false }), true);
});
test('clean-rating waits for any clean-up on the rating column', () => {
  assert.equal(gate('clean-rating', { ratingCleaned: false }), false);
  assert.equal(gate('clean-rating', { ratingCleaned: true }), true);
});
test('pagination waits for a detected pattern, then for the step', () => {
  assert.equal(gate('pagination', { paginationSuggested: false }), false);
  assert.equal(gate('pagination', { paginationSuggested: true }), true);
  assert.equal(gate('pagination-add', { hasPaginate: false }), false);
  assert.equal(gate('pagination-add', { hasPaginate: true }), true);
});
test('preview-data / run gates', () => {
  assert.equal(gate('preview-data', { activeTab: 'workflow' }), false);
  assert.equal(gate('preview-data', { activeTab: 'data' }), true);
  assert.equal(gate('run', { execDone: false }), false);
  assert.equal(gate('run', { execDone: true }), true);
});

console.log('on-track hints fire only when something is actually wrong');
test('picking stays on after a field lands — and the hint says how to stop', () => {
  const h = hint('add-field', { hasStockField: true, listFieldPickActive: true });
  assert.ok(h && /done picking/i.test(h.text), 'names the button that ends the mode');
  // Before anything is picked it explains what to click instead.
  const before = hint('add-field', { hasStockField: false, listFieldPickActive: true });
  assert.ok(before && /in stock/i.test(before.text));
  // Picking off and the column in → nothing to say.
  assert.equal(hint('add-field', { hasStockField: true, listFieldPickActive: false }), null);
});
test('picking a detail inside a product offers the one-click fix', () => {
  assert.equal(hint('pick-product', { selIsCard: true }), null);
  assert.equal(hint('pick-product', { selInsideCard: false, selIsCard: false }), null);
  const h = hint('pick-product', { selInsideCard: true, selIsCard: false, selMultiCards: false });
  assert.ok(h && h.text, 'explains what happened');
  let called = false;
  h.action.run({ selectParent: () => { called = true; } });
  assert.ok(called, 'the fix steps out to the whole product');
});
test('wandering off the practice shop offers a way back', () => {
  assert.equal(hint('back-to-start', { onDemoSite: true }), null);
  const h = hint('back-to-start', { onDemoSite: false });
  let went = false;
  h.action.run({ goDemoStart: () => { went = true; } });
  assert.ok(went);
});
test('open-page nudges only when on the shop but off its front page', () => {
  assert.equal(hint('open-page', { onDemoSite: false, onDemoBase: false }), null);
  assert.equal(hint('open-page', { onDemoSite: true, onDemoBase: true }), null);
  assert.ok(hint('open-page', { onDemoSite: true, onDemoBase: false }));
});
test('pagination explains the wait rather than looking stuck', () => {
  assert.equal(hint('pagination', { paginationDetecting: false }), null);
  assert.ok(hint('pagination', { paginationDetecting: true }).text);
});
test('every hint returns null for a user who is doing it right', () => {
  const happy = {
    mode: 'selection', onDemoSite: true, onDemoBase: true, onDemoAudio: false,
    selIsCard: true, selInsideCard: false, selMultiCards: true,
    hasExtractList: true, hasPaginate: true, hasStockField: true, ratingCleaned: true,
    listFieldPickActive: false, paginationSuggested: true, paginationDetecting: false,
    activeTab: 'data', execDone: true,
  };
  for (const s of steps.filter(x => typeof x.hint === 'function')) {
    assert.equal(s.hint(happy), null, `${s.id} nags a user who is on track`);
  }
});

console.log(`\n${passed} assertions passed`);
