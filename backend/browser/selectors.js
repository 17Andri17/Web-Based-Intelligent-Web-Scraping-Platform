(function () {
  function normalizeText(txt) {
    return (txt || '').replace(/\s+/g, ' ').trim();
  }

  function isRandomLike(value) {
    if (!value) return false;
    // crude: many hex-like chars or long random string
    if (/[0-9a-f]{8,}/i.test(value)) return true;
    if (value.length > 32 && !/\s/.test(value)) return true;
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
    return !!cls && !isRandomLike(cls);
  }

  // --- Context extraction ----------------------------------------------------

  function buildContext(el) {
    const path = [];
    let node = el;

    while (
      node &&
      node.nodeType === Node.ELEMENT_NODE &&
      node !== document.documentElement
    ) {
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
        nthOfType: sameTagSiblings.indexOf(node) + 1
      });

      node = parent;
    }

    return {
      element: el,
      path, // root-ish → target
      text: normalizeText(el.innerText || el.textContent || '')
    };
  }

  // --- CSS generation --------------------------------------------------------

  function cssEscape(str) {
    // Minimal escaping for ids/classes/attr values
    return String(str).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
  }

  function cssAttrEquals(name, value) {
    const escapedVal = String(value).replace(/"/g, '\\"');
    return `${name}="${escapedVal}"`;
  }

  function generateCssCandidates(ctx) {
    const elInfo = ctx.path[ctx.path.length - 1];
    const candidates = [];

    // 1) Simple id
    if (isStableId(elInfo.id)) {
      candidates.push({
        type: 'css',
        strategy: 'id',
        value: `#${cssEscape(elInfo.id)}`
      });
    }

    // 2) Single stable class
    const stableClasses = (elInfo.classList || []).filter(isStableClass);
    stableClasses.forEach(cls => {
      candidates.push({
        type: 'css',
        strategy: 'class',
        value: `.${cssEscape(cls)}`
      });
    });

    // 3) data-* attributes
    Object.entries(elInfo.attributes || {}).forEach(([name, value]) => {
      if (!value || isRandomLike(value)) return;
      if (name.startsWith('data-')) {
        candidates.push({
          type: 'css',
          strategy: 'data-attr',
          value: `${elInfo.tag}[${cssAttrEquals(name, value)}]`
        });
      }
    });

    // 4) Scoped by stable ancestor
    const ancestorSelectors = [];
    for (let i = 0; i < ctx.path.length - 1; i++) {
      const a = ctx.path[i];
      if (isStableId(a.id)) {
        ancestorSelectors.push(`#${cssEscape(a.id)}`);
        break;
      }
      const stableAncestorClasses = (a.classList || []).filter(isStableClass);
      if (stableAncestorClasses.length) {
        ancestorSelectors.push(
          `${a.tag}.${cssEscape(stableAncestorClasses[0])}`
        );
        break;
      }
    }

    if (ancestorSelectors.length) {
      const ancestor = ancestorSelectors[0];
      // ancestor + target class
      stableClasses.forEach(cls => {
        candidates.push({
          type: 'css',
          strategy: 'ancestor+class',
          value: `${ancestor} .${cssEscape(cls)}`
        });
      });
      // ancestor + tag
      if (!stableClasses.length) {
        candidates.push({
          type: 'css',
          strategy: 'ancestor+tag',
          value: `${ancestor} ${elInfo.tag}`
        });
      }
    }

    // 5) Last-resort nth-of-type
    candidates.push({
      type: 'css',
      strategy: 'nth-of-type',
      value: `${elInfo.tag}:nth-of-type(${elInfo.nthOfType})`
    });

    return candidates;
  }

  // --- XPath generation (ROBULA+-style inspired) -----------------------------

  function xpathEscape(str) {
    // Handle both quote types by using concat if needed
    const s = String(str);
    if (!s.includes('"')) return s;
    if (!s.includes("'")) return `'${s}'`;
    const parts = s.split('"').map(p => `"${p}"`);
    return `concat(${parts.join(', "\"", ')})`;
  }

  function generateXPathCandidates(ctx) {
    const elInfo = ctx.path[ctx.path.length - 1];
    const candidates = [];

    // Helper: build tag path from ancestor index to leaf
    function buildTagPath(fromIdx) {
      return ctx.path
        .slice(fromIdx)
        .map(n => n.tag)
        .join('/');
    }

    // 1) id-based
    if (isStableId(elInfo.id)) {
      candidates.push({
        type: 'xpath',
        strategy: 'id',
        value: `//*[@id="${xpathEscape(elInfo.id)}"]`
      });
    }

    // 2) text-based (short text only)
    if (ctx.text && ctx.text.length <= 64) {
      const t = ctx.text;
      candidates.push({
        type: 'xpath',
        strategy: 'text-contains',
        value: `//${elInfo.tag}[contains(normalize-space(.), "${xpathEscape(
          t
        )}")]`
      });
    }

    // 3) attribute-based (non-random, non-id/class)
    Object.entries(elInfo.attributes || {}).forEach(([name, value]) => {
      if (!value || isRandomLike(value)) return;
      if (name === 'id' || name === 'class') return;
      candidates.push({
        type: 'xpath',
        strategy: 'attr',
        value: `//${elInfo.tag}[@${name}="${xpathEscape(value)}"]`
      });
    });

    // 4) ancestor + path
    for (let i = 0; i < ctx.path.length - 1; i++) {
      const anc = ctx.path[i];
      const classes = (anc.classList || []).filter(isStableClass);
      if (!anc.id && !classes.length) continue;

      const ancSelector = anc.id
        ? `//*[@id="${xpathEscape(anc.id)}"]`
        : `//${anc.tag}[contains(concat(' ', normalize-space(@class), ' '), ' ${classes[0]} ')]`;

      const relPath = buildTagPath(i + 1);
      candidates.push({
        type: 'xpath',
        strategy: 'ancestor+path',
        value: `${ancSelector}//${relPath}`
      });
      break;
    }

    // 5) full structural path with positional predicates (last resort)
    const fullPath = ctx.path
      .map(n => `${n.tag}[${n.nthOfType}]`)
      .join('/');
    candidates.push({
      type: 'xpath',
      strategy: 'full-path',
      value: `/${fullPath}`
    });

    return candidates;
  }

  // --- Evaluation & scoring --------------------------------------------------

  function isUnique(candidate, el) {
    try {
      if (candidate.type === 'css') {
        const nodes = document.querySelectorAll(candidate.value);
        return nodes.length === 1 && nodes[0] === el;
      } else if (candidate.type === 'xpath') {
        const res = document.evaluate(
          candidate.value,
          document,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null
        );
        return res.snapshotLength === 1 && res.snapshotItem(0) === el;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  function scoreSelector(candidate) {
    const value = candidate.value;
    let score = 0;

    // shorter is better
    const lengthApprox = value.split(/\/| |\./).length;
    score -= lengthApprox * 0.5;

    // penalize indices
    const indexMatches = value.match(/\[(\d+)\]/g) || [];
    score -= indexMatches.length * 1.5;

    if (/nth-of-type/i.test(value)) score -= 3;

    // reward id / data-* / text / ancestor usage
    if (/^#/.test(value) || /@id=/.test(value)) score += 8;
    if (/data-/.test(value)) score += 4;
    if (/contains\(normalize-space\(\.\)/.test(value)) score += 3;
    if (
      candidate.strategy === 'ancestor+class' ||
      candidate.strategy === 'ancestor+path'
    ) {
      score += 2;
    }

    // small bias towards CSS (easier to debug)
    if (candidate.type === 'css') score += 1;

    candidate.score = score;
    return candidate;
  }

  // --- Public API ------------------------------------------------------------

  /**
   * Generate robust primary + fallback selectors for a DOM element.
   *
   * @param {Element} el - Clicked element.
   * @param {Object} options - { actionType?: string, maxFallbacks?: number }
   * @returns {{ primary: object|null, fallbacks: Array<object>, meta: object }}
   */
  function getSelectorsForElement(el, options = {}) {
    const ctx = buildContext(el);
    const allCandidates = [
      ...generateCssCandidates(ctx),
      ...generateXPathCandidates(ctx)
    ];

    const unique = allCandidates.filter(c => isUnique(c, el));
    const scored = unique.map(scoreSelector).sort((a, b) => b.score - a.score);

    const primary = scored[0] || null;
    const maxFallbacks =
      typeof options.maxFallbacks === 'number' ? options.maxFallbacks : 3;
    const fallbacks = scored.slice(1, 1 + maxFallbacks);

    return {
      primary,
      fallbacks,
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

  // Attach to window for SelectorTool.js to use
  window.SelectorGenerator = {
    getSelectorsForElement
  };
})();
