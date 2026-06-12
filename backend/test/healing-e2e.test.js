'use strict';

/* End-to-end: codegen → child Puppeteer process → runner marker parsing →
   empty-result classification. Proves the silent-failure detection works on a
   REAL run: a list whose selector matches nothing now surfaces count:0 + a
   page snapshot instead of "succeeding" with no data.

   Run (from backend/):
     CHROME_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
       node test/healing-e2e.test.js
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

process.env.CHROME_PATH = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const runner = require('../services/runner.service');
const healingStats = require('../services/healingStats');

const PAGE = `<!doctype html><html><head><title>t</title></head><body>
  <h1>Catalog</h1>
  <div class="grid">
    <div class="item"><span class="n">Alpha</span><a href="/p/1">link</a></div>
    <div class="item"><span class="n">Beta</span><a href="/p/2">link</a></div>
    <div class="item"><span class="n">Gamma</span><a href="/p/3">link</a></div>
  </div>
</body></html>`;

const htmlFile = path.join(os.tmpdir(), `heal_e2e_${Date.now()}.html`);
fs.writeFileSync(htmlFile, PAGE, 'utf8');
const fileUrl = 'file://' + htmlFile.replace(/\\/g, '/');

const workflow = {
  id: 1,
  meta: {},
  steps: [
    { id: 'nav', kind: 'action', type: 'NAVIGATE', params: { url: fileUrl } },
    { id: 'good', kind: 'action', type: 'EXTRACT_LIST', label: 'items', params: {
        containerSelector: '.item',
        fields: { name: { selector: '.n', kind: 'text' }, link: { selector: 'a', kind: 'attr', attribute: 'href' } } } },
    { id: 'broken', kind: 'action', type: 'EXTRACT_LIST', label: 'gone', params: {
        containerSelector: '.does-not-exist',
        fields: { x: { selector: '.x', kind: 'text' } } } },
    { id: 'partial', kind: 'action', type: 'EXTRACT_LIST', label: 'partial', params: {
        containerSelector: '.item',
        fields: { name: { selector: '.n', kind: 'text' }, missing: { selector: '.nope', kind: 'text' } } } },
    { id: 'single_ok', kind: 'action', type: 'EXTRACT_TEXT', label: 'heading', params: { selector: 'h1' } },
    { id: 'single_broken', kind: 'action', type: 'EXTRACT_TEXT', label: 'ghost', params: { selector: '.nothing' } },
  ],
};

let passed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name}`); process.exitCode = 1; }
}

(async () => {
  console.log('Self-healing end-to-end (real child run)');
  const { events, promise } = runner.runChild(workflow);
  events.on('log', () => {}); // swallow child logs
  const result = await promise;

  ok('child run did NOT throw (silent-success path)', result.success === true);

  const byId = {};
  for (const s of result.stepResults || []) byId[s.stepId] = s;

  ok('healthy list reported 3 records', byId.good && byId.good.count === 3);
  ok('healthy list fields fully filled', byId.good && byId.good.fields.name.nonEmpty === 3 && byId.good.fields.link.nonEmpty === 3);
  ok('broken list reported 0 records', byId.broken && byId.broken.count === 0);
  ok('partial list: name filled, missing empty', byId.partial && byId.partial.fields.name.nonEmpty === 3 && byId.partial.fields.missing.nonEmpty === 0);
  ok('single ok reported a value', byId.single_ok && byId.single_ok.count === 1);
  ok('single broken reported no value', byId.single_broken && byId.single_broken.count === 0);

  // Snapshots only for the suspicious steps.
  const snaps = result.stepSnapshots || {};
  ok('snapshot captured for broken list', !!(snaps.broken && snaps.broken.html));
  ok('snapshot captured for partial (empty field)', !!(snaps.partial && snaps.partial.html));
  ok('snapshot captured for single_broken', !!(snaps.single_broken && snaps.single_broken.html));
  ok('NO snapshot for healthy list', !snaps.good);
  ok('NO snapshot for healthy single', !snaps.single_ok);

  // Classification matches intent.
  ok('classify: healthy list not broken', healingStats.classifyStep(byId.good).broken === false);
  ok('classify: empty list is broken (no-records)', healingStats.classifyStep(byId.broken).reason === 'no-records');
  const pv = healingStats.classifyStep(byId.partial);
  ok('classify: partial list broken on empty field', pv.broken === true && pv.brokenFields.includes('missing'));
  ok('classify: single_broken is broken (no-value)', healingStats.classifyStep(byId.single_broken).reason === 'no-value');

  try { fs.unlinkSync(htmlFile); } catch (_) {}
  console.log(`\n${passed} checks passed`);
})().catch(err => { console.error('e2e crashed:', err); process.exitCode = 1; });
