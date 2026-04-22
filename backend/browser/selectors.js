(function () {
  // ===========================================================================
  // 1. Utilities – improved random detection & text normalisation
  // ===========================================================================

  function normalizeText(txt) {
    return (txt || '').replace(/\s+/g, ' ').trim();
  }

  /** True when a string looks like a generated/random token (hash, UUID, base64, timestamp, incremental ID) */
  function isRandomLike(value) {
    if (!value) return false;
    // Hex run of 8+ chars
    if (/[0-9a-f]{8,}/i.test(value)) return true;
    // Long unbroken string
    if (value.length > 32 && !/\s/.test(value)) return true;
    // UUID
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true;
    // Base64 (e.g. random tokens)
    if (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(value)) return true;
    // Unix timestamp or numeric id > 10 digits
    if (/^\d{10,13}$/.test(value)) return true;
    // Incremental pattern: text followed by number, e.g. "item_123", "user42"
    if (/^[a-z]+-?\d+$/i.test(value) && value.length > 8) return true;
    // Any value containing 'random', 'guid', 'temp' etc.
    if (/\b(random|guid|temp|tmp|draft|clone|copy)\b/i.test(value)) return true;
    return false;
  }

  /** Smart text cleaning – remove numbers, prices, dates while keeping meaningful words */
  function cleanText(text) {
    if (!text) return '';
    // Remove common dynamic patterns: prices, dates, times, percentages
    let cleaned = text
      .replace(/\b\d{1,3}(?:[.,]\d{2})?\s?[€$£%]\b/g, '')   // prices: 12.99€, $5
      .replace(/\b\d{1,2}[:]\d{2}\b/g, '')                    // times: 14:30
      .replace(/\b\d{1,4}[-/]\d{1,2}[-/]\d{2,4}\b/g, '')      // dates: 2024-12-31
      .replace(/\b\d+\s*(?:items?|pcs?|pieces?|people?)\b/gi, '') // "3 items"
      .replace(/\b\d+(?:\.\d+)?\b/g, '')                      // any standalone number
      .replace(/\s+/g, ' ')
      .trim();
    // If result is empty after cleaning, keep original short text (e.g. just "42" may be meaningful)
    if (cleaned.length === 0 && text.length <= 20) return text;
    return cleaned;
  }

  function splitClasses(cls) {
    return (cls || '').split(/\s+/).map(c => c.trim()).filter(Boolean);
  }

  function isStableId(id) {
    return !!id && !isRandomLike(id);
  }

  function isStableClass(cls) {
    if (!cls || isRandomLike(cls)) return false;
    // Skip pure state / utility classes that change often
    if (/^(active|hover|focus|disabled|selected|open|closed|visible|hidden|show|hide|is-|has-|ng-|v-|css-)/i.test(cls)) return false;
    return true;
  }

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

  // ===========================================================================
  // 2. Context extraction (enhanced with sibling/parent info)
  // ===========================================================================

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
        index: siblings.indexOf(node),
        nthOfType: sameTagSiblings.indexOf(node) + 1,
        // New: store the element itself for later queries
        element: node,
      });
      node = parent;
    }

    return {
      element: el,
      path,
      textRaw: normalizeText(el.innerText || el.textContent || ''),
      textCleaned: cleanText(normalizeText(el.innerText || el.textContent || '')),
    };
  }

  // ===========================================================================
  // 3. Uniqueness helpers
  // ===========================================================================

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
      const res = document.evaluate(expr, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return res.snapshotLength === 1 && res.snapshotItem(0) === el;
    } catch (_) {
      return false;
    }
  }

  // ===========================================================================
  // 4. Modern CSS pseudo‑class helpers
  // ===========================================================================

  /** Build a :has() selector that includes context from ancestors or children */
  function buildHasContextSelector(ctx, baseSelector, contextType = 'ancestor') {
    // Example: button:has(> span.icon)  or  div:has(> .child)
    if (contextType === 'child') {
      // Look for a unique child element inside the target
      const children = Array.from(ctx.element.children);
      for (let child of children.slice(0, 3)) {
        const childCtx = buildContext(child);
        const childSelector = generateSimpleSelector(childCtx.path[childCtx.path.length - 1], false);
        if (childSelector) {
          return `${baseSelector}:has(> ${childSelector})`;
        }
      }
    } else if (contextType === 'ancestor') {
      // Use a stable ancestor to qualify the target:  #stableContainer button
      for (let i = ctx.path.length - 2; i >= 0; i--) {
        const ancInfo = ctx.path[i];
        const ancSelector = generateSimpleSelector(ancInfo, true);
        if (ancSelector) {
          return `${ancSelector} ${baseSelector}`;
        }
      }
    }
    return null;
  }

  /** Generate a simple selector for a single node (no combinators) */
  function generateSimpleSelector(info, allowId = true) {
    if (allowId && isStableId(info.id)) return `#${cssEscape(info.id)}`;
    const stableClasses = (info.classList || []).filter(isStableClass);
    if (stableClasses.length) return `${info.tag}.${cssEscape(stableClasses[0])}`;
    return info.tag;
  }

  // ===========================================================================
  // 5. Relative positional selectors inside a list container
  // ===========================================================================

  /**
   * Find the nearest ancestor that acts as a "container" for a list,
   * then compute the element's index relative to siblings with same tag/class.
   */
  function getRelativeListPosition(ctx) {
    const el = ctx.element;
    let container = el.parentElement;
    let depth = 0;
    // Look up to 3 levels for a container that has at least 2 children similar to el
    while (container && depth < 4) {
      const children = Array.from(container.children);
      const similar = children.filter(c => c.tagName === el.tagName);
      if (similar.length >= 2 && similar.includes(el)) {
        const idx = similar.indexOf(el); // 0‑based
        return {
          containerSelector: generateSimpleSelector(buildContext(container).path[buildContext(container).path.length - 1], true),
          tag: el.tagName.toLowerCase(),
          index: idx + 1,
          total: similar.length,
        };
      }
      container = container.parentElement;
      depth++;
    }
    return null;
  }

  function generateRelativeListSelector(ctx) {
    const pos = getRelativeListPosition(ctx);
    if (!pos) return null;
    // Example: div.product-list > .product-item:nth-child(2)
    return `${pos.containerSelector} > ${pos.tag}:nth-child(${pos.index})`;
  }

  // ===========================================================================
  // 6. CSS candidate generation (improved – avoids over‑specificity)
  // ===========================================================================

  function buildMinimalCssSelector(ctx) {
    const el = ctx.element;
    const path = ctx.path;
    const leafInfo = path[path.length - 1];

    function nodeSegments(info, includeNth) {
      const segs = [];
      const stableClasses = (info.classList || []).filter(isStableClass);

      if (isStableId(info.id)) segs.push({ seg: `#${cssEscape(info.id)}`, specificity: 100 });
      for (const attr of ['data-testid', 'data-cy', 'data-qa', 'data-test', 'data-id']) {
        const v = (info.attributes || {})[attr];
        if (v && !isRandomLike(v)) segs.push({ seg: `${info.tag}${cssAttrEquals(attr, v)}`, specificity: 80 });
      }
      if (stableClasses.length >= 2) {
        const combo = info.tag + stableClasses.slice(0, 2).map(c => `.${cssEscape(c)}`).join('');
        segs.push({ seg: combo, specificity: 45 });
      }
      stableClasses.forEach(cls => segs.push({ seg: `${info.tag}.${cssEscape(cls)}`, specificity: 30 }));
      segs.push({ seg: info.tag, specificity: 10 });
      if (includeNth) segs.push({ seg: `${info.tag}:nth-of-type(${info.nthOfType})`, specificity: 5 });
      return segs;
    }

    // Try leaf only first
    const leafSegs = nodeSegments(leafInfo, true);
    for (const { seg } of leafSegs) {
      if (querySelectorUnique(seg, el)) return { value: seg, strategy: 'leaf-only' };
    }

    // Try with ancestor (up to 2 levels)
    for (let ancIdx = Math.max(0, path.length - 3); ancIdx < path.length - 1; ancIdx++) {
      const ancInfo = path[ancIdx];
      const ancSegs = nodeSegments(ancInfo, false); // don't use nth on ancestors
      for (const { seg: ancSeg } of ancSegs) {
        for (const leafSeg of leafSegs) {
          for (const combinator of [' > ', ' ']) {
            const full = `${ancSeg}${combinator}${leafSeg.seg}`;
            if (querySelectorUnique(full, el)) return { value: full, strategy: 'ancestor+leaf' };
          }
        }
      }
    }

    // Fallback: relative list position
    const listSel = generateRelativeListSelector(ctx);
    if (listSel && querySelectorUnique(listSel, el)) return { value: listSel, strategy: 'relative-list' };

    // Last resort: full path
    const fullPath = path.map(n => `${n.tag}:nth-of-type(${n.nthOfType})`).join(' > ');
    return { value: fullPath, strategy: 'full-path' };
  }

  function generateCssCandidates(ctx) {
    const elInfo = ctx.path[ctx.path.length - 1];
    const candidates = [];

    // 1. ID
    if (isStableId(elInfo.id)) candidates.push({ type: 'css', strategy: 'id', value: `#${cssEscape(elInfo.id)}` });

    // 2. Data attributes
    for (const attr of ['data-testid', 'data-cy', 'data-qa', 'data-test', 'data-id']) {
      const v = (elInfo.attributes || {})[attr];
      if (v && !isRandomLike(v)) candidates.push({ type: 'css', strategy: 'test-hook', value: `${elInfo.tag}${cssAttrEquals(attr, v)}` });
    }

    // 3. Other stable attributes
    for (const [name, value] of Object.entries(elInfo.attributes || {})) {
      if (['id', 'class', 'data-testid', 'data-cy', 'data-qa', 'data-test', 'data-id'].includes(name)) continue;
      if (value && !isRandomLike(value) && value.length <= 80) {
        candidates.push({ type: 'css', strategy: 'attr', value: `${elInfo.tag}${cssAttrEquals(name, value)}` });
      }
    }

    // 4. Classes
    const stableClasses = (elInfo.classList || []).filter(isStableClass);
    if (stableClasses.length >= 2) candidates.push({ type: 'css', strategy: 'multi-class', value: elInfo.tag + stableClasses.slice(0, 2).map(c => `.${cssEscape(c)}`).join('') });
    stableClasses.forEach(cls => candidates.push({ type: 'css', strategy: 'class', value: `.${cssEscape(cls)}` }));

    // 5. Minimal unique selector
    const minimal = buildMinimalCssSelector(ctx);
    candidates.push({ type: 'css', strategy: minimal.strategy, value: minimal.value });

    // 6. Contextual :has() selector (if supported)
    if (window.CSS && CSS.supports('selector(:has(div))')) {
      const base = generateSimpleSelector(elInfo, true);
      if (base) {
        const hasChild = buildHasContextSelector(ctx, base, 'child');
        if (hasChild && querySelectorUnique(hasChild, ctx.element)) candidates.push({ type: 'css', strategy: 'has-child', value: hasChild });
      }
    }

    // Deduplicate
    const seen = new Set();
    return candidates.filter(c => !seen.has(c.value) && seen.add(c.value));
  }

  // ===========================================================================
  // 7. XPath candidates (similar improvements)
  // ===========================================================================

  function xpathEscape(str) {
    const s = String(str);
    if (!s.includes('"')) return `"${s}"`;
    if (!s.includes("'")) return `'${s}'`;
    const parts = s.split('"').map((p, i, arr) => i < arr.length - 1 ? `"${p}", '"'` : `"${p}"`);
    return `concat(${parts.join(', ')})`;
  }

  function generateXPathCandidates(ctx) {
    const elInfo = ctx.path[ctx.path.length - 1];
    const candidates = [];

    if (isStableId(elInfo.id)) candidates.push({ type: 'xpath', strategy: 'id', value: `//*[@id=${xpathEscape(elInfo.id)}]` });
    for (const attr of ['data-testid', 'data-cy', 'data-qa', 'data-test']) {
      const v = (elInfo.attributes || {})[attr];
      if (v && !isRandomLike(v)) candidates.push({ type: 'xpath', strategy: 'test-hook', value: `//${elInfo.tag}[@${attr}=${xpathEscape(v)}]` });
    }
    const ariaLabel = (elInfo.attributes || {})['aria-label'];
    if (ariaLabel && !isRandomLike(ariaLabel)) candidates.push({ type: 'xpath', strategy: 'aria-label', value: `//${elInfo.tag}[@aria-label=${xpathEscape(ariaLabel)}]` });

    // Cleaned text
    if (ctx.textCleaned && ctx.textCleaned.length >= 2 && ctx.textCleaned.length <= 64) {
      candidates.push({ type: 'xpath', strategy: 'text-cleaned', value: `//${elInfo.tag}[normalize-space(.)=${xpathEscape(ctx.textCleaned)}]` });
    }

    // Ancestor + relative path (up to 2 levels)
    for (let i = Math.max(0, ctx.path.length - 3); i < ctx.path.length - 1; i++) {
      const anc = ctx.path[i];
      const ancSelector = isStableId(anc.id) ? `//*[@id=${xpathEscape(anc.id)}]` : `//${anc.tag}[contains(concat(' ', normalize-space(@class), ' '), ' ${(anc.classList || []).filter(isStableClass)[0]} ')]`;
      const relPath = ctx.path.slice(i + 1).map(n => n.tag).join('/');
      candidates.push({ type: 'xpath', strategy: 'ancestor+path', value: `${ancSelector}//${relPath}` });
      break;
    }

    // Fallback full path
    const fullPath = ctx.path.map(n => `${n.tag}[${n.nthOfType}]`).join('/');
    candidates.push({ type: 'xpath', strategy: 'full-path', value: `/${fullPath}` });

    const seen = new Set();
    return candidates.filter(c => !seen.has(c.value) && seen.add(c.value));
  }

  // ===========================================================================
  // 8. Nth‑match for non‑unique but semantic selectors (improved)
  // ===========================================================================

  function generateNthMatchCandidates(ctx) {
    const el = ctx.element;
    const elInfo = ctx.path[ctx.path.length - 1];
    const candidates = [];

    // Base candidates that may match multiple
    const bases = [];

    const ariaLabel = (elInfo.attributes || {})['aria-label'];
    if (ariaLabel && !isRandomLike(ariaLabel)) {
      bases.push({ type: 'css', value: `${elInfo.tag}${cssAttrEquals('aria-label', ariaLabel)}` });
      bases.push({ type: 'xpath', value: `//${elInfo.tag}[@aria-label=${xpathEscape(ariaLabel)}]` });
      const root = ariaLabel.split(/[:\s\d]/)[0];
      if (root && root !== ariaLabel) bases.push({ type: 'css', value: `${elInfo.tag}[aria-label^="${cssEscape(root)}"]` });
    }

    for (const [name, value] of Object.entries(elInfo.attributes || {})) {
      if (['id', 'class', 'aria-label'].includes(name)) continue;
      if (value && !isRandomLike(value) && value.length <= 80) {
        bases.push({ type: 'css', value: `${elInfo.tag}${cssAttrEquals(name, value)}` });
        bases.push({ type: 'xpath', value: `//${elInfo.tag}[@${name}=${xpathEscape(value)}]` });
      }
    }

    if (ctx.textCleaned && ctx.textCleaned.length >= 2 && ctx.textCleaned.length <= 64) {
      bases.push({ type: 'xpath', value: `//${elInfo.tag}[normalize-space(.)=${xpathEscape(ctx.textCleaned)}]` });
    }

    for (const base of bases) {
      try {
        let nodes;
        if (base.type === 'css') nodes = Array.from(document.querySelectorAll(base.value));
        else {
          const res = document.evaluate(base.value, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          nodes = Array.from({ length: res.snapshotLength }, (_, i) => res.snapshotItem(i));
        }
        const idx = nodes.indexOf(el);
        if (idx !== -1 && nodes.length > 1) {
          candidates.push({
            type: `${base.type}-nth`,
            strategy: 'nth-match',
            base: base.value,
            nth: { index: idx + 1, total: nodes.length },
            value: base.type === 'css' ? `(${base.value}):nth-match(${idx + 1})` : `(${base.value})[${idx + 1}]`,
          });
        }
      } catch (_) {}
    }
    return candidates;
  }

  // ===========================================================================
  // 9. Scoring & uniqueness
  // ===========================================================================

  const STRATEGY_SCORE = {
    'id': 100, 'test-hook': 90, 'attr': 70, 'aria-label': 65, 'multi-class': 45,
    'class': 35, 'leaf-only': 30, 'ancestor+leaf': 25, 'has-child': 28,
    'relative-list': 22, 'text-cleaned': 55, 'ancestor+path': 20, 'full-path': 2,
  };

  function scoreSelector(candidate) {
    let score = STRATEGY_SCORE[candidate.strategy] || 15;
    score -= Math.max(0, candidate.value.length - 40) * 0.1;
    const indexMatches = candidate.value.match(/nth-match|nth-of-type|nth-child|\[\d+\]/g) || [];
    score -= indexMatches.length * 5;
    if (candidate.type === 'css') score += 2;
    candidate.score = Math.max(0, Math.min(100, score));
    return candidate;
  }

  function isUnique(candidate, el) {
    if (candidate.type === 'css') return querySelectorUnique(candidate.value, el);
    if (candidate.type === 'xpath') return xpathUnique(candidate.value, el);
    return false;
  }

  // ===========================================================================
  // 10. Puppeteer locator generation
  // ===========================================================================

  function toPuppeteerLocator(candidate, pageVar = 'page') {
    if (!candidate) return null;
    if (candidate.type === 'css') {
      return `${pageVar}.locator("${candidate.value.replace(/"/g, '\\"')}")`;
    } else if (candidate.type === 'xpath') {
      return `${pageVar}.locator("xpath=${candidate.value}")`;
    } else if (candidate.type === 'css-nth') {
      // For nth-match, Playwright supports :nth-match() directly
      return `${pageVar}.locator("${candidate.value}")`;
    } else if (candidate.type === 'xpath-nth') {
      return `${pageVar}.locator("xpath=${candidate.value}")`;
    }
    return null;
  }

  // ===========================================================================
  // 11. Find similar elements (based on tag, attributes, text, structure)
  // ===========================================================================

  function similarityScore(elA, elB) {
    let score = 0;
    const ctxA = buildContext(elA);
    const ctxB = buildContext(elB);
    const infoA = ctxA.path[ctxA.path.length - 1];
    const infoB = ctxB.path[ctxB.path.length - 1];

    if (infoA.tag === infoB.tag) score += 20;
    const commonClasses = infoA.classList.filter(c => infoB.classList.includes(c));
    score += commonClasses.length * 5;
    const commonAttrs = Object.keys(infoA.attributes).filter(attr => infoB.attributes[attr] === infoA.attributes[attr]);
    score += commonAttrs.length * 3;
    if (ctxA.textCleaned === ctxB.textCleaned) score += 15;
    else if (ctxA.textCleaned && ctxB.textCleaned && ctxA.textCleaned.includes(ctxB.textCleaned)) score += 5;

    // Structure: same depth
    if (ctxA.path.length === ctxB.path.length) score += 5;
    return Math.min(100, score);
  }

  function findSimilarElements(targetElement, options = { threshold: 50, maxResults: 10 }) {
    const allElements = document.querySelectorAll('*');
    const similarities = [];
    for (let el of allElements) {
      if (el === targetElement) continue;
      const score = similarityScore(targetElement, el);
      if (score >= options.threshold) similarities.push({ element: el, score });
    }
    similarities.sort((a, b) => b.score - a.score);
    return similarities.slice(0, options.maxResults).map(s => s.element);
  }

  // ===========================================================================
  // 12. Selector for multiple selected elements (common pattern)
  // ===========================================================================

  function getCommonSelectorForElements(elements, options = {}) {
    if (!elements || elements.length === 0) return null;
    if (elements.length === 1) return getSelectorsForElement(elements[0], options).primary;

    // Try to find a common parent container
    let commonParent = elements[0].parentElement;
    for (let i = 1; i < elements.length; i++) {
      let parent = elements[i].parentElement;
      while (parent && commonParent && parent !== commonParent) {
        if (commonParent.contains(parent)) break;
        parent = parent.parentElement;
      }
      commonParent = parent;
      if (!commonParent) break;
    }

    if (commonParent) {
      const children = Array.from(commonParent.children);
      const indices = elements.map(el => children.indexOf(el)).filter(i => i !== -1);
      if (indices.length === elements.length) {
        // All are direct children of same parent → use :nth-child() ranges?
        const tag = elements[0].tagName.toLowerCase();
        const allSameTag = elements.every(el => el.tagName === elements[0].tagName);
        if (allSameTag && indices.length > 1) {
          // e.g. div.container > button:nth-child(2), button:nth-child(5)
          const nthSelectors = indices.map(idx => `${tag}:nth-child(${idx + 1})`).join(', ');
          const parentSelector = generateSimpleSelector(buildContext(commonParent).path[buildContext(commonParent).path.length - 1], true);
          if (parentSelector) return { type: 'css', value: `${parentSelector} > ${nthSelectors}`, strategy: 'multiple-children' };
        }
      }
    }

    // Fallback: generate selector for each element and return array
    const selectors = elements.map(el => getSelectorsForElement(el, options).primary?.value).filter(Boolean);
    return { type: 'multiple', values: selectors, strategy: 'fallback-list' };
  }

  // ===========================================================================
  // 13. Main public API
  // ===========================================================================

  function getSelectorsForElement(el, options = {}) {
    const ctx = buildContext(el);
    const uniqueCandidates = [...generateCssCandidates(ctx), ...generateXPathCandidates(ctx)].filter(c => isUnique(c, el));
    let scored = uniqueCandidates.map(scoreSelector).sort((a, b) => b.score - a.score);
    const primary = scored[0] || null;
    const fallbacks = scored.slice(1, options.maxFallbacks || 3);
    const nthMatch = generateNthMatchCandidates(ctx).map(scoreSelector).sort((a, b) => b.score - a.score);
    const puppeteer = primary ? toPuppeteerLocator(primary) : null;

    return {
      primary,
      fallbacks,
      nthMatch,
      puppeteerLocator: puppeteer,
      meta: {
        textRaw: ctx.textRaw,
        textCleaned: ctx.textCleaned,
        pathLength: ctx.path.length,
      },
    };
  }

  window.SelectorGenerator = {
    getSelectorsForElement,
    findSimilarElements,
    getCommonSelectorForElements,
    toPuppeteerLocator,
  };
})();