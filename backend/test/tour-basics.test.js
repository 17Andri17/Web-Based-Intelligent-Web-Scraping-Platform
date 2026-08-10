'use strict';

/* Deterministic check of the Basics guided tour's step logic. Loads the
   frontend tour script (frontend/src/tours/basicsTour.js) via vm and asserts
   the step shapes, ordering, forced/soft classification, targets, and that
   each forced step's advance condition fires exactly when the expected editor
   state occurs. The on-screen spotlight still needs a live run; the "when does
   each step advance" logic is verified here.
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

const makeBasicsTour = loadTour();
const steps = makeBasicsTour({ demoUrl: 'http://localhost:3001/demo/shop.html' });
const byId = Object.fromEntries(steps.map(s => [s.id, s]));
const gate = (id, state) => byId[id].gate(state);

console.log('shape + order');
test('expected step sequence', () => {
  assert.deepEqual(steps.map(s => s.id), [
    'welcome', 'go', 'modes', 'navigate', 'return', 'select-mode',
    'pick-heading', 'sidebar',
    'open-extraction', 'select-text', 'add-text',
    'pick-product', 'page-structure', 'pick-many',
    'use-ai', 'add-ai', 'edit-fields',
    'pagination-open', 'pagination-add',
    'explain-steps', 'data-tab', 'run', 'more-features', 'free-play',
  ]);
});
test('every step has a title and body', () => {
  for (const s of steps) { assert.ok(s.title, `${s.id} title`); assert.ok(s.body, `${s.id} body`); }
});
test('soft (showcase) steps are the tips + finale', () => {
  assert.deepEqual(steps.filter(s => s.soft).map(s => s.id),
    ['welcome', 'modes', 'sidebar', 'edit-fields', 'explain-steps', 'more-features', 'free-play']);
});
test('forced steps have a target, an advance condition, and waiting text', () => {
  for (const s of steps) {
    if (s.soft || s.info) continue;
    assert.ok(s.target, `${s.id} needs a target`);
    assert.ok(typeof s.gate === 'function' || s.domGate, `${s.id} needs gate or domGate`);
    assert.ok(s.waiting, `${s.id} needs waiting text`);
  }
});
test('soft steps never block on a gate they can’t satisfy', () => {
  // soft steps advance with Next; if they carry a gate it must be optional
  // (the engine shows Next for soft steps regardless).
  for (const s of steps.filter(x => x.soft)) assert.ok(!s.waiting, `${s.id} soft step should not force-wait`);
});
test('plain language — no jargon (advanced/selector/CSS/XPath)', () => {
  const bad = /\b(advanced|css|xpath|selector)\b/i;
  for (const s of steps) {
    assert.ok(!bad.test(s.title || ''), `${s.id} title has jargon`);
    assert.ok(!bad.test(s.body || ''), `${s.id} body has jargon`);
  }
});

console.log('key targets');
test('single-element capture: heading → Extraction tab → Extract Text card → Add', () => {
  assert.deepEqual(byId['pick-heading'].target, { canvas: '#heading' });
  assert.equal(byId['open-extraction'].target, '[data-tour="cat-extraction"]');
  assert.equal(byId['open-extraction'].domGate, '[data-tour="capture-text"]');   // the visible card, not the hover-only "+"
  assert.equal(byId['select-text'].target, '[data-tour="capture-text"]');
  assert.equal(byId['select-text'].domGate, '[data-tour="add-step"]');            // configurator's Add button appears
  assert.equal(byId['add-text'].target, '[data-tour="add-step"]');
});
test('return step targets the orange back button (not the address bar)', () => {
  assert.equal(byId['return'].target, '[data-tour="url-back"]');
});
test('list steps: card canvas targets + forced AI buttons', () => {
  assert.deepEqual(byId['pick-product'].target, { canvas: '.product-card' });
  assert.deepEqual(byId['pick-many'].target, { canvas: '.product-card:nth-of-type(2)' });
  assert.equal(byId['use-ai'].domGate, '[data-tour="add-ai"]');
});
test('edit-fields is a soft step over the field editor', () => {
  assert.equal(byId['edit-fields'].soft, true);
  assert.equal(byId['edit-fields'].target, '.elfe-fields');
});
test('modes + sidebar explainers point out several controls with labels', () => {
  const m = byId['modes'].highlights;
  assert.ok(Array.isArray(m) && m.length === 2, 'modes has 2 highlights');
  assert.deepEqual(m.map(h => h.target), ['[data-tour="mode-navigate"]', '[data-tour="mode-select"]']);
  assert.ok(m.every(h => typeof h.label === 'string' && h.label), 'each highlight has a label');
  const s = byId['sidebar'].highlights;
  assert.ok(Array.isArray(s) && s.length === 3, 'sidebar has 3 highlights');
  assert.deepEqual(s.map(h => h.target), ['[data-tour="side-inspector"]', '[data-tour="side-workflow"]', '[data-tour="side-html"]']);
  // multi-highlight explainers don't need a single spotlight target
  assert.equal(byId['modes'].target, null);
  assert.equal(byId['sidebar'].target, null);
});

console.log('gates advance on the right state (and not before)');
test('go / navigate / return page gates', () => {
  assert.equal(gate('go', { onDemoBase: false }), false);
  assert.equal(gate('go', { onDemoBase: true }), true);
  assert.equal(gate('navigate', { onDemoAudio: true }), true);
  assert.equal(gate('return', { onDemoBase: true }), true);
});
test('select-mode: only in selection mode', () => {
  assert.equal(gate('select-mode', { mode: 'navigation' }), false);
  assert.equal(gate('select-mode', { mode: 'selection' }), true);
});
test('pick-heading: any selection', () => {
  assert.equal(gate('pick-heading', { selHasSingle: false, selMultiCards: false }), false);
  assert.equal(gate('pick-heading', { selHasSingle: true }), true);
});
test('add-text: needs an Extract Text step (and select-text is a domGate step)', () => {
  assert.equal(typeof byId['select-text'].gate, 'undefined'); // advances via domGate
  assert.equal(gate('add-text', { hasExtractText: false }), false);
  assert.equal(gate('add-text', { hasExtractText: true }), true);
});
test('pick-product: waits until a PRODUCT (not the heading) is selected', () => {
  // still on the heading from the previous step → must NOT advance
  assert.equal(gate('pick-product', { selHasSingle: true, selIsHeading: true }), false);
  // a product selected → advance
  assert.equal(gate('pick-product', { selHasSingle: true, selIsHeading: false }), true);
  assert.equal(gate('pick-product', { selIsCard: true }), true);
});
test('page-structure: needs the whole card', () => {
  assert.equal(gate('page-structure', { selIsCard: false, selMultiCards: false }), false);
  assert.equal(gate('page-structure', { selIsCard: true }), true);
});
test('pick-many: needs the multi-card selection', () => {
  assert.equal(gate('pick-many', { selMultiCards: false }), false);
  assert.equal(gate('pick-many', { selMultiCards: true }), true);
});
test('add-ai: needs an Extract List step', () => {
  assert.equal(gate('add-ai', { hasExtractList: false }), false);
  assert.equal(gate('add-ai', { hasExtractList: true }), true);
});
test('pagination-open: waits for a detected pattern', () => {
  assert.equal(gate('pagination-open', { paginationSuggested: false }), false);
  assert.equal(gate('pagination-open', { paginationSuggested: true }), true);
});
test('pagination-add: needs a pagination step', () => {
  assert.equal(gate('pagination-add', { hasPaginate: true }), true);
});
test('data-tab / run gates', () => {
  assert.equal(gate('data-tab', { activeTab: 'data' }), true);
  assert.equal(gate('run', { execDone: false }), false);
  assert.equal(gate('run', { execDone: true }), true);
});

console.log(`\n${passed} assertions passed`);
