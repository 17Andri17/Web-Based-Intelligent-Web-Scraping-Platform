'use strict';

/* ===========================================================================
   selectorDebug
   ---------------------------------------------------------------------------
   The brains of the "why does this selector match 0 elements?" panel, split so
   the logic is unit-testable without a browser:

     • cssRelaxations(selector) — generate progressively looser variants of a
       CSS selector (drop pseudo-classes, then attribute filters, then trailing
       compounds, then individual tokens). The socket handler evaluates each
       against the live page; the one(s) that DO match pinpoint which part of
       the user's selector is wrong.

     • buildDiagnosis(raw) — turn the raw counts gathered in the page (total /
       visible / per-relaxation / iframe) into a plain-language verdict plus
       concrete suggestions.

   Both are pure. The thin in-page count-gathering lives in server.js's
   `debugSelector` handler.
   ========================================================================= */

// Split a CSS selector into combinator-separated compounds, e.g.
// "div.card > a.link" → ["div.card", "a.link"] (combinators dropped).
function compounds(selector) {
  return String(selector)
    .split(/\s*[>+~]\s*|\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

// The simple tokens of one compound: tags, #ids, .classes, [attrs].
function simpleTokens(compound) {
  const out = [];
  const re = /\[[^\]]*\]|::?[\w-]+(?:\([^)]*\))?|[.#][\w-]+|\*|[\w-]+/g;
  let m;
  while ((m = re.exec(compound)) !== null) out.push(m[0]);
  return out;
}

function stripPseudos(selector) {
  // Remove :pseudo and ::pseudo (with optional (...) arg), but not inside [...].
  return String(selector).replace(/::?[\w-]+(?:\([^)]*\))?/g, '').replace(/\s{2,}/g, ' ').trim();
}

function stripAttrs(selector) {
  return String(selector).replace(/\[[^\]]*\]/g, '').replace(/\s{2,}/g, ' ').trim();
}

// Ordered, de-duped list of looser selectors to try (most specific first),
// never including the exact original. Bounded so we don't hammer the page.
function cssRelaxations(selector, { max = 12 } = {}) {
  const original = String(selector || '').trim();
  if (!original) return [];
  const out = [];
  const seen = new Set([original]);
  const push = (s) => {
    const v = (s || '').trim();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  };

  // 1. Drop pseudo-classes, then also attribute filters.
  const noPseudo = stripPseudos(original);
  push(noPseudo);
  push(stripAttrs(noPseudo));

  // 2. Drop trailing compounds: "A B C" → "A B" → "A".
  const comps = compounds(noPseudo);
  for (let k = comps.length - 1; k >= 1; k--) push(comps.slice(0, k).join(' '));

  // 3. Each compound on its own (helps when a middle/ancestor compound is the culprit).
  for (const c of comps) push(c);

  // 4. Each individual token (class / id / tag / attr) on its own — the finest
  //    grain, so we can say exactly which class doesn't exist.
  for (const c of comps) {
    for (const t of simpleTokens(c)) {
      if (t === '*') continue;
      push(t);
    }
  }

  return out.slice(0, max);
}

// Synthesize a verdict + messages + suggestions from the raw page counts.
//   raw = {
//     selector, selectorType,               // 'css' | 'xpath'
//     matchCount, visibleCount, samples,     // for the full selector
//     relaxations: [{ selector, count }],    // looser variants + their counts
//     iframeMatches,                         // count found inside iframes
//   }
function buildDiagnosis(raw) {
  const r = raw || {};
  const total = r.matchCount || 0;
  const visible = r.visibleCount || 0;
  const messages = [];
  const suggestions = [];
  let verdict;

  if (total > 0) {
    if (visible === 0) {
      verdict = 'hidden';
      messages.push(`Matches ${plural(total, 'element')}, but none are currently visible (off-screen, collapsed, or display:none).`);
      messages.push('It may need a scroll or hover first, or it loads later — add a Wait / Scroll step before using it.');
    } else {
      verdict = 'ok';
      messages.push(`✓ Matches ${plural(total, 'element')}${visible < total ? ` (${visible} visible)` : ''}.`);
    }
    return { verdict, messages, suggestions, matchCount: total, visibleCount: visible, samples: r.samples || [] };
  }

  // 0 matches.
  if ((r.iframeMatches || 0) > 0) {
    verdict = 'iframe';
    messages.push(`Nothing matches in the main page, but ${plural(r.iframeMatches, 'element')} match inside an iframe.`);
    messages.push('The element lives in a frame — the scraper needs to target that frame, not the top page.');
    return { verdict, messages, suggestions, matchCount: 0, visibleCount: 0, samples: [] };
  }

  const hits = (r.relaxations || []).filter(x => x && x.count > 0);
  if (r.selectorType === 'xpath') {
    verdict = 'none';
    messages.push('This XPath matches nothing on the current page.');
    messages.push('Check for a typo, or re-pick the element on the page. (Automatic part-by-part diagnosis is available for CSS selectors.)');
    return { verdict, messages, suggestions, matchCount: 0, visibleCount: 0, samples: [] };
  }

  if (hits.length === 0) {
    verdict = 'none';
    messages.push('Nothing on this page matches even the simplest part of this selector.');
    messages.push('The page probably changed, or you are on a different page than when it was built. Re-pick the element on the page.');
    return { verdict, messages, suggestions, matchCount: 0, visibleCount: 0, samples: [] };
  }

  // Partial: the full selector fails but looser parts match — name the culprit.
  verdict = 'partial';
  const best = hits[0]; // relaxations are most-specific-first
  messages.push(`The full selector matches nothing, but part of it does: \`${best.selector}\` matches ${plural(best.count, 'element')}.`);
  messages.push('The rest of your selector is too specific or wrong for this page — narrow down from the working part above.');
  for (const h of hits.slice(0, 4)) suggestions.push({ selector: h.selector, count: h.count });
  return { verdict, messages, suggestions, matchCount: 0, visibleCount: 0, samples: [] };
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

module.exports = { cssRelaxations, buildDiagnosis, compounds, simpleTokens, stripPseudos, stripAttrs };
