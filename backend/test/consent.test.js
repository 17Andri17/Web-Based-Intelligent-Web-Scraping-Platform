/* Live checks for the two things only a real browser can prove:
   1. the cascade now records WHICH control it clicked, and hands back a
      selector that actually addresses that control;
   2. dismissConsent's wait budget collapses on an already-loaded page instead
      of sleeping out a fixed retry loop.

   Every fixture gets a FRESH page: puppeteer's setContent reuses the same
   window, so the cascade's own 1.5s post-click cooldown would otherwise carry
   from one fixture into the next and suppress the second one. */
const assert = require('assert');
const puppeteer = require('puppeteer');
const { CONSENT_CASCADE_SRC, buildCodegenConsentHelper } = require('../browser/consent');

// Banners HIDE rather than remove themselves, so the recorded selector can
// still be resolved after the click — a removed node could never resolve.
const ONETRUST = `
<html><body>
  <h1>Article</h1>
  <div id="onetrust-banner-sdk" style="position:fixed;bottom:0;left:0;width:100%;height:120px;background:#eee">
    <p>We use cookies to improve your experience.</p>
    <button id="onetrust-accept-btn-handler" style="width:120px;height:40px">Accept All Cookies</button>
  </div>
  <script>
    document.getElementById('onetrust-accept-btn-handler').addEventListener('click', () => {
      document.getElementById('onetrust-banner-sdk').style.display = 'none';
    });
  </script>
</body></html>`;

const CUSTOM = `
<html><body>
  <h1>Shop</h1>
  <div class="cookie-notice" style="position:fixed;bottom:0;left:0;width:100%;height:140px;background:#ddd">
    <p>This site uses cookies and similar technologies. See our cookie policy.</p>
    <button class="cn-agree" style="width:160px;height:44px">Accept all</button>
    <button class="cn-more" style="width:160px;height:44px">Manage settings</button>
  </div>
  <script>
    document.querySelector('.cn-agree').addEventListener('click', () => {
      document.querySelector('.cookie-notice').style.display = 'none';
    });
  </script>
</body></html>`;

const NO_BANNER = '<html><body><h1>Plain page</h1><button>Subscribe</button></body></html>';

let browser;
let pass = 0;
const ok = (name) => { console.log('  ok  ' + name); pass++; };

async function freshPage(html) {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  return page;
}

const applyCascade = (page) => page.evaluate((src) => {
  // eslint-disable-next-line no-new-func
  const fn = new Function(src + '\n;return { name: __consentApplyOnce("accept", false), match: window.__consentLastMatch__ };');
  const r = fn();
  return {
    name: r.name,
    selector: r.match ? r.match.selector : null,
    text: r.match ? r.match.text : null,
    hasEl: !!(r.match && r.match.el),
    // Does the recorded selector actually address the element it clicked?
    resolves: r.match && r.match.selector
      ? document.querySelector(r.match.selector) === r.match.el
      : null,
  };
}, CONSENT_CASCADE_SRC);

const bannerGone = (page, sel) => page.evaluate((s) => {
  const b = document.querySelector(s);
  return !b || getComputedStyle(b).display === 'none';
}, sel);

(async () => {
  browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

  console.log('the cascade records what it clicked');

  let page = await freshPage(ONETRUST);
  let r = await applyCascade(page);
  assert.strictEqual(r.name, 'OneTrust', 'registry should recognise OneTrust, got ' + r.name);
  assert.strictEqual(r.selector, '#onetrust-accept-btn-handler',
    'a registry hit must hand back its own hand-written selector, got ' + r.selector);
  assert.strictEqual(r.resolves, true, 'the recorded selector must address the clicked element');
  ok('a registry hit hands back the selector it matched on');
  assert.strictEqual(await bannerGone(page, '#onetrust-banner-sdk'), true, 'banner should be dismissed');
  ok('and the banner is actually dismissed');
  await page.close();

  page = await freshPage(CUSTOM);
  r = await applyCascade(page);
  assert.strictEqual(r.name, 'heuristic', 'custom banner should fall to the heuristic, got ' + r.name);
  assert.strictEqual(r.hasEl, true, 'the heuristic must still record the element it clicked');
  assert.strictEqual(r.selector, null,
    'the heuristic has no hand-written selector — the editor generates one from the element');
  assert.strictEqual(r.text, 'Accept all', 'the button label should be recorded, got ' + r.text);
  ok('a heuristic hit records the element (selector generated editor-side) and its label');
  assert.strictEqual(await bannerGone(page, '.cookie-notice'), true, 'banner should be dismissed');
  ok('and the custom banner is actually dismissed');
  await page.close();

  page = await freshPage(NO_BANNER);
  r = await applyCascade(page);
  assert.strictEqual(r.name, null, 'a page with no banner must not be clicked, got ' + r.name);
  assert.strictEqual(r.hasEl, false, 'nothing clicked → nothing recorded');
  ok('a page with no banner is left alone, and records nothing');
  await page.close();

  console.log('\nthe wait budget collapses on a loaded page');

  const helperSrc = buildCodegenConsentHelper();
  // eslint-disable-next-line no-new-func
  const { dismissConsent, __consentBudget } = new Function(
    helperSrc + '\n;return { dismissConsent, __consentBudget };')();

  page = await freshPage(NO_BANNER);
  let t = Date.now();
  let hit = await dismissConsent(page);
  let elapsed = Date.now() - t;
  assert.strictEqual(hit, false, 'no banner → false');
  assert.ok(elapsed < 1500,
    'a loaded page with no banner must not sleep out the full budget (took ' + elapsed + 'ms)');
  ok('no banner on a loaded page costs ' + elapsed + 'ms (was a fixed ~3000ms)');

  assert.strictEqual(await __consentBudget(page, 8000), 400,
    'a step still carrying the old 8000 default must collapse too');
  ok('a step saved with the old 8000 default collapses to 400ms as well');

  // waitMs: 0 is what the selector path hands its fallback — exactly one pass.
  t = Date.now();
  await dismissConsent(page, undefined, { waitMs: 0 });
  elapsed = Date.now() - t;
  assert.ok(elapsed < 400, 'waitMs:0 must be a single pass (took ' + elapsed + 'ms)');
  ok('waitMs:0 is a single pass (' + elapsed + 'ms)');
  await page.close();

  page = await freshPage(ONETRUST);
  t = Date.now();
  hit = await dismissConsent(page);
  elapsed = Date.now() - t;
  assert.strictEqual(hit, true, 'banner present → true');
  assert.strictEqual(await bannerGone(page, '#onetrust-banner-sdk'), true, 'banner should be dismissed');
  ok('a real banner is still dismissed, in ' + elapsed + 'ms');
  await page.close();

  // 'off' must stay a hard no-op regardless of budget.
  page = await freshPage(ONETRUST);
  assert.strictEqual(await dismissConsent(page, 'off'), false, "'off' must not click");
  assert.strictEqual(await bannerGone(page, '#onetrust-banner-sdk'), false, 'banner must still be up');
  ok("'off' leaves the banner up");
  await page.close();

  await browser.close();
  console.log('\n' + pass + ' assertions passed');
})().catch(async (e) => {
  console.error('\nFAILED:', e.message);
  if (browser) await browser.close().catch(() => {});
  process.exit(1);
});
