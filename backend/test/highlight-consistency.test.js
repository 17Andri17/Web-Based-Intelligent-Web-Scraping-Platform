'use strict';

/* Highlight consistency for the in-page selector tool.

   The picker paints several *state* decorations that persist (green confirmed
   selection, amber next tier, purple ForEach scope ring, EXTRACT_LIST
   container outlines and field markers, the pending-pick spotlight) and four
   *transient* hovers that paint on top of them: the canvas cursor ring, the
   breadcrumb / HTML-tree preview, the list-pick hover, and the workflow
   sidebar's step hover.

   Every combination of "transient X lands on state Y and then leaves" must
   put Y back exactly as it was. Historically each hover hand-rolled its own
   teardown covering a different subset of the state subsystems, so hovering
   the wrong thing silently destroyed a decoration (or left its own behind) —
   which is what made the highlights look random to users. SelectorTool now
   funnels every teardown through one `_repaintResting`; these tests pin that
   invariant down.

   Run (from backend/):  node test/highlight-consistency.test.js         */

const fs   = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { resolveChromePath } = require('../browser/chromePath');

const selectorsSrc = fs.readFileSync(path.join(__dirname, '../browser/selectors.js'), 'utf8');
const toolSrc      = fs.readFileSync(path.join(__dirname, '../browser/inject/SelectorTool.js'), 'utf8');

// Browser-serialised forms of the tool's palette (hex → rgb, shorthand
// re-ordered), which is what shows up in el.style.outline.
const GREEN  = 'rgb(63, 185, 80) solid 2px';        // confirmed selection
const AMBER  = 'rgb(210, 153, 34) dashed 2px';      // proposed next tier
const BLUE   = 'rgb(88, 166, 255) solid 2px';       // canvas / list-pick hover
const SCOPE  = 'rgba(163, 113, 247, 0.6) solid 2px'; // ForEach iterator ring
const MARK   = 'rgb(63, 185, 80) dashed 1.5px';     // captured list field
const MARK_MUTED = 'rgba(63, 185, 80, 0.18) dashed 1.5px';
const PREV_CONT  = 'rgba(163, 113, 247, 0.45) dashed 1px'; // passive preview container
const PICK_CONT  = 'rgb(163, 113, 247) solid 2px';  // active pick container
const PENDING    = 'rgb(88, 166, 255) solid 3px';   // pick being configured

const PAGE = `<!doctype html><html><head><style>
  body{font:14px sans-serif;margin:0;padding:20px}
  .card{border:1px solid #ccc;padding:10px;margin:8px 0}
  .title{font-weight:700}
</style></head><body><div id="list">
  <div class="card" id="c1"><a class="link" href="/a"><span class="title">Alpha</span></a><span class="price">10</span></div>
  <div class="card" id="c2"><a class="link" href="/b"><span class="title">Beta</span></a><span class="price">20</span></div>
  <div class="card" id="c3"><a class="link" href="/c"><span class="title">Gamma</span></a><span class="price">30</span></div>
</div></body></html>`;

let passed = 0;
function check(name, actual, expected) {
  if (actual === expected) { passed++; console.log(`  ✓ ${name}`); return; }
  console.error(`  ✗ ${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  process.exitCode = 1;
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: resolveChromePath(),
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800 });
  await page.exposeFunction('sendToNode', () => {});   // the tool emits selections through this
  await page.setContent(PAGE);
  await page.evaluate(selectorsSrc);
  await page.evaluate(toolSrc);
  await page.evaluate(() => { window.__SELECTION_MODE__ = true; });

  // ── page-side helpers ──────────────────────────────────────────────────
  await page.evaluate(() => {
    window.__t = {
      outline: (s) => { const e = document.querySelector(s); return e ? (e.style.outline || '') : null; },
      shadow:  (s) => { const e = document.querySelector(s); return e ? (e.style.boxShadow || '') : null; },
      all:     (s) => Array.from(document.querySelectorAll(s)).map((e) => e.style.outline || ''),
      // Real events — the tool listens in the capture phase on document.
      hover: (s) => document.querySelector(s).dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 })),
      click: (s) => document.querySelector(s).dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true })),
      // Element-index chain, the addressing __highlightByPath__ expects.
      pathOf: (s) => {
        let e = document.querySelector(s); const p = [];
        while (e && e.parentElement) { p.unshift(Array.prototype.indexOf.call(e.parentElement.children, e)); e = e.parentElement; }
        return p;
      },
    };
  });
  const outline = (s) => page.evaluate((x) => window.__t.outline(x), s);
  const shadow  = (s) => page.evaluate((x) => window.__t.shadow(x), s);
  const all     = (s) => page.evaluate((x) => window.__t.all(x), s);
  const hover   = (s) => page.evaluate((x) => window.__t.hover(x), s);
  const click   = (s) => page.evaluate((x) => window.__t.click(x), s);
  const reset   = () => page.evaluate(() => window.__resetSelection__());
  const treeHover = (s) => page.evaluate((x) => window.__highlightByPath__(window.__t.pathOf(x)), s);
  const treeClear = () => page.evaluate(() => window.__clearHoverHighlight__());

  console.log('\nselection basics');
  await hover('#c1 .title');
  await click('#c1 .title');
  check('seed element goes green', await outline('#c1 .title'), GREEN);
  check('similar siblings go amber', (await all('.card .title')).slice(1).join('|'), [AMBER, AMBER].join('|'));

  console.log('\nbreadcrumb / HTML-tree hover must not eat the selection');
  await treeHover('#c1 .title');
  await treeClear();
  check('green seed is green again after a tree hover', await outline('#c1 .title'), GREEN);
  check('  and keeps its green fill', (await shadow('#c1 .title')).startsWith('rgba(63, 185, 80'), true);
  await treeHover('#c2 .title');
  await treeClear();
  check('amber tier member is amber again after a tree hover', await outline('#c2 .title'), AMBER);

  console.log('\ncanvas hover must not eat the selection');
  await hover('#c3 .title');
  await hover('#c1 .price');
  check('amber tier member survives the canvas cursor', await outline('#c3 .title'), AMBER);

  console.log('\nForEach scope ring survives every hover');
  await reset();
  await page.evaluate(() => window.__setForEachScope__('.card'));
  check('iterator cards get the purple ring', await outline('#c1'), SCOPE);
  await treeHover('#c1');
  await treeClear();
  check('ring survives a tree hover', await outline('#c1'), SCOPE);
  check('  and keeps its glow', (await shadow('#c1')).startsWith('rgba(163, 113, 247, 0.18)'), true);
  await hover('#c2 .title');
  await hover('#c3 .title');
  check('ring survives the canvas cursor on a child', await outline('#c2'), SCOPE);
  await hover('#c1');
  await click('#c1');
  check('selecting a card paints it green', await outline('#c1'), GREEN);
  await hover('#c2');
  await click('#c2');
  check('moving the selection reverts the old card to its ring', await outline('#c1'), SCOPE);
  await page.evaluate(() => window.__clearForEachScope__());
  check('clearing the scope leaves cards bare', await outline('#c1'), '');

  console.log('\nEXTRACT_LIST passive marker preview survives the canvas cursor');
  await reset();
  await page.evaluate(() => window.__showListFieldMarkers__('.card', [
    { name: 'title', selector: '.title', kind: 'text' },
  ]));
  check('containers get the preview outline', await outline('#c1'), PREV_CONT);
  check('captured fields get the dashed marker', await outline('#c1 .title'), MARK);
  await hover('#c1 .title');
  await hover('#c2 .price');
  check('marker survives being hovered', await outline('#c1 .title'), MARK);
  await hover('#c3');
  await hover('#c2 .price');
  check('container preview survives being hovered', await outline('#c3'), PREV_CONT);
  check('every container still marked', (await all('.card')).join('|'), [PREV_CONT, PREV_CONT, PREV_CONT].join('|'));
  await page.evaluate(() => window.__hideListFieldMarkers__());

  console.log('\nEXTRACT_LIST active pick cycle');
  await reset();
  await page.evaluate(() => window.__startListFieldPick__('.card', [
    { name: 'title', selector: '.title', kind: 'text' },
  ]));
  check('containers go purple', await outline('#c1'), PICK_CONT);
  check('already-captured field is marked', await outline('#c1 .title'), MARK);
  await hover('#c1 .price');
  check('hovered child gets the pick ring', await outline('#c1 .price'), BLUE);
  await click('#c1 .price');
  check('picked child gets the spotlight', await outline('#c1 .price'), PENDING);
  check('existing markers step back while configuring', await outline('#c1 .title'), MARK_MUTED);
  await page.evaluate(() => window.__updateListFieldMarkers__([
    { name: 'title', selector: '.title', kind: 'text' },
    { name: 'price', selector: '.price', kind: 'text' },
  ]));
  check('confirming drops the spotlight for a marker', await outline('#c1 .price'), MARK);
  check('  and un-mutes the others', await outline('#c1 .title'), MARK);
  await page.evaluate(() => window.__stopListFieldPick__());
  check('stopping the pick leaves nothing behind',
        (await all('.card, .card .title, .card .price')).join(''), '');

  console.log('\nsidebar step hover cannot resurrect a stale selection');
  await reset();
  await hover('#c1 .title');
  await click('#c1 .title');                                     // titles: green + amber
  await page.evaluate(() => window.__setStepHoverHighlight__('.title'));
  check('step hover rings its targets', await outline('#c2 .title'), 'rgb(79, 156, 249) solid 2px');
  await page.evaluate(() => window.__clearStepHoverHighlight__());
  check('clearing restores the green seed', await outline('#c1 .title'), GREEN);
  check('clearing restores the amber tier', await outline('#c2 .title'), AMBER);
  // The regression: the selection MOVES while the sidebar hover is up. The old
  // dataset-stashing implementation wrote the stale green/amber back on clear,
  // leaving .title AND .price both looking selected.
  await page.evaluate(() => window.__setStepHoverHighlight__('.title'));
  await hover('#c1 .price');
  await click('#c1 .price');
  await page.evaluate(() => window.__clearStepHoverHighlight__());
  check('titles are bare after the selection moved off them', (await all('.card .title')).join(''), '');
  check('prices carry the selection instead', await outline('#c1 .price'), GREEN);

  console.log('\nleaving selection mode clears the page');
  await page.evaluate(() => { window.__SELECTION_MODE__ = false; });
  const leftovers = await page.evaluate(() => Array.from(document.querySelectorAll('*'))
    // The tool's own tooltip is not page content.
    .filter((el) => (el.style.outline || el.style.boxShadow) && el.style.zIndex !== '2147483647')
    .map((el) => `${el.id || el.className || el.tagName}{${el.style.outline}|${el.style.boxShadow}}`));
  check('no inline decoration survives the mode change', leftovers.join(', '), '');

  await browser.close();
  console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}\n`);
})().catch((e) => { console.error(e); process.exit(1); });
