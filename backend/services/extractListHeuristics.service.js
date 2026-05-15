'use strict';

/* ===========================================================================
   extractListHeuristics
   ---------------------------------------------------------------------------
   Selector-discovery fallback when the LLM is unreachable, returns garbage,
   or finds nothing. Runs inside the live puppeteer page so we work against
   the actual DOM rather than the cleaned HTML snapshot — that means every
   selector we return is guaranteed to resolve in the FIRST container.

   We score candidates by:
     - "shape" signals (anchor / image / heading / time / specific text
       patterns like a price or a date)
     - how many of the surveyed sibling containers also have a matching
       descendant (selectors that hit 1 of 5 are likely too specific)

   Output: { fields: [{ name, selector, kind, attribute, sampleValue,
                        hitCount, surveyed, source: 'heuristic' }], notes }
   Empty fields is possible if the container is opaque (e.g. all-canvas
   widgets); the caller should still surface that to the user.

   Public:
     proposeFromContainer(page, containerSelector, selectorType, opts) → result
   ========================================================================= */

async function proposeFromContainer(page, containerSelector, selectorType = 'css', opts = {}) {
  const { requestId = '?', maxFields = 10, surveyN = 5 } = opts;
  const tag = `[extractListHeuristics ${requestId}]`;

  if (!page || !containerSelector) {
    return { fields: [], notes: ['no page or container selector'] };
  }

  console.log(`${tag} running on container "${containerSelector}" (surveying up to ${surveyN} siblings)`);

  let result;
  try {
    result = await page.evaluate((containerSel, type, surveyN, maxFields) => {
      const isXPath = type === 'xpath' || containerSel.startsWith('/') || containerSel.startsWith('(');
      // ── Resolve containers ────────────────────────────────────────────
      let containers = [];
      try {
        if (isXPath) {
          const r = document.evaluate(containerSel, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let i = 0; i < r.snapshotLength; i++) containers.push(r.snapshotItem(i));
        } else {
          containers = Array.from(document.querySelectorAll(containerSel));
        }
      } catch (e) {
        return { error: 'container selector invalid: ' + e.message };
      }
      if (containers.length === 0) return { error: 'container selector matched nothing' };

      const c0 = containers[0];
      const surveyed = containers.slice(0, surveyN);

      // ── Helpers (must be inline — runs inside the page) ───────────────
      function elTag(el) { return el ? el.tagName.toLowerCase() : ''; }
      function txt(el)   { return el ? (el.textContent || '').trim() : ''; }
      function attr(el, a) { return el ? (el.getAttribute(a) || '') : ''; }

      // Build a STABLE relative CSS selector for `target` against `root`.
      // Walks up the ancestor chain emitting tag + most-stable identifier
      // (data-* attr → role → aria-label → first non-state class → tag).
      // Falls back to nth-of-type when we have to.
      function relativeSelector(root, target) {
        if (!target || !root.contains(target) || target === root) return '';
        const parts = [];
        let cur = target;
        let safety = 8;
        while (cur && cur !== root && safety-- > 0) {
          parts.unshift(stableStep(cur));
          cur = cur.parentElement;
        }
        return parts.join(' > ');
      }
      function stableStep(el) {
        const tag = el.tagName.toLowerCase();
        // data-* attribute is usually the most stable anchor
        for (const a of Array.from(el.attributes || [])) {
          if (/^data-/i.test(a.name) && a.value && a.value.length < 60 && /^[\w.\-]+$/.test(a.value)) {
            return `${tag}[${a.name}="${a.value}"]`;
          }
        }
        const role = el.getAttribute && el.getAttribute('role');
        if (role && /^[\w-]+$/.test(role)) return `${tag}[role="${role}"]`;
        const aria = el.getAttribute && el.getAttribute('aria-label');
        if (aria && aria.length < 60 && /^[\w\s.-]+$/.test(aria)) {
          return `${tag}[aria-label="${aria.replace(/"/g, '\\"')}"]`;
        }
        // Pick the first non-state, non-hashed class
        const cls = Array.from(el.classList || []).filter(c =>
          !/^(is-|has-|active|selected|current|focus|hover|disabled|open)$/i.test(c) &&
          !/css-[a-z0-9]{4,}/i.test(c) &&
          !/__[a-z0-9]{4,}$/i.test(c)
        );
        if (cls.length) return `${tag}.${cls[0]}`;
        // nth-of-type fallback (stable across renders if structure is stable)
        const parent = el.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(s => s.tagName === el.tagName);
          if (siblings.length > 1) {
            const idx = siblings.indexOf(el) + 1;
            return `${tag}:nth-of-type(${idx})`;
          }
        }
        return tag;
      }

      // findInOrSelf — return the first match for `selector` either as the
      // container itself (selector "" for the user's params) or among its
      // descendants. Critical for cases where the container IS the meaningful
      // element (e.g. user multi-selected anchor tags directly).
      function findInOrSelf(root, sel) {
        try {
          if (root.matches && root.matches(sel)) return { el: root, isSelf: true };
          const el = root.querySelector(sel);
          return el ? { el, isSelf: false } : null;
        } catch (_) { return null; }
      }
      function selForMatch(root, m) {
        return m.isSelf ? '' : relativeSelector(root, m.el);
      }

      // ── Detectors ─────────────────────────────────────────────────────
      // Each detector returns 0..N { name, selector, kind, attribute, hint } proposals
      // against c0. We score & dedup later. An empty `selector` means
      // "the container itself" — both our codegen and the verifier handle
      // that case explicitly.

      const proposals = [];

      // 1. Primary heading / title — first h1-h6 inside container OR
      //    container itself if IT is a heading.
      const headingMatch = findInOrSelf(c0, 'h1,h2,h3,h4,h5,h6');
      if (headingMatch) {
        proposals.push({ name: 'title', selector: selForMatch(c0, headingMatch), kind: 'text', why: 'heading element' });
      }

      // 2. Anchor → link URL  (and link text as fallback title)
      const aMatch = findInOrSelf(c0, 'a[href]');
      if (aMatch) {
        const sel = selForMatch(c0, aMatch);
        proposals.push({ name: 'link', selector: sel, kind: 'attr', attribute: 'href', why: 'anchor href' });
        if (!headingMatch && txt(aMatch.el)) {
          // Use the anchor's visible text as a tentative title only when no
          // heading exists — otherwise heading wins.
          proposals.push({ name: 'title', selector: sel, kind: 'text', why: 'anchor visible text' });
        }
      }

      // 3. Image → image URL  +  alt text
      const imgMatch = findInOrSelf(c0, 'img');
      if (imgMatch) {
        const sel = selForMatch(c0, imgMatch);
        const img = imgMatch.el;
        const srcAttr = img.getAttribute('src') ? 'src'
                      : img.getAttribute('data-src') ? 'data-src'
                      : 'src';
        proposals.push({ name: 'image_url', selector: sel, kind: 'attr', attribute: srcAttr, why: 'image src' });
        if (img.getAttribute('alt')) {
          proposals.push({ name: 'image_alt', selector: sel, kind: 'attr', attribute: 'alt', why: 'image alt text' });
        }
      }

      // 4. <time> element → date
      const timeMatch = findInOrSelf(c0, 'time');
      if (timeMatch) {
        const sel = selForMatch(c0, timeMatch);
        if (timeMatch.el.getAttribute('datetime')) {
          proposals.push({ name: 'date', selector: sel, kind: 'attr', attribute: 'datetime', why: 'time[datetime]' });
        } else {
          proposals.push({ name: 'date', selector: sel, kind: 'text', why: '<time> element' });
        }
      }

      // 5. Price — currency-shaped text. Search descendants AND the
      //    container's own (non-empty) text.
      const PRICE_RX = /(?:^|\s)(?:[$€£¥₹₩₽₫₪]|USD|EUR|GBP|JPY|PLN|zł|CZK|CHF|CAD|AUD)\s?\d[\d ,.]{0,12}|^\d[\d ,.]{0,12}\s?(?:[$€£¥₹₩₽₫₪]|USD|EUR|GBP|JPY|PLN|zł|CZK|CHF|CAD|AUD)\b/i;
      let priceMatch = null;
      // Try leaf descendants first
      for (const el of c0.querySelectorAll('*')) {
        if (el.children && el.children.length > 0) continue;
        const t = txt(el);
        if (t && t.length < 40 && PRICE_RX.test(t)) { priceMatch = { el, isSelf: false }; break; }
      }
      // Fall back to checking the container's own immediate text
      if (!priceMatch) {
        const ownText = (c0.childNodes ? Array.from(c0.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent || '').join(' ') : '').trim();
        if (ownText && PRICE_RX.test(ownText)) priceMatch = { el: c0, isSelf: true };
      }
      if (priceMatch) {
        proposals.push({ name: 'price', selector: selForMatch(c0, priceMatch), kind: 'text', why: 'currency-shaped text' });
      }

      // 6. Rating — text like "4.5", "4.5/5", "★ 4.5" near "rating" / "stars" / "review" class
      let ratingMatch = null;
      for (const el of c0.querySelectorAll('[class*="rating"],[class*="stars"],[class*="review"],[aria-label*="rating" i],[aria-label*="stars" i]')) {
        if (el.children && el.children.length > 0) {
          const leaf = Array.from(el.querySelectorAll('*')).find(x => x.children.length === 0 && /\d/.test(txt(x)));
          if (leaf) { ratingMatch = { el: leaf, isSelf: false }; break; }
        }
        if (txt(el) && /\d/.test(txt(el))) { ratingMatch = { el, isSelf: false }; break; }
      }
      if (ratingMatch) {
        proposals.push({ name: 'rating', selector: selForMatch(c0, ratingMatch), kind: 'text', why: 'looks-like-rating element' });
      }

      // 7. Class-hinted text labels (covers the common "<span class='product-code'>...</span>"
      //    or "<div class='card-title'>...</div>" patterns the heading
      //    detector misses). Picks the FIRST leaf descendant whose class
      //    matches a label-shaped keyword, and only if no heading was found.
      const LABEL_RX = /(title|name|label|heading|caption|product|exam|item|article)(?!_url|_link|_id)/i;
      // Each entry: [classRegex, fieldName] in priority order
      const LABEL_HINTS = [
        [/(?:^|[-_ ])(?:title|name|heading|caption)(?:$|[-_ ])/i,   'title'],
        [/(?:^|[-_ ])(?:code|sku)(?:$|[-_ ])/i,                       'code'],
        [/(?:^|[-_ ])(?:price|cost|amount|fee)(?:$|[-_ ])/i,          'price'],
        [/(?:^|[-_ ])(?:date|time|published|posted)(?:$|[-_ ])/i,     'date'],
        [/(?:^|[-_ ])(?:author|by|writer)(?:$|[-_ ])/i,               'author'],
        [/(?:^|[-_ ])(?:desc|description|summary|excerpt)(?:$|[-_ ])/i,'description'],
      ];
      // Walk every classed element looking at the most specific (leaf-first) candidates
      const classedLeaves = Array.from(c0.querySelectorAll('[class]'))
        .filter(el => el.children.length === 0 && (txt(el).length > 0));
      for (const [rx, fieldName] of LABEL_HINTS) {
        // Skip a field we've already proposed
        if (proposals.find(p => p.name === fieldName)) continue;
        const hit = classedLeaves.find(el => {
          const cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';
          return rx.test(cls);
        });
        if (hit) {
          proposals.push({ name: fieldName, selector: relativeSelector(c0, hit), kind: 'text', why: `class hints "${fieldName}"` });
        }
      }

      // 8. Container text — when nothing else has produced a title yet
      //    AND the container has visible inline text (e.g. user picked
      //    a list of <a> elements and there's no heading or label inside),
      //    expose the container's own textContent as "text".
      if (!proposals.find(p => p.name === 'title' || p.name === 'name')) {
        const ownText = txt(c0);
        if (ownText && ownText.length > 0 && ownText.length < 400) {
          // Avoid duplicating the anchor-text proposal we already added at (2)
          if (!proposals.find(p => p.name === 'title')) {
            proposals.push({ name: 'text', selector: '', kind: 'text', why: 'container text content' });
          }
        }
      }

      // 9. Generic id from data-* on the container itself (often product id)
      for (const a of Array.from(c0.attributes || [])) {
        if (/^data-/i.test(a.name) && /^(id|sku|product|item|key|exam)/i.test(a.name.replace(/^data-/i, '')) && a.value && a.value.length < 80) {
          proposals.push({
            name: a.name.replace(/^data-/i, '').replace(/[^a-z0-9]+/gi, '_').toLowerCase() || 'item_id',
            selector: '',                  // empty selector means "the container itself"
            kind: 'attr',
            attribute: a.name,
            why: 'container ' + a.name,
          });
          break;
        }
      }

      // ── Score / filter / dedupe ──────────────────────────────────────
      function survey(selector) {
        let hit = 0;
        for (const c of surveyed) {
          try {
            const t = selector ? c.querySelector(selector) : c;
            if (t) hit++;
          } catch (_) {}
        }
        return hit;
      }
      function sampleOf(p) {
        try {
          const t = p.selector ? c0.querySelector(p.selector) : c0;
          if (!t) return null;
          if (p.kind === 'attr' && p.attribute) return t.getAttribute(p.attribute);
          if (p.kind === 'html') return (t.innerHTML || '').slice(0, 400);
          return (t.textContent || '').trim().slice(0, 400);
        } catch (_) { return null; }
      }

      const seenNames = new Set();
      const seenSelectors = new Set();
      const finalFields = [];
      // Sort: prefer fields with valid samples, and prefer those that hit
      // many surveyed siblings. We don't bother with a full score function
      // because the detector order above already encodes priority.
      for (const p of proposals) {
        if (!p.selector && !p.attribute) continue;
        if (seenNames.has(p.name)) continue;
        const key = p.kind + '|' + p.selector + '|' + (p.attribute || '');
        if (seenSelectors.has(key)) continue;
        const sample = sampleOf(p);
        if (sample == null || sample === '') continue;
        const hitCount = survey(p.selector);
        if (hitCount === 0) continue; // didn't even match in c0; drop
        finalFields.push({
          name: p.name,
          selector: p.selector,
          kind: p.kind,
          attribute: p.attribute || null,
          sampleValue: sample,
          hitCount,
          surveyed: surveyed.length,
          source: 'heuristic',
          why: p.why,
        });
        seenNames.add(p.name);
        seenSelectors.add(key);
        if (finalFields.length >= maxFields) break;
      }

      return { fields: finalFields, totalMatched: containers.length };
    }, containerSelector, selectorType, surveyN, maxFields);
  } catch (err) {
    console.warn(`${tag} page.evaluate threw: ${err.message}`);
    return { fields: [], notes: [`page evaluate failed: ${err.message}`] };
  }

  if (result && result.error) {
    console.warn(`${tag} ${result.error}`);
    return { fields: [], notes: [result.error] };
  }

  const fields = (result && result.fields) || [];
  console.log(`${tag} produced ${fields.length} field(s): ${fields.map(f => `${f.name}=${f.kind === 'attr' ? '@' + f.attribute : f.kind}`).join(', ')}`);
  return { fields, totalMatched: result?.totalMatched ?? 0, notes: [] };
}

module.exports = { proposeFromContainer };
