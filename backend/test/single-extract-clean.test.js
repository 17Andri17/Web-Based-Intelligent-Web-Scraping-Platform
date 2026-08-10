'use strict';

/* Cleaning applied to SINGLE-element extraction (Get Text / Get Link /
   Get HTML), the counterpart of the per-field pipelines EXTRACT_LIST already
   had. Covers the runtime helper, the generated script, and the rule that a
   step without transforms must generate byte-identical code to before.

   Run: node test/single-extract-clean.test.js  (from backend/) */

const assert = require('assert');
const { __ftCleanAny } = require('../workflow/fieldTransforms');
const { generateCode } = require('../workflow/workflowCodegen');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const src = (steps) => {
  const out = generateCode({ id: 1, name: 'T', steps }, { clean: true });
  return typeof out === 'string' ? out : out.code;
};
const step = (type, params) => ({ id: 's', type, label: 'Field', params, advanced: {} });

console.log('__ftCleanAny');
test('cleans a scalar value', () => {
  assert.equal(__ftCleanAny('  $19.99  ', [{ op: 'trim' }, { op: 'extract_number' }]), '19.99');
});
test('maps element-wise over the multiple=true array', () => {
  const out = __ftCleanAny(['  a ', ' b  '], [{ op: 'trim' }, { op: 'uppercase' }]);
  assert.deepEqual(out, ['A', 'B']);
});
test('no ops → the value passes through untouched', () => {
  const v = { untouched: true };
  assert.strictEqual(__ftCleanAny(v, []), v);
  assert.strictEqual(__ftCleanAny(v, undefined), v);
});
test('null survives the array path', () => {
  assert.deepEqual(__ftCleanAny([null, ' x '], [{ op: 'trim' }]), ['', 'x']);
});

console.log('codegen — EXTRACT_TEXT / ATTRIBUTE / HTML');
test('a step with transforms wraps its extraction in __ftCleanAny', () => {
  const code = src([step('EXTRACT_TEXT', { selector: '.p', selectorType: 'css', transforms: [{ op: 'trim' }] })]);
  assert.ok(/__ftCleanAny\(await evalOnElement\(/.test(code), 'expected the call to wrap the extraction');
});
test('the transform runtime is inlined when only cleanAny is used', () => {
  const code = src([step('EXTRACT_TEXT', { selector: '.p', selectorType: 'css', transforms: [{ op: 'trim' }] })]);
  assert.ok(/function __ftCleanAny\(/.test(code), 'cleanAny missing from the script');
  assert.ok(/function __ftCleanValue\(/.test(code), 'cleanValue (its dependency) missing');
});
test('a step WITHOUT transforms generates no pipeline call and no runtime', () => {
  const code = src([step('EXTRACT_TEXT', { selector: '.p', selectorType: 'css' })]);
  assert.ok(!/__ftCleanAny\(/.test(code), 'unchanged steps must not gain a call');
  assert.ok(!/function __ftCleanValue\(/.test(code), 'unchanged workflows must not carry the runtime');
});
test('an empty transforms array counts as no pipeline', () => {
  const code = src([step('EXTRACT_TEXT', { selector: '.p', selectorType: 'css', transforms: [] })]);
  assert.ok(!/__ftCleanAny\(/.test(code));
});
test('multiple=true is wrapped too (cleanAny maps the array)', () => {
  const code = src([step('EXTRACT_TEXT', { selector: '.p', selectorType: 'css', multiple: true, transforms: [{ op: 'trim' }] })]);
  assert.ok(/__ftCleanAny\(await evalOnElements\(/.test(code));
});
test('EXTRACT_ATTRIBUTE is wrapped', () => {
  const code = src([step('EXTRACT_ATTRIBUTE', { selector: 'a', selectorType: 'css', attribute: 'href', transforms: [{ op: 'prepend', text: 'https://x' }] })]);
  assert.ok(/__ftCleanAny\(await \(async \(\) =>/.test(code));
  assert.ok(/"op":"prepend"/.test(code), 'the op config must be embedded');
});
test('EXTRACT_HTML is wrapped', () => {
  const code = src([step('EXTRACT_HTML', { selector: '.b', selectorType: 'css', transforms: [{ op: 'strip_html' }] })]);
  assert.ok(/__ftCleanAny\(await evalOnElement\(/.test(code));
});

console.log('codegen — inside a FOR_EACH_ELEMENTS loop');
test('per-row extractions honour the same transforms', () => {
  const code = src([
    { id: 'l', kind: 'control', type: 'FOR_EACH_ELEMENTS', label: 'rows',
      params: { selector: '.row', selectorType: 'css' }, advanced: {},
      body: [step('EXTRACT_TEXT', { selector: '.p', selectorType: 'css', transforms: [{ op: 'to_number' }] })] },
  ]);
  assert.ok(/__ftCleanAny\(/.test(code), 'loop-scoped extraction was not cleaned');
  assert.ok(/"op":"to_number"/.test(code));
});

console.log(`\n${passed} assertions passed`);
