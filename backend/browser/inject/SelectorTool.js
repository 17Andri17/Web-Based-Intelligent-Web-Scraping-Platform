(function enableSelectionMode() {
  // ── State machine ─────────────────────────────────────────────────────────
  // 'idle'           – nothing selected
  // 'first_selected' – seed green, similar group amber (selector-driven)
  // 'multi_selected' – group confirmed, all green
  // ─────────────────────────────────────────────────────────────────────────

  let selState     = 'idle';
  let currentEl    = null;   // seed element
  let softEls      = [];     // amber — from querySelectorAll(softSelector)
  let hardEls      = [];     // green — confirmed
  let softSelector = null;   // CSS selector that produced softEls
  let softStrategy = null;   // description of how the group was found
  let hoverEl      = null;
  let tooltip      = null;
  const originalStyles = new Map();

  const SOFT_OUTLINE  = '2px dashed #d29922';
  const HARD_OUTLINE  = '2px solid #3fb950';
  const HOVER_OUTLINE = '2px solid #58a6ff';

  // ── Style helpers ─────────────────────────────────────────────────────────

  function storeOriginalStyle(el, prop) {
    if (!originalStyles.has(el)) originalStyles.set(el, {});
    const s = originalStyles.get(el);
    if (!(prop in s)) s[prop] = el.style[prop] || '';
  }
  function setStyle(el, prop, value, important = false) {
    storeOriginalStyle(el, prop);
    if (important) el.style.setProperty(prop, value, 'important');
    else el.style[prop] = value;
  }
  function restoreStyle(el, prop) {
    const s = originalStyles.get(el);
    if (!s || !(prop in s)) return;
    const v = s[prop];
    if (v === '') el.style.removeProperty(prop); else el.style[prop] = v;
    delete s[prop];
    if (!Object.keys(s).length) originalStyles.delete(el);
  }
  function clearArr(arr) {
    arr.forEach(el => { restoreStyle(el, 'outline'); restoreStyle(el, 'box-shadow'); });
    arr.length = 0;
  }
  function applySoft(els) {
    clearArr(softEls);
    els.forEach(el => { softEls.push(el); setStyle(el, 'outline', SOFT_OUTLINE, true); setStyle(el, 'box-shadow', 'inset 0 0 0 9999px rgba(210,153,34,0.07)', true); });
  }
  function applyHard(els) {
    clearArr(hardEls);
    els.forEach(el => { hardEls.push(el); setStyle(el, 'outline', HARD_OUTLINE, true); setStyle(el, 'box-shadow', 'inset 0 0 0 9999px rgba(63,185,80,0.06)', true); });
  }

  function fullReset() {
    clearArr(softEls); clearArr(hardEls);
    if (hoverEl && !softEls.includes(hoverEl) && !hardEls.includes(hoverEl)) restoreStyle(hoverEl, 'outline');
    hoverEl = null; currentEl = null; softSelector = null; softStrategy = null; selState = 'idle';
  }

  function cleanupSelectionMode() {
    fullReset();
    for (const [el, s] of originalStyles) {
      for (const prop in s) { const v = s[prop]; if (v === '') el.style.removeProperty(prop); else el.style[prop] = v; }
    }
    originalStyles.clear();
    if (tooltip) tooltip.style.display = 'none';
  }

  // ── Tooltip ───────────────────────────────────────────────────────────────

  function createTooltip() {
    tooltip = document.createElement('div');
    tooltip.style.cssText = 'all:initial;position:fixed;background:rgba(13,17,23,0.92);color:#58a6ff;padding:5px 10px;font-size:11px;font-family:ui-monospace,monospace;border-radius:5px;border:1px solid #30363d;pointer-events:none;z-index:2147483647;display:none;box-shadow:0 2px 8px rgba(0,0,0,0.5);max-width:400px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    document.body.appendChild(tooltip);
  }
  function placeTooltip(e) {
    const vw = window.innerWidth, vh = window.innerHeight, m = 14;
    const r = tooltip.getBoundingClientRect();
    let left = e.clientX + m, top = e.clientY + m;
    if (left + r.width > vw - m) left = e.clientX - r.width - m;
    if (top + r.height > vh - m) top = e.clientY - r.height - m;
    tooltip.style.left = Math.max(m, left) + 'px';
    tooltip.style.top  = Math.max(m, top)  + 'px';
  }
  function getElPath(el, depth = 4) {
    const parts = []; let cur = el, n = 0;
    while (cur && cur.tagName && cur.tagName.toLowerCase() !== 'html') {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) seg += '#' + cur.id;
      else if (cur.classList.length) seg += '.' + [...cur.classList].slice(0, 2).join('.');
      parts.unshift(seg); cur = cur.parentElement;
      if (++n >= depth) { parts.unshift('...'); break; }
    }
    return parts.join(' > ');
  }

  // ── CSS selector primitives ───────────────────────────────────────────────

  function esc(id) { return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(id) : id.replace(/[^\w-]/g, '\\$&'); }
  function buildSimpleSelector(el) {
    if (el.id) return '#' + esc(el.id);
    const tag = el.tagName.toLowerCase();
    const cls = stableClasses(el);
    return cls.length ? tag + '.' + cls[0] : tag;
  }

  /** Classes that are stable identifiers (not state/utility) */
  function stableClasses(el) {
    return [...el.classList].filter(c => c.length > 1 && !/^(is-|has-|js-|active|open|hover|focus|selected|disabled|show|hide|visible|hidden|loading)/.test(c));
  }


  /** Build a child/descendant CSS selector for a group of elements that share a parent.
   *  Tries exact pattern match walking all ancestors up to <body>.
   *  Returns a selector only if it matches EXACTLY the given els. */
  function buildGroupSelector(els, parent) {
    const { childTag, common } = buildChildPattern(els);

    let cur = parent;
    while (cur && !isRoot(cur)) {
      const anchors = buildAllAnchorsFor(cur);
      for (const anchor of anchors) {
        const result = tryPatternWithScope(anchor, els, childTag, common);
        if (result) return result;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function isRoot(el) {
    return !el || el === document.documentElement || el === document.body;
  }

  /**
   * Build the child pattern (tag + common classes) for a set of elements.
   * Returns { childTag, common, childSel }
   */
  function buildChildPattern(els) {
    const tag = els[0].tagName.toLowerCase();
    const allSameTag = els.every(e => e.tagName.toLowerCase() === tag);
    const childTag = allSameTag ? tag : '*';
    const classSets = els.map(e => new Set(stableClasses(e)));
    const common = classSets.length
      ? [...classSets[0]].filter(c => classSets.every(s => s.has(c)))
      : [];
    const clsPart = common.length ? '.' + common[0] : '';
    return { childTag, common, childSel: childTag + clsPart };
  }

  /**
   * Try selectors of the form `${scopeSel} [>| ] ${childPattern}` for all class
   * combinations on childPattern. Returns the first selector that matches EXACTLY `els`.
   */
  function tryPatternWithScope(scopeSel, els, childTag, common) {
    for (let n = Math.min(common.length, 3); n >= 0; n--) {
      const cls = n > 0 ? '.' + common.slice(0, n).join('.') : '';
      const child = `${childTag}${cls}`;
      for (const comb of ['>', ' ']) {
        const sel = `${scopeSel} ${comb} ${child}`.trim();
        try {
          const matched = [...document.querySelectorAll(sel)];
          if (setsEqual(matched, els)) return sel;
        } catch (_) {}
      }
    }
    return null;
  }

  /**
   * Walk every ancestor of `startEl` up to <body>, returning them in order
   * from closest to farthest.
   */
  function ancestorChain(startEl) {
    const chain = [];
    let cur = startEl?.parentElement;
    while (cur && !isRoot(cur)) { chain.push(cur); cur = cur.parentElement; }
    return chain;
  }


  /**
   * Generate every useful anchor selector string for a single element.
   * Returns an array ordered most-specific → least-specific.
   * Crucially: includes nth-child-scoped variants so non-unique class anchors
   * get disambiguated (e.g. `div.item` × 3 becomes `div.item:nth-child(2)`).
   */
  function buildAllAnchorsFor(el, _depth) {
    const depth = _depth || 0;
    if (depth > 5 || !el || isRoot(el)) return [];
    const anchors = [];

    // 1. ID — globally unique, always sufficient
    if (el.id) {
      anchors.push('#' + esc(el.id));
      return anchors;
    }

    // 2. Test-id attributes
    for (const attr of ['data-testid','data-test-id','data-test','data-cy','data-qa']) {
      const v = el.getAttribute(attr);
      if (v) { anchors.push(`[${attr}="${v.replace(/"/g, '\\"')}"]`); break; }
    }

    const tag = el.tagName.toLowerCase();
    const cls = stableClasses(el);

    // 3. Multi → single class combinations
    for (let n = Math.min(cls.length, 3); n >= 1; n--) {
      anchors.push(tag + '.' + cls.slice(0, n).join('.'));
    }

    // 4. nth-child variants scoped to each parent anchor
    // This produces e.g. `div.vendors-row > div.item:nth-child(2)` which IS unique
    // even when `div.item` alone is not.
    const parent = el.parentElement;
    if (parent && !isRoot(parent)) {
      const idx = Array.from(parent.children).indexOf(el) + 1;
      const nthSeg = cls.length
        ? `${tag}.${cls[0]}:nth-child(${idx})`
        : `${tag}:nth-child(${idx})`;

      const parentAnchors = buildAllAnchorsFor(parent, depth + 1);
      for (const pa of parentAnchors.slice(0, 4)) {
        anchors.push(`${pa} > ${nthSeg}`);
      }
      // Also bare nth-child in case parent anchors are too verbose
      anchors.push(nthSeg);
    }

    return anchors;
  }

  /**
   * Derive a CSS selector matching EXACTLY the given element set.
   *
   * Strategy:
   *   1. Walk every ancestor from NCA to <body>.
   *      For EACH ancestor, generate ALL anchor candidates (buildAllAnchorsFor).
   *      For EACH anchor × child pattern combination, test with setsEqual.
   *      Return the first exact match — deepest ancestor wins (most specific scope).
   *
   *   2. NCA-relative :is() of unique nth-child paths — stays compact and scoped.
   *
   *   3. Absolute nth-child paths from body — last resort only.
   *
   * No uniqueness pre-filter: setsEqual IS the verification gate.
   */
  function deriveExactSelector(els) {
    if (!els.length) return null;

    if (els.length === 1) {
      const anchors = buildAllAnchorsFor(els[0]);
      for (const anchor of anchors) {
        try {
          const matched = [...document.querySelectorAll(anchor)];
          if (matched.length === 1 && matched[0] === els[0]) return anchor;
        } catch (_) {}
      }
      return buildUniqueNthChildPath(els[0]) || buildSimpleSelector(els[0]);
    }

    const nca = nearestCommonAncestor(els);
    const { childTag, common } = buildChildPattern(els);

    // ── Step 1: Walk ancestors, try all anchor × child-pattern combos ────
    {
      let cur = nca;
      while (cur && !isRoot(cur)) {
        const anchors = buildAllAnchorsFor(cur);
        for (const anchor of anchors) {
          const result = tryPatternWithScope(anchor, els, childTag, common);
          if (result) return result;
        }
        cur = cur.parentElement;
      }
    }

    // ── Step 2: NCA-relative :is() of unique nth-child paths ─────────────
    if (nca && !isRoot(nca)) {
      const ncaAnchors = buildAllAnchorsFor(nca);
      const ncaAnchor  = ncaAnchors[0] || buildSimpleSelector(nca);

      const paths = els.map(e => buildUniquePathFromAncestor(e, nca));
      if (paths.every(Boolean)) {
        const isSel = `${ncaAnchor} :is(${paths.join(', ')})`;
        try {
          const matched = [...document.querySelectorAll(isSel)];
          if (setsEqual(matched, els)) return isSel;
        } catch (_) {}

        const expanded = paths.map(p => `${ncaAnchor} ${p}`).join(', ');
        try {
          const matched = [...document.querySelectorAll(expanded)];
          if (setsEqual(matched, els)) return expanded;
        } catch (_) {}
        return expanded;
      }
    }

    // ── Step 3: Absolute nth-child — true last resort ─────────────────────
    const absPaths = els.map(e => buildUniqueNthChildPath(e, 10));
    if (absPaths.every(Boolean)) return absPaths.join(', ');

    return null;
  }

  /** True iff two element arrays contain exactly the same elements (order-independent) */
  function setsEqual(a, b) {
    if (a.length !== b.length) return false;
    const s = new Set(a);
    return b.every(e => s.has(e));
  }

  /**
   * Build a unique CSS path from `ancestor` down to `el` using nth-child at every
   * step — guaranteed to identify exactly one element within that ancestor scope.
   * Class names are added for readability but nth-child ensures uniqueness.
   */
  function buildUniquePathFromAncestor(el, ancestor) {
    const parts = [];
    let cur = el;
    while (cur && cur !== ancestor) {
      const parent = cur.parentElement;
      if (!parent) return null;
      const idx = Array.from(parent.children).indexOf(cur) + 1;
      const tag = cur.tagName.toLowerCase();
      const cls = stableClasses(cur);
      // nth-child makes it unique; class is decorative / for readability
      const classPart = cls.length ? `.${cls[0]}` : '';
      parts.unshift(`${tag}${classPart}:nth-child(${idx})`);
      cur = parent;
    }
    if (cur !== ancestor) return null;
    return parts.join(' > ');
  }

  /**
   * Build an absolute unique CSS path from body to `el`.
   * Used as last resort when there is no useful common ancestor.
   */
  function buildUniqueNthChildPath(el, maxDepth = 8) {
    const parts = [];
    let cur = el, depth = 0;
    while (cur && !isRoot(cur) && depth < maxDepth) {
      const parent = cur.parentElement;
      if (!parent) break;
      const idx = Array.from(parent.children).indexOf(cur) + 1;
      const tag = cur.tagName.toLowerCase();
      const cls = stableClasses(cur);
      const classPart = cls.length ? `.${cls[0]}` : '';
      parts.unshift(`${tag}${classPart}:nth-child(${idx})`);
      cur = parent;
      depth++;
    }
    return parts.join(' > ');
  }


  /**
   * Find the deepest DOM node that contains every element in `els`.
   */
  function nearestCommonAncestor(els) {
    if (!els.length) return null;
    let cur = els[0].parentElement;
    while (cur && !isRoot(cur)) {
      if (els.every(e => cur.contains(e))) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  // ── Relative path (ancestor → descendant) ─────────────────────────────────
  // Used to map "seed within ancestor" → "corresponding element within sibling"

  /**
   * Build a path from `ancestor` down to `target` as a sequence of steps.
   * Each step: { tag, classes[], index } — classes preferred, index as fallback.
   */
  function buildRelativePath(target, ancestor) {
    const path = [];
    let cur = target;
    while (cur && cur !== ancestor) {
      const parent = cur.parentElement;
      if (!parent) return null; // disconnected
      path.unshift({
        tag: cur.tagName.toLowerCase(),
        classes: stableClasses(cur),
        index: Array.from(parent.children).indexOf(cur),
        tagIndex: Array.from(parent.children).filter(c => c.tagName === cur.tagName).indexOf(cur),
      });
      cur = parent;
    }
    if (cur !== ancestor) return null;
    return path;
  }

  /**
   * Follow `path` downward from `container`, returning the matched descendant or null.
   * Tries class-match first, falls back to tag-index, then any-index.
   */
  function followRelativePath(container, path) {
    let cur = container;
    for (const step of path) {
      if (!cur) return null;
      const children = Array.from(cur.children);

      // 1. Class + tag match
      if (step.classes.length > 0) {
        const byClass = children.find(c =>
          c.tagName.toLowerCase() === step.tag &&
          step.classes.every(cls => c.classList.contains(cls))
        );
        if (byClass) { cur = byClass; continue; }
      }

      // 2. Same tag, same position among same-tag siblings
      const byTag = children.filter(c => c.tagName.toLowerCase() === step.tag);
      if (byTag.length === 1) { cur = byTag[0]; continue; }
      if (byTag[step.tagIndex]) { cur = byTag[step.tagIndex]; continue; }

      // 3. Absolute child index
      if (children[step.index]) { cur = children[step.index]; continue; }

      return null; // couldn't follow
    }
    return cur;
  }

  /**
   * Build a CSS path string from `ancestor` down to `target`
   * using tag+class notation, suitable for appending to an ancestor selector.
   */
  function buildCssDescendantPath(target, ancestor) {
    const path = buildRelativePath(target, ancestor);
    if (!path) return null;
    return path.map(step => {
      let seg = step.tag;
      if (step.classes.length) seg += '.' + step.classes[0];
      return seg;
    }).join(' > ');
  }

  // ── Core: multi-strategy similar element finder ───────────────────────────
  //
  // Four complementary strategies, scored and ranked:
  //
  //  [A] Direct siblings   — seed's siblings that look the same
  //  [B] Ancestor-relative — ancestor of seed is itself a repeating unit;
  //                          find the corresponding sub-element in each sibling
  //  [C] Ancestor-cards    — like B but select the whole ancestor card, not sub-element
  //  [D] Global pattern    — all elements on the page with same tag+class signature
  //
  // The selector always drives the highlighted set, so highlight = scrape.

  function findSimilarGroup(seed) {
    const candidates = [];

    // ── [A] Direct siblings ──────────────────────────────────────────────
    const directResult = scanSiblingLevel(seed, seed.parentElement);
    if (directResult) {
      candidates.push({ ...directResult, strategy: 'A:direct-siblings', level: 0 });
    }

    // ── [B/C] Ancestor-relative ──────────────────────────────────────────
    let ancestor = seed.parentElement;
    for (let level = 1; level <= 7 && ancestor && !isRoot(ancestor); level++) {
      const grandparent = ancestor.parentElement;
      if (!grandparent || isRoot(grandparent)) { ancestor = grandparent; break; }

      // Does this ancestor itself repeat among its siblings?
      const ancestorSibGroup = scanSiblingLevel(ancestor, grandparent);
      if (ancestorSibGroup && ancestorSibGroup.els.length >= 2) {

        // [C] Select whole ancestor cards
        // Verify selector matches exactly ancestorSibGroup.els
        let cardSel = ancestorSibGroup.selector;
        if (cardSel) {
          try {
            const matched = [...document.querySelectorAll(cardSel)];
            if (!setsEqual(matched, ancestorSibGroup.els)) {
              cardSel = deriveExactSelector(ancestorSibGroup.els);
            }
          } catch (_) {
            cardSel = deriveExactSelector(ancestorSibGroup.els);
          }
        } else {
          cardSel = deriveExactSelector(ancestorSibGroup.els);
        }
        candidates.push({
          els:      ancestorSibGroup.els,
          selector: cardSel,
          strategy: 'C:ancestor-cards',
          level,
          coverage: 1.0,
        });

        // [B] Find element corresponding to `seed` within each ancestor sibling
        const path = buildRelativePath(seed, ancestor);
        if (path) {
          const mapped = [];
          for (const sib of ancestorSibGroup.els) {
            if (sib === ancestor) { mapped.push(seed); continue; }
            const found = followRelativePath(sib, path);
            if (found) mapped.push(found);
          }
          const coverage = mapped.length / ancestorSibGroup.els.length;
          if (mapped.length >= 2 && coverage >= 0.6) {
            // Build a selector anchored to the ancestor container
            const cssPath = buildCssDescendantPath(seed, ancestor);
            let mappedSel = null;
            if (cssPath && ancestorSibGroup.selector) {
              const candidate = `${ancestorSibGroup.selector} ${cssPath}`;
              try {
                const matched = [...document.querySelectorAll(candidate)];
                if (setsEqual(matched, mapped)) mappedSel = candidate; // exact
              } catch (_) {}
            }
            // If pattern doesn't match exactly, derive an exact selector
            if (!mappedSel) {
              mappedSel = deriveExactSelector(mapped);
            }
            candidates.push({
              els:             mapped,
              selector:        mappedSel,
              strategy:        'B:ancestor-relative',
              level,
              coverage,
              ancestorEls:     ancestorSibGroup.els,
              ancestorSelector: ancestorSibGroup.selector,
            });
          }
        }
      }

      ancestor = grandparent;
    }

    // ── [D] Global class pattern ─────────────────────────────────────────
    const globalResult = scanGlobalPattern(seed);
    if (globalResult) {
      candidates.push({ ...globalResult, strategy: 'D:global-class', level: 99 });
    }

    if (!candidates.length) {
      return { els: [seed], selector: null, strategy: 'none' };
    }

    // ── Score and pick best ──────────────────────────────────────────────
    return scoreBest(candidates, seed);
  }

  /**
   * Scan `parent`'s children for elements similar to `el`.
   * Returns { els: similar, selector } where selector matches EXACTLY `similar`,
   * or null if < 2 similar children found.
   *
   * Invariant: querySelectorAll(selector) === similar (same set, verified).
   */
  function scanSiblingLevel(el, parent) {
    if (!parent || isRoot(parent)) return null;

    const sf = getFeatures(el);
    const similar = Array.from(parent.children).filter(c =>
      c === el || similarityScore(sf, getFeatures(c)) >= 0.68
    );
    if (similar.length < 2) return null;

    // Try the pattern-based selector first — only accept if it matches EXACTLY similar
    const patternSel = buildGroupSelector(similar, parent);
    if (patternSel) {
      try {
        const matched = [...document.querySelectorAll(patternSel)];
        if (setsEqual(matched, similar)) {
          return { els: similar, selector: patternSel }; // perfect
        }
      } catch (_) {}
    }

    // Pattern over-matches or failed — derive a selector that is exact by construction
    const exactSel = deriveExactSelector(similar);
    return { els: similar, selector: exactSel };
  }

  /**
   * Find all elements on the page that share the same tag + stable class signature.
   * Only accepted if the matched set is small and the selector matches exactly what's found.
   */
  function scanGlobalPattern(seed) {
    const tag = seed.tagName.toLowerCase();
    const cls = stableClasses(seed);
    if (!cls.length) return null;

    for (let n = Math.min(cls.length, 3); n >= 1; n--) {
      const sel = tag + '.' + cls.slice(0, n).join('.');
      try {
        const matched = [...document.querySelectorAll(sel)];
        if (!matched.includes(seed)) continue;
        if (matched.length < 2 || matched.length > 200) continue;
        // Selector already exact by definition (it produced matched),
        // so els === matched is guaranteed here.
        return { els: matched, selector: sel };
      } catch (_) {}
    }
    return null;
  }

  /**
   * Score candidates and return the best.
   *
   * Scoring philosophy:
   *  - Prefer selectors that are specific (parent-scoped) over global
   *  - Prefer ancestor-relative (finds sub-elements in repeating cards) over direct siblings
   *    when it gives better coverage
   *  - A "sweet spot" count of 2–40 elements is rewarded; huge counts penalised
   *  - Lower ancestor level (closer to seed) is slightly preferred
   */
  function scoreBest(candidates, seed) {
    const scored = candidates.map(c => {
      let score = 0;
      const n = c.els.length;

      // Count score: sweet spot 2–40
      if (n >= 2  && n <= 10)  score += 50 + n * 2;
      else if (n <= 40)         score += 70 + n * 0.5;
      else if (n <= 100)        score += 90 - (n - 40) * 0.8;
      else                      score += 90 - 48 - (n - 100) * 2; // heavily penalise huge sets

      // Strategy bonus
      if (c.strategy.startsWith('B')) score += 35;  // ancestor-relative: best for sub-elements
      if (c.strategy.startsWith('A')) score += 28;  // direct siblings
      if (c.strategy.startsWith('C')) score += 22;  // whole ancestor cards
      if (c.strategy.startsWith('D')) score += 10;  // global — last resort

      // Level penalty (prefer closest to seed)
      score -= (c.level || 0) * 4;

      // Coverage bonus (how many ancestor containers yielded a match)
      if (c.coverage != null) score += c.coverage * 25;

      // Selector specificity bonus
      if (c.selector) {
        if (c.selector.includes('#'))  score += 18;
        if (c.selector.includes('>'))  score += 12;
        if (c.selector.includes('.'))  score += 5;
      } else {
        score -= 15; // no selector = bad
      }

      return { ...c, _score: score };
    });

    scored.sort((a, b) => b._score - a._score);

    // Debug info (stripped in production builds)
    if (window.__SELECTOR_DEBUG__) {
      console.table(scored.map(c => ({
        strategy: c.strategy,
        count:    c.els.length,
        selector: c.selector,
        level:    c.level,
        coverage: c.coverage?.toFixed(2),
        score:    c._score.toFixed(1),
      })));
    }

    return scored[0];
  }

  // ── Element info builder ──────────────────────────────────────────────────

  function buildElementInfo(el) {
    let primary = null, fallbackSelectors = [];
    try {
      const result = window.SelectorGenerator.getSelectorsForElement(el, { actionType: 'generic', maxFallbacks: 5 });
      primary = result.primary ? { value: result.primary.value, type: result.primary.type, strategy: result.primary.strategy } : null;
      fallbackSelectors = (result.fallbacks || []).map(f => ({ value: f.value, type: f.type, strategy: f.strategy }));
    } catch (_) {
      primary = { value: buildSimpleSelector(el), type: 'css', strategy: 'fallback' };
    }

    const tag     = el.tagName.toLowerCase();
    const isLink  = tag === 'a' || !!el.closest('a');
    const isInput = ['input','textarea','select'].includes(tag);
    const isImg   = tag === 'img';
    const isTable = tag === 'table' || !!el.querySelector('table');
    const text    = (el.textContent || '').trim().slice(0, 120);
    const href    = el.getAttribute('href') || null;
    const src     = el.getAttribute('src')  || null;

    const breadcrumb = [];
    let cur = el;
    while (cur && cur.tagName && cur.tagName.toLowerCase() !== 'html') {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) seg += '#' + cur.id;
      else if (cur.classList.length) seg += '.' + [...cur.classList].slice(0, 2).join('.');
      breadcrumb.unshift({ label: seg, selector: buildSimpleSelector(cur) });
      cur = cur.parentElement;
    }

    const attrs = {};
    for (const a of el.attributes) {
      if (a.name === 'style') continue;
      attrs[a.name] = a.value.slice(0, 100);
    }

    return {
      selector: primary?.value || '',
      selectorType: primary?.type || 'css',
      selectorStrategy: primary?.strategy || '',
      fallbackSelectors,
      tag, text, href, src,
      isLink, isInput, isImg, isTable,
      attrs, breadcrumb,
      classes: [...el.classList].join(' '),
    };
  }

  // ── Selection actions ─────────────────────────────────────────────────────

  function doFirstClick(target) {
    fullReset();
    currentEl = target;
    selState  = 'first_selected';
    applyHard([target]);

    const group    = findSimilarGroup(target);
    const siblings = group.els.filter(el => el !== target);

    if (siblings.length > 0) {
      softSelector = group.selector;
      softStrategy = group.strategy;
      applySoft(siblings);
    }

    tooltip.style.display = 'none';
    const info = buildElementInfo(target);
    info.softHighlightCount = siblings.length;
    info.softSelector       = group.selector;
    info.softStrategy       = group.strategy;
    window.sendToNode({ type: 'elementSelected', element: info });
  }

  function confirmSiblingGroup() {
    const allEls = [currentEl, ...softEls];
    clearArr(softEls);
    applyHard(allEls);
    selState = 'multi_selected';
    tooltip.style.display = 'none';

    // Guarantee a selector — derive from actual element set if softSelector is missing
    const finalSelector = softSelector || deriveExactSelector(allEls) || '';

    // Verify the final selector actually matches what's highlighted
    let verifiedSelector = finalSelector;
    if (finalSelector) {
      try {
        const matched = [...document.querySelectorAll(finalSelector)];
        const allCovered = allEls.every(e => matched.includes(e));
        if (!allCovered) {
          // Derived selector doesn't cover all elements — force exact derivation
          verifiedSelector = deriveExactSelector(allEls) || finalSelector;
        }
      } catch (_) {
        verifiedSelector = deriveExactSelector(allEls) || finalSelector;
      }
    }

    window.sendToNode({
      type:           'multiElementSelected',
      commonSelector: verifiedSelector,
      matchCount:     allEls.length,
      selectorCount:  allEls.length,
      strategy:       softStrategy || '',
      elements:       allEls.slice(0, 5).map(buildElementInfo),
    });
  }

  // ── Mouse events ──────────────────────────────────────────────────────────

  function onMouseMove(e) {
    if (!window.__SELECTION_MODE__) return;
    const target = e.target;
    if (target === hoverEl) { if (tooltip.style.display !== 'none') placeTooltip(e); return; }

    if (hoverEl && !hardEls.includes(hoverEl) && !softEls.includes(hoverEl)) restoreStyle(hoverEl, 'outline');
    hoverEl = target;
    if (!hardEls.includes(hoverEl) && !softEls.includes(hoverEl)) setStyle(hoverEl, 'outline', HOVER_OUTLINE, true);

    tooltip.style.display = 'block';
    if (selState === 'first_selected' && softEls.includes(target)) {
      tooltip.textContent = '⬡ Click to select all ' + (softEls.length + 1) + ' similar elements';
    } else if (selState === 'first_selected' && hardEls.includes(target)) {
      tooltip.textContent = '✕ Click again to deselect';
    } else if (selState === 'multi_selected') {
      tooltip.textContent = '✕ Click anywhere to restart selection';
    } else {
      tooltip.textContent = getElPath(hoverEl);
    }
    placeTooltip(e);
  }

  function onClick(e) {
    if (!window.__SELECTION_MODE__) return;
    e.preventDefault();
    e.stopPropagation();

    const target = e.target;

    if (selState === 'idle')           { doFirstClick(target); return; }
    if (selState === 'first_selected') {
      if (softEls.includes(target))    { confirmSiblingGroup(); return; }
      if (hardEls.includes(target))    { fullReset(); window.sendToNode({ type: 'selectionCleared' }); return; }
      doFirstClick(target); return;
    }
    if (selState === 'multi_selected') { doFirstClick(target); }
  }

  // ── Exposed API ───────────────────────────────────────────────────────────

  window.__resetSelection__ = () => fullReset();

  window.__selectAncestor__ = (levelsUp) => {
    if (!currentEl) return;
    let el = currentEl;
    for (let i = 0; i < levelsUp; i++) el = el?.parentElement;
    if (el && el.tagName && !isRoot(el)) doFirstClick(el);
  };

  window.__getChildrenOf__ = (levelsUp) => {
    if (!currentEl) return [];
    let el = currentEl;
    for (let i = 0; i < levelsUp; i++) el = el?.parentElement;
    if (!el) return [];
    return Array.from(el.children).map((child, idx) => {
      const info = buildElementInfo(child);
      info.childIndex = idx;
      return info;
    });
  };

  window.__selectChildByIndex__ = (levelsUp, childIndex) => {
    if (!currentEl) return;
    let el = currentEl;
    for (let i = 0; i < levelsUp; i++) el = el?.parentElement;
    if (el?.children[childIndex]) doFirstClick(el.children[childIndex]);
  };

  // ── Mode watcher ──────────────────────────────────────────────────────────

  let _selectionMode = window.__SELECTION_MODE__;
  Object.defineProperty(window, '__SELECTION_MODE__', {
    get: () => _selectionMode,
    set: (value) => { if (_selectionMode !== value) { _selectionMode = value; if (!value) cleanupSelectionMode(); } },
    configurable: true
  });

  createTooltip();
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click',     onClick,     true);
  console.log('✅ SelectorTool injected (multi-strategy v2)');
})();

// ─── Shared utilities ─────────────────────────────────────────────────────────

function getFeatures(el) {
  return {
    tag:       el.tagName,
    classes:   Array.from(el.classList),
    attrs:     Array.from(el.attributes).map(a => a.name),
    childTags: Array.from(el.children).map(c => c.tagName),
    childCount: el.children.length,
    textType:  (() => {
      const t = (el.textContent || '').trim();
      if (!t) return 'empty';
      if (/^\d+(\.\d+)?$/.test(t)) return 'number';
      if (/[\$€£¥₹]/.test(t)) return 'money';
      if (t.length < 30) return 'short';
      return 'long';
    })(),
  };
}

function similarityScore(f1, f2) {
  // Tag match — hard requirement: different tags = very low score
  const tagScore = f1.tag === f2.tag ? 1 : 0;
  if (tagScore === 0) return 0.1;

  // Class overlap (Jaccard)
  const c1 = new Set(f1.classes), c2 = new Set(f2.classes);
  const classScore = (c1.size === 0 && c2.size === 0) ? 0.8  // both classless: neutral
    : (c1.size === 0 || c2.size === 0)                 ? 0.2
    : [...c1].filter(x => c2.has(x)).length / new Set([...c1,...c2]).size;

  // Attribute name overlap
  const a1 = new Set(f1.attrs), a2 = new Set(f2.attrs);
  const attrScore = (a1.size === 0 && a2.size === 0) ? 0.8
    : (a1.size === 0 || a2.size === 0)                ? 0.3
    : [...a1].filter(x => a2.has(x)).length / new Set([...a1,...a2]).size;

  // Child tag structure overlap
  const ct1 = new Set(f1.childTags), ct2 = new Set(f2.childTags);
  const childTagScore = new Set([...ct1,...ct2]).size === 0 ? 0.8
    : [...ct1].filter(x => ct2.has(x)).length / new Set([...ct1,...ct2]).size;

  // Child count similarity (ratio, capped)
  const maxC = Math.max(f1.childCount, f2.childCount, 1);
  const minC = Math.min(f1.childCount, f2.childCount);
  const childCountScore = minC / maxC;

  // Text type match
  const textScore = f1.textType === f2.textType ? 1 : 0.3;

  // Weights: classes are the strongest signal; structure next; text weakest
  const w = (c1.size === 0 && c2.size === 0)
    ? { tag: 0.35, cls: 0, attr: 0.20, ctag: 0.25, ccnt: 0.15, txt: 0.05 }
    : { tag: 0.30, cls: 0.30, attr: 0.15, ctag: 0.15, ccnt: 0.05, txt: 0.05 };

  return (
    w.tag  * tagScore        +
    w.cls  * classScore      +
    w.attr * attrScore       +
    w.ctag * childTagScore   +
    w.ccnt * childCountScore +
    w.txt  * textScore
  );
}