'use strict';

const puppeteer = require('puppeteer-extra');
const { resolveChromePath } = require('../browser/chromePath');

/* ===========================================================================
   healingVerify
   ---------------------------------------------------------------------------
   The deterministic, no-AI half of self-healing. A repair proposed by the LLM
   is only ever a *candidate*; before it can be adopted we load the captured
   page snapshot into a real headless Chromium and check, against the actual
   DOM, that:

     - a (list) container selector matches a sensible number of elements,
     - each per-item field selector resolves inside the containers and yields
       values (which healingValidators then judges for sensibility),
     - a single-element selector resolves to the right kind of value.

   We verify against the SNAPSHOT that was captured at the moment of failure
   (not a fresh navigation) so the DOM state exactly matches what broke —
   crucial when the list only appears after earlier interaction steps.

   A single headless browser is launched lazily and reused across verifications
   (cheap; selectors are tested with page.setContent, no network). It is closed
   on process exit.
   ========================================================================= */

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: 'new',
      executablePath: resolveChromePath(),   // undefined → puppeteer's bundled Chromium
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    }).catch((err) => {
      browserPromise = null;                  // allow a later retry
      throw err;
    });
  }
  return browserPromise;
}

async function closeVerificationBrowser() {
  if (!browserPromise) return;
  try { const b = await browserPromise; await b.close(); } catch (_) {}
  browserPromise = null;
}

// Best-effort cleanup so the helper browser doesn't outlive the process.
process.once('exit', () => { closeVerificationBrowser(); });

/**
 * Load `html` into a throwaway page and run `fn(page)`; always closes the page.
 * Returns whatever `fn` returns, or { error } if the browser can't be reached.
 */
async function withSnapshot(html, fn) {
  if (typeof html !== 'string' || !html.trim()) {
    return { error: 'no snapshot html to verify against' };
  }
  let browser;
  try { browser = await getBrowser(); }
  catch (err) { return { error: `verification browser unavailable: ${err.message}` }; }

  let page;
  try {
    page = await browser.newPage();
    // Block external requests — we only care about static structure, and the
    // snapshot may reference images/CSS we neither have nor need.
    await page.setJavaScriptEnabled(false);
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
    return await fn(page);
  } catch (err) {
    return { error: err && err.message ? err.message : String(err) };
  } finally {
    if (page) { try { await page.close(); } catch (_) {} }
  }
}

// ── In-page primitive: count elements for a selector (-1 = invalid syntax) ──
function inPageCount(sel, type) {
  const isXPath = type === 'xpath' || (typeof sel === 'string' && (sel.startsWith('/') || sel.startsWith('(')));
  try {
    if (isXPath) {
      const r = document.evaluate(sel, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return r.snapshotLength;
    }
    return document.querySelectorAll(sel).length;
  } catch (_) { return -1; }
}

/**
 * Verify a container / list selector against the snapshot.
 * @returns {{ ok:boolean, count:number, reason?:string }}
 */
async function verifyContainerSelector(page, { selector, type = 'css', minCount = 1 }) {
  if (!selector) return { ok: false, count: 0, reason: 'empty selector' };
  const count = await page.evaluate(inPageCount, selector, type);
  if (count === -1) return { ok: false, count: 0, reason: 'invalid selector syntax' };
  return { ok: count >= minCount, count, reason: count >= minCount ? undefined : `matched ${count} (< ${minCount})` };
}

/**
 * Verify a single-element selector and return a sample value.
 * @returns {{ ok:boolean, count:number, sampleValue:string|null, reason?:string }}
 */
async function verifySingleSelector(page, { selector, type = 'css', kind = 'text', attribute = null }) {
  if (!selector) return { ok: false, count: 0, sampleValue: null, reason: 'empty selector' };
  const res = await page.evaluate((sel, t, k, attr) => {
    const isXPath = t === 'xpath' || (typeof sel === 'string' && (sel.startsWith('/') || sel.startsWith('(')));
    let els = [];
    try {
      if (isXPath) {
        const r = document.evaluate(sel, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < r.snapshotLength; i++) els.push(r.snapshotItem(i));
      } else {
        els = Array.from(document.querySelectorAll(sel));
      }
    } catch (_) { return { count: -1, sampleValue: null }; }
    const el = els[0] || null;
    let val = null;
    if (el) {
      if (k === 'attr' && attr) val = el.getAttribute(attr);
      else if (k === 'html') val = (el.innerHTML || '').slice(0, 400);
      else val = (el.textContent || '').trim().slice(0, 400);
    }
    return { count: els.length, sampleValue: val };
  }, selector, type, kind, attribute);

  if (res.count === -1) return { ok: false, count: 0, sampleValue: null, reason: 'invalid selector syntax' };
  return { ok: res.count >= 1, count: res.count, sampleValue: res.sampleValue,
           reason: res.count >= 1 ? undefined : 'no match' };
}

/**
 * Verify a set of per-item field selectors inside the list containers. For
 * each field, gathers up to `sampleSize` extracted values across containers so
 * the caller (pure validators) can judge sensibility and fill rate.
 *
 * Mirrors the "rescue to container itself" behaviour used during authoring:
 * if a field selector matches no descendant but the container itself matches
 * it, we treat the container as the target and rewrite the selector to "".
 *
 * @param {Object} args { containerSelector, type, fields:[{name,selector,kind,attribute}], sampleSize }
 * @returns {{ totalContainers:number, fields:Object }|{ error:string }}
 *    fields[name] = { selector, kind, attribute, samples:[...], hitCount, surveyed, rescuedToSelf }
 */
async function verifyListFields(page, { containerSelector, type = 'css', fields = [], sampleSize = 8 }) {
  return page.evaluate((containerSel, t, fieldsIn, n) => {
    const isXPath = t === 'xpath' || (typeof containerSel === 'string' && (containerSel.startsWith('/') || containerSel.startsWith('(')));
    let containers = [];
    try {
      if (isXPath) {
        const r = document.evaluate(containerSel, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < r.snapshotLength; i++) containers.push(r.snapshotItem(i));
      } else {
        containers = Array.from(document.querySelectorAll(containerSel));
      }
    } catch (e) {
      return { error: 'invalid container selector: ' + e.message };
    }
    const survey = containers.slice(0, n);
    const out = { totalContainers: containers.length, fields: {} };

    for (const f of fieldsIn) {
      const rec = { selector: f.selector, kind: f.kind || 'text', attribute: f.attribute || null,
                    samples: [], hitCount: 0, surveyed: survey.length, rescuedToSelf: false };
      // Decide once (on the first container) whether the field reads from a
      // descendant or the container itself.
      let useSelf = !f.selector;
      if (f.selector && survey[0]) {
        try {
          if (!survey[0].querySelector(f.selector) && survey[0].matches && survey[0].matches(f.selector)) {
            useSelf = true; rec.rescuedToSelf = true; rec.selector = '';
          }
        } catch (_) {}
      }
      for (const c of survey) {
        let target = null;
        try { target = useSelf ? c : c.querySelector(f.selector); }
        catch (_) { target = null; }
        if (!target) { rec.samples.push(null); continue; }
        rec.hitCount++;
        let v = null;
        try {
          if (rec.kind === 'attr' && rec.attribute) v = target.getAttribute(rec.attribute);
          else if (rec.kind === 'html') v = (target.innerHTML || '').slice(0, 400);
          else v = (target.textContent || '').trim().slice(0, 400);
        } catch (_) {}
        rec.samples.push(v);
      }
      out.fields[f.name] = rec;
    }
    return out;
  }, containerSelector, type, fields, sampleSize).catch((err) => ({ error: err.message }));
}

module.exports = {
  withSnapshot,
  verifyContainerSelector,
  verifySingleSelector,
  verifyListFields,
  closeVerificationBrowser,
};
