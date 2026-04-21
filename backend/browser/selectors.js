(function () {
  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function normalizeText(txt) {
    return (txt || '').replace(/\s+/g, ' ').trim();
  }

  /** True when a string looks like a generated/random token (hash, UUID, etc.) */
  function isRandomLike(value) {
    if (!value) return false;
    // hex run of 8+ chars
    if (/[0-9a-f]{8,}/i.test(value)) return true;
    // long unbroken string with no whitespace
    if (value.length > 32 && !/\s/.test(value)) return true;
    // looks like a UUID
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true;
    // looks like a numeric/auto-generated id  e.g. "ember123", "react-select-3"
    if (/^[a-z]+-\d+$/i.test(value) && value.length > 8) return true;
    return false;
  }

  function splitClasses(cls) {
    return (cls || '')
      .split(/\s+/)
      .map(c => c.trim())
      .filter(Boolean);
  }

  function isStableId(id) {
    return !!id && !isRandomLike(id);
  }

  function isStableClass(cls) {
    if (!cls || isRandomLike(cls)) return false;
    // skip purely structural / state utility classes that offer no specificity
    if (/^(active|hover|focus|disabled|selected|open|closed|visible|hidden|show|hide|is-|has-)/.test(cls)) return false;
    return true;
  }

  /** Escape a string for use inside a CSS selector */
  function cssEscape(str) {
    if (typeof window.CSS !== 'undefined' && window.CSS.escape) {
      return window.CSS.escape(str);
    }
    return String(str).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
  }

  function cssAttrEquals(name, value) {
    const escaped = String(value).replace(/"/g, '\\"');
    return `[${name}="${escaped}"]`;
  }

  // ---------------------------------------------------------------------------
  // Context extraction
  // ---------------------------------------------------------------------------

  function buildContext(el) {
    const path = [];
    let node = el;

    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const attrs = node.attributes;
      const attrMap = {};
      for (let i = 0; i < attrs.length; i++) {
        attrMap[attrs[i].name] = attrs[i].value;
      }

      const parent = node.parentNode;
      const siblings = parent ? Array.from(parent.children) : [];
      const sameTagSiblings = siblings.filter(s => s.tagName === node.tagName);

      path.unshift({
        tag: node.tagName.toLowerCase(),
        id: node.id || null,
        classList: splitClasses(node.className),
        attributes: attrMap,
        index: siblings.indexOf(node),          // 0-based among all children
        nthOfType: sameTagSiblings.indexOf(node) + 1  // 1-based among same-tag siblings
      });

      node = parent;
    }

    return {
      element: el,
      path,   // root → target
      text: normalizeText(el.innerText || el.textContent || '')
    };
  }

  // ---------------------------------------------------------------------------
  // Uniqueness check helpers
  // ---------------------------------------------------------------------------

  function querySelectorUnique(selector, el) {
    try {
      const nodes = document.querySelectorAll(selector);
      return nodes.length === 1 && nodes[0] === el;
    } catch (_) {
      return false;
    }
  }

  function xpathUnique(expr, el) {
    try {
      const res = document.evaluate(
        expr, document, null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
      );
      return res.snapshotLength === 1 && res.snapshotItem(0) === el;
    } catch (_) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // CSS candidate generation (ordered best → worst)
  // ---------------------------------------------------------------------------

  function xpathEscape(str) {
    const s = String(str);
    if (!s.includes('"')) return `"${s}"`;
    if (!s.includes("'")) return `'${s}'`;
    // mixed quotes – use concat()
    const parts = s.split('"').map((p, i, arr) =>
      i < arr.length - 1 ? `"${p}", '"'` : `"${p}"`
    );
    return `concat(${parts.join(', ')})`;
  }

  /**
   * Build a minimal CSS selector that is already unique, walking up the tree
   * one step at a time and prepending the cheapest qualifying ancestor segment.
   *
   * This is the heart of the improvement: instead of a fixed list of patterns
   * we iteratively extend the selector until it becomes unique, favouring
   * stable attributes and ids over positional indices.
   */
  function buildMinimalCssSelector(ctx) {
    const el = ctx.element;
    const path = ctx.path;
    const leafInfo = path[path.length - 1];

    // Preference-ordered list of "how to describe a single node"
    function nodeSegments(info, includeNth) {
      const segs = [];
      const stableClasses = (info.classList || []).filter(isStableClass);

      if (isStableId(info.id)) {
        segs.push({ seg: `#${cssEscape(info.id)}`, specificity: 100 });
      }

      // data-testid / data-cy / data-qa – very stable test hooks
      for (const attr of ['data-testid', 'data-cy', 'data-qa', 'data-test', 'data-id']) {
        const v = (info.attributes || {})[attr];
        if (v && !isRandomLike(v)) {
          segs.push({ seg: `${info.tag}${cssAttrEquals(attr, v)}`, specificity: 80 });
        }
      }

      // Other data-* attributes
      for (const [name, value] of Object.entries(info.attributes || {})) {
        if (!name.startsWith('data-') || ['data-testid','data-cy','data-qa','data-test','data-id'].includes(name)) continue;
        if (!value || isRandomLike(value)) continue;
        segs.push({ seg: `${info.tag}${cssAttrEquals(name, value)}`, specificity: 60 });
      }

      // Semantic / stable HTML attributes
      for (const attr of ['name', 'type', 'role', 'aria-label', 'placeholder', 'href', 'for']) {
        const v = (info.attributes || {})[attr];
        if (v && !isRandomLike(v) && v.length <= 80) {
          segs.push({ seg: `${info.tag}${cssAttrEquals(attr, v)}`, specificity: 50 });
        }
      }

      // Multi-class combination (up to 3 stable classes)
      if (stableClasses.length >= 2) {
        const combo = info.tag + stableClasses.slice(0, 3).map(c => `.${cssEscape(c)}`).join('');
        segs.push({ seg: combo, specificity: 45 });
      }

      // Single stable class
      stableClasses.forEach(cls => {
        segs.push({ seg: `${info.tag}.${cssEscape(cls)}`, specificity: 30 });
        segs.push({ seg: `.${cssEscape(cls)}`, specificity: 25 });
      });

      // Bare tag
      segs.push({ seg: info.tag, specificity: 10 });

      // nth-of-type (positional – last resort)
      if (includeNth) {
        segs.push({ seg: `${info.tag}:nth-of-type(${info.nthOfType})`, specificity: 5 });
        segs.push({ seg: `${info.tag}:nth-child(${info.index + 1})`, specificity: 4 });
      }

      return segs;
    }

    // Start with the leaf node only
    const leafSegs = nodeSegments(leafInfo, true);
    for (const { seg } of leafSegs) {
      if (querySelectorUnique(seg, el)) {
        return { value: seg, strategy: 'leaf-only' };
      }
    }

    // Walk ancestors from immediate parent outward, prepend cheapest segment
    for (let ancIdx = path.length - 2; ancIdx >= 0; ancIdx--) {
      const ancInfo = path[ancIdx];
      const ancSegs = nodeSegments(ancInfo, true);

      for (const { seg: ancSeg } of ancSegs) {
        // Try: ancestor > leaf (direct child) and ancestor leaf (descendant)
        for (const leafSeg of leafSegs) {
          for (const combinator of [' > ', ' ']) {
            const full = `${ancSeg}${combinator}${leafSeg.seg}`;
            if (querySelectorUnique(full, el)) {
              return {
                value: full,
                strategy: ancIdx === path.length - 2 ? 'parent+leaf' : 'ancestor+leaf'
              };
            }
          }
        }
      }
    }

    // Absolute fallback: full structural path
    const fullPath = path
      .map(n => `${n.tag}:nth-of-type(${n.nthOfType})`)
      .join(' > ');
    return { value: fullPath, strategy: 'full-path' };
  }

  function generateCssCandidates(ctx) {
    const el = ctx.element;
    const elInfo = ctx.path[ctx.path.length - 1];
    const candidates = [];

    // --- 1. Simple #id ---
    if (isStableId(elInfo.id)) {
      const v = `#${cssEscape(elInfo.id)}`;
      candidates.push({ type: 'css', strategy: 'id', value: v });
    }

    // --- 2. data-testid / data-cy / data-qa (most stable hooks) ---
    for (const attr of ['data-testid', 'data-cy', 'data-qa', 'data-test', 'data-id']) {
      const v = (elInfo.attributes || {})[attr];
      if (v && !isRandomLike(v)) {
        candidates.push({
          type: 'css',
          strategy: 'test-hook',
          value: `${elInfo.tag}${cssAttrEquals(attr, v)}`
        });
      }
    }

    // --- 3. Other data-* attributes ---
    for (const [name, value] of Object.entries(elInfo.attributes || {})) {
      if (!name.startsWith('data-') || ['data-testid','data-cy','data-qa','data-test','data-id'].includes(name)) continue;
      if (!value || isRandomLike(value)) continue;
      candidates.push({
        type: 'css',
        strategy: 'data-attr',
        value: `${elInfo.tag}${cssAttrEquals(name, value)}`
      });
    }

    // --- 4. Semantic attributes (name, aria-label, role, placeholder…) ---
    for (const attr of ['name', 'role', 'aria-label', 'placeholder', 'for', 'type']) {
      const v = (elInfo.attributes || {})[attr];
      if (v && !isRandomLike(v) && v.length <= 80) {
        candidates.push({
          type: 'css',
          strategy: `attr-${attr}`,
          value: `${elInfo.tag}${cssAttrEquals(attr, v)}`
        });
      }
    }

    // --- 5. Multi-class combination ---
    const stableClasses = (elInfo.classList || []).filter(isStableClass);
    if (stableClasses.length >= 2) {
      candidates.push({
        type: 'css',
        strategy: 'multi-class',
        value: elInfo.tag + stableClasses.slice(0, 3).map(c => `.${cssEscape(c)}`).join('')
      });
    }

    // --- 6. Single stable class ---
    stableClasses.forEach(cls => {
      candidates.push({ type: 'css', strategy: 'class', value: `.${cssEscape(cls)}` });
    });

    // --- 7. Minimal unique CSS (iterative ancestor walk) ---
    const minimal = buildMinimalCssSelector(ctx);
    candidates.push({ type: 'css', strategy: minimal.strategy, value: minimal.value });

    // Deduplicate by value
    const seen = new Set();
    return candidates.filter(c => {
      if (seen.has(c.value)) return false;
      seen.add(c.value);
      return true;
    });
  }

  // ---------------------------------------------------------------------------
  // XPath candidate generation
  // ---------------------------------------------------------------------------

  function generateXPathCandidates(ctx) {
    const elInfo = ctx.path[ctx.path.length - 1];
    const candidates = [];

    // Helper: build a relative tag path from ancestor index to leaf
    function buildTagPath(fromIdx) {
      return ctx.path.slice(fromIdx).map(n => n.tag).join('/');
    }

    // 1) id-based
    if (isStableId(elInfo.id)) {
      candidates.push({
        type: 'xpath',
        strategy: 'id',
        value: `//*[@id=${xpathEscape(elInfo.id)}]`
      });
    }

    // 2) data-testid / data-cy / data-qa
    for (const attr of ['data-testid', 'data-cy', 'data-qa', 'data-test']) {
      const v = (elInfo.attributes || {})[attr];
      if (v && !isRandomLike(v)) {
        candidates.push({
          type: 'xpath',
          strategy: 'test-hook',
          value: `//${elInfo.tag}[@${attr}=${xpathEscape(v)}]`
        });
      }
    }

    // 3) aria-label (great for accessibility-driven selectors)
    const ariaLabel = (elInfo.attributes || {})['aria-label'];
    if (ariaLabel && !isRandomLike(ariaLabel) && ariaLabel.length <= 80) {
      candidates.push({
        type: 'xpath',
        strategy: 'aria-label',
        value: `//${elInfo.tag}[@aria-label=${xpathEscape(ariaLabel)}]`
      });
    }

    // 4) Text-based (short, meaningful text only)
    if (ctx.text && ctx.text.length >= 1 && ctx.text.length <= 64) {
      const t = ctx.text;
      // Exact text match first (more specific)
      candidates.push({
        type: 'xpath',
        strategy: 'text-exact',
        value: `//${elInfo.tag}[normalize-space(.)=${xpathEscape(t)}]`
      });
      // Contains fallback
      candidates.push({
        type: 'xpath',
        strategy: 'text-contains',
        value: `//${elInfo.tag}[contains(normalize-space(.), ${xpathEscape(t)})]`
      });
    }

    // 5) Other stable attributes
    for (const [name, value] of Object.entries(elInfo.attributes || {})) {
      if (name === 'id' || name === 'class') continue;
      if (!value || isRandomLike(value) || value.length > 100) continue;
      if (['data-testid','data-cy','data-qa','data-test','aria-label'].includes(name)) continue;
      candidates.push({
        type: 'xpath',
        strategy: 'attr',
        value: `//${elInfo.tag}[@${name}=${xpathEscape(value)}]`
      });
    }

    // 6) Ancestor + relative path (walk from closest stable ancestor outward)
    for (let i = ctx.path.length - 2; i >= 0; i--) {
      const anc = ctx.path[i];
      const classes = (anc.classList || []).filter(isStableClass);
      if (!isStableId(anc.id) && !classes.length) continue;

      const ancExpr = isStableId(anc.id)
        ? `//*[@id=${xpathEscape(anc.id)}]`
        : `//${anc.tag}[contains(concat(' ', normalize-space(@class), ' '), ' ${classes[0]} ')]`;

      const relPath = buildTagPath(i + 1);

      // Direct descendant path
      candidates.push({
        type: 'xpath',
        strategy: 'ancestor+path',
        value: `${ancExpr}//${relPath}`
      });

      // With positional predicate on the leaf
      const relPathWithPos = ctx.path
        .slice(i + 1)
        .map(n => `${n.tag}[${n.nthOfType}]`)
        .join('/');
      candidates.push({
        type: 'xpath',
        strategy: 'ancestor+path+pos',
        value: `${ancExpr}//${relPathWithPos}`
      });
      break;
    }

    // 7) Full structural path (last resort)
    const fullPath = ctx.path
      .map(n => `${n.tag}[${n.nthOfType}]`)
      .join('/');
    candidates.push({
      type: 'xpath',
      strategy: 'full-path',
      value: `/${fullPath}`
    });

    // Deduplicate
    const seen = new Set();
    return candidates.filter(c => {
      if (seen.has(c.value)) return false;
      seen.add(c.value);
      return true;
    });
  }

  // ---------------------------------------------------------------------------
  // Nth-match positional strategy
  // ---------------------------------------------------------------------------

  /**
   * For selectors that match N > 1 elements on the page (i.e. non-unique but
   * semantically correct, like button[aria-label="Draw"]), we look for the
   * shortest base selector that:
   *   a) matches this element among its siblings, AND
   *   b) can be expressed as :nth-match / [N] so the scraper knows "pick the
   *      2nd draw button" rather than failing because the selector isn't unique.
   *
   * Returned candidates have type 'css-nth' or 'xpath-nth' and carry an extra
   * `nth` field with { index (1-based), total }.  They are NOT run through
   * isUnique() – by definition they match multiple elements.
   */
  function generateNthMatchCandidates(ctx) {
    const el = ctx.element;
    const elInfo = ctx.path[ctx.path.length - 1];
    const candidates = [];

    // Build a list of base selectors worth trying (no random/generated values)
    const cssBaseCandidates = [];
    const xpathBaseCandidates = [];

    // aria-label (the canonical example: "Remis: 22" → "Remis")
    const ariaLabel = (elInfo.attributes || {})['aria-label'];
    if (ariaLabel && !isRandomLike(ariaLabel) && ariaLabel.length <= 80) {
      // Try with the full label AND with just the part before a colon/number
      // e.g. "Remis: 22" → also try "Remis"
      cssBaseCandidates.push(`${elInfo.tag}${cssAttrEquals('aria-label', ariaLabel)}`);
      xpathBaseCandidates.push(`//${elInfo.tag}[@aria-label=${xpathEscape(ariaLabel)}]`);

      const labelRoot = ariaLabel.split(/[:\s\d]/)[0].trim();
      if (labelRoot && labelRoot !== ariaLabel) {
        const escapedRoot = String(labelRoot).replace(/"/g, '\\"');
        cssBaseCandidates.push(`${elInfo.tag}[aria-label^="${escapedRoot}"]`);
        xpathBaseCandidates.push(
          `//${elInfo.tag}[starts-with(@aria-label, ${xpathEscape(labelRoot)})]`
        );
      }
    }

    // Stable non-random data-* and semantic attributes
    for (const [name, value] of Object.entries(elInfo.attributes || {})) {
      if (!value || isRandomLike(value) || value.length > 80) continue;
      if (name === 'id' || name === 'class') continue;
      if (name === 'aria-label') continue; // already handled above
      cssBaseCandidates.push(`${elInfo.tag}${cssAttrEquals(name, value)}`);
      xpathBaseCandidates.push(`//${elInfo.tag}[@${name}=${xpathEscape(value)}]`);
    }

    // Stable classes
    const stableClasses = (elInfo.classList || []).filter(isStableClass);
    if (stableClasses.length) {
      const classCombo = elInfo.tag + stableClasses.slice(0, 2).map(c => `.${cssEscape(c)}`).join('');
      cssBaseCandidates.push(classCombo);
    }

    // Text content
    if (ctx.text && ctx.text.length >= 1 && ctx.text.length <= 64) {
      xpathBaseCandidates.push(
        `//${elInfo.tag}[normalize-space(.)=${xpathEscape(ctx.text)}]`
      );
    }

    // For each base CSS selector that matches more than one element, compute
    // the 1-based position of `el` within that NodeList.
    for (const base of cssBaseCandidates) {
      try {
        const nodes = Array.from(document.querySelectorAll(base));
        const idx = nodes.indexOf(el); // -1 if not found
        if (idx === -1 || nodes.length <= 1) continue; // unique → handled elsewhere
        candidates.push({
          type: 'css-nth',
          strategy: 'nth-match',
          base,
          nth: { index: idx + 1, total: nodes.length },
          // CSS :nth-of-type can't do this generically; use the positional
          // form that scraper engines understand:  (selector)[N]
          value: `(${base}):nth-match(${idx + 1})`, // Playwright / modern CSS
          valueAlt: base, // raw selector + position stored in nth
        });
      } catch (_) { /* invalid selector */ }
    }

    // For each base XPath that matches multiple elements, record the position.
    for (const base of xpathBaseCandidates) {
      try {
        const res = document.evaluate(
          base, document, null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
        );
        if (res.snapshotLength <= 1) continue; // unique → handled elsewhere
        let idx = -1;
        for (let i = 0; i < res.snapshotLength; i++) {
          if (res.snapshotItem(i) === el) { idx = i; break; }
        }
        if (idx === -1) continue;
        candidates.push({
          type: 'xpath-nth',
          strategy: 'nth-match',
          base,
          nth: { index: idx + 1, total: res.snapshotLength },
          // Standard XPath positional: (//tag[@attr="val"])[N]
          value: `(${base})[${idx + 1}]`,
          valueAlt: base,
        });
      } catch (_) { /* invalid xpath */ }
    }

    // Deduplicate by value
    const seen = new Set();
    return candidates.filter(c => {
      if (seen.has(c.value)) return false;
      seen.add(c.value);
      return true;
    });
  }

  // ---------------------------------------------------------------------------
  // Cross-syntax semantic deduplication
  // ---------------------------------------------------------------------------

  /**
   * Extract the "semantic core" of a selector so we can detect when a CSS
   * selector and an XPath selector are expressing exactly the same constraint.
   * e.g.  button[aria-label="Remis: 22"]  and  //button[@aria-label="Remis: 22"]
   * both reduce to  button|aria-label|Remis: 22
   */
  function semanticKey(candidate) {
    let v = candidate.value;
    // Strip XPath axis prefix
    v = v.replace(/^\/\//, '').replace(/^\//, '');
    // Normalise attribute syntax:  [@foo="bar"]  →  [foo="bar"]
    v = v.replace(/\[@/g, '[');
    // Normalise XPath string quotes to double-quotes
    v = v.replace(/\['([^']+)'\]/g, '["$1"]');
    // Collapse whitespace
    v = v.replace(/\s+/g, ' ').trim().toLowerCase();
    return v;
  }

  /**
   * Remove candidates whose semantic core has already appeared in a
   * higher-scored candidate. Keeps the best (highest-scored) representative
   * of each semantic group.
   */
  function deduplicateBySemantic(scored) {
    const seenKeys = new Set();
    return scored.filter(c => {
      const key = semanticKey(c);
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });
  }

  // ---------------------------------------------------------------------------
  // Uniqueness check & scoring
  // ---------------------------------------------------------------------------

  function isUnique(candidate, el) {
    if (candidate.type === 'css') return querySelectorUnique(candidate.value, el);
    if (candidate.type === 'xpath') return xpathUnique(candidate.value, el);
    return false;
  }

  const STRATEGY_SCORE = {
    // CSS
    'id':              100,
    'test-hook':        90,
    'data-attr':        70,
    'attr-aria-label':  65,
    'attr-name':        60,
    'attr-role':        55,
    'attr-placeholder': 50,
    'attr-for':         50,
    'attr-type':        40,
    'multi-class':      45,
    'class':            35,
    'leaf-only':        30,
    'parent+leaf':      25,
    'ancestor+leaf':    20,
    // XPath
    'aria-label':       65,
    'text-exact':       55,
    'text-contains':    45,
    'attr':             42,
    'ancestor+path':    22,
    'ancestor+path+pos':18,
    // Shared worst
    'nth-of-type':       5,
    'full-path':         2,
  };

  function scoreSelector(candidate) {
    const value = candidate.value;
    let score = STRATEGY_SCORE[candidate.strategy] ?? 15;

    // Penalise length (long selectors are fragile)
    score -= Math.max(0, value.length - 30) * 0.05;

    // Penalise positional indices (nth-of-type, [N] predicates)
    const indexMatches = value.match(/\[(\d+)\]|nth-of-type\(\d+\)|nth-child\(\d+\)/g) || [];
    score -= indexMatches.length * 3;

    // Small bias towards CSS (easier to read / debug)
    if (candidate.type === 'css') score += 1;

    candidate.score = score;
    return candidate;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Generate robust primary + fallback selectors for a DOM element.
   *
   * @param {Element} el - The target element.
   * @param {Object}  options - { actionType?: string, maxFallbacks?: number }
   * @returns {{ primary: object|null, fallbacks: Array<object>, meta: object }}
   */
  function getSelectorsForElement(el, options = {}) {
    const ctx = buildContext(el);

    if (typeof window.sendToNode === 'function') {
      window.sendToNode(ctx);
    }

    // --- Unique selectors (match exactly this element) ---
    const uniqueCandidates = [
      ...generateCssCandidates(ctx),
      ...generateXPathCandidates(ctx)
    ].filter(c => isUnique(c, el));

    // Score, sort, then remove semantically duplicate selectors
    // (e.g. CSS vs XPath expressing the exact same constraint).
    let scored = uniqueCandidates.map(scoreSelector).sort((a, b) => b.score - a.score);
    scored = deduplicateBySemantic(scored);

    // --- Nth-match candidates (selector matches N elements; el is the Nth) ---
    // Surfaced separately so the scraper can use positional targeting when needed.
    const nthCandidates = generateNthMatchCandidates(ctx)
      .map(c => { scoreSelector(c); return c; })
      .sort((a, b) => b.score - a.score);

    const primary = scored[0] || null;
    const maxFallbacks = typeof options.maxFallbacks === 'number' ? options.maxFallbacks : 3;
    const fallbacks = scored.slice(1, 1 + maxFallbacks);

    return {
      primary,
      fallbacks,
      // nth-match selectors are surfaced separately so the scraper can decide
      // whether to use positional targeting instead of (or alongside) unique ones.
      nthMatch: nthCandidates,
      meta: {
        all: scored,
        context: {
          text: ctx.text,
          pathLength: ctx.path.length
        },
        actionType: options.actionType || null
      }
    };
  }

  // Expose for SelectorTool.js
  window.SelectorGenerator = { getSelectorsForElement };
})();