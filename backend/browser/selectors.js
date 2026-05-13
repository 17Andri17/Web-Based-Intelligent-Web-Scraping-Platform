(function () {
  'use strict';

  /* =========================================================================
     CONSTANTS & CONFIGURATION
     ========================================================================= */

  const TEST_ID_ATTRS = [
    'data-testid', 'data-test-id', 'data-test',
    'data-cy', 'data-qa', 'data-e2e',
    'data-automation', 'data-automation-id',
    'data-id',
  ];

  const UNSTABLE_CLASS_PATTERNS = [
    /^(is-|has-|js-)/,
    /^(active|inactive|open|closed|expanded|collapsed|visible|hidden|show|hide)$/,
    /^(selected|current|checked|disabled|enabled|loading|loaded|error|success|warning)$/,
    /^(hover|focus|focused|pressed|dragging|dragged|over|highlighted)$/,
    /^(first|last|odd|even|middle)$/,
    /^(flex|grid|block|inline|hidden|visible|relative|absolute|fixed|sticky|static)$/,
    /^(container|clearfix|italic|underline|uppercase|lowercase|capitalize|truncate|antialiased)$/,
    /^(m|p|mx|my|px|py|mt|mb|ml|mr|pt|pb|pl|pr)-/,
    /^(w|h|min-w|max-w|min-h|max-h)-/,
    /^(text|font|leading|tracking|align|indent)-/,
    /^(bg|border|ring|shadow|outline|divide|space)-/,
    /^(flex|grid|col|row|gap|justify|items|content|self|place)-/,
    /^(block|inline|hidden|visible|relative|absolute|fixed|sticky|overflow|z)-/,
    /^(rounded|opacity|cursor|pointer|select|resize|appearance|object)-/,
    /^(transition|transform|scale|rotate|translate|skew|origin)-/,
    /^(duration|ease|delay|animate|sr)-/,
    /^(d-|g-|p-|m-|ms-|me-|ps-|pe-|mt-|mb-|fw-|fs-|text-|bg-|border-|rounded|float-|order-|col-|row-|offset-)/,
    /_{2}[a-zA-Z0-9_-]+_{2}[A-Za-z0-9_-]{4,}$/,
    /^[a-f0-9]{6,}$/i,
  ];

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

  function isRandomLike(value) {
    if (!value) return false;
    const s = String(value);
    if (/[0-9a-f]{8,}/i.test(s)) return true;
    if (s.length > 40 && !/\s/.test(s)) return true;
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

  function cssEscape(str) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(String(str));
    return String(str).replace(/([ !"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1')
                      .replace(/^(\d)/, '\\3$1 ');
  }

  function cssAttrValue(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

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

  function countMatches(selector, type) {
    type = type || 'css';
    try {
      if (type === 'css') return document.querySelectorAll(selector).length;
      const result = document.evaluate(selector, document, null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return result.snapshotLength;
    } catch (_) { return -1; }
  }

  function getMatchedEl(selector, type, index) {
    type  = type  || 'css';
    index = index || 0;
    try {
      if (type === 'css') return document.querySelectorAll(selector)[index] || null;
      const result = document.evaluate(selector, document, null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return result.snapshotItem(index);
    } catch (_) { return null; }
  }

  function isUnique(selector, el, type) {
    type = type || 'css';
    const n = countMatches(selector, type);
    if (n !== 1) return false;
    return getMatchedEl(selector, type) === el;
  }

  /* =========================================================================
     CONTEXT EXTRACTION
     ========================================================================= */

  function buildNodeInfo(node) {
    const attrs = {};
    for (let i = 0; i < node.attributes.length; i++) {
      attrs[node.attributes[i].name] = node.attributes[i].value;
    }
    const parent   = node.parentElement;
    const siblings = parent ? Array.from(parent.children) : [];
    const sameTag  = siblings.filter(function(s) { return s.tagName === node.tagName; });

    return {
      el:            node,
      tag:           node.tagName.toLowerCase(),
      id:            node.id || null,
      classList:     splitClasses(node.className),
      stableClasses: getStableClasses(node),
      attributes:    attrs,
      nthChild:      siblings.indexOf(node) + 1,
      nthOfType:     sameTag.indexOf(node) + 1,
      onlyChild:     siblings.length === 1,
      onlyOfType:    sameTag.length === 1,
    };
  }

  function buildContext(el) {
    const chain = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      chain.unshift(buildNodeInfo(node));
      node = node.parentElement;
    }
    const elInfo    = chain[chain.length - 1];
    const text      = normalizeText(el.innerText || el.textContent || '');
    const innerText = normalizeText(el.innerText || '');
    return { el: el, chain: chain, elInfo: elInfo, text: text, innerText: innerText };
  }

  /* =========================================================================
     CSS CANDIDATE GENERATION (single element)
     ========================================================================= */

  function nodeToCss(info, disambiguate) {
    disambiguate = disambiguate || 'none';
    var tag = info.tag, id = info.id, stableClasses = info.stableClasses, attributes = info.attributes;
    if (isStableId(id)) return '#' + cssEscape(id);
    for (var i = 0; i < TEST_ID_ATTRS.length; i++) {
      var attr = TEST_ID_ATTRS[i];
      var val  = attributes[attr];
      if (val && !isRandomLike(val)) return '[' + attr + '="' + cssAttrValue(val) + '"]';
    }
    var clsPart = stableClasses.slice(0, 3).map(function(c) { return '.' + cssEscape(c); }).join('');
    var base    = tag + clsPart;
    if (disambiguate === 'nth-child')   return base + ':nth-child(' + info.nthChild + ')';
    if (disambiguate === 'nth-of-type') return base + ':nth-of-type(' + info.nthOfType + ')';
    return base;
  }

  function buildCssPath(chain, el, maxLen) {
    maxLen = maxLen || chain.length;
    for (var start = chain.length - 1; start >= Math.max(0, chain.length - maxLen); start--) {
      var parts    = chain.slice(start).map(function(info) { return nodeToCss(info, 'none'); });
      var selector = parts.join(' > ');
      if (isUnique(selector, el)) return selector;
      var partsNth = parts.slice();
      partsNth[partsNth.length - 1] = nodeToCss(chain[chain.length - 1], 'nth-of-type');
      var selectorNth = partsNth.join(' > ');
      if (isUnique(selectorNth, el)) return selectorNth;
    }
    return null;
  }

  function generateCssCandidates(ctx) {
    var el        = ctx.el;
    var chain     = ctx.chain;
    var elInfo    = ctx.elInfo;
    var candidates = [];

    function add(value, strategy, priority) {
      priority = priority || 0;
      if (value && countMatches(value) >= 0) {
        candidates.push({ type: 'css', strategy: strategy, value: value, priority: priority });
      }
    }

    // Tier 1: Test/automation IDs
    for (var ti = 0; ti < TEST_ID_ATTRS.length; ti++) {
      var tAttr = TEST_ID_ATTRS[ti];
      var tVal  = elInfo.attributes[tAttr];
      if (tVal && !isRandomLike(tVal)) {
        add('[' + tAttr + '="' + cssAttrValue(tVal) + '"]', 'test-id', 100);
        add(elInfo.tag + '[' + tAttr + '="' + cssAttrValue(tVal) + '"]', 'test-id-tag', 99);
      }
    }

    // Tier 2: Stable #id
    if (isStableId(elInfo.id)) {
      add('#' + cssEscape(elInfo.id), 'id', 95);
    }

    // Tier 3: ARIA
    var ariaAttrs = ['aria-label', 'aria-labelledby', 'aria-describedby'];
    for (var ai = 0; ai < ariaAttrs.length; ai++) {
      var aAttr = ariaAttrs[ai];
      var aVal  = elInfo.attributes[aAttr];
      if (aVal && !isRandomLike(aVal)) {
        add(elInfo.tag + '[' + aAttr + '="' + cssAttrValue(aVal) + '"]', 'aria', 85);
        add('[' + aAttr + '="' + cssAttrValue(aVal) + '"]', 'aria-global', 84);
      }
    }

    // Tier 4: Semantic input attributes
    var inputTags = ['input', 'select', 'textarea', 'button', 'label'];
    if (inputTags.indexOf(elInfo.tag) !== -1) {
      var sinAttrs = ['name', 'placeholder', 'for', 'type'];
      for (var si = 0; si < sinAttrs.length; si++) {
        var sAttr = sinAttrs[si];
        var sVal  = elInfo.attributes[sAttr];
        if (sVal && !isRandomLike(sVal)) {
          add(elInfo.tag + '[' + sAttr + '="' + cssAttrValue(sVal) + '"]', 'semantic-input', 80);
        }
      }
      var typV = elInfo.attributes['type'];
      var namV = elInfo.attributes['name'];
      if (typV && namV && !isRandomLike(namV)) {
        add(elInfo.tag + '[type="' + cssAttrValue(typV) + '"][name="' + cssAttrValue(namV) + '"]', 'type+name', 82);
      }
    }

    // Tier 5: href / img alt
    if (elInfo.tag === 'a') {
      var href = elInfo.attributes['href'];
      if (href && !isRandomLike(href) && href !== '#' && href.length < 120) {
        add('a[href="' + cssAttrValue(href) + '"]', 'href', 78);
        var cleanHref = href.split('?')[0];
        if (cleanHref !== href && (cleanHref.indexOf('/') === 0 || cleanHref.indexOf('http') === 0)) {
          add('a[href*="' + cssAttrValue(cleanHref) + '"]', 'href-contains', 65);
        }
      }
    }
    if (elInfo.tag === 'img') {
      var alt = elInfo.attributes['alt'];
      if (alt && alt.trim()) add('img[alt="' + cssAttrValue(alt) + '"]', 'img-alt', 75);
    }

    // Tier 6: data-* attributes (non-test)
    var attrKeys = Object.keys(elInfo.attributes);
    for (var dk = 0; dk < attrKeys.length; dk++) {
      var dAttr = attrKeys[dk];
      var dVal  = elInfo.attributes[dAttr];
      if (!dAttr.startsWith('data-') || TEST_ID_ATTRS.indexOf(dAttr) !== -1) continue;
      if (!dVal || isRandomLike(dVal)) continue;
      add(elInfo.tag + '[' + dAttr + '="' + cssAttrValue(dVal) + '"]', 'data-attr', 72);
      add('[' + dAttr + '="' + cssAttrValue(dVal) + '"]', 'data-attr-global', 70);
    }

    // Tier 7: role
    var role = elInfo.attributes['role'];
    if (role && !isRandomLike(role)) {
      add('[role="' + cssAttrValue(role) + '"]', 'role', 65);
    }

    // Tier 8: Multi-class combination (boosted)
    var stableCls = elInfo.stableClasses;
    if (stableCls.length >= 2) {
      var two   = stableCls.slice(0, 2).map(function(c) { return '.' + cssEscape(c); }).join('');
      var three = stableCls.slice(0, 3).map(function(c) { return '.' + cssEscape(c); }).join('');
      add(elInfo.tag + two,   'multi-class-2', 80);
      add(elInfo.tag + three, 'multi-class-3', 78);
      add(two,                'multi-class-2-notag', 75);
      add(three,              'multi-class-3-notag', 73);
    }

    // Tier 9: Single stable class (boosted)
    for (var ci = 0; ci < Math.min(stableCls.length, 3); ci++) {
      var cls = stableCls[ci];
      add(elInfo.tag + '.' + cssEscape(cls), 'class-tag', 72);
      add('.' + cssEscape(cls),              'class',     68);
    }

    // Tier 10: BEM partial class
    for (var bi = 0; bi < stableCls.length; bi++) {
      var bcls = stableCls[bi];
      if (bcls.indexOf('__') !== -1 || bcls.indexOf('--') !== -1) {
        var bbase = bcls.split('__')[0].split('--')[0];
        if (bbase.length >= 3) {
          add(elInfo.tag + '[class*="' + cssAttrValue(bcls) + '"]', 'bem-contains', 45);
        }
      }
    }

    // Tier 11: Ancestor-scoped selectors + ancestor+leaf-nth child
    for (var ancI = chain.length - 2; ancI >= 0; ancI--) {
      var anc = chain[ancI];
      var anchorCandidates = [];

      for (var ati = 0; ati < TEST_ID_ATTRS.length; ati++) {
        var atVal = anc.attributes[TEST_ID_ATTRS[ati]];
        if (atVal && !isRandomLike(atVal)) {
          anchorCandidates.push('[' + TEST_ID_ATTRS[ati] + '="' + cssAttrValue(atVal) + '"]');
          break;
        }
      }

      if (isStableId(anc.id)) anchorCandidates.push('#' + cssEscape(anc.id));

      var ancAria = anc.attributes['aria-label'];
      if (ancAria && !isRandomLike(ancAria)) {
        anchorCandidates.push(anc.tag + '[aria-label="' + cssAttrValue(ancAria) + '"]');
      }

      if (anc.stableClasses.length >= 2) {
        var ancTwo = anc.stableClasses.slice(0, 2).map(function(c) { return '.' + cssEscape(c); }).join('');
        anchorCandidates.push(anc.tag + ancTwo);
      } else if (anc.stableClasses.length === 1) {
        anchorCandidates.push(anc.tag + '.' + cssEscape(anc.stableClasses[0]));
      }

      if (anchorCandidates.length) {
        var tailChain   = chain.slice(ancI + 1);
        var tailSimple  = tailChain.map(function(n) { return n.tag; }).join(' > ');
        var tailClassed = tailChain.map(function(n, tidx) {
          if (tidx === tailChain.length - 1 && n.stableClasses.length) {
            return n.tag + '.' + cssEscape(n.stableClasses[0]);
          }
          return n.tag;
        }).join(' > ');

        for (var ak = 0; ak < Math.min(anchorCandidates.length, 2); ak++) {
          var ancSel = anchorCandidates[ak];
          var ancPriority = ancSel.indexOf('#') === 0 ? 68 : ancSel.indexOf('test') !== -1 ? 72 : 60;

          add(ancSel + ' ' + elInfo.tag, 'ancestor+tag', ancPriority - 2);
          if (stableCls[0]) {
            add(ancSel + ' .' + cssEscape(stableCls[0]), 'ancestor+class', ancPriority);
            add(ancSel + ' ' + elInfo.tag + '.' + cssEscape(stableCls[0]), 'ancestor+class-tag', ancPriority + 1);
          }
          if (tailChain.length > 0 && tailChain.length <= 4) {
            add(ancSel + ' > ' + tailClassed, 'ancestor+path-classed', ancPriority - 1);
            add(ancSel + ' > ' + tailSimple,  'ancestor+path',         ancPriority - 3);
          }

          // stable ancestor + leaf :nth-child / :nth-of-type
          add(ancSel + ' > ' + elInfo.tag + ':nth-child(' + elInfo.nthChild + ')',
              'ancestor+leaf-nth-child', 91);
          add(ancSel + ' > ' + elInfo.tag + ':nth-of-type(' + elInfo.nthOfType + ')',
              'ancestor+leaf-nth-of-type', 89);
        }
        break;
      }
    }

    // Tier 12: Shortest unique CSS path
    var structuralPath = buildCssPath(chain, el, 6);
    if (structuralPath) add(structuralPath, 'structural-path', 40);

    // Tier 13: Full path with nth disambiguation
    var fullPath = chain.map(function(info, i) {
      var isLast = i === chain.length - 1;
      if (isLast) return nodeToCss(info, 'nth-of-type');
      if (isStableId(info.id)) return '#' + cssEscape(info.id);
      if (info.stableClasses.length) return info.tag + '.' + cssEscape(info.stableClasses[0]);
      return info.tag + ':nth-child(' + info.nthChild + ')';
    }).join(' > ');
    add(fullPath, 'full-path', 20);

    return candidates;
  }

  /* =========================================================================
     XPATH CANDIDATE GENERATION (single element) – text priorities lowered
     ========================================================================= */

  function generateXPathCandidates(ctx) {
    var el        = ctx.el;
    var chain     = ctx.chain;
    var elInfo    = ctx.elInfo;
    var innerText = ctx.innerText;
    var candidates = [];

    function add(value, strategy, priority) {
      priority = priority || 0;
      if (value) candidates.push({ type: 'xpath', strategy: strategy, value: value, priority: priority });
    }

    // Tier 1: Test IDs
    for (var ti = 0; ti < TEST_ID_ATTRS.length; ti++) {
      var tAttr = TEST_ID_ATTRS[ti];
      var tVal  = elInfo.attributes[tAttr];
      if (tVal && !isRandomLike(tVal)) {
        add('//*[@' + tAttr + '=' + xpathString(tVal) + ']', 'test-id', 100);
        add('//' + elInfo.tag + '[@' + tAttr + '=' + xpathString(tVal) + ']', 'test-id-tag', 99);
      }
    }

    // Tier 2: Stable ID
    if (isStableId(elInfo.id)) {
      add('//*[@id=' + xpathString(elInfo.id) + ']', 'id', 95);
      add('//' + elInfo.tag + '[@id=' + xpathString(elInfo.id) + ']', 'id-tag', 94);
    }

    // Tier 3: ARIA label
    var ariaLabel = elInfo.attributes['aria-label'];
    if (ariaLabel && !isRandomLike(ariaLabel)) {
      add('//' + elInfo.tag + '[@aria-label=' + xpathString(ariaLabel) + ']', 'aria-label', 88);
    }

    // Tier 4: Exact text match (now backup priority)
    if (innerText && innerText.length >= 2 && innerText.length <= 80) {
      add('//' + elInfo.tag + '[normalize-space(.)=' + xpathString(innerText) + ']', 'text-exact', 35);
      if (innerText.length >= 20) {
        add('//' + elInfo.tag + '[contains(normalize-space(.), ' + xpathString(innerText) + ')]', 'text-contains', 25);
      }
    }

    // Tier 5: Semantic attributes
    var semAttrs = { name: 80, placeholder: 79, alt: 78, title: 76, value: 72, href: 70, role: 65, type: 60, for: 68 };
    Object.keys(semAttrs).forEach(function(attr) {
      var val = elInfo.attributes[attr];
      if (!val || isRandomLike(val)) return;
      if (attr === 'href' && (val === '#' || val.length > 120)) return;
      add('//' + elInfo.tag + '[@' + attr + '=' + xpathString(val) + ']', 'attr-' + attr, semAttrs[attr]);
    });

    // Tier 6: data-* attributes
    Object.keys(elInfo.attributes).forEach(function(attr) {
      if (!attr.startsWith('data-') || TEST_ID_ATTRS.indexOf(attr) !== -1) return;
      var val = elInfo.attributes[attr];
      if (!val || isRandomLike(val)) return;
      add('//' + elInfo.tag + '[@' + attr + '=' + xpathString(val) + ']', 'data-attr', 70);
    });

    // Tier 7: Class-based XPath
    for (var ci = 0; ci < Math.min(elInfo.stableClasses.length, 2); ci++) {
      var cls = elInfo.stableClasses[ci];
      add('//' + elInfo.tag + '[contains(concat(\' \', normalize-space(@class), \' \'), ' + xpathString(' ' + cls + ' ') + ')]', 'class', 55);
    }

    // Tier 8: Ancestor-anchored (text lowered)
    for (var ai = chain.length - 2; ai >= 0; ai--) {
      var anc = chain[ai];
      var ancXPath = null;
      for (var ati = 0; ati < TEST_ID_ATTRS.length; ati++) {
        var atV = anc.attributes[TEST_ID_ATTRS[ati]];
        if (atV && !isRandomLike(atV)) { ancXPath = '//*[@' + TEST_ID_ATTRS[ati] + '=' + xpathString(atV) + ']'; break; }
      }
      if (!ancXPath && isStableId(anc.id)) ancXPath = '//*[@id=' + xpathString(anc.id) + ']';
      if (!ancXPath && anc.stableClasses.length) {
        ancXPath = '//' + anc.tag + '[contains(concat(\' \', normalize-space(@class), \' \'), ' + xpathString(' ' + anc.stableClasses[0] + ' ') + ')]';
      }
      if (!ancXPath) continue;

      var relChain  = chain.slice(ai + 1);
      var simplePath = relChain.map(function(n) { return n.tag; }).join('/');
      add(ancXPath + '//' + elInfo.tag, 'ancestor+tag', 60);
      add(ancXPath + '//' + simplePath, 'ancestor+path', 58);
      if (innerText && innerText.length >= 2 && innerText.length <= 60) {
        add(ancXPath + '//' + elInfo.tag + '[normalize-space(.)=' + xpathString(innerText) + ']', 'ancestor+text', 30);
      }
      break;
    }

    // Tier 9: ROBULA+-style path
    function buildRobulaPath(chain) {
      var segs = chain.map(function(info, i) {
        var isLast = i === chain.length - 1;
        if (isStableId(info.id)) return '//' + info.tag + '[@id=' + xpathString(info.id) + ']';
        for (var xi = 0; xi < TEST_ID_ATTRS.length; xi++) {
          var xv = info.attributes[TEST_ID_ATTRS[xi]];
          if (xv && !isRandomLike(xv)) return '//' + info.tag + '[@' + TEST_ID_ATTRS[xi] + '=' + xpathString(xv) + ']';
        }
        var albl = info.attributes['aria-label'];
        if (albl && !isRandomLike(albl)) return '//' + info.tag + '[@aria-label=' + xpathString(albl) + ']';
        if (isLast && innerText && innerText.length >= 2 && innerText.length <= 60) {
          return '//' + info.tag + '[normalize-space(.)=' + xpathString(innerText) + ']';
        }
        if (info.stableClasses.length) {
          return '/' + info.tag + '[contains(concat(\' \', normalize-space(@class), \' \'), ' + xpathString(' ' + info.stableClasses[0] + ' ') + ')]';
        }
        return '/' + info.tag + '[' + info.nthOfType + ']';
      });
      return '/' + segs.join('').replace(/^\/\/+/, '/');
    }
    add(buildRobulaPath(chain), 'robula-path', 35);

    // Tier 10: Absolute positional XPath
    var absPath = '/' + chain.map(function(n) { return n.tag + '[' + n.nthOfType + ']'; }).join('/');
    add(absPath, 'absolute-path', 15);

    return candidates;
  }

  /* =========================================================================
     UNIQUIFICATION
     ========================================================================= */

  function tryUniquify(candidate, el) {
    var n = countMatches(candidate.value, candidate.type);
    if (n === 1) return candidate;
    if (n <= 0 || n > 6) return null;

    if (candidate.type === 'css') {
      var matched = Array.from(document.querySelectorAll(candidate.value));
      var pos     = matched.indexOf(el);
      if (pos === -1) return null;

      var nthPos = el.parentElement
        ? Array.from(el.parentElement.children).filter(function(c) { return c.tagName === el.tagName; }).indexOf(el) + 1
        : pos + 1;
      var suffixed = candidate.value + ':nth-of-type(' + nthPos + ')';
      if (isUnique(suffixed, el)) {
        return Object.assign({}, candidate, { value: suffixed, strategy: candidate.strategy + '+nth', priority: candidate.priority - 2 });
      }

      var parentInfo = el.parentElement;
      if (parentInfo) {
        var parentCls = getStableClasses(parentInfo);
        if (parentCls.length) {
          var scoped = parentInfo.tagName.toLowerCase() + '.' + cssEscape(parentCls[0]) + ' > ' + candidate.value;
          if (isUnique(scoped, el)) {
            return Object.assign({}, candidate, { value: scoped, strategy: candidate.strategy + '+scoped', priority: candidate.priority - 1 });
          }
        }
        if (isStableId(parentInfo.id)) {
          var scopedId = '#' + cssEscape(parentInfo.id) + ' > ' + candidate.value;
          if (isUnique(scopedId, el)) {
            return Object.assign({}, candidate, { value: scopedId, strategy: candidate.strategy + '+scoped', priority: candidate.priority - 1 });
          }
        }
      }
    }

    if (candidate.type === 'xpath') {
      try {
        var result = document.evaluate(candidate.value, document, null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        var xpos = -1;
        for (var xi = 0; xi < result.snapshotLength; xi++) {
          if (result.snapshotItem(xi) === el) { xpos = xi + 1; break; }
        }
        if (xpos === -1) return null;
        var xsuffixed = '(' + candidate.value + ')[' + xpos + ']';
        if (isUnique(xsuffixed, el, 'xpath')) {
          return Object.assign({}, candidate, { value: xsuffixed, strategy: candidate.strategy + '+pos', priority: candidate.priority - 2 });
        }
      } catch (_) {}
    }

    return null;
  }

  /* =========================================================================
     SCORING (for single-element selectors)
     ========================================================================= */

  function scoreCandidate(candidate) {
    var score = candidate.priority || 0;
    var v     = candidate.value;

    score -= Math.floor(v.length / 20);
    var indexCount = (v.match(/\[\d+\]/g) || []).length;
    score -= indexCount * 5;
    if (/nth-of-type|nth-child/.test(v)) score -= 4;
    if (v.length < 20) score += 3;
    if (v.length < 10) score += 5;
    if (candidate.type === 'css') score += 2;
    if (candidate.type === 'xpath' && v.indexOf('contains(') !== -1) score -= 2;
    if (candidate.strategy === 'absolute-path' || candidate.strategy === 'full-path') score -= 15;

    var stableStrategies = ['test-id', 'id', 'aria', 'aria-label', 'text-exact', 'href', 'img-alt', 'type+name',
                            'ancestor+leaf-nth-child', 'ancestor+leaf-nth-of-type'];
    if (stableStrategies.indexOf(candidate.strategy) !== -1) score += 5;

    candidate.score = score;
    return candidate;
  }

  /* =========================================================================
     BASIS DEDUPLICATION
     ========================================================================= */

  function getBasis(candidate) {
    var s = candidate.strategy;
    if (s === 'href' || s === 'href-contains' || s === 'attr-href') return 'href';
    if (s === 'text-exact' || s === 'text-contains') return 'text';
    if (s === 'id' || s === 'id-tag') return 'id';
    if (s === 'test-id' || s === 'test-id-tag') return 'test-id';
    if (s.indexOf('aria') === 0) return 'aria';
    if (s === 'semantic-input' || s === 'type+name') return 'semantic-input';
    if (s.indexOf('class') === 0 || s.indexOf('multi-class') === 0 || s === 'bem-contains') return 'class';
    if (s.indexOf('ancestor+') === 0) return 'ancestor';
    if (s === 'structural-path' || s === 'full-path' || s === 'robula-path' || s === 'absolute-path') return 'structural';
    if (s.indexOf('data-attr') === 0) return 'data-attr';
    if (s === 'img-alt') return 'img-alt';
    if (s === 'role') return 'role';
    return s;
  }

  var BASIS_LIMITS = {
    href: 1, text: 1, id: 1, 'test-id': 1, aria: 1,
    'semantic-input': 1, 'class': 2, ancestor: 2, structural: 1,
    'data-attr': 1, 'img-alt': 1, role: 1,
  };

  function applyBasisDedup(candidates) {
    var basisCounts = {};
    return candidates.filter(function(c) {
      var basis = getBasis(c);
      var limit = (BASIS_LIMITS[basis] !== undefined) ? BASIS_LIMITS[basis] : 2;
      var count = basisCounts[basis] || 0;
      if (count >= limit) return false;
      basisCounts[basis] = count + 1;
      return true;
    });
  }

  /* =========================================================================
     SINGLE-ELEMENT SELECTOR API
     ========================================================================= */

  function getSelectorsForElement(el, options) {
    options = options || {};
    var ctx          = buildContext(el);
    var maxFallbacks = typeof options.maxFallbacks === 'number' ? options.maxFallbacks : 5;

    var rawCandidates = generateCssCandidates(ctx).concat(generateXPathCandidates(ctx));

    var seen   = new Set();
    var unique = rawCandidates.filter(function(c) {
      if (seen.has(c.value)) return false;
      seen.add(c.value);
      return true;
    });

    var verified = [];
    for (var i = 0; i < unique.length; i++) {
      var c = unique[i];
      if (isUnique(c.value, el, c.type)) {
        verified.push(c);
      } else if (c.priority >= 50) {
        var narrowed = tryUniquify(c, el);
        if (narrowed) verified.push(narrowed);
      }
    }

    var scored = verified
      .map(function(c) { return scoreCandidate(c); })
      .sort(function(a, b) { return b.score - a.score; });

    var finalSeen = new Set();
    var deduped   = scored.filter(function(c) {
      if (finalSeen.has(c.value)) return false;
      finalSeen.add(c.value);
      return true;
    });

    var finalList     = applyBasisDedup(deduped);
    var primary       = finalList[0] || null;
    var fallbackPool  = finalList.slice(1);
    var fallbacks     = applyBasisDedup(fallbackPool).slice(0, maxFallbacks);

    // SAFETY NET: if no primary selector was found, build a structural path
    if (!primary) {
      var anc = el.parentElement;
      var ancSel = null;
      while (anc && !isBoundary(anc)) {
        if (isStableId(anc.id)) {
          ancSel = '#' + cssEscape(anc.id);
          break;
        }
        var ancClasses = getStableClasses(anc);
        if (ancClasses.length) {
          ancSel = anc.tagName.toLowerCase() + '.' + ancClasses.map(cssEscape).join('.');
          break;
        }
        anc = anc.parentElement;
      }
      if (!ancSel) {
        anc = document.body;
        ancSel = 'body';
      }
      var path = buildNthPath(el, anc);
      if (path) {
        primary = { value: ancSel + ' > ' + path, type: 'css', strategy: 'fallback-ancestor+nth' };
      } else {
        var fullPath = buildNthPath(el, null);
        primary = { value: fullPath, type: 'css', strategy: 'fallback-full-path' };
      }
    }

    return {
      primary:   primary,
      fallbacks: fallbacks,
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

  /* =========================================================================
     SIMILAR ELEMENT ENGINE
     ========================================================================= */

  function getElFeatures(el) {
    return {
      tag:           el.tagName,
      stableClasses: getStableClasses(el),
      childTags:     Array.from(el.children).map(function(c) { return c.tagName; }).sort(),
      childCount:    el.children.length,
      attrNames:     Array.from(el.attributes)
                       .map(function(a) { return a.name; })
                       .filter(function(n) { return n !== 'style' && n !== 'class'; }),
    };
  }

  function tagSetSimilarity(tagsA, tagsB) {
    var setA = new Set(tagsA);
    var setB = new Set(tagsB);
    if (setA.size === 0 && setB.size === 0) return 1;
    if (setA.size === 0 || setB.size === 0) return 0;
    var inter = tagsA.filter(function(t) { return setB.has(t); }).length;
    var union  = new Set(tagsA.concat(tagsB)).size;
    return inter / union;
  }

  function attrNameSimilarity(attrsA, attrsB) {
    if (attrsA.length === 0 && attrsB.length === 0) return 0.5;
    var setB  = new Set(attrsB);
    var inter = attrsA.filter(function(a) { return setB.has(a); }).length;
    var union  = new Set(attrsA.concat(attrsB)).size;
    return union === 0 ? 0.5 : inter / union;
  }

  function elSimilarity(a, b) {
    if (a === b) return 1;
    if (a.tagName !== b.tagName) return 0;

    var fa = getElFeatures(a);
    var fb = getElFeatures(b);

    var hasClsA = fa.stableClasses.length > 0;
    var hasClsB = fb.stableClasses.length > 0;

    if (hasClsA || hasClsB) {
      if (!hasClsA || !hasClsB) return 0.1;

      var setB  = new Set(fb.stableClasses);
      var inter = fa.stableClasses.filter(function(c) { return setB.has(c); }).length;
      var union  = new Set(fa.stableClasses.concat(fb.stableClasses)).size;
      var jaccard = inter / union;

      if (jaccard < 0.25) return 0.1;

      var childSim = tagSetSimilarity(fa.childTags, fb.childTags);
      return 0.70 * jaccard + 0.30 * childSim;
    }

    var exactChildMatch = fa.childTags.join(',') === fb.childTags.join(',');
    var childTagSim     = tagSetSimilarity(fa.childTags, fb.childTags);
    var countSim        = (fa.childCount === 0 && fb.childCount === 0)
      ? 1
      : Math.min(fa.childCount, fb.childCount) / Math.max(fa.childCount, fb.childCount, 1);
    var attrSim = attrNameSimilarity(fa.attrNames, fb.attrNames);

    var base = exactChildMatch ? 0.20 : 0;
    return base + 0.50 * childTagSim + 0.20 * countSim + 0.10 * attrSim;
  }

  function simThreshold(seedEl) {
    return getStableClasses(seedEl).length > 0 ? 0.55 : 0.72;
  }

  function isBoundary(el) {
    return !el || el === document.body || el === document.documentElement;
  }

  function findNCA(els) {
    if (!els.length) return null;
    var cur = els[0].parentElement;
    while (cur && !isBoundary(cur)) {
      if (els.every(function(e) { return cur.contains(e); })) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function buildRelPath(target, ancestor) {
    var steps = [];
    var cur   = target;
    while (cur && cur !== ancestor) {
      var parent = cur.parentElement;
      if (!parent) return null;
      steps.unshift({
        tag:      cur.tagName.toLowerCase(),
        classes:  getStableClasses(cur),
        tagIndex: Array.from(parent.children)
                    .filter(function(c) { return c.tagName === cur.tagName; })
                    .indexOf(cur),
        index:    Array.from(parent.children).indexOf(cur),
      });
      cur = parent;
    }
    if (cur !== ancestor) return null;
    return steps;
  }

  function followRelPath(container, path) {
    var cur = container;
    for (var i = 0; i < path.length; i++) {
      var step     = path[i];
      var children = Array.from(cur.children);
      if (!children.length) return null;

      if (step.classes.length > 0) {
        var byClass = null;
        for (var j = 0; j < children.length; j++) {
          var child = children[j];
          if (child.tagName.toLowerCase() === step.tag &&
              step.classes.every(function(cls) { return child.classList.contains(cls); })) {
            byClass = child;
            break;
          }
        }
        if (byClass) { cur = byClass; continue; }
      }

      var byTag = children.filter(function(c) { return c.tagName.toLowerCase() === step.tag; });
      if (byTag.length === 1)              { cur = byTag[0]; continue; }
      if (byTag[step.tagIndex] !== undefined) { cur = byTag[step.tagIndex]; continue; }

      if (children[step.index]) { cur = children[step.index]; continue; }
      return null;
    }
    return cur;
  }

  function buildNthPath(el, ancestor) {
    var parts = [];
    var cur   = el;
    while (cur && cur !== ancestor && !isBoundary(cur)) {
      var parent = cur.parentElement;
      if (!parent) break;
      var idx     = Array.from(parent.children).indexOf(cur) + 1;
      var tag     = cur.tagName.toLowerCase();
      var cls     = getStableClasses(cur);
      var clsPart = cls.length ? '.' + cssEscape(cls[0]) : '';
      parts.unshift(tag + clsPart + ':nth-child(' + idx + ')');
      cur = parent;
      if (ancestor && cur === ancestor) break;
    }
    if (!parts.length) return null;
    if (ancestor && cur !== ancestor) return null;
    return parts.join(' > ');
  }

  function tryQSA(sel) {
    try { return Array.from(document.querySelectorAll(sel)); }
    catch (_) { return null; }
  }

  function setsMatch(a, b) {
    if (a.length !== b.length) return false;
    var s = new Set(a);
    return b.every(function(e) { return s.has(e); });
  }

  function sharedStableClasses(els) {
    if (!els.length) return [];
    var sets = els.map(function(e) { return new Set(getStableClasses(e)); });
    return Array.from(sets[0]).filter(function(c) {
      return sets.every(function(s) { return s.has(c); });
    });
  }

  function buildExactGroupSelector(els) {
    if (!els || els.length === 0) return null;

    if (els.length === 1) {
      var single = getSelectorsForElement(els[0]);
      return single.primary ? single.primary.value : null;
    }

    var tag        = els[0].tagName.toLowerCase();
    var allSameTag = els.every(function(e) { return e.tagName.toLowerCase() === tag; });
    var shared     = sharedStableClasses(els);

    function exactMatch(sel) {
      var m = tryQSA(sel);
      return !!(m && setsMatch(m, els));
    }

    function coversAll(sel) {
      var m = tryQSA(sel);
      if (!m || m.length === 0) return false;
      var s = new Set(m);
      return els.every(function(e) { return s.has(e); });
    }

    // 1) Global shared class (exact)
    for (var n = Math.min(shared.length, 2); n >= 1; n--) {
      var clsPart  = shared.slice(0, n).map(function(c) { return '.' + cssEscape(c); }).join('');
      var variants = allSameTag ? [tag + clsPart, clsPart] : [clsPart];
      for (var vi = 0; vi < variants.length; vi++) {
        if (exactMatch(variants[vi])) return variants[vi];
      }
    }

    // 2) Ancestor anchor
    var nca      = findNCA(els);
    var scopeEl  = nca;
    var scopeSel = null;

    if (scopeEl && !isBoundary(scopeEl)) {
      var scopeResult = getSelectorsForElement(scopeEl);
      if (scopeResult.primary) {
        scopeSel = scopeResult.primary.value;
      } else {
        var sCls = getStableClasses(scopeEl);
        if (sCls.length) {
          scopeSel = scopeEl.tagName.toLowerCase() + '.' + sCls.map(cssEscape).join('.');
        } else if (scopeEl.id && isStableId(scopeEl.id)) {
          scopeSel = '#' + cssEscape(scopeEl.id);
        } else {
          scopeSel = scopeEl.tagName.toLowerCase();
        }
      }
    }

    if (scopeSel) {
      // a) Shared class exact
      for (var sn = Math.min(shared.length, 2); sn >= 1; sn--) {
        var sClsPart = shared.slice(0, sn).map(function(c) { return '.' + cssEscape(c); }).join('');
        var segs = allSameTag
          ? [tag + sClsPart, sClsPart, '> ' + tag + sClsPart, '> ' + sClsPart]
          : [sClsPart, '> ' + sClsPart];
        for (var si = 0; si < segs.length; si++) {
          var ssel = scopeSel + ' ' + segs[si];
          if (exactMatch(ssel)) return ssel;
        }
      }

      // b) Shared class covers-all (superset OK)
      for (var cn = Math.min(shared.length, 2); cn >= 1; cn--) {
        var cClsPart = shared.slice(0, cn).map(function(c) { return '.' + cssEscape(c); }).join('');
        var cSegs = allSameTag
          ? [tag + cClsPart, cClsPart, '> ' + tag + cClsPart, '> ' + cClsPart]
          : [cClsPart, '> ' + cClsPart];
        for (var ci = 0; ci < cSegs.length; ci++) {
          var csel = scopeSel + ' ' + cSegs[ci];
          if (coversAll(csel)) return csel;
        }
      }

      // c) Tag-only covers-all
      if (allSameTag) {
        var tagSel = scopeSel + ' ' + tag;
        if (coversAll(tagSel)) return tagSel;
      }

      // d) Relative nth-child paths from ancestor
      var relPaths = els.map(function(e) { return buildNthPath(e, scopeEl); });
      if (relPaths.every(Boolean)) {
        return relPaths.map(function(p) { return scopeSel + ' ' + p; }).join(', ');
      }
    }

    // 3) Last resort: use nearest common ancestor + descendant tag
    if (allSameTag && scopeSel) {
      return scopeSel + ' ' + tag;
    }

    return null;
  }

  function strategyDirectSiblings(seed) {
    var parent    = seed.parentElement;
    if (!parent || isBoundary(parent)) return null;

    var threshold = simThreshold(seed);
    var similar   = Array.from(parent.children).filter(function(c) {
      return c === seed || elSimilarity(seed, c) >= threshold;
    });

    if (similar.length >= 2) {
      return { els: similar, selector: buildExactGroupSelector(similar), strategy: 'A:direct-siblings', level: 0 };
    }
    return null;
  }

  function strategyAncestorGroups(seed) {
    var results  = [];
    var ancestor = seed.parentElement;

    for (var level = 1; level <= 7 && ancestor && !isBoundary(ancestor); level++) {
      var grandparent = ancestor.parentElement;
      if (!grandparent || isBoundary(grandparent)) { ancestor = grandparent; continue; }

      var ancThreshold = simThreshold(ancestor);
      var similarAncs  = Array.from(grandparent.children).filter(function(c) {
        return c === ancestor || elSimilarity(ancestor, c) >= ancThreshold;
      });

      if (similarAncs.length >= 2) {
        results.push({
          els:      similarAncs,
          selector: buildExactGroupSelector(similarAncs),
          strategy: 'C:ancestor-cards',
          level:    level,
        });

        var path = buildRelPath(seed, ancestor);
        if (path && path.length > 0) {
          var mapped = similarAncs
            .map(function(anc) {
              return anc === ancestor ? seed : followRelPath(anc, path);
            })
            .filter(Boolean);

          if (mapped.length >= 2 && mapped.length / similarAncs.length >= 0.6) {
            results.push({
              els:      mapped,
              selector: buildExactGroupSelector(mapped),
              strategy: 'B:ancestor-relative',
              level:    level,
              coverage: mapped.length / similarAncs.length,
            });
          }
        }
        break;
      }
      ancestor = grandparent;
    }
    return results;
  }

  function strategyGlobalClass(seed) {
    var stableCls = getStableClasses(seed);
    if (stableCls.length === 0) return null;

    var tag = seed.tagName.toLowerCase();
    for (var n = Math.min(stableCls.length, 2); n >= 1; n--) {
      var clsPart = stableCls.slice(0, n).map(function(c) { return '.' + cssEscape(c); }).join('');
      var sel     = tag + clsPart;
      var matched = tryQSA(sel);
      if (matched && matched.indexOf(seed) !== -1 && matched.length >= 2 && matched.length <= 150) {
        return { els: matched, selector: sel, strategy: 'D:global-class', level: 99 };
      }
    }
    return null;
  }

  /* =========================================================================
     FIND SIMILAR ELEMENTS (REVISED PRIORITY)
     Try global class first to capture all similar elements across the page,
     even when they are split into multiple containers (e.g. infinite scroll).
     ========================================================================= */

  function findSimilarElements(seedEl) {
    if (!seedEl || isBoundary(seedEl)) {
      return { els: seedEl ? [seedEl] : [], selector: null, strategy: 'none' };
    }

    // 1) Global class – captures all similar elements using stable classes
    var global = strategyGlobalClass(seedEl);
    if (global && global.selector && !/:nth-(child|of-type)/.test(global.selector)) {
      return { els: global.els, selector: global.selector, strategy: global.strategy };
    }

    // 2) Direct siblings
    var direct = strategyDirectSiblings(seedEl);
    if (direct && direct.els.length > 1) {
      return { els: direct.els, selector: direct.selector, strategy: direct.strategy };
    }

    // 3) Ancestor‑based groups
    var candidates = [];
    var ancestorGroups = strategyAncestorGroups(seedEl);
    for (var i = 0; i < ancestorGroups.length; i++) candidates.push(ancestorGroups[i]);

    // if global didn't pass the nth‑test, still consider it as a fallback
    if (global) candidates.push(global);

    if (!candidates.length) {
      return { els: [seedEl], selector: null, strategy: 'none' };
    }

    candidates.forEach(function(c) {
      c.score = (c.strategy.indexOf('B') === 0 ? 40 : 15) + c.els.length;
    });
    candidates.sort(function(a, b) { return b.score - a.score; });

    var best = candidates[0];
    return { els: best.els, selector: best.selector, strategy: best.strategy };
  }

  /* =========================================================================
     PUBLIC API
     ========================================================================= */

  window.SelectorGenerator = {
    getSelectorsForElement: getSelectorsForElement,
    findSimilarElements: findSimilarElements,
    buildGroupSelector: buildExactGroupSelector,
    getStableClasses: getStableClasses,
  };

})();