'use strict';

/* Plain-node unit tests for the deterministic (AI-free) healing core.
   Run: node test/healing-pure.test.js  (from backend/) */

const assert = require('assert');

const stats = require('../services/healingStats');
const validators = require('../services/healingValidators');
const codeCheck = require('../services/codeCheck');
const { generateCode } = require('../workflow/workflowCodegen');
const wf = require('../workflow/workflowUtils');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('healingStats.classifyStep');
test('0 records is broken (no-records)', () => {
  const v = stats.classifyStep({ type: 'EXTRACT_LIST', count: 0, fields: {} });
  assert.equal(v.broken, true);
  assert.equal(v.reason, 'no-records');
  assert.equal(v.severity, 'empty');
});
test('healthy list is not broken', () => {
  const v = stats.classifyStep({ type: 'EXTRACT_LIST', count: 20,
    fields: { title: { nonEmpty: 20, total: 20 }, price: { nonEmpty: 19, total: 20 } } });
  assert.equal(v.broken, false);
});
test('1 record with NO history is NOT broken (avoids false alarm)', () => {
  const v = stats.classifyStep({ type: 'EXTRACT_LIST', count: 1, fields: { t: { nonEmpty: 1, total: 1 } } }, null);
  assert.equal(v.broken, false);
});
test('1 record WHEN history shows many IS broken', () => {
  const v = stats.classifyStep({ type: 'EXTRACT_LIST', count: 1, fields: { t: { nonEmpty: 1, total: 1 } } }, 20);
  assert.equal(v.broken, true);
  assert.equal(v.reason, 'too-few-records');
});
test('records present but a field empty in all rows is field-broken', () => {
  const v = stats.classifyStep({ type: 'EXTRACT_LIST', count: 12,
    fields: { title: { nonEmpty: 12, total: 12 }, price: { nonEmpty: 0, total: 12 } } });
  assert.equal(v.broken, true);
  assert.equal(v.reason, 'empty-fields');
  assert.deepEqual(v.brokenFields, ['price']);
  assert.equal(v.severity, 'field');
});
test('scalar single extraction with no value is broken', () => {
  const v = stats.classifyStep({ type: 'EXTRACT_TEXT', count: 0, fields: {} });
  assert.equal(v.broken, true);
  assert.equal(v.reason, 'no-value');
});

console.log('healingStats.isSuspicious (runtime snapshot trigger)');
test('collection count 0 is suspicious', () => assert.equal(stats.isSuspicious({ count: 0, fields: {} }, true), true));
test('collection count 1 is suspicious', () => assert.equal(stats.isSuspicious({ count: 1, fields: {} }, true), true));
test('scalar count 1 is NOT suspicious (healthy single)', () => assert.equal(stats.isSuspicious({ count: 1, fields: {} }, false), false));
test('scalar count 0 is suspicious', () => assert.equal(stats.isSuspicious({ count: 0, fields: {} }, false), true));
test('empty field makes it suspicious even with many rows', () =>
  assert.equal(stats.isSuspicious({ count: 50, fields: { p: { nonEmpty: 0, total: 50 } } }, true), true));
test('healthy big list is not suspicious', () =>
  assert.equal(stats.isSuspicious({ count: 50, fields: { p: { nonEmpty: 50, total: 50 } } }, true), false));

console.log('healingValidators.validateValue');
test('href must look like a link', () => {
  assert.equal(validators.validateValue({ kind: 'attr', attribute: 'href', name: 'link' }, '/p/123').ok, true);
  assert.equal(validators.validateValue({ kind: 'attr', attribute: 'href', name: 'link' }, 'javascript:void(0)').ok, false);
  assert.equal(validators.validateValue({ kind: 'attr', attribute: 'href', name: 'link' }, '   ').ok, false);
});
test('price text must contain a digit', () => {
  assert.equal(validators.validateValue({ kind: 'text', name: 'price' }, '$19.99').ok, true);
  assert.equal(validators.validateValue({ kind: 'text', name: 'price' }, 'Add to cart').ok, false);
});
test('punctuation-only text is rejected', () => {
  assert.equal(validators.validateValue({ kind: 'text', name: 'title' }, '—').ok, false);
  assert.equal(validators.validateValue({ kind: 'text', name: 'title' }, 'Wireless Mouse').ok, true);
});

console.log('healingValidators.assessFieldSamples (majority rule)');
test('majority valid passes', () => {
  const r = validators.assessFieldSamples({ kind: 'text', name: 'title' }, ['A', 'B', 'C', '']);
  assert.equal(r.ok, true); assert.equal(r.valid, 3); assert.equal(r.total, 4);
});
test('one lucky hit does not adopt a selector', () => {
  const r = validators.assessFieldSamples({ kind: 'text', name: 'price' }, ['$5', '', '', '', '']);
  assert.equal(r.ok, false);
});

console.log('codeCheck.checkCompiles');
test('valid generated code compiles', () => {
  const code = generateCode({ steps: [
    { id: 's1', kind: 'action', type: 'NAVIGATE', params: { url: 'https://example.com' } },
    { id: 's2', kind: 'action', type: 'EXTRACT_TEXT', label: 'title', params: { selector: 'h1' } },
  ], meta: {} });
  assert.equal(codeCheck.checkCompiles(code).ok, true);
});
test('syntactically broken code is caught', () => {
  assert.equal(codeCheck.checkCompiles('const x = (;').ok, false);
});

console.log('workflowUtils mutations');
const sampleSteps = [
  { id: 'nav', kind: 'action', type: 'NAVIGATE', params: { url: 'u' } },
  { id: 'list', kind: 'action', type: 'EXTRACT_LIST', label: 'products', params: {
      containerSelector: '.card',
      fields: { title: { selector: '.t', kind: 'text' }, price: { selector: '.p', kind: 'text' }, link: { selector: 'a', kind: 'attr', attribute: 'href' } },
  } },
];
test('removeListField drops one field, keeps the rest', () => {
  const { steps, dropped } = wf.removeListField(sampleSteps, 'list', 'price');
  assert.ok(dropped);
  const list = steps.find(s => s.id === 'list');
  assert.deepEqual(Object.keys(list.params.fields), ['title', 'link']);
  // original untouched (pure)
  assert.ok(sampleSteps[1].params.fields.price);
});
test('removeStepById removes the step', () => {
  const { steps, removed } = wf.removeStepById(sampleSteps, 'list');
  assert.equal(removed.id, 'list');
  assert.equal(steps.find(s => s.id === 'list'), undefined);
  assert.equal(steps.length, 1);
});
test('setStepParams replaces params', () => {
  const { steps, patched } = wf.setStepParams(sampleSteps, 'list', { containerSelector: '.new', fields: {} });
  assert.equal(patched, true);
  assert.equal(steps.find(s => s.id === 'list').params.containerSelector, '.new');
});

console.log(`\n${passed} assertions passed`);
