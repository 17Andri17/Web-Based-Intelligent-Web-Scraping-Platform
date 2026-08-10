'use strict';

/* ===========================================================================
   HTTP-first extraction
   ---------------------------------------------------------------------------
   Two things have to hold for HTTP mode to be safe:

     1. It must read HTML the same way the browser path does. If the two
        disagree on correct output, the verification step is comparing apples
        to oranges and its "they match" verdict means nothing. So the fixtures
        below assert the exact values the in-page extractors produce —
        trimmed text, raw attributes, container-relative fields, the lot.

     2. It must never silently take over a site it can't actually read. The
        dispatch tests cover the JavaScript-rendered case, the empty-result
        case (which proves nothing and must NOT be read as success), and the
        concurrent case where several workers reach the undecided state at once
        and only one probe may run.
   ========================================================================= */

const assert = require('assert');
const vm = require('vm');
const { buildCodegenHttpExtractHelper, httpEligibleSteps } = require('../workflow/httpExtract');

const A = (o) => Object.assign({ kind: 'action' }, o);

function sandbox() {
  const logs = [];
  const box = {
    require, JSON, Object, Array, Promise, Set, Math, String, Number, Date,
    setTimeout, clearTimeout, AbortController, fetch: undefined,
    console: { log: (l) => logs.push(l), error: () => {} },
  };
  vm.createContext(box);
  vm.runInContext(buildCodegenHttpExtractHelper({}), box);
  box.__logs = logs;
  return box;
}

const css = (v) => [{ value: v, type: 'css' }];

// Objects built inside the VM carry that realm's Object.prototype, which
// deepStrictEqual rejects even when every value is identical. Round-tripping
// through JSON compares the data, which is what these assertions are about.
const plain = (v) => JSON.parse(JSON.stringify(v));

const FIXTURE = `
<html><body>
  <h1>  Widget   Pro  </h1>
  <img id="hero" src="/img/a.png" data-zoom="/img/big.png">
  <div class="desc"><b>Fast</b> and light</div>
  <ul>
    <li class="row"><span class="k">Weight</span><a class="v" href="/w">1.2kg</a></li>
    <li class="row"><span class="k">Colour</span><a class="v" href="/c">Blue</a></li>
  </ul>
  <table id="t">
    <tr><th>Name</th><th>Value</th></tr>
    <tr><td>A</td><td>1</td></tr>
    <tr><td>B</td><td>2</td></tr>
  </table>
</body></html>`;

let failures = 0;
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => console.log(`  ok  ${name}`))
    .catch(err => { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); });
}

(async () => {
  console.log('http extraction semantics');
  const box = sandbox();
  const $ = box.__hxLoad(FIXTURE);

  await test('text is trimmed, matching el.textContent.trim()', () => {
    assert.strictEqual(box.__hxText($, css('h1'), false), 'Widget   Pro');
  });

  await test('text of a missing element is null, not an error', () => {
    assert.strictEqual(box.__hxText($, css('.nope'), false), null);
  });

  await test('multiple returns every match in document order', () => {
    assert.deepStrictEqual(plain(box.__hxText($, css('.k'), true)), ['Weight', 'Colour']);
  });

  await test('attributes come back raw (not resolved), like getAttribute', () => {
    assert.strictEqual(box.__hxAttr($, css('#hero'), 'src', false), '/img/a.png');
    assert.strictEqual(box.__hxAttr($, css('#hero'), 'data-zoom', false), '/img/big.png');
    assert.strictEqual(box.__hxAttr($, css('#hero'), 'missing', false), null);
  });

  await test('inner vs outer html', () => {
    assert.strictEqual(box.__hxHtml($, css('.desc'), false), '<b>Fast</b> and light');
    assert.match(box.__hxHtml($, css('.desc'), true), /^<div class="desc">/);
  });

  await test('selector cascade: first selector that matches wins', () => {
    const sels = [{ value: '.nothing', type: 'css' }, { value: 'h1', type: 'css' }];
    assert.strictEqual(box.__hxText($, sels, false), 'Widget   Pro');
  });

  await test('xpath entries are skipped, never mis-evaluated as css', () => {
    const sels = [{ value: '//h1', type: 'xpath' }, { value: 'h1', type: 'css' }];
    assert.strictEqual(box.__hxText($, sels, false), 'Widget   Pro');
    assert.strictEqual(box.__hxText($, [{ value: '//h1', type: 'xpath' }], false), null);
  });

  await test('list rows resolve fields relative to their own container', () => {
    const rows = box.__hxList($, css('.row'), {
      k: { selector: '.k', kind: 'text' },
      v: { selector: '.v', kind: 'text' },
      href: { selector: '.v', kind: 'attr', attribute: 'href' },
    });
    assert.deepStrictEqual(plain(rows), [
      { k: 'Weight', v: '1.2kg', href: '/w' },
      { k: 'Colour', v: 'Blue', href: '/c' },
    ]);
  });

  await test('an empty field selector means the container element itself', () => {
    const rows = box.__hxList($, css('.row'), { self: { selector: '', kind: 'attr', attribute: 'class' } });
    assert.deepStrictEqual(plain(rows), [{ self: 'row' }, { self: 'row' }]);
  });

  await test('a field that matches nothing is null, and does not drop the row', () => {
    const rows = box.__hxList($, css('.row'), {
      k: { selector: '.k', kind: 'text' },
      gone: { selector: '.nope', kind: 'text' },
    });
    assert.deepStrictEqual(plain(rows), [{ k: 'Weight', gone: null }, { k: 'Colour', gone: null }]);
  });

  await test('table with header maps cells to header names', () => {
    assert.deepStrictEqual(plain(box.__hxTable($, css('#t'), true)), [
      { Name: 'A', Value: '1' }, { Name: 'B', Value: '2' },
    ]);
  });

  await test('table without header returns positional rows', () => {
    assert.deepStrictEqual(plain(box.__hxTable($, css('#t'), false)), [
      ['Name', 'Value'], ['A', '1'], ['B', '2'],
    ]);
  });

  await test('missing table is null', () => {
    assert.strictEqual(box.__hxTable($, css('#none'), true), null);
  });

  console.log('\nverification comparison');

  await test('identical results match', () => {
    assert.strictEqual(box.__hxSameResult({ a: 'x', b: [1, 2] }, { a: 'x', b: [1, 2] }), true);
  });

  await test('incidental whitespace differences still match', () => {
    assert.strictEqual(box.__hxSameResult({ a: 'Widget  Pro' }, { a: 'Widget Pro' }), true);
  });

  await test('_sourceUrl is ignored (it is provenance, not scraped data)', () => {
    assert.strictEqual(box.__hxSameResult({ a: 'x', _sourceUrl: 'u1' }, { a: 'x', _sourceUrl: 'u2' }), true);
  });

  await test('any real difference fails — a JS-rendered page must not pass', () => {
    assert.strictEqual(box.__hxSameResult({ title: null }, { title: 'Widget Pro' }), false);
    assert.strictEqual(box.__hxSameResult({ rows: [] }, { rows: [{ n: 1 }] }), false);
    assert.strictEqual(box.__hxSameResult({ a: 'x' }, { a: 'y' }), false);
  });

  await test('an empty browser reference proves nothing, so it fails closed', () => {
    // Both empty would "match" on a naive comparison and wrongly enable HTTP
    // mode for a site whose data simply hadn't loaded yet.
    assert.strictEqual(box.__hxSameResult({}, {}), false);
    assert.strictEqual(box.__hxSameResult({ a: null }, { a: null }), false);
    assert.strictEqual(box.__hxSameResult({ rows: [] }, { rows: [] }), false);
  });

  console.log('\ndispatch + verification gate');

  await test('static site: probes once, then skips the browser entirely', async () => {
    const b = sandbox();
    const state = { mode: 'undecided', gate: null };
    let browserCalls = 0, httpCalls = 0;
    const browserRun = async () => { browserCalls++; return { t: 'Widget' }; };
    const httpRun = async () => { httpCalls++; return { t: 'Widget' }; };
    const out = [];
    for (let i = 0; i < 5; i++) out.push(await b.__hxDispatch(state, 'u' + i, httpRun, browserRun));
    assert.strictEqual(state.mode, 'http');
    assert.strictEqual(browserCalls, 1, 'browser used only for the probe');
    assert.strictEqual(httpCalls, 5, 'probe + 4 remaining items over HTTP');
    assert.strictEqual(out.length, 5);
    assert.ok(b.__logs.some(l => /Verified against the browser/.test(l)));
  });

  await test('js-rendered site: falls back and never tries HTTP again', async () => {
    const b = sandbox();
    const state = { mode: 'undecided', gate: null };
    let browserCalls = 0, httpCalls = 0;
    const browserRun = async () => { browserCalls++; return { t: 'Widget' }; };
    const httpRun = async () => { httpCalls++; return { t: null }; };   // HTML has no data
    for (let i = 0; i < 5; i++) await b.__hxDispatch(state, 'u' + i, httpRun, browserRun);
    assert.strictEqual(state.mode, 'browser');
    assert.strictEqual(browserCalls, 5, 'every item uses the browser');
    assert.strictEqual(httpCalls, 1, 'HTTP tried once, then abandoned');
    assert.ok(b.__logs.some(l => /needs a browser/.test(l)));
  });

  await test('concurrent workers share ONE probe', async () => {
    const b = sandbox();
    const state = { mode: 'undecided', gate: null };
    let browserCalls = 0;
    const browserRun = async () => {
      browserCalls++;
      await new Promise(r => setTimeout(r, 20));
      return { t: 'Widget' };
    };
    const httpRun = async () => ({ t: 'Widget' });
    // 8 workers all hit the undecided state simultaneously.
    await Promise.all(Array.from({ length: 8 }, (_, i) => b.__hxDispatch(state, 'u' + i, httpRun, browserRun)));
    assert.strictEqual(browserCalls, 1, `only one probe may run, saw ${browserCalls}`);
    assert.strictEqual(state.mode, 'http');
  });

  await test('a one-off fetch failure retries that item in the browser, keeping HTTP mode', async () => {
    const b = sandbox();
    const state = { mode: 'http', gate: null };
    let browserCalls = 0;
    const browserRun = async () => { browserCalls++; return { t: 'from-browser' }; };
    let n = 0;
    const httpRun = async () => (++n === 2 ? null : { t: 'from-http' });
    const r1 = await b.__hxDispatch(state, 'u1', httpRun, browserRun);
    const r2 = await b.__hxDispatch(state, 'u2', httpRun, browserRun);   // fetch fails
    const r3 = await b.__hxDispatch(state, 'u3', httpRun, browserRun);
    assert.deepStrictEqual([r1.t, r2.t, r3.t], ['from-http', 'from-browser', 'from-http']);
    assert.strictEqual(browserCalls, 1, 'only the failed item touched the browser');
    assert.strictEqual(state.mode, 'http', 'mode is not abandoned over one failure');
  });

  await test('a throwing httpRun is treated as a failure, not a crash', async () => {
    const b = sandbox();
    const state = { mode: 'http', gate: null };
    const r = await b.__hxDispatch(state, 'u1', async () => { throw new Error('ECONNRESET'); },
      async () => ({ t: 'browser' }));
    assert.strictEqual(r.t, 'browser');
  });

  await test('no http runner ⇒ straight to the browser', async () => {
    const b = sandbox();
    const state = { mode: 'undecided', gate: null };
    const r = await b.__hxDispatch(state, 'u1', null, async () => ({ t: 'b' }));
    assert.strictEqual(r.t, 'b');
    assert.strictEqual(state.mode, 'undecided', 'no runner means no decision to make');
  });

  console.log('\ncompile-time eligibility');

  await test('a body of pure css extraction is eligible', () => {
    assert.strictEqual(httpEligibleSteps([
      A({ type: 'EXTRACT_TEXT', params: { selector: 'h1' } }),
      A({ type: 'EXTRACT_LIST', params: { containerSelector: '.r', fields: { a: '.a' } } }),
    ]).eligible, true);
  });

  await test('anything needing a browser disqualifies the whole body', () => {
    for (const t of ['CLICK_ELEMENT', 'SCROLL', 'TYPE_TEXT', 'WAIT', 'NAVIGATE', 'SOLVE_CAPTCHA', 'COLLECT_LIST']) {
      const r = httpEligibleSteps([A({ type: 'EXTRACT_TEXT', params: { selector: 'h1' } }), A({ type: t, params: {} })]);
      assert.strictEqual(r.eligible, false, `${t} should disqualify`);
    }
  });

  await test('xpath anywhere disqualifies — cheerio cannot evaluate it', () => {
    assert.strictEqual(httpEligibleSteps([
      A({ type: 'EXTRACT_TEXT', params: { selector: '//h1', selectorType: 'xpath' } }),
    ]).eligible, false);
    assert.strictEqual(httpEligibleSteps([
      A({ type: 'EXTRACT_TEXT', params: { selector: 'h1' } }),
      A({ type: 'EXTRACT_LIST', params: { containerSelector: '.r', fields: { a: './span' } } }),
    ]).eligible, false, 'container-relative xpath in a field must disqualify');
    assert.strictEqual(httpEligibleSteps([
      A({ type: 'EXTRACT_TEXT', params: { selector: 'h1', fallbackSelectors: [{ value: '/html/body/h1', type: 'css' }] } }),
    ]).eligible, false, 'xpath-shaped fallback must disqualify');
  });

  await test('control flow disqualifies', () => {
    assert.strictEqual(httpEligibleSteps([
      { kind: 'control', type: 'FOR_EACH', body: [A({ type: 'EXTRACT_TEXT', params: { selector: 'h1' } })] },
    ]).eligible, false);
  });

  await test('an empty body is not eligible', () => {
    assert.strictEqual(httpEligibleSteps([]).eligible, false);
  });

  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall http-extract tests passed');
})();
