'use strict';

/* ===========================================================================
   httpExtract
   ---------------------------------------------------------------------------
   Scrape a detail page with a plain HTTP request and an HTML parser, no Chrome.

   A huge share of detail-page scraping is a pure DOM read: open a URL, pull
   some CSS selectors out of the markup, move on. Nothing about that needs a
   browser — but until now every one of those pages launched a tab, executed
   the site's JavaScript, and waited for its subresources. On a job that walks
   thousands of product pages that is the dominant cost.

   Fetching the HTML and parsing it with cheerio is roughly an order of
   magnitude faster and uses a small fraction of the memory, which is what
   actually lifts the concurrency ceiling: tabs cost ~50-80MB each, so ~8 is a
   sensible cap, while parsed documents cost kilobytes and dozens are fine.

   The obvious risk is that the site turns out to be JavaScript-rendered, in
   which case the HTML holds none of the data and the run would quietly
   collect nothing. So this is never assumed — it is PROVEN, per run, on the
   first item: scrape it both ways, compare field-by-field, and only switch if
   they agree. Same "verify, don't guess" shape apiReplay.service.js already
   uses for API endpoints. If they disagree, the run silently uses the browser
   and is no worse off than before.

   Eligibility is decided at codegen time (httpEligibleSteps below) and is
   deliberately narrow: only pure CSS extraction. Anything that clicks,
   scrolls, types, waits, or uses XPath falls back to the browser, because
   cheerio has no layout, no events and no XPath.
   ========================================================================= */

// Extraction types this runtime can reproduce faithfully against static HTML.
const HTTP_EXTRACTABLE = new Set([
  'EXTRACT_TEXT', 'EXTRACT_ATTRIBUTE', 'EXTRACT_HTML', 'EXTRACT_LIST', 'EXTRACT_TABLE',
]);

// A selector cheerio can't handle. Mirrors the runtime's __isX check: leading
// '/', './' or '(' marks an XPath, which css-select cannot evaluate.
function isXPathish(sel) {
  if (typeof sel !== 'string') return false;
  const s = sel.replace(/^\s+/, '');
  return s[0] === '/' || s[0] === '(' || (s[0] === '.' && s[1] === '/');
}

function selectorsOf(step) {
  const p = step.params || {};
  const out = [];
  const push = (v) => { if (typeof v === 'string' && v.trim()) out.push(v); };
  push(p.selector);
  push(p.containerSelector);
  for (const f of (p.fallbackSelectors || [])) push(typeof f === 'string' ? f : (f && f.value));
  for (const v of Object.values(p.fields || {})) {
    push(typeof v === 'string' ? v : (v && v.selector));
  }
  return out;
}

/**
 * Can this list of steps run entirely over fetched HTML?
 *
 * Conservative by construction: every step must be a CSS-only extraction. One
 * unsupported step disqualifies the whole body, because a partial switch would
 * mean two different execution models over one page.
 *
 * @returns {{ eligible: boolean, reason?: string }}
 */
function httpEligibleSteps(steps) {
  const list = Array.isArray(steps) ? steps : [];
  if (list.length === 0) return { eligible: false, reason: 'no steps' };

  for (const s of list) {
    if (!s || !s.type) continue;
    if (s.kind === 'control' || Array.isArray(s.body)) {
      return { eligible: false, reason: `control flow (${s.type}) needs a browser` };
    }
    if (!HTTP_EXTRACTABLE.has(s.type)) {
      return { eligible: false, reason: `${s.type} needs a browser` };
    }
    if ((s.params || {}).selectorType === 'xpath') {
      return { eligible: false, reason: 'XPath selectors need a browser' };
    }
    for (const sel of selectorsOf(s)) {
      if (isXPathish(sel)) return { eligible: false, reason: 'XPath selectors need a browser' };
    }
  }
  return { eligible: true };
}

/**
 * Runtime inlined into generated scripts. Defines the fetch + cheerio
 * equivalents of the puppeteer extraction helpers, plus the comparison used to
 * decide whether HTTP mode is trustworthy for this site.
 *
 * Kept semantically identical to the browser path on purpose — same selector
 * cascade (first selector that matches wins), same trimming, same "missing
 * element yields null rather than an error". If the two ever diverged, the
 * verification step would be comparing two different definitions of correct.
 */
function buildCodegenHttpExtractHelper({ timeoutMs = 30000, userAgent = null, instrument = false } = {}) {
  // Metering for the no-browser path. `__hxMeter` is declared here rather than
  // reusing the pool helper's `__pagesFetched` directly because this helper is
  // inlined BEFORE the pool helper in the generated script, and a `let` from a
  // later block is in its temporal dead zone until then — `typeof` on it would
  // throw rather than return 'undefined'. Assigning through a function called
  // only at run time sidesteps the ordering entirely.
  const meter = instrument
    ? `    try { __pagesFetched++; console.log('PAGES_FETCHED:' + JSON.stringify({ pages: __pagesFetched })); } catch (_) {}\n`
    : '';
  return `
// ─── HTTP-first extraction (see backend/workflow/httpExtract.js) ───────────
const __cheerio = require('cheerio');
const __httpFetch = (typeof fetch === 'function') ? fetch : require('node-fetch');
const __HTTP_TIMEOUT_MS = ${Number(timeoutMs) || 30000};
${userAgent ? `const __HTTP_UA = ${JSON.stringify(userAgent)};` : 'const __HTTP_UA = null;'}

// Fetch a page's HTML. Returns null on any failure — the caller falls back to
// the browser rather than treating a fetch problem as "no data".
async function __hxFetch(url, cookieHeader) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), __HTTP_TIMEOUT_MS);
  try {
    const headers = { 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' };
    if (__HTTP_UA) headers['User-Agent'] = __HTTP_UA;
    if (cookieHeader) headers['Cookie'] = cookieHeader;
    const res = await __httpFetch(String(url), { headers, redirect: 'follow', signal: ctl.signal });
    if (!res.ok) return null;
    const ct = String(res.headers.get('content-type') || '');
    if (ct && !/html|xml|text\\/plain/i.test(ct)) return null;
    // Counted only on success. A failed fetch returns null and the caller
    // retries the item in the browser, where __meterPage counts the
    // navigation — metering both would bill the same page twice.
${meter}    return await res.text();
  } catch (_) {
    return null;
  } finally { clearTimeout(timer); }
}

function __hxLoad(html) { return __cheerio.load(html); }

// Selector cascade: first selector that matches anything wins — the static
// twin of resolveElement / resolveElements.
function __hxOne($, selectors) {
  for (const s of selectors) {
    if (!s || s.type === 'xpath' || !s.value) continue;
    try { const el = $(s.value).first(); if (el.length) return el; } catch (_) {}
  }
  return null;
}
function __hxAll($, selectors) {
  for (const s of selectors) {
    if (!s || s.type === 'xpath' || !s.value) continue;
    try { const els = $(s.value); if (els.length) return els.toArray().map(e => $(e)); } catch (_) {}
  }
  return [];
}

function __hxText($, selectors, multiple) {
  if (multiple) return __hxAll($, selectors).map(el => (el.text() || '').trim());
  const el = __hxOne($, selectors);
  return el ? (el.text() || '').trim() : null;
}
function __hxAttr($, selectors, attr, multiple) {
  if (multiple) return __hxAll($, selectors).map(el => el.attr(attr) ?? null);
  const el = __hxOne($, selectors);
  return el ? (el.attr(attr) ?? null) : null;
}
function __hxHtml($, selectors, outer) {
  const el = __hxOne($, selectors);
  if (!el) return null;
  return outer ? ($.html(el) || null) : (el.html() || null);
}

// Row extraction. Mirrors the in-page version, including "an empty field
// selector means the container element itself".
function __hxList($, selectors, fields) {
  return __hxAll($, selectors).map(container => {
    const item = {};
    for (const [name, spec] of Object.entries(fields)) {
      const sel = spec.selector || '';
      let child;
      if (!sel) child = container;
      else { try { const f = container.find(sel).first(); child = f.length ? f : null; } catch (_) { child = null; } }
      if (!child) { item[name] = null; continue; }
      if (spec.kind === 'attr' && spec.attribute) item[name] = child.attr(spec.attribute) ?? null;
      else if (spec.kind === 'html') item[name] = (child.html() || '').trim();
      else item[name] = (child.text() || '').trim();
    }
    return item;
  });
}

function __hxTable($, selectors, hasHeader) {
  const tbl = __hxOne($, selectors);
  if (!tbl) return null;
  const rows = tbl.find('tr').toArray().map(r => $(r));
  const cells = (row, sel) => row.find(sel).toArray().map(c => ($(c).text() || '').trim());
  if (hasHeader && rows.length > 0) {
    const headers = cells(rows[0], 'th,td');
    return rows.slice(1).map(row => {
      const vals = cells(row, 'td,th');
      return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? null]));
    });
  }
  return rows.map(r => cells(r, 'td,th'));
}

/* Do the HTTP and browser results agree?

   Whitespace is normalised (the two paths can differ in incidental spacing
   without differing in content) but nothing else is: any real difference means
   the page needs JavaScript, and the browser must be used. Deliberately strict
   — a false "yes" here would silently corrupt the entire run, while a false
   "no" only costs the speed-up. */
function __hxNorm(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map(__hxNorm);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) { if (k !== '_sourceUrl') out[k] = __hxNorm(v[k]); }
    return out;
  }
  if (typeof v === 'string') return v.replace(/\\s+/g, ' ').trim();
  return v;
}

function __hxSameResult(a, b) {
  try {
    const na = __hxNorm(a), nb = __hxNorm(b);
    // An empty result on both sides proves nothing about whether the HTML
    // carries the data, so refuse to conclude "HTTP works" from it.
    const empty = (o) => !o || Object.keys(o).length === 0 ||
      Object.values(o).every(v => v == null || (Array.isArray(v) && v.length === 0) || v === '');
    if (empty(nb)) return false;
    return JSON.stringify(na) === JSON.stringify(nb);
  } catch (_) { return false; }
}

/* Decide once per loop whether this site can be scraped over HTTP, then route
   every item accordingly.

   The decision is made by the FIRST item to arrive and shared through a gate
   promise, so with N workers running concurrently only one probe happens and
   the rest wait for its verdict rather than each verifying independently.

   The probe deliberately returns the BROWSER result: it is the reference the
   HTTP result was checked against, so it is the one known to be right. */
async function __hxDispatch(state, url, httpRun, browserRun) {
  if (!httpRun) return browserRun();

  if (state.mode === 'undecided') {
    if (!state.gate) {
      state.gate = (async () => {
        const viaBrowser = await browserRun();
        const viaHttp = await httpRun().catch(() => null);
        const same = viaHttp != null && __hxSameResult(viaHttp, viaBrowser);
        state.mode = same ? 'http' : 'browser';
        console.log(same
          ? '⚡ Verified against the browser on the first page — fetching the rest directly, no browser needed.'
          : '• This page needs a browser to render its data — using the browser for the whole list.');
        return { url: url, result: viaBrowser };
      })();
    }
    const decided = await state.gate;
    if (decided.url === url) return decided.result;   // this caller WAS the probe
  }

  if (state.mode === 'http') {
    const r = await httpRun().catch(() => null);
    if (r) return r;
    // One failed fetch is not evidence the mode is wrong (a timeout, a 503).
    // Retry just this item in the browser and keep HTTP for the rest.
  }
  return browserRun();
}
`;
}

module.exports = {
  buildCodegenHttpExtractHelper,
  httpEligibleSteps,
  isXPathish,
  HTTP_EXTRACTABLE,
};
