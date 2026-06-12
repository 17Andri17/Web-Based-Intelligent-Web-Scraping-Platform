'use strict';

/* End-to-end test of the self-healing BRAIN against a real, mutated page.
   - The LLM is stubbed with canned proposals (some correct, one wrong, two
     "disappeared") so the test is deterministic and offline.
   - Selector VERIFICATION is real: the captured snapshot is loaded into
     headless Chromium and candidates are checked against the live DOM.

   This proves the central guarantee: a fix is only adopted when it actually
   captures sensible data; a wrong selector (right element, wrong value) is
   rejected; genuinely-gone fields are dropped.

   Run (from backend/):
     CHROME_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
       node test/healing-integration.test.js
*/

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// ── Stub the LLM BEFORE healing.service is required (shared module cache). ──
const llm = require('../services/llm.service');
llm.isConfigured = () => true;

// Canonical correct repairs for the "changed" benchmark page.
const FIELD_REPAIR = {
  title:          { selector: 'h3.vg-hl',     kind: 'text' },
  brand:          { selector: 'small.vg-vendor', kind: 'text' },
  price:          { selector: 'em.vg-cur',    kind: 'text' },
  original_price: { selector: 'del.vg-was',   kind: 'text' },
  discount:       { selector: 'b.vg-off',     kind: 'text' },
  rating:         { selector: '.vg-stars',    kind: 'text' },
  review_count:   { selector: '.vg-votes',    kind: 'text' },
  availability:   { selector: '.vg-stock',    kind: 'text' },
};
// Fields with no equivalent on the changed page → model reports "disappeared".
const DISAPPEARED = new Set(['link', 'coupon_code']);
// A deliberately WRONG repair the verifier must reject (returns brand, not a price).
let WRONG_PRICE = false;

llm.safeChat = async ({ system, user }) => {
  if (/repair a broken web-scraping list selector/i.test(system)) {
    return { ok: true, text: JSON.stringify({ selectors: [{ value: 'article.vg-card', type: 'css' }], confidence: 'high' }) };
  }
  if (/repair ONE broken field selector/i.test(system)) {
    const m = /name="([^"]+)"/.exec(user);
    const name = m && m[1];
    if (WRONG_PRICE && name === 'price') {
      return { ok: true, text: JSON.stringify({ candidates: [{ selector: 'small.vg-vendor', kind: 'text' }], disappeared: false, confidence: 'medium' }) };
    }
    if (DISAPPEARED.has(name)) {
      return { ok: true, text: JSON.stringify({ candidates: [], disappeared: true, confidence: 'high' }) };
    }
    const rep = FIELD_REPAIR[name];
    if (rep) return { ok: true, text: JSON.stringify({ candidates: [rep], disappeared: false, confidence: 'high' }) };
    return { ok: true, text: JSON.stringify({ candidates: [], disappeared: true, confidence: 'low' }) };
  }
  return { ok: false, error: 'unexpected prompt', code: 'TEST' };
};

const healing = require('../services/healing.service');
const verify = require('../services/healingVerify');

const changedHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'evaluation', 'llm_field_discovery_changed.html'), 'utf8');

// The step as originally authored against the BASE page (now all broken).
function brokenListStep() {
  return {
    id: 'list1', kind: 'action', type: 'EXTRACT_LIST', label: 'products',
    params: {
      containerSelector: '.product-card', selectorType: 'css',
      fields: {
        title:          { selector: '.product-card__title', kind: 'text' },
        brand:          { selector: '.product-card__brand', kind: 'text' },
        price:          { selector: '.product-card__price', kind: 'text' },
        original_price: { selector: '.product-card__original-price', kind: 'text' },
        discount:       { selector: '.product-card__discount', kind: 'text' },
        rating:         { selector: '.product-card__rating', kind: 'text' },
        review_count:   { selector: '.product-card__review-count', kind: 'text' },
        availability:   { selector: '.product-card__availability', kind: 'text' },
        link:           { selector: '.product-card__link', kind: 'attr', attribute: 'href' },
        coupon_code:    { selector: '.product-card__coupon', kind: 'text' },
      },
    },
  };
}

let passed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name}`); process.exitCode = 1; }
}

(async () => {
  try {
    console.log('Self-healing integration (real DOM verification)');

    // ── Scenario A: correct proposals → verified patch, fields remapped,
    //    genuinely-gone fields dropped. ───────────────────────────────────
    WRONG_PRICE = false;
    const verdict = { broken: true, reason: 'no-records', brokenFields: [], count: 0 };
    const outA = await healing.healStep({
      step: brokenListStep(), verdict, snapshotHtml: changedHtml, pageUrl: 'file://changed',
      historySamples: { price: ['$199'], title: ['Old Title'] },
    });

    ok('A: outcome is a patch', outA.outcome === 'patch');
    ok('A: list selector re-pointed to article.vg-card',
       outA.newParams && outA.newParams.containerSelector === 'article.vg-card');
    const f = (outA.newParams && outA.newParams.fields) || {};
    ok('A: title remapped to h3.vg-hl', f.title && f.title.selector === 'h3.vg-hl');
    ok('A: price remapped to em.vg-cur', f.price && f.price.selector === 'em.vg-cur');
    ok('A: availability remapped to .vg-stock', f.availability && f.availability.selector === '.vg-stock');
    ok('A: disappeared "link" dropped', !f.link && outA.droppedFields.includes('link'));
    ok('A: disappeared "coupon_code" dropped', !f.coupon_code && outA.droppedFields.includes('coupon_code'));
    ok('A: kept fields all present', ['title','brand','price','original_price','discount','rating','review_count','availability'].every(n => f[n]));
    ok('A: confidence high (clean verified remap)', outA.confidence === 'high');
    ok('A: evidence records container count > 1', outA.evidence && outA.evidence.container && outA.evidence.container.count >= 2);

    // ── Scenario B: a WRONG price selector (returns brand text) must be
    //    rejected by the deterministic validators → manual, never adopted. ─
    WRONG_PRICE = true;
    const outB = await healing.healStep({
      step: brokenListStep(), verdict, snapshotHtml: changedHtml, pageUrl: 'file://changed',
      historySamples: {},
    });
    ok('B: wrong price selector is NOT silently adopted', outB.outcome === 'manual');
    ok('B: manual reason mentions the field', /price/i.test(outB.explanation || ''));

    await verify.closeVerificationBrowser();
    console.log(`\n${passed} checks passed`);
  } catch (err) {
    console.error('integration test crashed:', err);
    process.exitCode = 1;
    try { await verify.closeVerificationBrowser(); } catch (_) {}
  }
})();
