(function enableSelectionMode() {
  'use strict';

  /* =========================================================================
     STATE MACHINE
     ─────────────────────────────────────────────────────────────────────────
     idle           → nothing selected
     first_selected → seed element green, similar group amber
     multi_selected → group confirmed, all green
     ========================================================================= */

  let selState     = 'idle';
  let currentEl    = null;   // seed element (first click)
  let softEls      = [];     // amber — proposed similar group
  let hardEls      = [];     // green — confirmed selection
  let softSelector = null;   // CSS selector for the soft group
  let softStrategy = null;   // human-readable strategy label
  let hoverEl      = null;
  let tooltip      = null;

  const originalStyles = new Map();

  const SOFT_OUTLINE  = '2px dashed #d29922';
  const HARD_OUTLINE  = '2px solid #3fb950';
  const HOVER_OUTLINE = '2px solid #58a6ff';

  /* =========================================================================
     STYLE HELPERS
     ========================================================================= */

  function storeOriginalStyle(el, prop) {
    if (!originalStyles.has(el)) originalStyles.set(el, {});
    const s = originalStyles.get(el);
    if (!(prop in s)) s[prop] = el.style[prop] || '';
  }

  function setStyle(el, prop, value, important) {
    storeOriginalStyle(el, prop);
    if (important) el.style.setProperty(prop, value, 'important');
    else           el.style[prop] = value;
  }

  function restoreStyle(el, prop) {
    const s = originalStyles.get(el);
    if (!s || !(prop in s)) return;
    const v = s[prop];
    if (v === '') el.style.removeProperty(prop);
    else          el.style[prop] = v;
    delete s[prop];
    if (!Object.keys(s).length) originalStyles.delete(el);
  }

  function clearArr(arr) {
    arr.forEach(function(el) {
      restoreStyle(el, 'outline');
      restoreStyle(el, 'box-shadow');
      // Re-apply scope elevation if this element is an iterator card
      if (_allIteratorEls && _allIteratorEls.indexOf(el) !== -1) {
        _reapplyScopeEl(el);
      }
    });
    arr.length = 0;
  }

  function _reapplyScopeEl(el) {
    if (!el) return;
    el.style.setProperty('outline',    SCOPE_OUTLINE, 'important');
    el.style.setProperty('box-shadow', SCOPE_SHADOW,  'important');
    if (getComputedStyle(el).position === 'static') {
      el.style.setProperty('position', 'relative', 'important');
    }
    el.style.setProperty('z-index', '2147483641', 'important');
  }

  function applySoft(els) {
    clearArr(softEls);
    els.forEach(function(el) {
      softEls.push(el);
      setStyle(el, 'outline',    SOFT_OUTLINE, true);
      setStyle(el, 'box-shadow', 'inset 0 0 0 9999px rgba(210,153,34,0.07)', true);
    });
  }

  function applyHard(els) {
    clearArr(hardEls);
    els.forEach(function(el) {
      hardEls.push(el);
      setStyle(el, 'outline',    HARD_OUTLINE, true);
      setStyle(el, 'box-shadow', 'inset 0 0 0 9999px rgba(63,185,80,0.06)', true);
    });
  }

  function fullReset() {
    clearArr(softEls);
    clearArr(hardEls);
    if (hoverEl &&
        softEls.indexOf(hoverEl) === -1 &&
        hardEls.indexOf(hoverEl) === -1) {
      if (_allIteratorEls && _allIteratorEls.indexOf(hoverEl) !== -1) {
        _reapplyScopeEl(hoverEl);
      } else {
        restoreStyle(hoverEl, 'outline');
      }
    }
    hoverEl      = null;
    currentEl    = null;
    softSelector = null;
    softStrategy = null;
    selState     = 'idle';
  }

  function cleanupSelectionMode() {
    fullReset();
    originalStyles.forEach(function(s, el) {
      Object.keys(s).forEach(function(prop) {
        var v = s[prop];
        if (v === '') el.style.removeProperty(prop);
        else          el.style[prop] = v;
      });
    });
    originalStyles.clear();
    if (tooltip) tooltip.style.display = 'none';
  }

  /* =========================================================================
     UTILITIES
     ========================================================================= */

  function isRoot(el) {
    return !el || el === document.documentElement || el === document.body;
  }

  function stableClasses(el) {
    if (window.SelectorGenerator && window.SelectorGenerator.getStableClasses) {
      return window.SelectorGenerator.getStableClasses(el);
    }
    return Array.from(el.classList).filter(function(c) {
      return c.length > 1 &&
        !/^(is-|has-|js-)/.test(c) &&
        !/^(active|inactive|open|closed|expanded|collapsed|visible|hidden|show|hide|selected|current|checked|disabled|enabled|loading|loaded|error|success|warning|hover|focus|focused|first|last|odd|even)$/.test(c) &&
        !/^(flex|grid|block|inline|relative|absolute|fixed|sticky|m|p|mx|my|px|py|mt|mb|ml|mr|pt|pb|pl|pr|w|h|text|font|bg|border|ring|shadow|rounded|opacity|gap|col|row|justify|items|self|overflow|z|cursor|transition|transform|duration|ease|animate)-/.test(c);
    });
  }

  function esc(id) {
    return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(id) : String(id).replace(/[^\w-]/g, '\\$&');
  }

  function buildSimpleSelector(el) {
    if (el.id) return '#' + esc(el.id);
    const tag = el.tagName.toLowerCase();
    const cls = stableClasses(el);
    return cls.length ? tag + '.' + esc(cls[0]) : tag;
  }

  function isInside(target, elementArray) {
    let el = target;
    while (el && el !== document.body) {
      if (elementArray.indexOf(el) !== -1) return true;
      el = el.parentElement;
    }
    return false;
  }

  /* =========================================================================
     TOOLTIP
     ========================================================================= */

  function createTooltip() {
    tooltip = document.createElement('div');
    tooltip.style.cssText = [
      'all:initial',
      'position:fixed',
      'background:rgba(13,17,23,0.92)',
      'color:#58a6ff',
      'padding:5px 10px',
      'font-size:11px',
      'font-family:ui-monospace,monospace',
      'border-radius:5px',
      'border:1px solid #30363d',
      'pointer-events:none',
      'z-index:2147483647',
      'display:none',
      'box-shadow:0 2px 8px rgba(0,0,0,0.5)',
      'max-width:400px',
      'white-space:nowrap',
      'overflow:hidden',
      'text-overflow:ellipsis',
    ].join(';');
    document.body.appendChild(tooltip);
  }

  function placeTooltip(e) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const m  = 14;
    const r  = tooltip.getBoundingClientRect();
    let left = e.clientX + m;
    let top  = e.clientY + m;
    if (left + r.width  > vw - m) left = e.clientX - r.width  - m;
    if (top  + r.height > vh - m) top  = e.clientY - r.height - m;
    tooltip.style.left = Math.max(m, left) + 'px';
    tooltip.style.top  = Math.max(m, top)  + 'px';
  }

  function getElPath(el, depth) {
    depth = depth || 4;
    const parts = [];
    let cur = el, n = 0;
    while (cur && cur.tagName && cur.tagName.toLowerCase() !== 'html') {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) seg += '#' + cur.id;
      else if (cur.classList.length) seg += '.' + Array.from(cur.classList).slice(0, 2).join('.');
      parts.unshift(seg);
      cur = cur.parentElement;
      if (++n >= depth) { parts.unshift('...'); break; }
    }
    return parts.join(' > ');
  }

  /* =========================================================================
     RELATIVE SELECTOR (forEach scope) — now allows nth-child as last resort
     ========================================================================= */

  function buildRelativeSelector(el, scopeEl) {
    const segments = [];
    let cur = el;
    while (cur && cur !== scopeEl) {
      const tag = cur.tagName.toLowerCase();
      const cls = stableClasses(cur);
      segments.unshift({ tag: tag, cls: cls, el: cur });
      cur = cur.parentElement;
      if (!cur) return null;
    }
    if (cur !== scopeEl || !segments.length) return null;

    function tryRel(sel) {
      try {
        const hits = Array.from(scopeEl.querySelectorAll(sel));
        if (hits.length === 1 && hits[0] === el) return sel;
        return null;
      } catch (_) { return null; }
    }

    // Strategy A: id or single/dual-class at the leaf level
    if (el.id) {
      const r = tryRel('#' + esc(el.id));
      if (r) return r;
    }
    const leaf = segments[segments.length - 1];
    if (leaf.cls.length >= 2) {
      const r = tryRel(leaf.tag + '.' + esc(leaf.cls[0]) + '.' + esc(leaf.cls[1]));
      if (r) return r;
    }
    if (leaf.cls.length >= 1) {
      let r = tryRel(leaf.tag + '.' + esc(leaf.cls[0]));
      if (r) return r;
      r = tryRel('.' + esc(leaf.cls[0]));
      if (r) return r;
    }

    // Strategy B: shortest suffix of the path that resolves uniquely
    for (let start = segments.length - 1; start >= 0; start--) {
      const path = segments.slice(start).map(function(s) {
        if (s.cls.length >= 2) return s.tag + '.' + esc(s.cls[0]) + '.' + esc(s.cls[1]);
        if (s.cls.length >= 1) return s.tag + '.' + esc(s.cls[0]);
        return s.tag;
      }).join(' > ');
      let r = tryRel(path);
      if (r) return r;

      const pathDesc = segments.slice(start).map(function(s) {
        return s.cls.length ? s.tag + '.' + esc(s.cls[0]) : s.tag;
      }).join(' ');
      r = tryRel(pathDesc);
      if (r) return r;
    }

    // Strategy C: nth-child fallback on leaf element
    var leafParent = el.parentElement;
    var leafIdxChild = Array.from(leafParent.children).indexOf(el) + 1;
    var leafTag = el.tagName.toLowerCase();
    var leafSel = leafTag + ':nth-child(' + leafIdxChild + ')';
    var fullSel;
    if (leafParent === scopeEl) {
      fullSel = leafSel;
    } else {
      var intermediate = segments.slice(0, -1).map(function(s) { return s.tag; }).join(' > ');
      fullSel = intermediate + ' > ' + leafSel;
    }
    var r = tryRel(fullSel);
    if (r) return r;

    // Also try nth-of-type
    var leafIdxType = Array.from(leafParent.children).filter(function(c) { return c.tagName === leafTag; }).indexOf(el) + 1;
    leafSel = leafTag + ':nth-of-type(' + leafIdxType + ')';
    if (leafParent === scopeEl) {
      fullSel = leafSel;
    } else {
      fullSel = intermediate + ' > ' + leafSel;
    }
    r = tryRel(fullSel);
    if (r) return r;

    // Absolute last resort: tag-only path (may not be unique, but kept for compatibility)
    return segments.map(function(s) { return s.tag; }).join(' > ');
  }

  /* =========================================================================
     ELEMENT INFO
     ========================================================================= */

  function buildElementInfo(el) {
    let primary           = null;
    let fallbackSelectors = [];

    const scopeEl = _forEachScopeEl;
    if (scopeEl && (el === scopeEl || scopeEl.contains(el))) {
      if (el === scopeEl) {
        primary = { value: ':scope', type: 'css', strategy: 'iterator-self' };
      } else {
        let relSel = buildRelativeSelector(el, scopeEl);

        if (relSel && _allIteratorEls.length > 1) {
          const others = _allIteratorEls.filter(function(e) { return e !== scopeEl; }).slice(0, 5);
          const tooAmbiguous = others.some(function(iterEl) {
            try { return iterEl.querySelectorAll(relSel).length > 1; }
            catch (_) { return false; }
          });
          if (tooAmbiguous) {
            const parts = [];
            let c = el;
            while (c && c !== scopeEl) {
              const tag = c.tagName.toLowerCase();
              const cls = stableClasses(c);
              parts.unshift(cls.length ? tag + '.' + esc(cls[0]) : tag);
              c = c.parentElement;
            }
            const candidate = parts.join(' > ');
            try {
              const hits = Array.from(scopeEl.querySelectorAll(candidate));
              if (hits.length === 1 && hits[0] === el) relSel = candidate;
            } catch (_) {}
          }
        }

        if (relSel) {
          primary = { value: relSel, type: 'css', strategy: 'relative-to-scope' };
        }
      }
    }

    if (!primary) {
      try {
        const result = window.SelectorGenerator.getSelectorsForElement(el, {
          actionType:   'generic',
          maxFallbacks: 5,
        });
        if (result.primary) {
          primary = {
            value:    result.primary.value,
            type:     result.primary.type,
            strategy: result.primary.strategy,
          };
        }
        fallbackSelectors = (result.fallbacks || []).map(function(f) {
          return { value: f.value, type: f.type, strategy: f.strategy };
        });
      } catch (_) {
        primary = { value: buildSimpleSelector(el), type: 'css', strategy: 'fallback' };
      }
    }

    const tag     = el.tagName.toLowerCase();
    const isLink  = tag === 'a' || !!el.closest('a');
    const isInput = ['input', 'textarea', 'select'].indexOf(tag) !== -1;
    const isImg   = tag === 'img';
    const isTable = tag === 'table' || !!el.querySelector('table');
    const text    = (el.textContent || '').trim().slice(0, 120);
    const href    = el.getAttribute('href') || null;
    const src     = el.getAttribute('src')  || null;

    const stopAt    = (scopeEl && el !== scopeEl) ? scopeEl : document.documentElement;
    const breadcrumb = [];
    let c = el;
    while (c && c.tagName && c !== stopAt) {
      let seg = c.tagName.toLowerCase();
      if (c.id) seg += '#' + c.id;
      else if (c.classList.length) seg += '.' + Array.from(c.classList).slice(0, 2).join('.');
      breadcrumb.unshift({ label: seg, selector: buildSimpleSelector(c) });
      c = c.parentElement;
    }

    const attrs = {};
    Array.from(el.attributes).forEach(function(a) {
      if (a.name !== 'style') attrs[a.name] = a.value.slice(0, 100);
    });

    return {
      selector:          primary ? primary.value    : '',
      selectorType:      primary ? primary.type     : 'css',
      selectorStrategy:  primary ? primary.strategy : '',
      fallbackSelectors: fallbackSelectors,
      isRelativeToScope: !!(scopeEl && (el === scopeEl || scopeEl.contains(el))),
      tag:    tag,
      text:   text,
      href:   href,
      src:    src,
      isLink: isLink, isInput: isInput, isImg: isImg, isTable: isTable,
      attrs:  attrs,
      breadcrumb: breadcrumb,
      classes: Array.from(el.classList).join(' '),
    };
  }

  /* =========================================================================
     SELECTION ACTIONS
     ========================================================================= */

  function doFirstClick(target) {

    if (_forEachScopeSel !== null) {
      const ownerIterEl = _allIteratorEls.find(function(el) {
        return el === target || el.contains(target);
      });
      if (!ownerIterEl) return;

      _forEachScopeEl = ownerIterEl;
      fullReset();
      currentEl = target;
      selState  = 'first_selected';
      applyHard([target]);

      tooltip.style.display = 'none';
      const info = buildElementInfo(target);
      info.softHighlightCount = 0;
      window.sendToNode({ type: 'elementSelected', element: info });
      return;
    }

    fullReset();
    currentEl = target;
    selState  = 'first_selected';
    applyHard([target]);

    let group;
    try {
      group = window.SelectorGenerator.findSimilarElements(target);
    } catch (_) {
      group = { els: [target], selector: null, strategy: 'none' };
    }

    const siblings = group.els.filter(function(el) { return el !== target; });

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
    const allEls = [currentEl].concat(softEls.slice());
    clearArr(softEls);
    applyHard(allEls);
    selState = 'multi_selected';
    tooltip.style.display = 'none';

    const buildGroup = (window.SelectorGenerator && window.SelectorGenerator.buildGroupSelector)
      ? window.SelectorGenerator.buildGroupSelector
      : function() { return null; };

    let finalSelector = softSelector || buildGroup(allEls) || '';

    if (finalSelector) {
      try {
        const matched   = Array.from(document.querySelectorAll(finalSelector));
        const allCovered = allEls.every(function(e) { return matched.indexOf(e) !== -1; });
        if (!allCovered) {
          finalSelector = buildGroup(allEls) || finalSelector;
        }
      } catch (_) {
        finalSelector = buildGroup(allEls) || finalSelector;
      }
    }

    window.sendToNode({
      type:           'multiElementSelected',
      commonSelector: finalSelector,
      matchCount:     allEls.length,
      selectorCount:  allEls.length,
      strategy:       softStrategy || '',
      elements:       allEls.map(buildElementInfo),
    });
  }

  /* =========================================================================
     MOUSE EVENTS
     ========================================================================= */

  function onMouseMove(e) {
    if (!window.__SELECTION_MODE__) return;
    const target = e.target;

    if (target === hoverEl) {
      if (tooltip.style.display !== 'none') placeTooltip(e);
      return;
    }

    if (hoverEl &&
        hardEls.indexOf(hoverEl) === -1 &&
        softEls.indexOf(hoverEl) === -1) {
      restoreStyle(hoverEl, 'outline');
    }
    hoverEl = target;

    const inScope = _forEachScopeSel === null ||
      _allIteratorEls.some(function(el) { return el === target || el.contains(target); });

    if (inScope &&
        hardEls.indexOf(hoverEl)         === -1 &&
        softEls.indexOf(hoverEl)         === -1 &&
        _allIteratorEls.indexOf(hoverEl) === -1) {
      setStyle(hoverEl, 'outline', HOVER_OUTLINE, true);
    }

    tooltip.style.display = 'block';

    if (_hoverHighlightEl) {
      tooltip.textContent = '🖱️ Click to select: ' + getElPath(_hoverHighlightEl, 3);
    } else if (_forEachScopeSel !== null) {
      const ownerIter = _allIteratorEls.find(function(el) {
        return el === target || el.contains(target);
      });
      if (ownerIter) {
        tooltip.textContent = target === ownerIter
          ? '⊙ Click to select this whole element (iterator)'
          : '⊙ Click to select: ' + getElPath(target, 3);
      } else {
        tooltip.textContent = '✕ Outside loop scope — only elements inside the highlighted items are selectable';
      }
    } else if (selState === 'first_selected' && (softEls.indexOf(target) !== -1 || isInside(target, softEls))) {
      tooltip.textContent = '⬡ Click to select all ' + (softEls.length + 1) + ' similar elements';
    } else if (selState === 'first_selected' && (hardEls.indexOf(target) !== -1 || isInside(target, hardEls))) {
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

    let target = e.target;
    if (_hoverHighlightEl) {
      target = _hoverHighlightEl;
      clearHoverHighlight();
    }

    if (selState === 'idle') {
      doFirstClick(target);
      return;
    }

    if (selState === 'first_selected') {
      if (_forEachScopeSel !== null) { doFirstClick(target); return; }

      if (softEls.indexOf(target) !== -1 || isInside(target, softEls)) {
        confirmSiblingGroup();
        return;
      }
      if (hardEls.indexOf(target) !== -1 || isInside(target, hardEls)) {
        fullReset();
        window.sendToNode({ type: 'selectionCleared' });
        return;
      }
      doFirstClick(target);
      return;
    }

    if (selState === 'multi_selected') {
      doFirstClick(target);
    }
  }

  /* =========================================================================
     FOREACH SCOPE
     ========================================================================= */

  let _forEachScopeEl  = null;
  let _forEachScopeSel = null;
  let _allIteratorEls  = [];
  let _dimOverlay      = null;

  const SCOPE_OUTLINE = '2px solid rgba(163,113,247,0.6)';
  const SCOPE_SHADOW  = '0 0 0 3px rgba(163,113,247,0.18)';

  function _createDimOverlay() {
    if (_dimOverlay) return;
    _dimOverlay = document.createElement('div');
    _dimOverlay.style.cssText = [
      'position:fixed', 'inset:0', 'pointer-events:none',
      'z-index:2147483640',
      'background:rgba(0,0,0,0)',
      'transition:background 200ms ease',
    ].join(';');
    document.body.appendChild(_dimOverlay);
    requestAnimationFrame(function() {
      if (_dimOverlay) _dimOverlay.style.background = 'rgba(0,0,0,0.45)';
    });
  }

  function _removeDimOverlay() {
    if (!_dimOverlay) return;
    const el = _dimOverlay;
    _dimOverlay = null;
    el.style.background = 'rgba(0,0,0,0)';
    setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
  }

  function _elevateEl(el) {
    if (!el) return;
    storeOriginalStyle(el, 'outline');
    storeOriginalStyle(el, 'box-shadow');
    storeOriginalStyle(el, 'position');
    storeOriginalStyle(el, 'z-index');
    el.style.setProperty('outline',    SCOPE_OUTLINE, 'important');
    el.style.setProperty('box-shadow', SCOPE_SHADOW,  'important');
    if (getComputedStyle(el).position === 'static') {
      el.style.setProperty('position', 'relative', 'important');
    }
    el.style.setProperty('z-index', '2147483641', 'important');
  }

  function _unelevateEl(el) {
    if (!el) return;
    restoreStyle(el, 'outline');
    restoreStyle(el, 'box-shadow');
    restoreStyle(el, 'position');
    restoreStyle(el, 'z-index');
  }

  window.__setForEachScope__ = function(iteratorSelector) {
    window.__clearForEachScope__();
    _forEachScopeSel = iteratorSelector;
    try {
      _allIteratorEls = Array.from(document.querySelectorAll(iteratorSelector));
    } catch (_) { _allIteratorEls = []; }

    _allIteratorEls.forEach(function(el) { _elevateEl(el); });
    _forEachScopeEl = _allIteratorEls[0] || null;
    _createDimOverlay();
  };

  window.__clearForEachScope__ = function() {
    const toUnelevate = _allIteratorEls.slice();
    _allIteratorEls  = [];
    _forEachScopeEl  = null;
    _forEachScopeSel = null;

    toUnelevate.forEach(function(el) { _unelevateEl(el); });
    clearArr(hardEls);
    clearArr(softEls);
    _removeDimOverlay();
    fullReset();
  };

  /* =========================================================================
     HOVER HIGHLIGHT (breadcrumb picker preview)
     ========================================================================= */

  let _hoverHighlightEl    = null;
  const HOVER_PICK_OUTLINE = '2px solid #a371f7';

  function applyHoverHighlight(el) {
    clearHoverHighlight();
    if (!el || !el.tagName) return;
    _hoverHighlightEl = el;
    setStyle(el, 'outline',    HOVER_PICK_OUTLINE, true);
    setStyle(el, 'box-shadow', 'inset 0 0 0 9999px rgba(163,113,247,0.10)', true);
  }

  function clearHoverHighlight() {
    if (!_hoverHighlightEl) return;
    const el = _hoverHighlightEl;
    _hoverHighlightEl = null;
    if (hardEls.indexOf(el) === -1 && softEls.indexOf(el) === -1) {
      restoreStyle(el, 'outline');
      restoreStyle(el, 'box-shadow');
    }
  }

  /* =========================================================================
     EXPOSED API
     ========================================================================= */

  window.__resetSelection__ = function() { fullReset(); };

  window.__highlightAncestor__ = function(levelsUp) {
    if (!currentEl) return;
    let el = currentEl;
    for (let i = 0; i < levelsUp; i++) el = el && el.parentElement;
    applyHoverHighlight(el || null);
  };

  window.__highlightPickerChild__ = function(levelsUp, childIndex) {
    if (!currentEl) return;
    let el = currentEl;
    for (let i = 0; i < levelsUp; i++) el = el && el.parentElement;
    applyHoverHighlight((el && el.children[childIndex]) || null);
  };

  window.__clearHoverHighlight__ = function() { clearHoverHighlight(); };

  window.__selectAncestor__ = function(levelsUp) {
    if (!currentEl) return;
    let el = currentEl;
    for (let i = 0; i < levelsUp; i++) el = el && el.parentElement;
    if (el && el.tagName && !isRoot(el)) {
      onClick({ target: el, preventDefault: function(){}, stopPropagation: function(){} });
    }
  };

  window.__getChildrenOf__ = function(levelsUp) {
    if (!currentEl) return [];
    let el = currentEl;
    for (let i = 0; i < levelsUp; i++) el = el && el.parentElement;
    if (!el) return [];
    return Array.from(el.children).map(function(child, idx) {
      const info = buildElementInfo(child);
      info.childIndex = idx;
      return info;
    });
  };

  window.__selectChildByIndex__ = function(levelsUp, childIndex) {
    if (!currentEl) return;
    let el = currentEl;
    for (let i = 0; i < levelsUp; i++) el = el && el.parentElement;
    if (el && el.children[childIndex]) {
      // Call doFirstClick directly — onClick would see the child inside hardEls
      // and fire selectionCleared instead of selecting the child.
      doFirstClick(el.children[childIndex]);
    }
  };

  /* =========================================================================
     SELECTION MODE WATCHER
     ========================================================================= */

  let _selectionMode = window.__SELECTION_MODE__;
  Object.defineProperty(window, '__SELECTION_MODE__', {
    get: function()      { return _selectionMode; },
    set: function(value) {
      if (_selectionMode !== value) {
        _selectionMode = value;
        if (!value) cleanupSelectionMode();
      }
    },
    configurable: true,
  });

  /* =========================================================================
     INIT
     ========================================================================= */

  function initSelectorTool() {

    // Prevent double init
    if (window.__SELECTOR_TOOL_INITIALIZED__) return;
    window.__SELECTOR_TOOL_INITIALIZED__ = true;

    createTooltip();

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);

    console.log('✅ SelectorTool injected (delegating to SelectorGenerator v3)');
  }

  if (document.body) {
    initSelectorTool();
  } else {
    window.addEventListener('DOMContentLoaded', initSelectorTool, { once: true });
  }

})();