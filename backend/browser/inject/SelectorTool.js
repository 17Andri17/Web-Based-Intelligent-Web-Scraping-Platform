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

  // Manual multi-element add — the "select more similar elements yourself"
  // escape hatch. The tier engine only widens within ONE similarity basis
  // (a shared class, a structural twin set); this lets the user hand-pick a
  // set that CROSSES those bases (e.g. every badge <p> regardless of its
  // .green/.red/.blue colour) and derives the most specific comma-free
  // selector covering them all. Adding picks that sit farther apart widens
  // the scope on its own (see SelectorGenerator.generalizeFromSamples).
  let _multiAddMode  = false;
  let _multiSamples  = [];   // explicit user picks (blue rings)
  let _multiMatchEls = [];   // everything the generalised selector matches (green)

  // List-field-pick mode — activated when user clicks "Pick from page" in
  // the EXTRACT_LIST step editor. Highlights containers, lets user click
  // child elements, emits relative selectors back to the frontend.
  let _listPickMode       = false;
  let _listPickContainers = [];
  let _listPickHoverEl    = null;
  let _listPickOverlay    = null;
  // Markers for fields that are ALREADY defined on the list: outlined
  // elements + small name chips, painted on every matching container item
  // so the user sees at a glance what's captured and what's still free.
  let _listPickFieldEls   = [];
  let _listPickChips      = [];
  let _listPickLastFields = null;
  // The element the user just clicked and is now naming/configuring in the
  // editor — spotlighted on the page until the pick is confirmed/discarded.
  let _listPickPendingEl   = null;
  let _listPickPendingCont = null;
  let _listPickPendingBox  = null;   // positioned highlight box (outline alone
                                     // collapses on inline elements wrapping blocks)
  // Periodic layout watchdog: re-anchors overlay holes + marker chips when
  // the page reflows (lazy images, infinite lists).
  let _listPickLayoutTimer = null;
  let _listPickLayoutSig   = '';
  // Passive marker PREVIEW — shown while an EXTRACT_LIST step's editor is
  // expanded (but not actively picking): the captured-field markers on every
  // similar item, with NO dim and NO click interception, so the user always
  // sees what the step captures. Shares the container / marker machinery with
  // pick mode; `_listPickMode` gates the dim + interception, this gates the
  // passive view.
  let _listPreviewActive  = false;
  let _listPreviewSelector = null;

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

  // Manual multi-add: the derived match set is green (like a confirmed group);
  // the elements the user picked BY HAND get a stronger blue ring on top so
  // they stand out from the generalisation they produced.
  const MULTI_PICK_OUTLINE  = '3px solid #58a6ff';
  const MULTI_PICK_SHADOW   = 'inset 0 0 0 9999px rgba(88,166,255,0.16)';
  const MULTI_MATCH_OUTLINE = '2px solid #3fb950';
  const MULTI_MATCH_SHADOW  = 'inset 0 0 0 9999px rgba(63,185,80,0.07)';

  const CONTAINER_PICK_OUTLINE     = '2px solid #a371f7';
  const CONTAINER_PICK_SHADOW      = 'inset 0 0 0 9999px rgba(163,113,247,0.05)';
  const FIELD_PICK_HOVER_OUTLINE   = '2px solid #58a6ff';
  const FIELD_PICK_HOVER_SHADOW    = 'inset 0 0 0 9999px rgba(88,166,255,0.11)';
  const FIELD_PICK_CONFIRM_OUTLINE = '2px solid #3fb950';
  const FIELD_PICK_CONFIRM_SHADOW  = 'inset 0 0 0 9999px rgba(63,185,80,0.13)';
  // Subtle container outline used in passive marker preview (lighter than
  // the pick-mode container outline — it's just orienting, not interactive).
  const CONTAINER_PREVIEW_OUTLINE  = '1px dashed rgba(163,113,247,0.45)';
  // Already-captured field markers (see __updateListFieldMarkers__)
  const FIELD_MARK_OUTLINE         = '1.5px dashed #3fb950';
  const FIELD_MARK_OUTLINE_MUTED   = '1.5px dashed rgba(63,185,80,0.18)';
  const FIELD_MARK_COLORS = {
    text: '#3fb950',
    attr: '#58a6ff',
    html: '#a371f7',
  };
  // Spotlight for the pick being configured in the editor right now.
  const FIELD_PENDING_OUTLINE = '3px solid #58a6ff';
  const FIELD_PENDING_SHADOW  = '0 0 0 4px rgba(88,166,255,0.35), inset 0 0 0 9999px rgba(88,166,255,0.14)';

  /* =========================================================================
     STYLE HELPERS
     ========================================================================= */

  // ── "Is this value one of OUR highlight decorations?" ───────────────────
  // Two teardown mechanisms depend on recognising a style WE applied:
  //   1. storeOriginalStyle must never mistake our own decoration for the
  //      page's real style — recording it as the "original" makes a later
  //      restore RE-ASSERT the highlight, leaking it permanently (the exact
  //      "the border won't go away" bug).
  //   2. the stray-highlight sweep strips any of our outlines that slipped
  //      through untracked.
  // The browser re-serialises inline CSS (hex → rgb(), shorthand re-ordering),
  // so a raw string compare against our constants is unreliable. We therefore
  // build the set of forms the browser actually produces for each constant by
  // round-tripping them through a probe element once, and match against that.
  // The late-declared SCOPE_*/HOVER_PICK_* consts are only read at call-time
  // (long after their declarations run), so referencing them here is safe.
  function _normCss(v) {
    return String(v == null ? '' : v).toLowerCase().replace(/\s+/g, ' ').trim();
  }
  var _hlOutlineSet = null;
  function _hlOutlines() {
    if (_hlOutlineSet) return _hlOutlineSet;
    _hlOutlineSet = {};
    var list = [
      SOFT_OUTLINE, HARD_OUTLINE, HOVER_OUTLINE,
      MULTI_PICK_OUTLINE, MULTI_MATCH_OUTLINE,
      CONTAINER_PICK_OUTLINE, FIELD_PICK_HOVER_OUTLINE, FIELD_PICK_CONFIRM_OUTLINE,
      CONTAINER_PREVIEW_OUTLINE, FIELD_MARK_OUTLINE, FIELD_MARK_OUTLINE_MUTED,
      FIELD_PENDING_OUTLINE,
      (typeof SCOPE_OUTLINE      !== 'undefined' ? SCOPE_OUTLINE      : null),
      (typeof HOVER_PICK_OUTLINE !== 'undefined' ? HOVER_PICK_OUTLINE : null),
    ];
    var probe = null;
    try { probe = document.createElement('div'); } catch (_) {}
    list.forEach(function(v) {
      if (!v) return;
      _hlOutlineSet[_normCss(v)] = true;              // raw form
      if (probe) {
        try {
          probe.style.setProperty('outline', '');
          probe.style.setProperty('outline', v, 'important');
          var ser = probe.style.outline || probe.style.getPropertyValue('outline');
          if (ser) _hlOutlineSet[_normCss(ser)] = true; // browser-serialised form
        } catch (_) {}
      }
    });
    return _hlOutlineSet;
  }
  var _hlShadowSet = null;
  function _hlShadows() {
    if (_hlShadowSet) return _hlShadowSet;
    _hlShadowSet = {};
    var list = [
      (typeof SCOPE_SHADOW         !== 'undefined' ? SCOPE_SHADOW         : null),
      (typeof FIELD_PENDING_SHADOW !== 'undefined' ? FIELD_PENDING_SHADOW : null),
    ];
    var probe = null;
    try { probe = document.createElement('div'); } catch (_) {}
    list.forEach(function(v) {
      if (!v) return;
      _hlShadowSet[_normCss(v)] = true;
      if (probe) {
        try {
          probe.style.setProperty('box-shadow', '');
          probe.style.setProperty('box-shadow', v, 'important');
          var ser = probe.style.boxShadow || probe.style.getPropertyValue('box-shadow');
          if (ser) _hlShadowSet[_normCss(ser)] = true;
        } catch (_) {}
      }
    });
    return _hlShadowSet;
  }
  function _isOurOutlineValue(v) { return !!v && !!_hlOutlines()[_normCss(v)]; }
  function _isOurShadowValue(v) {
    var n = _normCss(v);
    if (!n) return false;
    // Every full-page "dim" shadow we use is an inset 9999px spread — match it
    // order-independently (serialisation can move `inset` to the end).
    if (n.indexOf('9999px') !== -1 && n.indexOf('inset') !== -1) return true;
    return !!_hlShadows()[n];
  }
  function _readStyleValue(el, prop) {
    try {
      if (prop === 'box-shadow')     return el.style.boxShadow     || el.style.getPropertyValue('box-shadow');
      if (prop === 'outline-offset') return el.style.outlineOffset || el.style.getPropertyValue('outline-offset');
      return el.style[prop] || el.style.getPropertyValue(prop);
    } catch (_) { return (el && el.style && el.style[prop]) || ''; }
  }
  // True when `el`'s current inline `prop` holds a decoration this tool applied.
  function _isOurDecoration(el, prop) {
    if (!el || !el.style) return false;
    if (prop === 'outline')        return _isOurOutlineValue(_readStyleValue(el, 'outline'));
    if (prop === 'box-shadow')     return _isOurShadowValue(_readStyleValue(el, 'box-shadow'));
    if (prop === 'outline-offset') return _normCss(_readStyleValue(el, 'outline-offset')) === '-1px';
    return false;
  }

  function storeOriginalStyle(el, prop) {
    if (!originalStyles.has(el)) originalStyles.set(el, {});
    const s = originalStyles.get(el);
    if (!(prop in s)) {
      // Guard: never capture one of OUR OWN highlight decorations as the
      // page's original. If it slipped in untracked (a re-apply that bypassed
      // this bookkeeping), recording it would make a later restore re-assert
      // the highlight and leak it forever — so treat it as "no original".
      s[prop] = _isOurDecoration(el, prop) ? '' : (el.style[prop] || '');
    }
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
    // Ring only — the ForEach dim is a hole-punch overlay now, so iterator
    // cards need no z-index/position lift to stay bright (see _createDimOverlay).
    el.style.setProperty('outline',    SCOPE_OUTLINE, 'important');
    el.style.setProperty('box-shadow', SCOPE_SHADOW,  'important');
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
    // Match against every outline/shadow/offset THIS tool paints — including
    // the marker-family decorations (field markers, container preview, pending
    // spotlight) that the old list missed, so a stray one can't survive here.
    _styledEls.forEach(function(el) {
      try {
        if (!el || !el.style) return;
        if (_isOurDecoration(el, 'outline'))        el.style.removeProperty('outline');
        if (_isOurDecoration(el, 'outline-offset')) el.style.removeProperty('outline-offset');
        if (_isOurDecoration(el, 'box-shadow'))     el.style.removeProperty('box-shadow');
      } catch (_) {}
    });
    _styledEls.clear();
  }

  function cleanupSelectionMode() {
    // Tear down EVERY highlight subsystem — not just the main selection — so
    // nothing lingers when the user flips to navigation mode. Each teardown
    // is guarded/idempotent.
    _multiAddMode  = false;   // exit manual multi-add; fullReset below clears its paint
    _multiSamples  = [];
    _multiMatchEls = [];
    _clearAllHovers();   // canvas + breadcrumb/tree + sidebar step hovers
    if (_listPickMode && typeof window.__stopListFieldPick__ === 'function') {
      try { window.__stopListFieldPick__(); } catch (_) {}
    }
    if (_forEachScopeSel !== null && typeof window.__clearForEachScope__ === 'function') {
      try { window.__clearForEachScope__(); } catch (_) {}
    }
    // The passive field-marker preview is tied to the step editor being open,
    // NOT to the canvas mode — snapshot it, let the blanket restore below wipe
    // its inline styles, then re-assert it so it survives the mode change.
    var previewSel = _listPreviewActive ? _listPreviewSelector : null;
    var previewFields = previewSel ? (_listPickLastFields || []) : null;
    if (previewSel) { try { window.__hideListFieldMarkers__(); } catch (_) {} }
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
    _clearStepHoverHighlight();   // belt-and-suspenders for the separate mechanism
    if (tooltip) tooltip.style.display = 'none';
    if (previewSel && typeof window.__showListFieldMarkers__ === 'function') {
      try { window.__showListFieldMarkers__(previewSel, previewFields); } catch (_) {}
    }
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
     LABEL-ANCHORED (TEXT) RELATIVE SELECTOR
     ─────────────────────────────────────────────────────────────────────────
     Some fields can't be pinned down structurally. The value sits at a
     position that shifts from item to item (optional blocks appear above it)
     and it shares its tag/classes with sibling values, so ONLY its position
     tells it apart — and that position isn't stable. Example: a review card's
     "Ocena ogólna" (overall rating) is one of four identical
     `<p><strong>label:</strong><span>value</span></p>` rows; nothing but the
     label text distinguishes it, and `.scores` floats around because the
     blocks above it are optional.

     What IS stable is the boilerplate LABEL next to the value — "Ocena
     ogólna:", "Location:", "Price". It repeats verbatim on every item, so a
     relative XPath anchored on that label text is the most robust option
     available. We look for such a label among the target's (and its
     ancestors') preceding siblings, build `label → value` XPath, and ACCEPT
     it only after verifying it resolves to EXACTLY the target in the seed
     item and to at most one element in every other item (a handful of items
     legitimately missing the field is fine; 2+ matches anywhere is not).

     The result is a container-relative XPath (starts with `.//`); downstream
     field resolution recognises XPath by that prefix, so no per-field type
     flag has to be threaded through the workflow model.
     ========================================================================= */

  function _normText(s) {
    return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  }

  // A container-relative selector is XPath when it starts with `/`, `//`,
  // `./`, `.//` or `(`. Plain CSS (`.cls`, `#id`, `:scope > …`, `tag`) never
  // does, so this prefix test unambiguously tells the two apart.
  function _isXPathSel(sel) {
    return typeof sel === 'string' && /^\s*(\.?\/\/|\.?\/|\()/.test(sel);
  }

  function _xpathNodes(root, xp) {
    try {
      var r = document.evaluate(xp, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      var out = [];
      for (var i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i));
      return out;
    } catch (_) { return null; }
  }

  // Resolve a container-relative field selector (CSS or XPath) to its first
  // matching element. '' / ':scope' mean "the container itself".
  function _relResolveOne(root, sel) {
    if (!sel || sel === ':scope') return root;
    if (_isXPathSel(sel)) {
      try {
        return document.evaluate(sel, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      } catch (_) { return null; }
    }
    try { return root.querySelector(sel); } catch (_) { return null; }
  }

  // How many elements a relative selector matches inside `root` (-1 = invalid
  // selector). Used for the "resolves to exactly one in every sibling" check.
  function _relCount(root, sel) {
    if (_isXPathSel(sel)) {
      var nodes = _xpathNodes(root, sel);
      return nodes === null ? -1 : nodes.length;
    }
    try { return root.querySelectorAll(sel).length; } catch (_) { return -1; }
  }

  // A quoted XPath 1.0 string literal (no escape sequences in XPath 1.0 — mix
  // quotes with concat() when the text contains both).
  function _xpLiteral(s) {
    if (s.indexOf('"') === -1) return '"' + s + '"';
    if (s.indexOf("'") === -1) return "'" + s + "'";
    return 'concat("' + s.split('"').join('", \'"\', "') + '")';
  }

  // "Label-like": short, non-empty, and containing at least one letter (Latin
  // + common accented ranges so Polish/German/… labels qualify). Pure numbers,
  // dates and punctuation are values, not labels.
  function _isLabelText(t) {
    return !!t && t.length >= 1 && t.length <= 60 && /[A-Za-z\u00C0-\u024F]/.test(t);
  }

  // XPath steps from `fromNode` (exclusive) down to `toEl` (inclusive), each a
  // tag + 1-based same-tag index, e.g. "/span[1]/b[2]". '' when toEl===fromNode.
  function _relXPathSteps(fromNode, toEl) {
    var steps = [];
    var cur = toEl;
    while (cur && cur !== fromNode) {
      var parent = cur.parentElement;
      if (!parent) return null;
      var idx = 0, seen = 0;
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i].tagName === cur.tagName) {
          seen++;
          if (parent.children[i] === cur) { idx = seen; break; }
        }
      }
      steps.unshift('/' + cur.tagName.toLowerCase() + '[' + idx + ']');
      cur = parent;
    }
    return cur === fromNode ? steps.join('') : null;
  }

  // Verify a candidate XPath is unambiguous AND generalises across items:
  //   • seed container   → resolves to EXACTLY the target,
  //   • any container    → never 2+ matches (ambiguous ⇒ reject outright),
  //   • across items      → exactly one match in a strong majority.
  // Returns true/false.
  function _labelSelectorVerifies(xp, el, scopeEl, containers) {
    var seed = _xpathNodes(scopeEl, xp);
    if (!seed || seed.length !== 1 || seed[0] !== el) return false;

    var pool = (containers && containers.length) ? containers : [scopeEl];
    var total = 0, hits = 0;
    for (var i = 0; i < pool.length && total < 30; i++) {
      var c = pool[i];
      if (!c) continue;
      total++;
      if (c === scopeEl) { hits++; continue; }
      var nodes = _xpathNodes(c, xp);
      if (nodes === null) return false;      // invalid in some item
      if (nodes.length > 1) return false;    // ambiguous somewhere
      if (nodes.length === 1) hits++;
    }
    return total >= 1 && (hits / total) >= 0.6;
  }

  // Build a label-anchored relative XPath for `el` within `scopeEl`, verified
  // across `containers` (the full set of similar items). Returns
  // { value, labelText } or null.
  function buildLabelAnchoredSelector(el, scopeEl, containers) {
    if (!el || !scopeEl || el === scopeEl || !scopeEl.contains(el)) return null;
    var elText = _normText(el.textContent);

    // Walk from the target up to (not including) the container. At every level
    // scan preceding siblings for a boilerplate label sitting next to us.
    var node = el;
    while (node && node !== scopeEl) {
      var suffix = _relXPathSteps(node, el);
      if (suffix === null) { node = node.parentElement; continue; }
      var nodeTag = node.tagName.toLowerCase();

      for (var sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        var labelText = _normText(sib.textContent);
        if (!_isLabelText(labelText) || labelText === elText) continue;
        var sibTag = sib.tagName.toLowerCase();
        var lit = _xpLiteral(labelText);
        // Nearest label first, most-specific (label tag pinned) first.
        var candidates = [
          './/' + sibTag + '[normalize-space(.)=' + lit + ']/following-sibling::' + nodeTag + '[1]' + suffix,
          './/*[normalize-space(.)=' + lit + ']/following-sibling::' + nodeTag + '[1]' + suffix,
        ];
        for (var ci = 0; ci < candidates.length; ci++) {
          if (_labelSelectorVerifies(candidates[ci], el, scopeEl, containers)) {
            return { value: candidates[ci], labelText: labelText };
          }
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  // Derive a snake_case field name from a label ("Ocena ogólna:" →
  // "ocena_ogolna"). Diacritics are folded where NFD allows.
  function _nameFromLabel(t) {
    var s = String(t == null ? '' : t);
    try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) {}
    s = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
    return s || 'value';
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

  function _docSize() {
    var d = document.documentElement, b = document.body;
    return {
      w: Math.max(d.scrollWidth, b ? b.scrollWidth : 0, d.clientWidth),
      h: Math.max(d.scrollHeight, b ? b.scrollHeight : 0, d.clientHeight),
    };
  }

  // Shared dim-overlay painter. `overlayEl` is a document-sized absolute
  // sheet; this cuts a HOLE (clip-path evenodd) over each element in `els`
  // so those elements show through at full brightness no matter what
  // stacking contexts their ancestors create. (The old approach lifted
  // elements with z-index, which silently failed whenever a parent was
  // itself a stacking context and dimmed the highlighted elements together
  // with the rest of the page — the exact bug users hit.)
  function _paintHoles(overlayEl, els, pad) {
    if (!overlayEl) return;
    var s = _docSize();
    overlayEl.style.width  = s.w + 'px';
    overlayEl.style.height = s.h + 'px';
    var PAD = pad == null ? 4 : pad;
    var parts = ['M0 0H' + s.w + 'V' + s.h + 'H0Z'];
    for (var i = 0; i < els.length; i++) {
      var r;
      try { r = els[i].getBoundingClientRect(); } catch (_) { continue; }
      if (r.width === 0 && r.height === 0) continue;
      var x = Math.max(0, r.left + window.scrollX - PAD);
      var y = Math.max(0, r.top + window.scrollY - PAD);
      var w = r.width + PAD * 2;
      var h = r.height + PAD * 2;
      parts.push('M' + x + ' ' + y + 'h' + w + 'v' + h + 'h-' + w + 'Z');
    }
    overlayEl.style.clipPath = 'path(evenodd, "' + parts.join(' ') + '")';
  }

  function _updateListPickOverlayHoles() {
    _paintHoles(_listPickOverlay, _listPickContainers, 4);
  }

  function _createListPickOverlay() {
    if (_listPickOverlay) return;
    _listPickOverlay = document.createElement('div');
    _listPickOverlay.style.cssText = [
      'position:absolute', 'top:0', 'left:0', 'pointer-events:none',
      'z-index:2147483640',
      'background:rgba(0,0,0,0)',
      'transition:background 200ms ease',
    ].join(';');
    document.body.appendChild(_listPickOverlay);
    _updateListPickOverlayHoles();
    requestAnimationFrame(function() {
      if (_listPickOverlay) _listPickOverlay.style.background = 'rgba(0,0,0,0.55)';
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
    // The restore reverted to the page's own styles — put back whatever
    // pick-mode decoration the element carries. Use setStyle (not a raw
    // setProperty) so the re-applied decoration stays TRACKED: a raw
    // re-apply here left the style untracked, which poisoned the next
    // storeOriginalStyle and leaked the outline permanently.
    if (el === _listPickPendingEl) {
      setStyle(el, 'outline',    FIELD_PENDING_OUTLINE, true);
      setStyle(el, 'box-shadow', FIELD_PENDING_SHADOW,  true);
    } else if (_listPickFieldEls.indexOf(el) !== -1) {
      setStyle(el, 'outline', _listPickPendingEl ? FIELD_MARK_OUTLINE_MUTED : FIELD_MARK_OUTLINE, true);
      setStyle(el, 'outline-offset', '-1px', true);
    }
  }

  /* ── Pending-pick spotlight ──────────────────────────────────────────────
     After the user clicks an element they configure its name / what to
     extract in the editor. While that's open, the exact element being
     edited gets a strong spotlight and the existing field markers step
     back, so it's unambiguous what the form refers to. */

  function _muteListFieldMarkers(mute) {
    for (var i = 0; i < _listPickChips.length; i++) {
      _listPickChips[i].style.opacity = mute ? '0.12' : '1';
    }
    for (var j = 0; j < _listPickFieldEls.length; j++) {
      var fe = _listPickFieldEls[j];
      if (fe === _listPickPendingEl || fe === _listPickHoverEl) continue;
      // setStyle keeps the true page-original tracked (it was captured when the
      // marker was first painted), so muting can never poison the teardown.
      setStyle(fe, 'outline', mute ? FIELD_MARK_OUTLINE_MUTED : FIELD_MARK_OUTLINE, true);
    }
  }

  function _clearListPickPendingStyles() {
    if (_listPickPendingBox) {
      if (_listPickPendingBox.parentNode) _listPickPendingBox.parentNode.removeChild(_listPickPendingBox);
      _listPickPendingBox = null;
    }
    if (!_listPickPendingEl) return;
    var el = _listPickPendingEl;
    restoreStyle(el, 'outline');
    restoreStyle(el, 'box-shadow');
    // Re-assert the resting decoration this element should still carry, TRACKED
    // via setStyle (a raw re-apply left it untracked and leaked). A field
    // element keeps its dashed marker; a container picked as a whole-item field
    // (the '' selector / enclosing-link case) keeps its container outline
    // instead of being left bare.
    if (_listPickFieldEls.indexOf(el) !== -1) {
      setStyle(el, 'outline', FIELD_MARK_OUTLINE, true);
      setStyle(el, 'outline-offset', '-1px', true);
    } else if (_listPickContainers.indexOf(el) !== -1) {
      if (_listPickMode) {
        setStyle(el, 'outline',    CONTAINER_PICK_OUTLINE, true);
        setStyle(el, 'box-shadow', CONTAINER_PICK_SHADOW,  true);
      } else if (_listPreviewActive) {
        setStyle(el, 'outline', CONTAINER_PREVIEW_OUTLINE, true);
      }
    }
  }

  // Anchor the spotlight box on the pending element's page rect. Re-run on
  // relayout so it tracks the element through reflows.
  function _positionPendingBox() {
    if (!_listPickPendingBox || !_listPickPendingEl) return;
    var r;
    try { r = _listPickPendingEl.getBoundingClientRect(); } catch (_) { return; }
    _listPickPendingBox.style.top    = (r.top  + window.scrollY - 3) + 'px';
    _listPickPendingBox.style.left   = (r.left + window.scrollX - 3) + 'px';
    _listPickPendingBox.style.width  = (r.width  + 6) + 'px';
    _listPickPendingBox.style.height = (r.height + 6) + 'px';
  }

  function _setListPickPending(el, containerEl) {
    _clearListPickPendingStyles();
    _listPickPendingEl = el || null;
    if (containerEl !== undefined) _listPickPendingCont = containerEl;
    if (!el) { _muteListFieldMarkers(false); return; }
    _markStyled(el);
    storeOriginalStyle(el, 'outline');
    storeOriginalStyle(el, 'box-shadow');
    el.style.setProperty('outline',    FIELD_PENDING_OUTLINE, 'important');
    el.style.setProperty('box-shadow', FIELD_PENDING_SHADOW,  'important');
    // Positioned box on top — outlines collapse to slivers on inline
    // elements that wrap block children (a common shape for card links),
    // so the spotlight can't rely on element styles alone.
    _listPickPendingBox = document.createElement('div');
    _listPickPendingBox.style.cssText = [
      'position:absolute',
      'z-index:2147483642',
      'pointer-events:none',
      'box-sizing:border-box',
      'border:3px solid #58a6ff',
      'border-radius:4px',
      'background:rgba(88,166,255,0.13)',
      'box-shadow:0 0 0 4px rgba(88,166,255,0.30)',
    ].join(';');
    document.body.appendChild(_listPickPendingBox);
    _positionPendingBox();
    _muteListFieldMarkers(true);
  }

  /* ── Already-captured field markers ──────────────────────────────────────
     Outline + tiny name chip on every element (in every container) that an
     existing field of the EXTRACT_LIST step resolves to, so while picking
     the user always sees what's captured — attribute fields are labelled
     with their @attr, html ones with </>. Chips use absolute page
     coordinates so they scroll with the content. */

  function _clearListFieldMarkers() {
    _listPickFieldEls.forEach(function(el) {
      restoreStyle(el, 'outline');
      restoreStyle(el, 'outline-offset');
    });
    _listPickFieldEls = [];
    _listPickChips.forEach(function(c) { if (c.parentNode) c.parentNode.removeChild(c); });
    _listPickChips = [];
  }

  function _applyListFieldMarkers(fields) {
    _clearListFieldMarkers();
    if ((!_listPickMode && !_listPreviewActive) || !Array.isArray(fields) || fields.length === 0) return;
    var MAX_CHIPS = 400; // keep huge lists from flooding the DOM
    var made = 0;
    for (var ci = 0; ci < _listPickContainers.length && made < MAX_CHIPS; ci++) {
      var cont = _listPickContainers[ci];
      var placed = []; // chips already laid out in this container ({top,left,w})
      for (var fi = 0; fi < fields.length && made < MAX_CHIPS; fi++) {
        var f = fields[fi];
        if (!f || !f.name) continue;
        var sel = (f.selector || '').trim();
        var el = _relResolveOne(cont, sel);
        if (!el) continue;
        var r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;

        // Dashed outline on the captured element (the container itself
        // already has the purple container outline — chip alone is enough).
        if (el !== cont && _listPickFieldEls.indexOf(el) === -1) {
          _markStyled(el);
          storeOriginalStyle(el, 'outline');
          storeOriginalStyle(el, 'outline-offset');
          el.style.setProperty('outline', FIELD_MARK_OUTLINE, 'important');
          el.style.setProperty('outline-offset', '-1px', 'important');
          _listPickFieldEls.push(el);
        }

        // Tiny name chip at the element's top-left corner.
        var color = FIELD_MARK_COLORS[f.kind] || FIELD_MARK_COLORS.text;
        var label = f.kind === 'attr' && f.attribute ? f.name + ' @' + f.attribute
                  : f.kind === 'html' ? f.name + ' </>'
                  : f.name;
        var chip = document.createElement('div');
        chip.textContent = label;
        chip.style.cssText = [
          'position:absolute',
          'z-index:2147483643',
          'pointer-events:none',
          'font:600 10px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace',
          'color:' + color,
          'background:rgba(13,17,23,0.92)',
          'border:1px solid ' + color,
          'border-radius:3px',
          'padding:0 5px',
          'white-space:nowrap',
          'max-width:170px',
          'overflow:hidden',
          'text-overflow:ellipsis',
          'box-shadow:0 1px 4px rgba(0,0,0,0.5)',
        ].join(';');
        var top  = r.top + window.scrollY - 16;
        if (top < 0) top = r.top + window.scrollY + 2;
        var left = Math.max(0, r.left + window.scrollX);
        chip.style.top  = top + 'px';
        chip.style.left = left + 'px';
        document.body.appendChild(chip);
        // Fields anchored to the same corner (e.g. a link and the title
        // inside it) would stack invisibly — slide overlapping chips right.
        var w = chip.offsetWidth || 40;
        var moved = true;
        while (moved) {
          moved = false;
          for (var pi = 0; pi < placed.length; pi++) {
            var p = placed[pi];
            if (Math.abs(p.top - top) < 14 && left < p.left + p.w + 4 && left + w > p.left) {
              left = p.left + p.w + 4;
              moved = true;
            }
          }
        }
        chip.style.left = left + 'px';
        placed.push({ top: top, left: left, w: w });
        _listPickChips.push(chip);
        made++;
      }
    }
    // A pick is being configured right now → freshly painted markers step
    // back immediately so they don't compete with the spotlight.
    if (_listPickPendingEl) _muteListFieldMarkers(true);
  }

  // Layout can shift under the absolute overlay/chips (images loading,
  // viewport resize, infinite lists) — re-anchor everything. Runs for both
  // the active pick and the passive preview.
  function _onListPickRelayout() {
    if (!_listPickMode && !_listPreviewActive) return;
    _updateListPickOverlayHoles();       // no-op if no overlay (preview)
    _applyListFieldMarkers(_listPickLastFields || []);
    _positionPendingBox();               // no-op if no pending box (preview)
  }

  // Resolve a container selector (CSS or XPath) into _listPickContainers.
  function _resolveListContainers(containerSelector) {
    try {
      _listPickContainers = Array.prototype.slice.call(document.querySelectorAll(containerSelector));
    } catch (_) {
      try {
        var xr = document.evaluate(containerSelector, document, null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        _listPickContainers = [];
        for (var xi = 0; xi < xr.snapshotLength; xi++) _listPickContainers.push(xr.snapshotItem(xi));
      } catch (_2) { _listPickContainers = []; }
    }
  }

  // Start / stop the reflow watchdog + resize listener shared by pick + preview.
  function _startListLayoutWatch() {
    window.addEventListener('resize', _onListPickRelayout);
    _listPickLayoutSig = _listPickLayoutSignature();
    clearInterval(_listPickLayoutTimer);
    _listPickLayoutTimer = setInterval(function() {
      if (!_listPickMode && !_listPreviewActive) return;
      var sig = _listPickLayoutSignature();
      if (sig !== _listPickLayoutSig) { _listPickLayoutSig = sig; _onListPickRelayout(); }
    }, 900);
  }
  function _stopListLayoutWatch() {
    window.removeEventListener('resize', _onListPickRelayout);
    clearInterval(_listPickLayoutTimer);
    _listPickLayoutTimer = null;
  }

  // Cheap signature of the containers' geometry; when it changes, the page
  // reflowed under us and the overlay holes + chips need re-anchoring.
  function _listPickLayoutSignature() {
    var n = _listPickContainers.length;
    if (!n) return '0';
    try {
      var a = _listPickContainers[0].getBoundingClientRect();
      var b = _listPickContainers[n - 1].getBoundingClientRect();
      return n + '|' + Math.round(a.top + window.scrollY) + ',' + Math.round(a.left) + ',' + Math.round(a.height)
               + '|' + Math.round(b.top + window.scrollY) + ',' + Math.round(b.height)
               + '|' + _docSize().h;
    } catch (_) { return 'err'; }
  }

  window.__updateListFieldMarkers__ = function(fields) {
    // No-op unless a pick or a preview is actually on screen.
    if (!_listPickMode && !_listPreviewActive) return;
    // Any marker update from the editor means the pending pick resolved
    // (confirmed or discarded) — drop the spotlight.
    _setListPickPending(null);
    _listPickLastFields = Array.isArray(fields) ? fields : null;
    _applyListFieldMarkers(_listPickLastFields || []);
  };

  // ── Passive marker preview (step expanded, not picking) ─────────────────
  // Show the captured-field markers on every similar item without the dim
  // overlay or click interception. Used whenever the EXTRACT_LIST editor is
  // open so the user always sees what the step captures.
  window.__showListFieldMarkers__ = function(containerSelector, fields) {
    if (_listPickMode) return;                 // active pick already shows them
    window.__hideListFieldMarkers__();         // clear any prior preview
    if (!containerSelector) return;
    _resolveListContainers(containerSelector);
    if (!_listPickContainers.length) return;
    _listPreviewActive   = true;
    _listPreviewSelector = containerSelector;
    _listPickContainers.forEach(function(el) {
      _markStyled(el);
      storeOriginalStyle(el, 'outline');
      el.style.setProperty('outline', CONTAINER_PREVIEW_OUTLINE, 'important');
    });
    _listPickLastFields = Array.isArray(fields) ? fields : [];
    _applyListFieldMarkers(_listPickLastFields);
    _startListLayoutWatch();
  };

  window.__hideListFieldMarkers__ = function() {
    if (_listPickMode || !_listPreviewActive) return;
    _listPreviewActive   = false;
    _listPreviewSelector = null;
    _stopListLayoutWatch();
    _clearListFieldMarkers();
    _listPickLastFields = null;
    _listPickContainers.forEach(function(el) { restoreStyle(el, 'outline'); });
    _listPickContainers = [];
  };

  // The editor's "Extract:" chooser targets a specific element (the clicked
  // one, or e.g. the enclosing <a> for its href) — move the spotlight so the
  // user sees exactly what the selected option refers to.
  window.__previewListPickOption__ = function(sel) {
    if (!_listPickMode || !_listPickPendingCont) return;
    var s = (sel == null ? '' : String(sel)).trim();
    var el = null;
    if (!s || s === ':scope') {
      el = _listPickPendingCont;
    } else {
      try { el = _listPickPendingCont.querySelector(s); } catch (_) { el = null; }
    }
    if (el) _setListPickPending(el);
  };

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

  /* ── Manual multi-element add ───────────────────────────────────────────── */

  // Repaint the manual-add state: every generalised match in green, the
  // hand-picked seeds with a stronger blue ring on top. hardEls holds them all
  // so the normal teardown paths clean up.
  function repaintMultiAdd() {
    clearArr(hardEls);
    var pickSet = new Set(_multiSamples);
    _multiMatchEls.forEach(function(el) {
      if (!el) return;
      hardEls.push(el);
      if (pickSet.has(el)) {
        setStyle(el, 'outline',    MULTI_PICK_OUTLINE, true);
        setStyle(el, 'box-shadow', MULTI_PICK_SHADOW,  true);
      } else {
        setStyle(el, 'outline',    MULTI_MATCH_OUTLINE, true);
        setStyle(el, 'box-shadow', MULTI_MATCH_SHADOW,  true);
      }
    });
    // Picks the selector doesn't cover yet (e.g. the very first pick before a
    // group exists) still need to be visible.
    _multiSamples.forEach(function(el) {
      if (!el || _multiMatchEls.indexOf(el) !== -1) return;
      hardEls.push(el);
      setStyle(el, 'outline',    MULTI_PICK_OUTLINE, true);
      setStyle(el, 'box-shadow', MULTI_PICK_SHADOW,  true);
    });
  }

  // Recompute the generalised selector for the current picks, repaint, and
  // push the result to the sidebar as a (manual) multi-selection.
  function refreshMultiAdd() {
    var res;
    try {
      res = window.SelectorGenerator.generalizeFromSamples(_multiSamples);
    } catch (_) {
      res = { primary: null, fallbacks: [], els: _multiSamples.slice(),
              matchCount: _multiSamples.length, strategy: 'manual-none' };
    }
    _multiMatchEls = (res.els && res.els.length) ? res.els.slice() : _multiSamples.slice();
    repaintMultiAdd();
    if (tooltip) tooltip.style.display = 'none';
    window.sendToNode({
      type:              'multiElementSelected',
      manualAdd:         true,
      sampleCount:       _multiSamples.length,
      commonSelector:    res.primary || '',
      fallbackSelectors: res.fallbacks || [],
      matchCount:        _multiMatchEls.length,
      selectorCount:     _multiMatchEls.length,
      strategy:          res.strategy || 'manual-generalized',
      elements:          _multiMatchEls.slice(0, 200).map(buildElementInfo),
    });
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

    // ── Manual multi-add (takes priority over normal selection) ───────────
    if (_multiAddMode) {
      var mtgt = e.target;
      if (mtgt === tooltip) return;
      if (mtgt !== hoverEl) {
        // Drop the previous plain hover ring, but never disturb a painted
        // pick/match (those live in hardEls).
        if (hoverEl && hardEls.indexOf(hoverEl) === -1) restoreStyle(hoverEl, 'outline');
        hoverEl = mtgt;
        if (!isRoot(mtgt) && hardEls.indexOf(mtgt) === -1) setStyle(mtgt, 'outline', HOVER_OUTLINE, true);
      }
      if (tooltip) {
        var already = _multiSamples.indexOf(mtgt) !== -1;
        tooltip.textContent = isRoot(mtgt)
          ? '➕ Move over an element to add it to the selection'
          : (already ? '➖ Click to remove from selection: ' : '➕ Click to add to selection: ') + getElPath(mtgt, 3);
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

      var structuralSel = buildRelativeSelector(tgt, containerEl);

      // Does a candidate resolve to exactly one element in each OTHER similar
      // container? (Sampled — that's what "the field is defined the same way
      // on every row" means.)
      var otherContainers = _listPickContainers.filter(function(c) { return c !== containerEl; });
      function worksEverywhere(sel) {
        if (!sel) return false;
        return otherContainers.slice(0, 8).every(function(c) { return _relCount(c, sel) === 1; });
      }

      var relSel          = structuralSel;
      var worksInSiblings = worksEverywhere(structuralSel);
      var labelInfo       = null;

      // A structural selector is "fragile" when it's missing, purely
      // positional (:nth-child/:nth-of-type — rides on per-item DOM shape), or
      // simply doesn't generalise across the other items. In that case reach
      // for a label/text anchor: the boilerplate label next to the value
      // ("Ocena ogólna:", "Location:") repeats verbatim on every item, so a
      // selector anchored on it is more reliable than a shifting position.
      // We only switch to it once it's VERIFIED to resolve across the items —
      // i.e. genuinely better than the structural option, never worse.
      var structuralFragile = !structuralSel ||
        /:nth-(child|of-type)/.test(structuralSel) || !worksInSiblings;
      if (structuralFragile) {
        labelInfo = buildLabelAnchoredSelector(tgt, containerEl, _listPickContainers);
        if (labelInfo) {
          relSel          = labelInfo.value;   // container-relative XPath (.//…)
          worksInSiblings = true;
        }
      }
      if (!relSel) return;

      var kindInfo   = _inferFieldKind(tgt);
      var sampleVal  = _extractPickSample(tgt, kindInfo.kind, kindInfo.attribute);
      // Name a label-anchored field after its label ("Ocena ogólna:" →
      // ocena_ogolna); otherwise fall back to the class/tag heuristic.
      var suggested  = (labelInfo && labelInfo.labelText)
        ? _nameFromLabel(labelInfo.labelText)
        : _suggestFieldName(tgt.tagName.toLowerCase(), relSel, kindInfo.kind, kindInfo.attribute);

      window.sendToNode({
        type:             'listFieldPicked',
        relativeSelector: relSel,
        // 'css' | 'xpath' — for the editor's information; downstream field
        // resolution also auto-detects XPath from the selector's prefix.
        selectorType:     _isXPathSel(relSel) ? 'xpath' : 'css',
        anchoredOnLabel:  labelInfo ? labelInfo.labelText : null,
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

      // Spotlight the clicked element while the user names/configures the
      // field in the editor — cleared when the pick is confirmed/discarded
      // (the editor re-sends the field markers either way).
      _clearListPickHover();
      _setListPickPending(tgt, containerEl);
      return;
    }

    // ── Manual multi-add (takes priority over normal selection) ────────────
    // Every click toggles the target in/out of the hand-picked set, then the
    // selector is re-derived and re-painted.
    if (_multiAddMode) {
      var atgt = e.target;
      if (atgt === tooltip) return;
      e.preventDefault();
      e.stopPropagation();
      if (isRoot(atgt)) return;
      var mIdx = _multiSamples.indexOf(atgt);
      if (mIdx !== -1) _multiSamples.splice(mIdx, 1);   // click again → remove
      else             _multiSamples.push(atgt);         // add
      if (hoverEl === atgt) hoverEl = null;              // its ring is now owned by the paint
      if (!_multiSamples.length) {
        clearArr(hardEls);
        _multiMatchEls = [];
        window.sendToNode({
          type: 'multiElementSelected', manualAdd: true, sampleCount: 0,
          commonSelector: '', fallbackSelectors: [], matchCount: 0,
          selectorCount: 0, strategy: 'manual-generalized', elements: [],
        });
        return;
      }
      refreshMultiAdd();
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
  let _forEachLayoutTimer = null;

  const SCOPE_OUTLINE = '2px solid rgba(163,113,247,0.6)';
  const SCOPE_SHADOW  = '0 0 0 3px rgba(163,113,247,0.18)';

  function _updateForEachOverlayHoles() { _paintHoles(_dimOverlay, _allIteratorEls, 4); }

  function _createDimOverlay() {
    if (_dimOverlay) return;
    _dimOverlay = document.createElement('div');
    // Document-sized hole-punch overlay (same technique as list-pick): the
    // iterator cards show through at full brightness regardless of ancestor
    // stacking contexts — no z-index elevation needed, so no stacking bug.
    _dimOverlay.style.cssText = [
      'position:absolute', 'top:0', 'left:0', 'pointer-events:none',
      'z-index:2147483640',
      'background:rgba(0,0,0,0)',
      'transition:background 200ms ease',
    ].join(';');
    document.body.appendChild(_dimOverlay);
    _updateForEachOverlayHoles();
    requestAnimationFrame(function() {
      if (_dimOverlay) _dimOverlay.style.background = 'rgba(0,0,0,0.5)';
    });
    window.addEventListener('resize', _updateForEachOverlayHoles);
    clearInterval(_forEachLayoutTimer);
    _forEachLayoutTimer = setInterval(function() {
      if (_forEachScopeSel !== null) _updateForEachOverlayHoles();
    }, 900);
  }

  function _removeDimOverlay() {
    window.removeEventListener('resize', _updateForEachOverlayHoles);
    clearInterval(_forEachLayoutTimer);
    _forEachLayoutTimer = null;
    if (!_dimOverlay) return;
    const el = _dimOverlay;
    _dimOverlay = null;
    el.style.background = 'rgba(0,0,0,0)';
    setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
  }

  // Iterator-card decoration: a purple ring only (the dim is a hole-punch
  // overlay now, so cards need no z-index/position lift to escape it).
  function _elevateEl(el) {
    if (!el) return;
    _markStyled(el);
    storeOriginalStyle(el, 'outline');
    storeOriginalStyle(el, 'box-shadow');
    el.style.setProperty('outline',    SCOPE_OUTLINE, 'important');
    el.style.setProperty('box-shadow', SCOPE_SHADOW,  'important');
  }

  function _unelevateEl(el) {
    if (!el) return;
    restoreStyle(el, 'outline');
    restoreStyle(el, 'box-shadow');
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

  // Clear the canvas hover outline (blue, follows the cursor in selection
  // mode) if it's on a non-selected element.
  function _clearCanvasHover() {
    if (hoverEl && hardEls.indexOf(hoverEl) === -1 && softEls.indexOf(hoverEl) === -1) {
      if (_allIteratorEls && _allIteratorEls.indexOf(hoverEl) !== -1) _reapplyScopeEl(hoverEl);
      else restoreStyle(hoverEl, 'outline');
    }
    hoverEl = null;
  }

  // Clear the workflow-sidebar step-hover highlight. That highlight is
  // applied by server.js's highlightSelector via `data-scraper-hl` datasets
  // — a mechanism completely separate from this script's originalStyles, so
  // no injected teardown ever touched it and it could linger after mode
  // changes / navigation / resets. Restoring it here folds it into every
  // teardown path.
  function _clearStepHoverHighlight() {
    try {
      var els = document.querySelectorAll('[data-scraper-hl]');
      var props = ['outline', 'outline-offset', 'box-shadow'];
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        for (var p = 0; p < props.length; p++) {
          var prop = props[p];
          var key  = 'scraperHl_' + prop.replace(/-/g, '_');
          var pkey = key + '_prio';
          if (el.dataset[key] !== undefined) {
            var v = el.dataset[key];
            if (v) el.style.setProperty(prop, v, el.dataset[pkey] || '');
            else   el.style.removeProperty(prop);
            delete el.dataset[key];
            delete el.dataset[pkey];
          }
        }
        delete el.dataset.scraperHl;
      }
    } catch (_) {}
  }

  // ── Unified transient-hover teardown ────────────────────────────────────
  // Every "hover preview" highlight — canvas hover, breadcrumb / HTML-tree
  // hover, and the sidebar step hover — is cleared together. Hover previews
  // are transient by definition and must never outlive the interaction that
  // produced them, so this runs on every meaningful transition (mode change,
  // selection change, navigation, entering a pick/loop context).
  function _clearAllHovers() {
    try { clearHoverHighlight(); } catch (_) {}
    try { _clearCanvasHover(); }   catch (_) {}
    try { _clearStepHoverHighlight(); } catch (_) {}
  }
  window.__clearHovers__ = _clearAllHovers;

  /* =========================================================================
     EXPOSED API
     ========================================================================= */

  window.__resetSelection__ = function() {
    _multiAddMode  = false;
    _multiSamples  = [];
    _multiMatchEls = [];
    _clearAllHovers();
    fullReset();
  };

  /* ── Manual multi-add API ────────────────────────────────────────────────
     Enter a mode where every page click toggles an element in/out of a
     hand-picked set and the most specific comma-free selector covering the
     set is re-derived live. Seeds from whatever is currently selected (the
     green group, or the seed element) so the user extends the existing pick
     rather than starting over. */
  window.__startMultiAdd__ = function() {
    // Snapshot the current selection BEFORE fullReset wipes it.
    var seed = hardEls.length ? hardEls.slice() : (currentEl ? [currentEl] : []);
    _clearAllHovers();
    fullReset();                         // clears tier amber / prior highlights
    _multiAddMode  = true;
    _multiSamples  = seed.filter(Boolean);
    _multiMatchEls = [];
    if (_multiSamples.length) {
      refreshMultiAdd();
    } else if (tooltip) {
      tooltip.textContent = '➕ Click any element on the page to start a manual selection';
      tooltip.style.cssText += ';transform:none';
      tooltip.style.display = 'block';
      tooltip.style.top  = '12px';
      tooltip.style.left = '50%';
      tooltip.style.setProperty('transform', 'translateX(-50%)');
    }
  };

  // Leave manual-add but KEEP the derived group as a confirmed green
  // selection (drops the blue pick rings). The sidebar keeps showing it.
  window.__stopMultiAdd__ = function() {
    if (!_multiAddMode) return;
    _multiAddMode = false;
    var finalEls = _multiMatchEls.length ? _multiMatchEls.slice() : _multiSamples.slice();
    _clearCanvasHover();
    clearArr(hardEls);
    if (finalEls.length) { applyHard(finalEls); selState = 'multi_selected'; }
    _multiSamples  = [];
    _multiMatchEls = [];
    if (tooltip) {
      tooltip.style.display = 'none';
      tooltip.style.transform = '';
      tooltip.style.top  = '';
      tooltip.style.left = '';
    }
  };

  // Apply a hand-edited selector (the "adjust selector" power-user path):
  // resolve it, paint the matches green, and regenerate fresh fallbacks for
  // the resulting set. Returns synchronously to the server's page.evaluate.
  window.__applyManualSelector__ = function(selector, type) {
    selector = String(selector == null ? '' : selector).trim();
    if (!selector) return { ok: false, error: 'Selector is empty' };
    if (!type) type = /^\s*(\.?\/\/|\.?\/|\()/.test(selector) ? 'xpath' : 'css';
    var els = [];
    try {
      if (type === 'xpath') {
        var r = document.evaluate(selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (var i = 0; i < r.snapshotLength; i++) {
          var n = r.snapshotItem(i);
          if (n && n.nodeType === 1) els.push(n);
        }
      } else {
        els = Array.prototype.slice.call(document.querySelectorAll(selector));
      }
    } catch (err) {
      return { ok: false, error: (err && err.message) ? err.message : 'Invalid selector' };
    }

    // Repaint as a plain confirmed selection.
    _multiAddMode = false;
    _multiSamples = [];
    _multiMatchEls = [];
    _clearAllHovers();
    fullReset();
    if (els.length) { applyHard(els); currentEl = els[0]; selState = 'multi_selected'; }

    // Regenerate fallbacks from the matched set (skip for huge sets — the
    // exact-group builder is O(n) DOM work per candidate).
    var fallbacks = [];
    if (els.length >= 1 && els.length <= 300 &&
        window.SelectorGenerator && window.SelectorGenerator.buildGroupSelectors) {
      try {
        var gs = window.SelectorGenerator.buildGroupSelectors(els);
        fallbacks = (gs.fallbacks || []).filter(function(f) { return f.value !== selector; });
      } catch (_) {}
    }

    return {
      ok:           true,
      matchCount:   els.length,
      primary:      selector,
      selectorType: type,
      fallbacks:    fallbacks,
      elements:     els.slice(0, 200).map(buildElementInfo),
    };
  };

  window.__startListFieldPick__ = function(containerSelector, fields) {
    window.__hideListFieldMarkers__(); // tear down any passive preview first
    window.__stopListFieldPick__();    // idempotent — clear any previous state
    // Field-pick is a top-level page context — mutually exclusive with the
    // ForEach loop scope and any normal selection. Clear both (and all hover
    // previews) so exactly one state highlight is ever on screen.
    if (_forEachScopeSel !== null) { try { window.__clearForEachScope__(); } catch (_) {} }
    _clearAllHovers();
    fullReset();
    _listPickMode = true;
    _resolveListContainers(containerSelector);
    _listPickContainers.forEach(function(el) {
      _markStyled(el);
      storeOriginalStyle(el, 'outline');
      storeOriginalStyle(el, 'box-shadow');
      el.style.setProperty('outline',    CONTAINER_PICK_OUTLINE, 'important');
      el.style.setProperty('box-shadow', CONTAINER_PICK_SHADOW,  'important');
      // NOTE: no position/z-index lifting here — the overlay has holes cut
      // over the containers instead, which works regardless of ancestor
      // stacking contexts (lifting silently failed inside them and dimmed
      // the containers together with the rest of the page).
    });
    _createListPickOverlay();
    if (tooltip) {
      tooltip.textContent = '🎯 Click an element inside the highlighted containers to add it as a field';
      tooltip.style.display = 'block';
      tooltip.style.top  = '12px';
      tooltip.style.left = '50%';
      tooltip.style.setProperty('transform', 'translateX(-50%)');
    }
    // Mark the fields that are already captured, and keep the overlay holes
    // + chips anchored through layout shifts.
    _startListLayoutWatch();
    if (Array.isArray(fields) && fields.length) {
      _listPickLastFields = fields;
      _applyListFieldMarkers(fields);
    }
  };

  window.__stopListFieldPick__ = function() {
    if (!_listPickMode) return;
    _listPickMode = false;
    _stopListLayoutWatch();
    _setListPickPending(null);
    _listPickPendingCont = null;
    _clearListFieldMarkers();
    _listPickLastFields = null;
    _clearListPickHover();
    _listPickContainers.forEach(function(el) {
      restoreStyle(el, 'outline');
      restoreStyle(el, 'box-shadow');
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