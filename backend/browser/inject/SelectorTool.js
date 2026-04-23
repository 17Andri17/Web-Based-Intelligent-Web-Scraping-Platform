(function enableSelectionMode() {
  let highlightedEl = null;
  let selectedEl = null;
  let tooltip = null;
  const originalStyles = new Map();

  // ─── Style helpers ────────────────────────────────────────────────────────

  function storeOriginalStyle(el, property) {
    if (!originalStyles.has(el)) originalStyles.set(el, {});
    const styles = originalStyles.get(el);
    if (!(property in styles)) styles[property] = el.style[property] || '';
  }

  function setStyleWithStore(el, property, value, important = false) {
    storeOriginalStyle(el, property);
    if (important) el.style.setProperty(property, value, 'important');
    else el.style[property] = value;
  }

  function restoreStyle(el, property) {
    const styles = originalStyles.get(el);
    if (!styles || !(property in styles)) return;
    const original = styles[property];
    if (original === '') el.style.removeProperty(property);
    else el.style[property] = original;
    delete styles[property];
    if (Object.keys(styles).length === 0) originalStyles.delete(el);
  }

  function cleanupSelectionMode() {
    for (const [el, styles] of originalStyles) {
      for (const prop in styles) {
        const v = styles[prop];
        if (v === '') el.style.removeProperty(prop);
        else el.style[prop] = v;
      }
    }
    originalStyles.clear();
    highlightedEl = null;
    selectedEl = null;
    if (tooltip) tooltip.style.display = 'none';
  }

  // ─── Tooltip ─────────────────────────────────────────────────────────────

  function createTooltip() {
    tooltip = document.createElement('div');
    tooltip.style.cssText = [
      'all:initial', 'position:fixed',
      'background:rgba(13,17,23,0.92)', 'color:#58a6ff',
      'padding:5px 10px', 'font-size:11px',
      'font-family:ui-monospace,monospace',
      'border-radius:5px', 'border:1px solid #30363d',
      'pointer-events:none', 'z-index:2147483647', 'display:none',
      'box-shadow:0 2px 8px rgba(0,0,0,0.5)',
      'max-width:360px', 'white-space:nowrap',
      'overflow:hidden', 'text-overflow:ellipsis'
    ].join(';');
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
    const parts = [];
    let cur = el, count = 0;
    while (cur && cur.tagName && cur.tagName.toLowerCase() !== 'html') {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) seg += '#' + cur.id;
      else if (cur.classList.length) seg += '.' + [...cur.classList].slice(0, 2).join('.');
      parts.unshift(seg);
      cur = cur.parentElement;
      count++;
      if (count >= depth) { parts.unshift('...'); break; }
    }
    return parts.join(' > ');
  }

  // ─── Build element info payload for frontend ──────────────────────────────

  function buildSimpleSelector(el) {
    if (el.id) return '#' + el.id;
    let sel = el.tagName.toLowerCase();
    if (el.classList.length) sel += '.' + [...el.classList].slice(0, 2).join('.');
    return sel;
  }

  function buildElementInfo(el) {
    // primary: { value, type, strategy }
    // fallbackSelectors: [{ value, type, strategy }, ...]
    let primary = null;
    let fallbackSelectors = [];
    try {
      const result = window.SelectorGenerator.getSelectorsForElement(el, { actionType: 'generic', maxFallbacks: 5 });
      primary = result.primary
        ? { value: result.primary.value, type: result.primary.type, strategy: result.primary.strategy }
        : null;
      fallbackSelectors = (result.fallbacks || []).map(f => ({
        value:    f.value,
        type:     f.type,
        strategy: f.strategy,
      }));
    } catch (_) {
      primary = { value: buildSimpleSelector(el), type: 'css', strategy: 'fallback' };
    }

    const tag    = el.tagName.toLowerCase();
    const isLink  = tag === 'a' || !!el.closest('a');
    const isInput = ['input', 'textarea', 'select'].includes(tag);
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

    let similarCount = 0;
    try { similarCount = selectSimilarElements(el).length; } catch (_) {}

    return {
      selector:          primary?.value || '',
      selectorType:      primary?.type  || 'css',
      selectorStrategy:  primary?.strategy || '',
      fallbackSelectors, // [{ value, type, strategy }, ...]
      tag, text, href, src,
      isLink, isInput, isImg, isTable,
      attrs, breadcrumb, similarCount,
      classes: [...el.classList].join(' '),
    };
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  function onMouseMove(e) {
    if (!window.__SELECTION_MODE__) return;
    const target = e.target;
    if (target === highlightedEl) { placeTooltip(e); return; }

    if (highlightedEl && highlightedEl !== selectedEl) {
      restoreStyle(highlightedEl, 'outline');
    }
    highlightedEl = target;
    if (highlightedEl !== selectedEl) {
      setStyleWithStore(highlightedEl, 'outline', '2px solid #58a6ff', true);
    }
    tooltip.style.display = 'block';
    tooltip.textContent = getElPath(highlightedEl);
    placeTooltip(e);
  }

  function onClick(e) {
    if (!window.__SELECTION_MODE__) return;
    e.preventDefault();
    e.stopPropagation();

    if (selectedEl) restoreStyle(selectedEl, 'outline');
    if (highlightedEl && highlightedEl !== e.target) restoreStyle(highlightedEl, 'outline');

    selectedEl = e.target;
    highlightedEl = e.target;
    setStyleWithStore(selectedEl, 'outline', '2px solid #3fb950', true);
    tooltip.style.display = 'none';

    window.sendToNode({
      type: 'elementSelected',
      element: buildElementInfo(selectedEl),
    });
  }

  // ─── Mode watcher ─────────────────────────────────────────────────────────

  let _selectionMode = window.__SELECTION_MODE__;
  Object.defineProperty(window, '__SELECTION_MODE__', {
    get: () => _selectionMode,
    set: (value) => {
      if (_selectionMode !== value) {
        _selectionMode = value;
        if (!value) cleanupSelectionMode();
      }
    },
    configurable: true
  });

  // ─── Init ─────────────────────────────────────────────────────────────────
  createTooltip();
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  console.log('✅ SelectorTool injected');
})();

/* ─── Shared utilities ───────────────────────────────────────────────────── */

function getFeatures(el) {
  return {
    tag: el.tagName,
    classes: Array.from(el.classList),
    attrs: Array.from(el.attributes).map(a => a.name),
    childTags: Array.from(el.children).map(c => c.tagName),
    textType: (() => {
      const txt = (el.textContent || '').trim();
      if (!txt) return 'empty';
      if (/^\d+$/.test(txt)) return 'number';
      if (/[\$€£]/.test(txt)) return 'money';
      if (txt.length < 30) return 'short';
      return 'long';
    })()
  };
}

function similarityScore(f1, f2) {
  const tagScore = f1.tag === f2.tag ? 1 : 0;
  const c1 = new Set(f1.classes), c2 = new Set(f2.classes);
  const classScore = (c1.size === 0 && c2.size === 0) ? 1
    : (c1.size === 0 || c2.size === 0) ? 0.3
    : [...c1].filter(x => c2.has(x)).length / new Set([...c1, ...c2]).size;
  const a1 = new Set(f1.attrs), a2 = new Set(f2.attrs);
  const attrScore = (a1.size === 0 && a2.size === 0) ? 1
    : (a1.size === 0 || a2.size === 0) ? 0.3
    : [...a1].filter(x => a2.has(x)).length / new Set([...a1, ...a2]).size;
  const ct1 = new Set(f1.childTags), ct2 = new Set(f2.childTags);
  const childScore = new Set([...ct1, ...ct2]).size === 0 ? 1
    : [...ct1].filter(x => ct2.has(x)).length / new Set([...ct1, ...ct2]).size;
  const textScore = f1.textType === f2.textType ? 1 : 0;
  const w = c1.size === 0 && c2.size === 0
    ? { tag: 0.45, cls: 0, attr: 0.15, child: 0.3, txt: 0.1 }
    : { tag: 0.4, cls: 0.25, attr: 0.15, child: 0.2, txt: 0.1 };
  return w.tag*tagScore + w.cls*classScore + w.attr*attrScore + w.child*childScore + w.txt*textScore;
}

function selectSimilarElements(selectedEl, threshold = 0.7) {
  if (!selectedEl) return [];
  const parent = selectedEl.parentElement;
  if (!parent) return [selectedEl];
  const sf = getFeatures(selectedEl);
  let matches = Array.from(parent.children).filter(el =>
    el === selectedEl || similarityScore(sf, getFeatures(el)) >= threshold
  );
  if (matches.length <= 1) {
    matches = Array.from(document.getElementsByTagName(selectedEl.tagName)).filter(el =>
      el === selectedEl || similarityScore(sf, getFeatures(el)) >= threshold
    );
  }
  return matches;
}