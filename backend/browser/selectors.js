(function () {
  'use strict';

  /* =========================================================================
     CONSTANTS & CONFIGURATION
     ========================================================================= */

  // Attributes checked in strict priority order for test/automation IDs
  const TEST_ID_ATTRS = [
    'data-testid', 'data-test-id', 'data-test',
    'data-cy', 'data-qa', 'data-e2e',
    'data-automation', 'data-automation-id',
    'data-id',
  ];

  // Semantic attributes that are stable and meaningful
  const SEMANTIC_ATTRS = [
    'aria-label', 'aria-labelledby', 'aria-describedby',
    'name', 'placeholder', 'title', 'alt',
    'role', 'type', 'for', 'href',
    'src', 'action', 'method',
    'value',   // for buttons/inputs with fixed values
  ];

  // Classes that indicate dynamic/state/utility — never use as stable identifiers
  const UNSTABLE_CLASS_PATTERNS = [
    // State classes
    /^(is-|has-|js-)/,
    /^(active|inactive|open|closed|expanded|collapsed|visible|hidden|show|hide)$/,
    /^(selected|current|checked|disabled|enabled|loading|loaded|error|success|warning)$/,
    /^(hover|focus|focused|pressed|dragging|dragged|over|highlighted)$/,
    /^(first|last|odd|even|middle)$/,
    // Tailwind bare utility words (no hyphen)
    /^(flex|grid|block|inline|hidden|visible|relative|absolute|fixed|sticky|static)$/,
    /^(container|clearfix|italic|underline|uppercase|lowercase|capitalize|truncate|antialiased)$/,
    // Tailwind utilities (single word + optional number)
    /^(m|p|mx|my|px|py|mt|mb|ml|mr|pt|pb|pl|pr)-/,
    /^(w|h|min-w|max-w|min-h|max-h)-/,
    /^(text|font|leading|tracking|align|indent)-/,
    /^(bg|border|ring|shadow|outline|divide|space)-/,
    /^(flex|grid|col|row|gap|justify|items|content|self|place)-/,
    /^(block|inline|hidden|visible|relative|absolute|fixed|sticky|overflow|z)-/,
    /^(rounded|opacity|cursor|pointer|select|resize|appearance|object)-/,
    /^(transition|transform|scale|rotate|translate|skew|origin)-/,
    /^(duration|ease|delay|animate|sr)-/,
    // Bootstrap utilities
    /^(d-|g-|p-|m-|ms-|me-|ps-|pe-|mt-|mb-|fw-|fs-|text-|bg-|border-|rounded|float-|order-|col-|row-|offset-)/,
    // CSS Modules hash pattern (e.g., styles__btn__3Ab9x)
    /_{2}[a-zA-Z0-9_-]+_{2}[A-Za-z0-9_-]{4,}$/,
    // Pure random / hash-like
    /^[a-f0-9]{6,}$/i,
    // Very long single-word classes with no semantic meaning
  ];

  // Attributes to always skip when building selectors
  const SKIP_ATTRS = new Set([
    'class', 'style', 'tabindex', 'xmlns',
    'onfocus', 'onblur', 'onclick', 'onchange',
    'onmouseenter', 'onmouseleave', 'onkeydown', 'onkeyup',
  ]);

  /* =========================================================================
     UTILITY FUNCTIONS
     ========================================================================= */

  function normalizeText(txt) {
    return (txt || '').replace(/\s+/g, ' ').trim();
  }

  /** True if a string looks like a generated/random token */
  function isRandomLike(value) {
    if (!value) return false;
    const s = String(value);
    // Hex hash segments
    if (/[0-9a-f]{8,}/i.test(s)) return true;
    // Long underscore/dash separated hash
    if (s.length > 40 && !/\s/.test(s)) return true;
    // Looks like a UUID
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
    return false;
  }

  function isUnstableClass(cls) {
    if (!cls) return true;
    if (isRandomLike(cls)) return true;
    return UNSTABLE_CLASS_PATTERNS.some(pattern => pattern.test(cls));
  }

  function isStableClass(cls) {
    return !!cls && !isUnstableClass(cls);
  }

  function isStableId(id) {
    return !!id && !isRandomLike(id) && !/^\d+$/.test(id);
  }

  function splitClasses(cls) {
    return (cls || '').split(/\s+/).map(c => c.trim()).filter(Boolean);
  }

  function getStableClasses(el) {
    return splitClasses(el.className).filter(isStableClass);
  }

  /** CSS-escape a string for use in selectors */
  function cssEscape(str) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(String(str));
    return String(str).replace(/([ !"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1')
                      .replace(/^(\d)/, '\\3$1 ');
  }

  /** Escape a value for use inside CSS attribute selectors [attr="..."] */
  function cssAttrValue(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /** XPath string literal, handling both quote types */
  function xpathString(str) {
    const s = String(str);
    if (!s.includes("'")) return `'${s}'`;
    if (!s.includes('"')) return `"${s}"`;
    const parts = s.split("'");
    return `concat('${parts.join("', \"'\", '")}')`;
  }

  /* =========================================================================
     UNIQUENESS CHECK
     ========================================================================= */

  /**
   * Returns the number of elements matched by this selector.
   * Returns -1 if the selector throws an error.
   */
  function countMatches(selector, type = 'css') {
    try {
      if (type === 'css') {
        return document.querySelectorAll(selector).length;
      } else {
        const result = document.evaluate(
          selector, document, null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
        );
        return result.snapshotLength;
      }
    } catch (_) {
      return -1;
    }
  }

  function getMatchedEl(selector, type = 'css', index = 0) {
    try {
      if (type === 'css') {
        return document.querySelectorAll(selector)[index] || null;
      } else {
        const result = document.evaluate(
          selector, document, null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
        );
        return result.snapshotItem(index);
      }
    } catch (_) {
      return null;
    }
  }

  function isUnique(selector, el, type = 'css') {
    const n = countMatches(selector, type);
    if (n !== 1) return false;
    return getMatchedEl(selector, type) === el;
  }

  function matchesEl(selector, el, type = 'css') {
    try {
      if (type === 'css') {
        return el.matches(selector);
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  /* =========================================================================
     CONTEXT EXTRACTION
     Build a full ancestor chain with rich per-node info.
     ========================================================================= */

  function buildNodeInfo(node) {
    const attrs = {};
    for (let i = 0; i < node.attributes.length; i++) {
      attrs[node.attributes[i].name] = node.attributes[i].value;
    }
    const parent   = node.parentElement;
    const siblings = parent ? Array.from(parent.children) : [];
    const sameTag  = siblings.filter(s => s.tagName === node.tagName);

    return {
      el:           node,
      tag:          node.tagName.toLowerCase(),
      id:           node.id || null,
      classList:    splitClasses(node.className),
      stableClasses: getStableClasses(node),
      attributes:   attrs,
      nthChild:     siblings.indexOf(node) + 1,
      nthOfType:    sameTag.indexOf(node) + 1,
      onlyChild:    siblings.length === 1,
      onlyOfType:   sameTag.length === 1,
    };
  }

  function buildContext(el) {
    const chain = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      chain.unshift(buildNodeInfo(node));
      node = node.parentElement;
    }

    const elInfo = chain[chain.length - 1];
    const text   = normalizeText(el.innerText || el.textContent || '');
    const innerText = normalizeText(el.innerText || '');

    return { el, chain, elInfo, text, innerText };
  }

  /* =========================================================================
     CSS CANDIDATE GENERATION
     ========================================================================= */

  /**
   * Build a minimal CSS selector string for a single node,
   * with optional disambiguation suffix (:nth-child / :nth-of-type).
   */
  function nodeToCss(info, disambiguate = 'none') {
    const { tag, id, stableClasses, attributes } = info;

    // Prefer id
    if (isStableId(id)) return `#${cssEscape(id)}`;

    // Test ID
    for (const attr of TEST_ID_ATTRS) {
      const val = attributes[attr];
      if (val && !isRandomLike(val)) return `[${attr}="${cssAttrValue(val)}"]`;
    }

    // Tag + stable classes
    const clsPart = stableClasses.slice(0, 3).map(c => `.${cssEscape(c)}`).join('');
    const base    = tag + clsPart;

    if (disambiguate === 'nth-child')   return `${base}:nth-child(${info.nthChild})`;
    if (disambiguate === 'nth-of-type') return `${base}:nth-of-type(${info.nthOfType})`;
    return base;
  }

  /**
   * Build the shortest unique CSS path from some ancestor index to the leaf.
   * Tries progressively longer paths until unique.
   */
  function buildCssPath(chain, el, maxLen = chain.length) {
    for (let start = chain.length - 1; start >= Math.max(0, chain.length - maxLen); start--) {
      const parts = chain.slice(start).map((info, i, arr) => {
        const isLast = i === arr.length - 1;
        // Add nth disambiguation only for last node if needed
        if (isLast) return nodeToCss(info, 'none');
        return nodeToCss(info, 'none');
      });

      const selector = parts.join(' > ');
      if (isUnique(selector, el)) return selector;

      // Try with nth-of-type on last node
      const partsNth = [...parts];
      partsNth[partsNth.length - 1] = nodeToCss(chain[chain.length - 1], 'nth-of-type');
      const selectorNth = partsNth.join(' > ');
      if (isUnique(selectorNth, el)) return selectorNth;
    }
    return null;
  }

  function generateCssCandidates(ctx) {
    const { el, chain, elInfo } = ctx;
    const candidates = [];

    const add = (value, strategy, priority = 0) => {
      if (value && countMatches(value) >= 0) {
        candidates.push({ type: 'css', strategy, value, priority });
      }
    };

    // ── Tier 1: Test/automation IDs (most stable) ────────────────────────
    for (const attr of TEST_ID_ATTRS) {
      const val = elInfo.attributes[attr];
      if (val && !isRandomLike(val)) {
        add(`[${attr}="${cssAttrValue(val)}"]`, 'test-id', 100);
        add(`${elInfo.tag}[${attr}="${cssAttrValue(val)}"]`, 'test-id-tag', 99);
      }
    }

    // ── Tier 2: Stable #id ───────────────────────────────────────────────
    if (isStableId(elInfo.id)) {
      add(`#${cssEscape(elInfo.id)}`, 'id', 95);
    }

    // ── Tier 3: ARIA attributes ──────────────────────────────────────────
    const ariaAttrs = ['aria-label', 'aria-labelledby', 'aria-describedby'];
    for (const attr of ariaAttrs) {
      const val = elInfo.attributes[attr];
      if (val && !isRandomLike(val)) {
        add(`${elInfo.tag}[${attr}="${cssAttrValue(val)}"]`, 'aria', 85);
        add(`[${attr}="${cssAttrValue(val)}"]`, 'aria-global', 84);
      }
    }

    // ── Tier 4: Semantic input/form attributes ───────────────────────────
    const semanticInputAttrs = ['name', 'placeholder', 'for', 'type'];
    if (['input', 'select', 'textarea', 'button', 'label'].includes(elInfo.tag)) {
      for (const attr of semanticInputAttrs) {
        const val = elInfo.attributes[attr];
        if (val && !isRandomLike(val)) {
          add(`${elInfo.tag}[${attr}="${cssAttrValue(val)}"]`, 'semantic-input', 80);
        }
      }
      // Combined: input[type="email"][name="email"]
      const type = elInfo.attributes['type'];
      const name = elInfo.attributes['name'];
      if (type && name && !isRandomLike(name)) {
        add(`${elInfo.tag}[type="${cssAttrValue(type)}"][name="${cssAttrValue(name)}"]`, 'type+name', 82);
      }
    }

    // ── Tier 5: href for anchors, src for images ─────────────────────────
    if (elInfo.tag === 'a') {
      const href = elInfo.attributes['href'];
      if (href && !isRandomLike(href) && href !== '#' && href.length < 120) {
        add(`a[href="${cssAttrValue(href)}"]`, 'href', 78);
        // Partial href match for cleaner URLs
        if (href.startsWith('/') || href.startsWith('http')) {
          add(`a[href*="${cssAttrValue(href.split('?')[0])}"]`, 'href-contains', 70);
        }
      }
    }
    if (elInfo.tag === 'img') {
      const alt = elInfo.attributes['alt'];
      if (alt && alt.trim()) add(`img[alt="${cssAttrValue(alt)}"]`, 'img-alt', 75);
    }

    // ── Tier 6: data-* attributes (non-test) ────────────────────────────
    for (const [attr, val] of Object.entries(elInfo.attributes)) {
      if (!attr.startsWith('data-') || TEST_ID_ATTRS.includes(attr)) continue;
      if (!val || isRandomLike(val)) continue;
      add(`${elInfo.tag}[${attr}="${cssAttrValue(val)}"]`, 'data-attr', 72);
      add(`[${attr}="${cssAttrValue(val)}"]`, 'data-attr-global', 70);
    }

    // ── Tier 7: role attribute ───────────────────────────────────────────
    const role = elInfo.attributes['role'];
    if (role && !isRandomLike(role)) {
      add(`[role="${cssAttrValue(role)}"]`, 'role', 65);
    }

    // ── Tier 8: Multi-class combination (most specific stable classes) ───
    const stableCls = elInfo.stableClasses;
    if (stableCls.length >= 2) {
      // Best 2 and best 3 class combos
      const two   = stableCls.slice(0, 2).map(c => `.${cssEscape(c)}`).join('');
      const three = stableCls.slice(0, 3).map(c => `.${cssEscape(c)}`).join('');
      add(`${elInfo.tag}${two}`,   'multi-class-2', 62);
      add(`${elInfo.tag}${three}`, 'multi-class-3', 61);
      add(two,   'multi-class-2-notag', 58);
      add(three, 'multi-class-3-notag', 57);
    }

    // ── Tier 9: Single stable class ─────────────────────────────────────
    for (const cls of stableCls.slice(0, 3)) {
      add(`${elInfo.tag}.${cssEscape(cls)}`, 'class-tag', 55);
      add(`.${cssEscape(cls)}`,              'class',     50);
    }

    // ── Tier 10: BEM partial class match ────────────────────────────────
    for (const cls of stableCls) {
      // Only for classes with double-underscore (BEM element) or double-dash (BEM modifier)
      if (cls.includes('__') || cls.includes('--')) {
        const base = cls.split('__')[0].split('--')[0];
        if (base.length >= 3) {
          add(`${elInfo.tag}[class*="${cssAttrValue(cls)}"]`, 'bem-contains', 45);
        }
      }
    }

    // ── Tier 11: Ancestor-scoped selectors ───────────────────────────────
    // Walk ancestors to find the most specific stable anchor, then scope to it
    for (let i = chain.length - 2; i >= 0; i--) {
      const anc = chain[i];

      // Ancestor anchor candidates in priority
      const anchorCandidates = [];

      // Test ID on ancestor
      for (const attr of TEST_ID_ATTRS) {
        const val = anc.attributes[attr];
        if (val && !isRandomLike(val)) {
          anchorCandidates.push(`[${attr}="${cssAttrValue(val)}"]`);
          break;
        }
      }

      if (isStableId(anc.id)) anchorCandidates.push(`#${cssEscape(anc.id)}`);

      const ancAria = anc.attributes['aria-label'];
      if (ancAria && !isRandomLike(ancAria)) {
        anchorCandidates.push(`${anc.tag}[aria-label="${cssAttrValue(ancAria)}"]`);
      }

      if (anc.stableClasses.length >= 2) {
        const two = anc.stableClasses.slice(0, 2).map(c => `.${cssEscape(c)}`).join('');
        anchorCandidates.push(`${anc.tag}${two}`);
      } else if (anc.stableClasses.length === 1) {
        anchorCandidates.push(`${anc.tag}.${cssEscape(anc.stableClasses[0])}`);
      }

      if (!anchorCandidates.length) continue;

      // Build the tail (from ancestor+1 to leaf)
      const tailChain = chain.slice(i + 1);
      const tailSimple = tailChain.map(n => n.tag).join(' > ');
      const tailClassed = tailChain.map((n, ti) => {
        if (ti === tailChain.length - 1) {
          // Last node — use classes for specificity
          if (n.stableClasses.length) return `${n.tag}.${cssEscape(n.stableClasses[0])}`;
        }
        return n.tag;
      }).join(' > ');

      for (const anchor of anchorCandidates.slice(0, 2)) {
        const priority = anchor.startsWith('#') ? 68 : anchor.includes('test') ? 72 : 60;
        add(`${anchor} ${elInfo.tag}`,       'ancestor+tag',       priority - 2);
        if (stableCls[0]) {
          add(`${anchor} .${cssEscape(stableCls[0])}`, 'ancestor+class', priority);
          add(`${anchor} ${elInfo.tag}.${cssEscape(stableCls[0])}`, 'ancestor+class-tag', priority + 1);
        }
        if (tailChain.length > 0 && tailChain.length <= 4) {
          add(`${anchor} > ${tailClassed}`, 'ancestor+path-classed', priority - 1);
          add(`${anchor} > ${tailSimple}`,  'ancestor+path',         priority - 3);
        }
      }
      break; // Stop at first useful ancestor tier
    }

    // ── Tier 12: Shortest unique CSS path (structural, bottom-up) ────────
    const structuralPath = buildCssPath(chain, el, 6);
    if (structuralPath) add(structuralPath, 'structural-path', 40);

    // ── Tier 13: Full structural path with nth disambig ──────────────────
    const fullPath = chain.map((info, i) => {
      const isLast = i === chain.length - 1;
      if (isLast) return nodeToCss(info, 'nth-of-type');
      if (isStableId(info.id)) return `#${cssEscape(info.id)}`;
      if (info.stableClasses.length) return `${info.tag}.${cssEscape(info.stableClasses[0])}`;
      return `${info.tag}:nth-child(${info.nthChild})`;
    }).join(' > ');
    add(fullPath, 'full-path', 20);

    return candidates;
  }

  /* =========================================================================
     XPATH CANDIDATE GENERATION
     ========================================================================= */

  function generateXPathCandidates(ctx) {
    const { el, chain, elInfo, text, innerText } = ctx;
    const candidates = [];

    const add = (value, strategy, priority = 0) => {
      if (value) candidates.push({ type: 'xpath', strategy, value, priority });
    };

    // ── Tier 1: Test ID attributes ────────────────────────────────────────
    for (const attr of TEST_ID_ATTRS) {
      const val = elInfo.attributes[attr];
      if (val && !isRandomLike(val)) {
        add(`//*[@${attr}=${xpathString(val)}]`,                   'test-id',     100);
        add(`//${elInfo.tag}[@${attr}=${xpathString(val)}]`,        'test-id-tag', 99);
      }
    }

    // ── Tier 2: Stable ID ────────────────────────────────────────────────
    if (isStableId(elInfo.id)) {
      add(`//*[@id=${xpathString(elInfo.id)}]`,           'id',     95);
      add(`//${elInfo.tag}[@id=${xpathString(elInfo.id)}]`, 'id-tag', 94);
    }

    // ── Tier 3: ARIA label ───────────────────────────────────────────────
    const ariaLabel = elInfo.attributes['aria-label'];
    if (ariaLabel && !isRandomLike(ariaLabel)) {
      add(`//${elInfo.tag}[@aria-label=${xpathString(ariaLabel)}]`, 'aria-label', 88);
    }

    // ── Tier 4: Exact text match (≤80 chars, visible text) ──────────────
    if (innerText && innerText.length >= 2 && innerText.length <= 80) {
      // Exact match is most precise
      add(`//${elInfo.tag}[normalize-space(.)=${xpathString(innerText)}]`,
          'text-exact', 82);
      // Fallback: contains
      add(`//${elInfo.tag}[contains(normalize-space(.), ${xpathString(innerText)})]`,
          'text-contains', 75);
    }

    // ── Tier 5: Semantic attributes ─────────────────────────────────────
    const semanticAttrPriority = {
      'name':        80, 'placeholder': 79, 'alt':   78,
      'title':       76, 'value':       72, 'href':  70,
      'role':        65, 'type':        60, 'for':   68,
    };
    for (const [attr, priority] of Object.entries(semanticAttrPriority)) {
      const val = elInfo.attributes[attr];
      if (!val || isRandomLike(val)) continue;
      if (attr === 'href' && (val === '#' || val.length > 120)) continue;
      add(`//${elInfo.tag}[@${attr}=${xpathString(val)}]`, `attr-${attr}`, priority);
    }

    // ── Tier 6: data-* attributes ───────────────────────────────────────
    for (const [attr, val] of Object.entries(elInfo.attributes)) {
      if (!attr.startsWith('data-') || TEST_ID_ATTRS.includes(attr)) continue;
      if (!val || isRandomLike(val)) continue;
      add(`//${elInfo.tag}[@${attr}=${xpathString(val)}]`, 'data-attr', 70);
    }

    // ── Tier 7: Class-based XPath (single stable class) ─────────────────
    for (const cls of elInfo.stableClasses.slice(0, 2)) {
      add(
        `//${elInfo.tag}[contains(concat(' ', normalize-space(@class), ' '), ${xpathString(' ' + cls + ' ')})]`,
        'class', 55
      );
    }

    // ── Tier 8: Ancestor-anchored path ───────────────────────────────────
    for (let i = chain.length - 2; i >= 0; i--) {
      const anc = chain[i];

      let ancXPath = null;
      for (const attr of TEST_ID_ATTRS) {
        const val = anc.attributes[attr];
        if (val && !isRandomLike(val)) { ancXPath = `//*[@${attr}=${xpathString(val)}]`; break; }
      }
      if (!ancXPath && isStableId(anc.id)) ancXPath = `//*[@id=${xpathString(anc.id)}]`;
      if (!ancXPath && anc.stableClasses.length) {
        const cls = anc.stableClasses[0];
        ancXPath = `//${anc.tag}[contains(concat(' ', normalize-space(@class), ' '), ${xpathString(' ' + cls + ' ')})]`;
      }
      if (!ancXPath) continue;

      // Build relative path from ancestor to leaf
      const relChain = chain.slice(i + 1);
      const simplePath = relChain.map(n => n.tag).join('/');
      add(`${ancXPath}//${elInfo.tag}`,      'ancestor+tag',  60);
      add(`${ancXPath}//${simplePath}`,      'ancestor+path', 58);

      // Add text anchor to ancestor path
      if (innerText && innerText.length >= 2 && innerText.length <= 60) {
        add(
          `${ancXPath}//${elInfo.tag}[normalize-space(.)=${xpathString(innerText)}]`,
          'ancestor+text', 62
        );
      }
      break;
    }

    // ── Tier 9: ROBULA+-style: full path with progressive class lifting ──
    //
    // Strategy: start from absolute positional path, then iteratively replace
    // positional predicates with attribute predicates where possible.
    //
    function buildRobulaPath(chain) {
      // Build segments from root to leaf
      const segs = chain.map((info, i) => {
        const isLast = i === chain.length - 1;

        // Prefer stable attribute predicates over position
        if (isStableId(info.id)) return `//${info.tag}[@id=${xpathString(info.id)}]`;

        for (const attr of TEST_ID_ATTRS) {
          const val = info.attributes[attr];
          if (val && !isRandomLike(val)) return `//${info.tag}[@${attr}=${xpathString(val)}]`;
        }

        const ariaLbl = info.attributes['aria-label'];
        if (ariaLbl && !isRandomLike(ariaLbl)) return `//${info.tag}[@aria-label=${xpathString(ariaLbl)}]`;

        if (isLast && innerText && innerText.length >= 2 && innerText.length <= 60) {
          return `//${info.tag}[normalize-space(.)=${xpathString(innerText)}]`;
        }

        if (info.stableClasses.length) {
          const cls = info.stableClasses[0];
          return `/${info.tag}[contains(concat(' ', normalize-space(@class), ' '), ${xpathString(' ' + cls + ' ')})]`;
        }

        // Last resort: positional
        return `/${info.tag}[${info.nthOfType}]`;
      });

      return '/' + segs.join('').replace(/^\/\/+/, '/');
    }

    add(buildRobulaPath(chain), 'robula-path', 35);

    // ── Tier 10: Full absolute positional XPath (last resort) ────────────
    const absPath = '/' + chain.map(n => `${n.tag}[${n.nthOfType}]`).join('/');
    add(absPath, 'absolute-path', 15);

    return candidates;
  }

  /* =========================================================================
     UNIQUIFICATION
     If a high-priority candidate matches 2–4 elements (almost unique),
     try to add a positional suffix or ancestor scope to make it unique.
     ========================================================================= */

  function tryUniquify(candidate, el) {
    const n = countMatches(candidate.value, candidate.type);
    if (n === 1) return candidate;
    if (n <= 0 || n > 6) return null;

    if (candidate.type === 'css') {
      // Try adding nth-of-type for the position of el among matched elements
      const matched = Array.from(document.querySelectorAll(candidate.value));
      const pos = matched.indexOf(el);
      if (pos === -1) return null;

      const suffixed = `${candidate.value}:nth-of-type(${el.parentElement
        ? Array.from(el.parentElement.children).filter(c => c.tagName === el.tagName).indexOf(el) + 1
        : pos + 1})`;
      if (isUnique(suffixed, el)) {
        return { ...candidate, value: suffixed, strategy: candidate.strategy + '+nth', priority: candidate.priority - 2 };
      }

      // Try adding :nth-child
      const nthChild = `(${candidate.value}):nth-child(${el.parentElement
        ? Array.from(el.parentElement.children).indexOf(el) + 1
        : pos + 1})`;

      // Try adding eq-style: (selector)[n] — not valid CSS, skip
      // Try scoping inside immediate parent
      const parentInfo = el.parentElement;
      if (parentInfo) {
        const parentCls = getStableClasses(parentInfo);
        if (parentCls.length) {
          const scoped = `${parentInfo.tagName.toLowerCase()}.${cssEscape(parentCls[0])} > ${candidate.value}`;
          if (isUnique(scoped, el)) {
            return { ...candidate, value: scoped, strategy: candidate.strategy + '+scoped', priority: candidate.priority - 1 };
          }
        }
        if (isStableId(parentInfo.id)) {
          const scoped = `#${cssEscape(parentInfo.id)} > ${candidate.value}`;
          if (isUnique(scoped, el)) {
            return { ...candidate, value: scoped, strategy: candidate.strategy + '+scoped', priority: candidate.priority - 1 };
          }
        }
      }
    }

    if (candidate.type === 'xpath') {
      // Add positional predicate
      try {
        const result = document.evaluate(
          candidate.value, document, null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
        );
        let pos = -1;
        for (let i = 0; i < result.snapshotLength; i++) {
          if (result.snapshotItem(i) === el) { pos = i + 1; break; }
        }
        if (pos === -1) return null;
        const suffixed = `(${candidate.value})[${pos}]`;
        if (isUnique(suffixed, el, 'xpath')) {
          return { ...candidate, value: suffixed, strategy: candidate.strategy + '+pos', priority: candidate.priority - 2 };
        }
      } catch (_) {}
    }

    return null;
  }

  /* =========================================================================
     SCORING
     Returns a numerical score — higher is better.
     ========================================================================= */

  function scoreCandidate(candidate, el) {
    let score = candidate.priority || 0;

    const v = candidate.value;

    // Penalize length (longer = more brittle)
    score -= Math.floor(v.length / 20);

    // Penalize positional indices (very brittle)
    const indexCount = (v.match(/\[\d+\]/g) || []).length;
    score -= indexCount * 5;

    // Penalize nth-of-type / nth-child (somewhat brittle)
    if (/nth-of-type|nth-child/.test(v)) score -= 4;

    // Reward uniqueness (already filtered, but extra reward for very short unique selectors)
    if (v.length < 20) score += 3;
    if (v.length < 10) score += 5;

    // CSS is easier to debug and more widely supported
    if (candidate.type === 'css') score += 2;

    // Penalize contains() in XPath (less precise than =)
    if (candidate.type === 'xpath' && v.includes('contains(')) score -= 2;

    // Penalize full absolute paths
    if (candidate.strategy === 'absolute-path' || candidate.strategy === 'full-path') score -= 15;

    // Reward strategies that don't depend on DOM position
    if (['test-id', 'id', 'aria', 'aria-label', 'text-exact', 'href', 'img-alt', 'type+name'].includes(candidate.strategy)) {
      score += 5;
    }

    candidate.score = score;
    return candidate;
  }

  /* =========================================================================
     PUBLIC API
     ========================================================================= */

  /**
   * Generate robust primary + fallback selectors for a DOM element.
   *
   * @param {Element} el
   * @param {Object}  options  { actionType?: string, maxFallbacks?: number }
   * @returns {{ primary, fallbacks, meta }}
   */
  function getSelectorsForElement(el, options = {}) {
    const ctx        = buildContext(el);
    const maxFallbacks = typeof options.maxFallbacks === 'number' ? options.maxFallbacks : 5;

    const rawCandidates = [
      ...generateCssCandidates(ctx),
      ...generateXPathCandidates(ctx),
    ];

    // Deduplicate by value
    const seen   = new Set();
    const unique = rawCandidates.filter(c => {
      if (seen.has(c.value)) return false;
      seen.add(c.value);
      return true;
    });

    // Check uniqueness, trying to uniquify near-unique high-priority candidates
    const verified = [];
    for (const c of unique) {
      if (isUnique(c.value, el, c.type)) {
        verified.push(c);
      } else if (c.priority >= 50) {
        // High-priority but not yet unique — try to narrow it
        const narrowed = tryUniquify(c, el);
        if (narrowed) verified.push(narrowed);
      }
    }

    // Score and sort
    const scored = verified
      .map(c => scoreCandidate(c, el))
      .sort((a, b) => b.score - a.score);

    // Deduplicate again after uniquification (some may produce same selector)
    const finalSeen = new Set();
    const finalList = scored.filter(c => {
      if (finalSeen.has(c.value)) return false;
      finalSeen.add(c.value);
      return true;
    });

    const primary   = finalList[0] || null;
    const fallbacks = finalList.slice(1, 1 + maxFallbacks);

    return {
      primary,
      fallbacks,
      meta: {
        all:        finalList,
        totalFound: finalList.length,
        context: {
          text:       ctx.text,
          innerText:  ctx.innerText,
          pathLength: ctx.chain.length,
          tag:        ctx.elInfo.tag,
        },
        actionType: options.actionType || null,
      },
    };
  }

  window.SelectorGenerator = { getSelectorsForElement };
})();