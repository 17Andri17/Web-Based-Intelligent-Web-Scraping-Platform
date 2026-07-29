'use strict';

/* Unit tests for the selector-debugger logic (services/selectorDebug):
   CSS relaxation generation + plain-language diagnosis synthesis. Pure — the
   in-page count gathering (server.js debugSelector) is not exercised here.
   Run: node test/selector-debug.test.js  (from backend/) */

const assert = require('assert');
const { cssRelaxations, buildDiagnosis, compounds, simpleTokens } = require('../services/selectorDebug');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('compounds / simpleTokens');
test('splits on combinators', () => {
  assert.deepEqual(compounds('div.card > a.link'), ['div.card', 'a.link']);
  assert.deepEqual(compounds('.a .b   .c'), ['.a', '.b', '.c']);
});
test('tokenizes a compound', () => {
  assert.deepEqual(simpleTokens('a.link[href]:hover'), ['a', '.link', '[href]', ':hover']);
});

console.log('cssRelaxations');
test('drops pseudo-classes and attribute filters first', () => {
  const rel = cssRelaxations('a.link[href]:hover');
  assert.ok(rel.includes('a.link[href]'));   // pseudo dropped
  assert.ok(rel.includes('a.link'));         // attr dropped
});
test('drops trailing compounds', () => {
  const rel = cssRelaxations('.product-card .price-final');
  assert.ok(rel.includes('.product-card'), rel.join(' | '));
});
test('includes individual tokens (finest grain)', () => {
  const rel = cssRelaxations('div.card > a.link');
  assert.ok(rel.includes('.card'));
  assert.ok(rel.includes('.link'));
});
test('never includes the exact original, and de-dupes', () => {
  const rel = cssRelaxations('.card');
  assert.ok(!rel.includes('.card'));
  assert.equal(new Set(rel).size, rel.length);
});
test('empty selector → no relaxations', () => {
  assert.deepEqual(cssRelaxations(''), []);
  assert.deepEqual(cssRelaxations('   '), []);
});
test('bounded by max', () => {
  const rel = cssRelaxations('a.b.c.d.e > f.g.h.i.j > k.l.m.n.o', { max: 6 });
  assert.ok(rel.length <= 6);
});

console.log('buildDiagnosis — matches');
test('visible matches → ok', () => {
  const d = buildDiagnosis({ selectorType: 'css', matchCount: 12, visibleCount: 12, samples: [{ tag: 'div' }] });
  assert.equal(d.verdict, 'ok');
  assert.ok(/Matches 12 elements/.test(d.messages[0]));
  assert.equal(d.samples.length, 1);
});
test('matches but all hidden → hidden verdict + advice', () => {
  const d = buildDiagnosis({ selectorType: 'css', matchCount: 5, visibleCount: 0 });
  assert.equal(d.verdict, 'hidden');
  assert.ok(d.messages.join(' ').match(/hidden|visible/i));
  assert.ok(d.messages.join(' ').match(/scroll|hover|Wait/i));
});
test('some hidden reported', () => {
  const d = buildDiagnosis({ selectorType: 'css', matchCount: 10, visibleCount: 3 });
  assert.equal(d.verdict, 'ok');
  assert.ok(/3 visible/.test(d.messages[0]));
});

console.log('buildDiagnosis — zero matches');
test('found only inside an iframe → iframe verdict', () => {
  const d = buildDiagnosis({ selectorType: 'css', matchCount: 0, visibleCount: 0, iframeMatches: 3, relaxations: [] });
  assert.equal(d.verdict, 'iframe');
  assert.ok(/iframe|frame/i.test(d.messages.join(' ')));
});
test('partial: names the closest matching part + suggestions', () => {
  const d = buildDiagnosis({
    selectorType: 'css', matchCount: 0, visibleCount: 0, iframeMatches: 0,
    relaxations: [{ selector: '.product-card', count: 12 }, { selector: '.card', count: 30 }, { selector: '.price-final', count: 0 }],
  });
  assert.equal(d.verdict, 'partial');
  assert.ok(/\.product-card/.test(d.messages[0]) && /12 elements/.test(d.messages[0]));
  assert.equal(d.suggestions[0].selector, '.product-card');
  assert.ok(d.suggestions.length <= 4);
});
test('nothing matches at all → none', () => {
  const d = buildDiagnosis({ selectorType: 'css', matchCount: 0, visibleCount: 0, iframeMatches: 0, relaxations: [{ selector: '.x', count: 0 }] });
  assert.equal(d.verdict, 'none');
  assert.ok(/Re-pick|changed|different page/i.test(d.messages.join(' ')));
});
test('xpath zero match → none, notes CSS-only diagnosis', () => {
  const d = buildDiagnosis({ selectorType: 'xpath', matchCount: 0, visibleCount: 0, relaxations: [] });
  assert.equal(d.verdict, 'none');
  assert.ok(/XPath/i.test(d.messages.join(' ')));
});

console.log(`\n${passed} assertions passed`);
