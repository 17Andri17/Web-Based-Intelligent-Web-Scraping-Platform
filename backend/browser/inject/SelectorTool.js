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
  let softEls      = [];     // amber — proposed similar group (next tier)
  let hardEls      = [];     // green — confirmed selection
  let softSelector = null;   // CSS selector for the soft group
  let softStrategy = null;   // human-readable strategy label
  let hoverEl      = null;
  let tooltip      = null;

  // Hierarchical similar-selection: an ordered ladder of progressively wider,
  // nested groups. tier 0 = nearest similar siblings … last tier = whole page.
  let tierList     = [];     // decorated tiers from SelectorGenerator.findSimilarTiers
  let pendingTier  = -1;     // index of the tier currently proposed in amber

  // List-field-pick mode — activated when user clicks "Pick from page" in
  // the EXTRACT_LIST step editor. Highlights containers, lets user click
  // child elements, emits relative selectors back to the frontend.
  let _listPickMode       = false;
  let _listPickContainers = [];
  let _listPickHoverEl    = null;
  let _listPickOverlay    = null;

  const originalStyles = new Map();
  // Every element we've ever applied a highlight style to. Used as a
  // last-resort sweep when tearing down — guarantees no stray inline
  // highlight survives even if the per-subsystem bookkeeping gets out of
  // sync (e.g. styles applied via direct setProperty that aren't tracked
  // in originalStyles).
  const _styledEls = new Set();
  function _markStyled(el) { if (el) _styledEls.add(el); }

  const SOFT_OUTLINE  = '2px dashed #d29922';
  const HARD_OUTLINE  = '2px solid #3fb950';
  const HOVER_OUTLINE = '2px solid #58a6ff';

  const CONTAINER_PICK_OUTLINE     = '2px solid rgba(163,113,247,0.55)';
  const CONTAINER_PICK_SHADOW      = 'inset 0 0 0 9999px rgba(163,113,247,0.06)';
  const FIELD_PICK_HOVER_OUTLINE   = '2px solid #58a6ff';
  const FIELD_PICK_HOVER_SHADOW    = 'inset 0 0 0 9999px rgba(88,166,255,0.11)';
  const FIELD_PICK_CONFIRM_OUTLINE = '2px solid #3fb950';
  const FIELD_PICK_CONFIRM_SHADOW  = 'inset 0 0 0 9999px rgba(63,185,80,0.13)';

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
    _markStyled(el);
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
    _markStyled(el);
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
    tierList     = [];
    pendingTier  = -1;
    selState     = 'idle';
  }

  // Brute-force safety net: strip any leftover highlight inline styles we may
  // have applied. Only removes values that match OUR highlight palette, so a
  // site's own inline outline/box-shadow is left untouched. Catches styles
  // applied via direct setProperty that originalStyles never tracked.
  function _sweepStrayHighlights() {
    var ourOutlines = [
      SOFT_OUTLINE, HARD_OUTLINE, HOVER_OUTLINE,
      CONTAINER_PICK_OUTLINE, FIELD_PICK_HOVER_OUTLINE, FIELD_PICK_CONFIRM_OUTLINE,
      (typeof SCOPE_OUTLINE     !== 'undefined' ? SCOPE_OUTLINE     : null),
      (typeof HOVER_PICK_OUTLINE !== 'undefined' ? HOVER_PICK_OUTLINE : null),
    ];
    _styledEls.forEach(function(el) {
      try {
        if (!el || !el.style) return;
        if (ourOutlines.indexOf(el.style.outline) !== -1) el.style.removeProperty('outline');
        var bs = el.style.boxShadow || el.style.getPropertyValue('box-shadow');
        if (bs && (bs.indexOf('inset 0 0 0 9999px') !== -1 ||
                   (typeof SCOPE_SHADOW !== 'undefined' && bs === SCOPE_SHADOW))) {
          el.style.removeProperty('box-shadow');
        }
      } catch (_) {}
    });
    _styledEls.clear();
  }

  function cleanupSelectionMode() {
    // Tear down EVERY highlight subsystem — not just the main selection — so
    // nothing lingers when the user flips to navigation mode. Each teardown
    // is guarded/idempotent.
    try { clearHoverHighlight(); } catch (_) {}
    if (_listPickMode && typeof window.__stopListFieldPick__ === 'function') {
      try { window.__stopListFieldPick__(); } catch (_) {}
    }
    if (_forEachScopeSel !== null && typeof window.__clearForEachScope__ === 'function') {
      try { window.__clearForEachScope__(); } catch (_) {}
    }
    fullReset();
    originalStyles.forEach(function(s, el) {
      Object.keys(s).forEach(function(prop) {
        var v = s[prop];
        if (v === '') el.style.removeProperty(prop);
        else          el.style[prop] = v;
      });
    });
    originalStyles.clear();
    _sweepStrayHighlights();
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

    // Strategy B: shortest suffix of the path that resolves uniquely.
    // For the full path (start === 0), prefix with :scope so the first
    // combinator anchors to a direct child of the container rather than
    // matching the same tag combination at any nesting depth.
    for (let start = segments.length - 1; start >= 0; start--) {
      const path = segments.slice(start).map(function(s) {
        if (s.cls.length >= 2) return s.tag + '.' + esc(s.cls[0]) + '.' + esc(s.cls[1]);
        if (s.cls.length >= 1) return s.tag + '.' + esc(s.cls[0]);
        return s.tag;
      }).join(' > ');
      let r = tryRel(path);
      if (r) return r;
      // Full path with :scope anchor
      if (start === 0) {
        r = tryRel(':scope > ' + path);
        if (r) return r;
      }

      const pathDesc = segments.slice(start).map(function(s) {
        return s.cls.length ? s.tag + '.' + esc(s.cls[0]) : s.tag;
      }).join(' ');
      r = tryRel(pathDesc);
      if (r) return r;
      if (start === 0) {
        r = tryRel(':scope > ' + pathDesc);
        if (r) return r;
      }
    }

    // Strategy C: nth-child / nth-of-type on the leaf, with :scope prefix so
    // the intermediate path is anchored to the container's direct children.
    var leafParent = el.parentElement;
    var leafIdxChild = Array.from(leafParent.children).indexOf(el) + 1;
    var leafTag = el.tagName.toLowerCase();
    var leafSel = leafTag + ':nth-child(' + leafIdxChild + ')';
    var fullSel;
    if (leafParent === scopeEl) {
      fullSel = ':scope > ' + leafSel;
    } else {
      var intermediate = segments.slice(0, -1).map(function(s) { return s.tag; }).join(' > ');
      fullSel = ':scope > ' + intermediate + ' > ' + leafSel;
    }
    var r = tryRel(fullSel);
    if (r) return r;

    // Also try nth-of-type
    var leafIdxType = Array.from(leafParent.children).filter(function(c) { return c.tagName === leafTag; }).indexOf(el) + 1;
    leafSel = leafTag + ':nth-of-type(' + leafIdxType + ')';
    if (leafParent === scopeEl) {
      fullSel = ':scope > ' + leafSel;
    } else {
      fullSel = ':scope > ' + intermediate + ' > ' + leafSel;
    }
    r = tryRel(fullSel);
    if (r) return r;

    // Strategy D: Full :scope-anchored nth-child path — truly guaranteed unique.
    // Without :scope, 'div:nth-child(2) > span:nth-child(1)' matches any span
    // that is the 1st child of a 2nd-child div ANYWHERE inside the container,
    // not just the one on the direct-child path we walked up. :scope > anchors
    // the first combinator to a direct child of the container, so the full
    // positional path is unambiguous.
    var nthParts = [];
    var nthCur = el;
    var nthOk  = true;
    while (nthCur && nthCur !== scopeEl) {
      var nthParent = nthCur.parentElement;
      if (!nthParent) { nthOk = false; break; }
      var nthIdx = Array.from(nthParent.children).indexOf(nthCur) + 1;
      nthParts.unshift(nthCur.tagName.toLowerCase() + ':nth-child(' + nthIdx + ')');
      nthCur = nthParent;
    }
    if (nthOk && nthParts.length) {
      var r = tryRel(':scope > ' + nthParts.join(' > '));
      if (r) return r;
    }

    // Nothing produced a unique match — caller will fall back to absolute selector.
    return null;
  }

  /* =========================================================================
     LIST-FIELD PICK HELPERS
     ========================================================================= */

  function _inferFieldKind(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'img') return { kind: 'attr', attribute: 'src' };
    if (tag === 'a')   return { kind: 'attr', attribute: 'href' };
    var href = el.getAttribute('href');
    var src  = el.getAttribute('src');
    if (href) return { kind: 'attr', attribute: 'href' };
    if (src)  return { kind: 'attr', attribute: 'src' };
    return { kind: 'text', attribute: null };
  }

  function _extractPickSample(el, kind, attribute) {
    if (kind === 'attr' && attribute) return (el.getAttribute(attribute) || '').slice(0, 200);
    return ((el.textContent || el.innerText || '').trim()).slice(0, 200);
  }

  // Every extractable thing on the element — the user picks which one they
  // meant (clicking a link doesn't always mean "give me the href"). Text
  // first, then each non-empty attribute (class/style are selector noise,
  // not data), then the enclosing link's href when the click landed on
  // something nested inside an <a> (a very common "I want the link" case),
  // innerHTML last. Options may carry their own `selector` when they target
  // a different element than the one clicked (the ancestor <a>).
  function _collectFieldOptions(el, containerEl) {
    var opts = [];
    opts.push({ kind: 'text', attribute: null,
                sample: ((el.textContent || el.innerText || '').trim()).slice(0, 200) });
    var attrs = Array.prototype.slice.call(el.attributes || []);
    for (var i = 0; i < attrs.length; i++) {
      var name = attrs[i].name;
      var val  = (attrs[i].value || '').trim();
      if (!val || name === 'class' || name === 'style') continue;
      opts.push({ kind: 'attr', attribute: name, sample: val.slice(0, 200) });
    }
    try {
      if (containerEl && el.closest && !el.getAttribute('href')) {
        var linkEl = el.closest('a[href]');
        if (linkEl && linkEl !== el && containerEl.contains(linkEl)) {
          // '' means "the container element itself" — same convention the
          // AI-detected fields use.
          var linkSel = linkEl === containerEl ? '' : buildRelativeSelector(linkEl, containerEl);
          if (linkSel !== null) {
            opts.push({ kind: 'attr', attribute: 'href',
                        sample: (linkEl.getAttribute('href') || '').slice(0, 200),
                        selector: linkSel, fromAncestor: true });
          }
        }
      }
    } catch (_) {}
    var html = (el.innerHTML || '').trim();
    if (html) opts.push({ kind: 'html', attribute: null, sample: html.slice(0, 200) });
    return opts;
  }

  function _suggestFieldName(tag, relSel, kind, attribute) {
    if (kind === 'attr' && attribute) {
      if (attribute === 'href') return 'link';
      if (attribute === 'src')  return 'image';
      return attribute.replace(/-/g, '_');
    }
    // Try to get a meaningful class name from the selector
    var clsMatch = relSel.match(/\.([a-zA-Z][a-zA-Z0-9_-]*)/);
    if (clsMatch) {
      var cls = clsMatch[1].replace(/-/g, '_').toLowerCase().slice(0, 30);
      // Skip obvious hashes (short, mixed case+digits) and numeric-only names
      var looksLikeHash = /^[a-f0-9]{4,}$/.test(cls) || /[0-9]{3,}/.test(cls);
      var tooShort = cls.length <= 1;
      if (!looksLikeHash && !tooShort) return cls;
    }
    // Semantic fallbacks from tag
    var semantics = { h1:'title', h2:'title', h3:'title', h4:'subtitle',
                      p:'description', time:'date', span:'value',
                      img:'image', a:'link', button:'button' };
    return semantics[tag] || tag;
  }

  function _createListPickOverlay() {
    if (_listPickOverlay) return;
    _listPickOverlay = document.createElement('div');
    _listPickOverlay.style.cssText = [
      'position:fixed', 'inset:0', 'pointer-events:none',
      'z-index:2147483640',
      'background:rgba(0,0,0,0)',
      'transition:background 200ms ease',
    ].join(';');
    document.body.appendChild(_listPickOverlay);
    requestAnimationFrame(function() {
      if (_listPickOverlay) _listPickOverlay.style.background = 'rgba(0,0,0,0.40)';
    });
  }

  function _removeListPickOverlay() {
    if (!_listPickOverlay) return;
    var el = _listPickOverlay;
    _listPickOverlay = null;
    el.style.background = 'rgba(0,0,0,0)';
    setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
  }

  function _clearListPickHover() {
    if (!_listPickHoverEl) return;
    var el = _listPickHoverEl;
    _listPickHoverEl = null;
    restoreStyle(el, 'outline');
    restoreStyle(el, 'box-shadow');
  }

  /* =========================================================================
     ELEMENT INFO
     ========================================================================= */

  // Element-only child-index chain from <html> down to el — the same
  // addressing the HTML tab's tree uses, so a selection made anywhere
  // (canvas click, ancestor nav, child pick) can be mirrored back onto
  // that tree without a CSS-selector round-trip.
  function computePath(el) {
    const path = [];
    let cur = el;
    while (cur && cur !== document.documentElement) {
      const parent = cur.parentElement;
      if (!parent) break;
      path.unshift(Array.prototype.indexOf.call(parent.children, cur));
      cur = parent;
    }
    return path;
  }

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
    // A table is in play when the element IS a table, sits INSIDE one (closest
    // ancestor — the nearest enclosing table wins for nested tables), or
    // CONTAINS one. We resolve the actual <table> node so the EXTRACT_TABLE
    // step targets it directly rather than the clicked cell/wrapper.
    const tableEl = el.closest('table') || (tag !== 'table' ? el.querySelector('table') : el);
    const isTable = !!tableEl;
    let tableSelector = null;
    if (tableEl) {
      if (tableEl === el && primary) {
        tableSelector = { value: primary.value, type: primary.type, fallbacks: fallbackSelectors };
      } else {
        try {
          const tr = window.SelectorGenerator.getSelectorsForElement(tableEl, {
            actionType: 'generic', maxFallbacks: 3,
          });
          if (tr.primary) {
            tableSelector = {
              value: tr.primary.value,
              type:  tr.primary.type,
              fallbacks: (tr.fallbacks || []).map(function(f) {
                return { value: f.value, type: f.type, strategy: f.strategy };
              }),
            };
          }
        } catch (_) {
          tableSelector = { value: buildSimpleSelector(tableEl), type: 'css', fallbacks: [] };
        }
      }
    }
    const text    = (el.textContent || '').trim().slice(0, 120);
    const href    = el.getAttribute('href') || null;
    const src     = el.getAttribute('src')  || null;

    // Parent context: the parent's text usually contains a nearby label that
    // describes what THIS element is (e.g. <h2>180</h2> next to
    // <h4>Cert Providers</h4>). We capture both the flat text and a
    // truncated outerHTML so the LLM can latch onto sibling labels.
    const parentEl = el.parentElement;
    const parentTag = parentEl && parentEl.tagName ? parentEl.tagName.toLowerCase() : '';
    const parentText = parentEl ? (parentEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400) : '';
    let parentHtml = '';
    if (parentEl && parentEl.outerHTML) {
      // Compact whitespace and cap aggressively — we just want the structure
      // and any label text, not full styling.
      parentHtml = parentEl.outerHTML.replace(/\s+/g, ' ').trim().slice(0, 600);
    }

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
      tableSelector: tableSelector,
      attrs:  attrs,
      breadcrumb: breadcrumb,
      classes: Array.from(el.classList).join(' '),
      parentTag:  parentTag,
      parentText: parentText,
      parentHtml: parentHtml,
      path: computePath(el),
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

    let tierResult;
    try {
      tierResult = window.SelectorGenerator.findSimilarTiers(target);
    } catch (_) {
      tierResult = { tiers: [], strategy: 'none' };
    }
    tierList     = tierResult.tiers || [];
    pendingTier  = -1;
    softSelector = null;
    softStrategy = null;

    let softCount = 0;
    if (tierList.length && tierList[0].els.length > 1) {
      pendingTier  = 0;
      softSelector = tierList[0].primary;
      softStrategy = tierResult.strategy;
      const extras = tierList[0].els.filter(function(el) { return el !== target; });
      applySoft(extras);
      softCount = extras.length;
    }

    tooltip.style.display = 'none';
    const info = buildElementInfo(target);
    info.softHighlightCount = softCount;
    info.softSelector       = softSelector;
    info.softFallbacks      = (pendingTier >= 0 && tierList[pendingTier])
      ? (tierList[pendingTier].fallbacks || [])
      : [];
    info.softStrategy       = softStrategy;
    info.pendingTier        = pendingTier;
    info.tierSummary        = tierList.map(function(t, i) {
      return { index: i, count: t.count, label: t.label };
    });
    window.sendToNode({ type: 'elementSelected', element: info });
  }

  /* Build the multiElementSelected payload for a confirmed tier. */
  function sendTierSelection(tier, idx) {
    tooltip.style.display = 'none';
    const next = tierList[idx + 1] || null;
    window.sendToNode({
      type:              'multiElementSelected',
      commonSelector:    tier.primary || '',
      fallbackSelectors: tier.fallbacks || [],
      matchCount:        tier.els.length,
      selectorCount:     tier.els.length,
      strategy:          tier.strategy || softStrategy || '',
      elements:          tier.els.map(buildElementInfo),
      tierIndex:         idx,
      tierCount:         tierList.length,
      tierLabel:         tier.label || '',
      nextTier:          next ? {
        count: next.count,
        label: next.label,
        added: next.count - tier.els.length,
      } : null,
    });
  }

  // Confirm the amber-highlighted tier as a green selection. If a wider tier
  // exists, reveal the newly-reachable elements in amber so the user can keep
  // expanding; otherwise the selection is final.
  function confirmPendingTier() {
    if (pendingTier < 0 || !tierList[pendingTier]) return;
    const idx  = pendingTier;
    const tier = tierList[idx];

    clearArr(softEls);
    applyHard(tier.els.slice());

    const nextIdx = idx + 1;
    let nextExtras = [];
    if (tierList[nextIdx]) {
      const confirmedSet = tier.els;
      nextExtras = tierList[nextIdx].els.filter(function(el) {
        return confirmedSet.indexOf(el) === -1;
      });
    }

    if (nextExtras.length) {
      pendingTier  = nextIdx;
      softSelector = tierList[nextIdx].primary;
      applySoft(nextExtras);
      selState = 'expandable';
    } else {
      pendingTier  = -1;
      softSelector = null;
      selState = 'multi_selected';
    }

    sendTierSelection(tier, idx);
  }

  // Lock in the current green selection without expanding any further.
  function finalizeStop() {
    clearArr(softEls);
    pendingTier  = -1;
    softSelector = null;
    selState     = 'multi_selected';
  }

  /* =========================================================================
     MOUSE EVENTS
     ========================================================================= */

  function onMouseMove(e) {
    // ── List-field-pick mode (takes priority over selection mode) ──────────
    if (_listPickMode) {
      var tgt = e.target;
      if (tgt === tooltip) return;
      var ownerContainer = null;
      for (var ci = 0; ci < _listPickContainers.length; ci++) {
        if (_listPickContainers[ci] === tgt || _listPickContainers[ci].contains(tgt)) {
          ownerContainer = _listPickContainers[ci];
          break;
        }
      }
      if (tgt !== _listPickHoverEl) {
        _clearListPickHover();
        if (ownerContainer && tgt !== ownerContainer) {
          _listPickHoverEl = tgt;
          setStyle(tgt, 'outline',    FIELD_PICK_HOVER_OUTLINE, true);
          setStyle(tgt, 'box-shadow', FIELD_PICK_HOVER_SHADOW,  true);
        }
      }
      if (tooltip) {
        if (ownerContainer && tgt !== ownerContainer) {
          tooltip.textContent = '🎯 Click to add as field: ' + getElPath(tgt, 3);
        } else if (ownerContainer === tgt) {
          tooltip.textContent = '⚠ Click a child element inside, not the container itself';
        } else {
          tooltip.textContent = '↩ Outside containers — move inside the purple-outlined items';
        }
        tooltip.style.cssText += ';transform:none';
        tooltip.style.display = 'block';
        placeTooltip(e);
      }
      return;
    }

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
    } else if ((selState === 'first_selected' || selState === 'expandable') &&
               (softEls.indexOf(target) !== -1 || isInside(target, softEls))) {
      const pt = (pendingTier >= 0 && tierList[pendingTier]) ? tierList[pendingTier] : null;
      if (pt) {
        const name = pt.label.replace(/\s*\(\d+\)\s*$/, '');
        tooltip.textContent = '⬡ Click to select ' + name +
          ' — ' + pt.count + ' element' + (pt.count !== 1 ? 's' : '');
      } else {
        tooltip.textContent = '⬡ Click to select the highlighted group';
      }
    } else if (selState === 'expandable' && (hardEls.indexOf(target) !== -1 || isInside(target, hardEls))) {
      tooltip.textContent = '✓ ' + hardEls.length + ' selected — click here to finish, or click an amber item to widen';
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
    // ── Cookie-consent auto-dismiss in progress ───────────────────────────
    // The consent manager dispatches a synthetic click on the accept/reject
    // button. Let it pass straight through to the real element instead of
    // treating it as an element selection (which would preventDefault and
    // emit a spurious selection). This is what keeps consent working while
    // the user is in selection mode or switches modes mid-navigation.
    if (window.__consentInProgress__) return;

    // ── List-field-pick mode (takes priority over selection mode) ──────────
    if (_listPickMode) {
      var tgt = e.target;
      if (tgt === tooltip) return;
      e.preventDefault();
      e.stopPropagation();

      // Find the owning container
      var containerEl = null;
      for (var ci = 0; ci < _listPickContainers.length; ci++) {
        if (_listPickContainers[ci] === tgt || _listPickContainers[ci].contains(tgt)) {
          containerEl = _listPickContainers[ci];
          break;
        }
      }
      if (!containerEl) return; // clicked outside any container
      if (tgt === containerEl) {
        // Click landed on container padding — fall back to last hovered child
        if (_listPickHoverEl && containerEl.contains(_listPickHoverEl)) {
          tgt = _listPickHoverEl;
        } else {
          return;
        }
      }

      var relSel = buildRelativeSelector(tgt, containerEl);
      if (!relSel) return;

      // Verify selector resolves to exactly one element in each sibling container
      var worksInSiblings = _listPickContainers
        .filter(function(c) { return c !== containerEl; })
        .slice(0, 8)
        .every(function(c) {
          try { return c.querySelectorAll(relSel).length === 1; }
          catch (_) { return false; }
        });

      var kindInfo   = _inferFieldKind(tgt);
      var sampleVal  = _extractPickSample(tgt, kindInfo.kind, kindInfo.attribute);
      var suggested  = _suggestFieldName(tgt.tagName.toLowerCase(), relSel, kindInfo.kind, kindInfo.attribute);

      window.sendToNode({
        type:             'listFieldPicked',
        relativeSelector: relSel,
        kind:             kindInfo.kind,
        attribute:        kindInfo.attribute || null,
        sampleValue:      sampleVal,
        suggestedName:    suggested,
        tag:              tgt.tagName.toLowerCase(),
        worksInSiblings:  worksInSiblings,
        // All extractable choices (text / attributes / html) so the editor
        // can let the user pick — kind/attribute above are just the default.
        options:          _collectFieldOptions(tgt, containerEl),
      });

      // Brief green flash to confirm
      _clearListPickHover();
      setStyle(tgt, 'outline',    FIELD_PICK_CONFIRM_OUTLINE, true);
      setStyle(tgt, 'box-shadow', FIELD_PICK_CONFIRM_SHADOW,  true);
      var flashEl = tgt;
      setTimeout(function() {
        restoreStyle(flashEl, 'outline');
        restoreStyle(flashEl, 'box-shadow');
      }, 700);
      return;
    }

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
        confirmPendingTier();
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

    if (selState === 'expandable') {
      // Amber → expand to the next (wider) tier. Green → finish here.
      if (softEls.indexOf(target) !== -1 || isInside(target, softEls)) {
        confirmPendingTier();
        return;
      }
      if (hardEls.indexOf(target) !== -1 || isInside(target, hardEls)) {
        finalizeStop();
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
    _markStyled(el);
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

  window.__startListFieldPick__ = function(containerSelector) {
    window.__stopListFieldPick__(); // idempotent — clear any previous state
    fullReset();                    // clear any normal element selection
    _listPickMode = true;
    try {
      _listPickContainers = Array.from(document.querySelectorAll(containerSelector));
    } catch (_) {
      // containerSelector may be an XPath expression — try document.evaluate
      try {
        var xr = document.evaluate(containerSelector, document, null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        _listPickContainers = [];
        for (var xi = 0; xi < xr.snapshotLength; xi++) {
          _listPickContainers.push(xr.snapshotItem(xi));
        }
      } catch (_2) { _listPickContainers = []; }
    }
    _listPickContainers.forEach(function(el) {
      _markStyled(el);
      storeOriginalStyle(el, 'outline');
      storeOriginalStyle(el, 'box-shadow');
      storeOriginalStyle(el, 'position');
      storeOriginalStyle(el, 'z-index');
      el.style.setProperty('outline',    CONTAINER_PICK_OUTLINE, 'important');
      el.style.setProperty('box-shadow', CONTAINER_PICK_SHADOW,  'important');
      if (getComputedStyle(el).position === 'static') {
        el.style.setProperty('position', 'relative', 'important');
      }
      el.style.setProperty('z-index', '2147483641', 'important');
    });
    _createListPickOverlay();
    if (tooltip) {
      tooltip.textContent = '🎯 Click an element inside the highlighted containers to add it as a field';
      tooltip.style.display = 'block';
      tooltip.style.top  = '12px';
      tooltip.style.left = '50%';
      tooltip.style.setProperty('transform', 'translateX(-50%)');
    }
  };

  window.__stopListFieldPick__ = function() {
    if (!_listPickMode) return;
    _listPickMode = false;
    _clearListPickHover();
    _listPickContainers.forEach(function(el) {
      restoreStyle(el, 'outline');
      restoreStyle(el, 'box-shadow');
      restoreStyle(el, 'position');
      restoreStyle(el, 'z-index');
    });
    _listPickContainers = [];
    _removeListPickOverlay();
    if (tooltip) {
      tooltip.style.display = 'none';
      tooltip.style.transform = '';
      tooltip.style.top  = '';
      tooltip.style.left = '';
    }
  };

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

  // ── HTML-tree tab support ────────────────────────────────────────────────
  // The HTML tab renders a DOMParser-built tree from the same markup the
  // backend serialized via page.content(), and re-derives a child-index path
  // for each node from <html> down. We just walk that path against the live
  // DOM and reuse the existing click-selection pipeline. Stale paths (page
  // mutated since the snapshot) simply find no element and no-op.
  function resolvePath(path) {
    let el = document.documentElement;
    for (let i = 0; i < path.length && el; i++) el = el.children[path[i]];
    return el || null;
  }

  window.__selectByPath__ = function(path) {
    const el = resolvePath(path || []);
    if (el) doFirstClick(el);
  };

  window.__highlightByPath__ = function(path) {
    const el = resolvePath(path || []);
    clearHoverHighlight();
    if (el) applyHoverHighlight(el);
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