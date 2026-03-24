(function enableDevToolsMode() {
  let highlightedEl = null;
  let selectedEl = null;
  let tooltip = null;
  let inspector = null;
  let allowNextClick = false;

  // Tooltip
  function createTooltip() {
    tooltip = document.createElement('div');
    tooltip.style.all = 'initial';
    tooltip.style.position = 'fixed';
    tooltip.style.background = 'rgba(0,0,0,0.85)';
    tooltip.style.color = '#fff';
    tooltip.style.padding = '4px 8px';
    tooltip.style.fontSize = '11px';
    tooltip.style.fontFamily = 'monospace';
    tooltip.style.borderRadius = '4px';
    tooltip.style.boxShadow = '0 2px 6px rgba(0,0,0,0.4)';
    tooltip.style.pointerEvents = 'none';
    tooltip.style.zIndex = 9999;
    document.body.appendChild(tooltip);
  }

  // Inspector
  function createInspector() {
    inspector = document.createElement('div');
    inspector.style.all = 'initial';
    inspector.style.position = 'fixed';
    inspector.style.bottom = '12px';
    inspector.style.right = '12px';
    inspector.style.background = '#222';
    inspector.style.color = '#eee';
    inspector.style.padding = '14px';
    inspector.style.fontFamily = 'monospace';
    inspector.style.fontSize = '13px';
    inspector.style.borderRadius = '8px';
    inspector.style.boxShadow = '0 3px 10px rgba(0,0,0,0.6)';
    inspector.style.zIndex = 10000;
    inspector.style.maxWidth = '480px';
    inspector.style.maxHeight = '60vh';
    inspector.style.overflow = 'auto';
    inspector.style.display = 'none';
    document.body.appendChild(inspector);
  }

  function placeTooltipNearMouse(e) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const ttRect = tooltip.getBoundingClientRect(), margin = 12;
    let left = e.clientX + margin, top = e.clientY + margin;
    if (left + ttRect.width + 10 > vw) left = e.clientX - ttRect.width - margin;
    if (top + ttRect.height + 10 > vh) top = e.clientY - ttRect.height - margin;
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    tooltip.style.left = left + 'px';
    tooltip.style.top  = top  + 'px';
  }

  function getShortHtmlPath(el, depth = 5) {
    if (!(el instanceof Element)) return '';
    const parts = [];
    let cur = el, count = 0;
    while (cur && cur.tagName.toLowerCase() !== 'html') {
      let tag = cur.tagName.toLowerCase();
      if (count === 0 && cur.classList.length) tag += '.' + [...cur.classList].join('.');
      parts.unshift(tag);
      cur = cur.parentElement;
      count++;
    }
    if (cur) parts.unshift('html');
    const truncated = count > depth;
    const body = (truncated ? '>> ' : '') + (truncated ? parts.slice(-depth) : parts).join(' > ');
    return body + (el.children.length ? ' >' : '');
  }

  // Highlight hovered element
  function highlightElement(e) {
    if (!window.__SELECTION_MODE__) return;
    const target = e.target;
    if (inspector && inspector.contains(target)) {
      tooltip.style.display = 'none';
      if (highlightedEl && highlightedEl !== selectedEl) highlightedEl.style.outline = '';
      highlightedEl = null;
      return;
    }
    if (target === selectedEl) return;
    if (highlightedEl && highlightedEl !== selectedEl) highlightedEl.style.outline = '';
    highlightedEl = target;
    if (highlightedEl !== selectedEl) highlightedEl.style.setProperty('outline', '1px solid red', 'important');
    tooltip.style.display = 'block';
    tooltip.textContent = getShortHtmlPath(highlightedEl, 5);
    placeTooltipNearMouse(e);
  }

  // Selection handler
  function selectElement(el) {
    if (highlightedEl && highlightedEl !== selectedEl) highlightedEl.style.outline = '';
    if (selectedEl) selectedEl.style.outline = '';
    selectedEl = el;
    selectedEl.style.setProperty('outline', '2px solid lime', 'important');

    inspector.innerHTML = ``;
    inspector.style.display = 'block';

    // Header
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.marginBottom = '10px';

    const title = document.createElement('span');
    title.style.color = '#fff';
    title.style.fontWeight = 'bold';
    title.style.fontSize = '14px';
    title.textContent = 'Element inspector';
    header.appendChild(title);

    const closeBtn = document.createElement('span');
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.fontSize = '18px';
    closeBtn.style.fontWeight = 'bold';
    closeBtn.style.marginLeft = '14px';
    closeBtn.style.color = '#aaa';
    closeBtn.onclick = (evt) => {
      evt.preventDefault(); evt.stopPropagation();
      if (selectedEl) { selectedEl.style.outline = ''; selectedEl = null; }
      inspector.style.display = 'none';
    };
    header.appendChild(closeBtn);
    inspector.appendChild(header);

    // Actions
    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.flexWrap = 'wrap';
    actions.style.gap = '6px';
    actions.style.marginBottom = '12px';

    const mkBtn = (label, handler) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.padding = '5px 10px';
      btn.style.background = '#333';
      btn.style.color = '#eee';
      btn.style.border = '1px solid #555';
      btn.style.borderRadius = '4px';
      btn.style.cursor = 'pointer';
      btn.style.fontFamily = 'monospace';
      btn.style.fontSize = '13px';
      btn.onmouseenter = () => btn.style.background = '#444';
      btn.onmouseleave = () => btn.style.background = '#333';
      btn.onclick = (evt) => { evt.preventDefault(); evt.stopPropagation(); handler(); };
      return btn;
    };

    actions.appendChild(mkBtn('Extract text', () => {
      const text = (selectedEl.textContent || '').trim();
      const { primary, fallbacks, meta } = window.SelectorGenerator.getSelectorsForElement(selectedEl, { actionType: 'extractText' });
      window.sendToNode({ type: 'workflowStep', action: 'EXTRACT_TEXT', primarySelector: primary, fallbackSelectors: fallbacks, text }, '*');
      console.log('Extracted text:', text);
    }));

    actions.appendChild(mkBtn('Extract data', () => {
      const data = extractLeafElements(selectedEl);
      window.sendToNode({ type: 'workflowStep', action: 'extractData', data }, '*');
      console.log('Extracted data:', data);
    }));

    actions.appendChild(mkBtn('Click element', () => {
      // allowNextClick = true;
      // selectedEl.click();
      const { primary, fallbacks, meta } = window.SelectorGenerator.getSelectorsForElement(selectedEl, { actionType: 'CLICK_ELEMENT' });
      window.sendToNode({
        type: 'userAction',
        action: 'CLICK_ELEMENT',
        primarySelector: primary, 
        fallbackSelectors: fallbacks
      });
    }));

    actions.appendChild(mkBtn('Select similar elements', () => {
      const matches = selectSimilarElements(selectedEl);
      matches.forEach(el => el.style.outline = '2px solid red');
      window.sendToNode({ type: 'workflowStep', action: 'selectSimilar', count: matches.length }, '*');
      console.log('Similar elements found:', matches);
    }));

    inspector.appendChild(actions);
    inspector.appendChild(buildClickablePath(el));
  }

  // Clickable breadcrumbs with child dropdown on last node
  function buildClickablePath(el, depth = 5) {
    const wrapper = document.createElement('div');
    wrapper.style.marginTop = '12px';
    wrapper.style.paddingTop = '8px';
    wrapper.style.borderTop = '1px solid #444';
    wrapper.style.lineHeight = '1.6';

    const nodes = [];
    let cur = el;
    while (cur && cur.tagName.toLowerCase() !== 'html') {
      nodes.unshift(cur);
      cur = cur.parentElement;
    }
    if (cur) nodes.unshift(cur);

    const tooLong = nodes.length > depth + 2;
    const shown = tooLong ? nodes.slice(-depth) : nodes;

    if (tooLong) {
      const more = document.createElement('span');
      more.textContent = '>> ';
      more.style.cursor = 'pointer';
      more.style.color = '#0ff';
      more.onclick = (evt) => {
        evt.preventDefault(); evt.stopPropagation();
        selectElement(nodes[nodes.length - depth - 1]);
      };
      wrapper.appendChild(more);
    }

    shown.forEach((node, i) => {
      const seg = document.createElement('span');
      seg.textContent = node.tagName.toLowerCase();
      seg.style.cursor = 'pointer';
      seg.style.color = '#0ff';
      seg.style.fontFamily = 'monospace';
      seg.style.fontSize = '13px';
      seg.onclick = (evt) => { evt.preventDefault(); evt.stopPropagation(); selectElement(node); };
      wrapper.appendChild(seg);

      // Add separator
      if (i < shown.length - 1) {
        const arrow = document.createElement('span');
        arrow.textContent = ' > ';
        arrow.style.color = '#aaa';
        wrapper.appendChild(arrow);
      } else {
        // For the last shown node, if it has children, add expandable caret + dropdown
        if (node.children && node.children.length) {
          const expand = document.createElement('span');
          expand.textContent = ' >';
          expand.style.cursor = 'pointer';
          expand.style.color = '#ff0';
          expand.style.marginLeft = '6px';

          expand.onclick = (evt) => {
            evt.preventDefault(); evt.stopPropagation();
            // toggle dropdown
            const existing = wrapper.querySelector('[data-dropdown-for="last-node"]');
            if (existing) { existing.remove(); return; }

            const dropdown = document.createElement('div');
            dropdown.style.all = 'initial';
            dropdown.dataset.dropdownFor = 'last-node';
            dropdown.style.background = '#2a2a2a';
            dropdown.style.border = '1px solid #444';
            dropdown.style.marginTop = '6px';
            dropdown.style.borderRadius = '4px';
            dropdown.style.boxShadow = '0 2px 6px rgba(0,0,0,0.4)';
            dropdown.style.maxHeight = '25vh';
            dropdown.style.overflow = 'auto';
            dropdown.style.display = 'block';
            dropdown.style.padding = '4px 0';

            Array.from(node.children).forEach((ch, idx) => {
              const item = document.createElement('div');
              item.style.all = 'initial';
              const cls = ch.classList.length ? '.' + [...ch.classList].join('.') : '';
              item.textContent = `${idx + 1}. ${ch.tagName.toLowerCase()}${cls}`;
              item.style.cursor = 'pointer';
              item.style.padding = '6px 10px';
              item.style.color = '#eee';
              item.style.fontFamily = 'monospace';
              item.style.fontSize = '13px';
              item.onmouseenter = () => { if (ch !== selectedEl) ch.style.outline = '1px dashed #888'; item.style.background = '#3a3a3a'; };
              item.onmouseleave = () => { if (ch !== selectedEl) ch.style.outline = ''; item.style.background = 'transparent'; };
              item.onclick = (evt2) => { evt2.preventDefault(); evt2.stopPropagation(); selectElement(ch); };
              dropdown.appendChild(item);
            });

            wrapper.appendChild(dropdown);
          };

          wrapper.appendChild(expand);
        }
      }
    });

    return wrapper;
  }

  // Initialization
  createTooltip();
  createInspector();
  document.addEventListener('mousemove', highlightElement, true);

  document.addEventListener('click', (e) => {
    if (!window.__SELECTION_MODE__) return;
    if (inspector && inspector.contains(e.target)) return;
    if (allowNextClick) { allowNextClick = false; return; }
    e.preventDefault(); e.stopPropagation();
    selectElement(e.target);
  }, true);

  console.log('✅ DevTools selection mode enabled');
})();

/* === Utility functions remain unchanged === */
function extractLeafElements(el) {
  const fields = {};
  let counter = 1;
  function walk(node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName.toLowerCase() === 'a' && node.hasAttribute('href')) {
        try {
          fields[`field${counter++}`] = node.href || node.getAttribute('href');
        } catch (e) {
          fields[`field${counter++}`] = node.getAttribute('href');
        }
      }
      if (node.children.length === 0) {
        const text = (node.textContent || '').trim();
        if (text) fields[`field${counter++}`] = text;
      } else {
        Array.from(node.children).forEach(walk);
      }
    }
  }
  walk(el);
  return fields;
}

function getFeatures(el) {
  return {
    tag: el.tagName,
    classes: Array.from(el.classList),
    attrs: Array.from(el.attributes).map(a => a.name),
    childTags: Array.from(el.children).map(c => c.tagName),
    textType: (() => {
      const txt = (el.textContent || "").trim();
      if (!txt) return "empty";
      if (/^\d+$/.test(txt)) return "number";
      if (/[\$€£]/.test(txt)) return "money";
      if (txt.length < 30) return "short";
      return "long";
    })()
  };
}

function similarityScore(f1, f2) {
  const tagScore = f1.tag === f2.tag ? 1 : 0;
  const c1 = new Set(f1.classes), c2 = new Set(f2.classes);
  let classScore;
  if (c1.size === 0 && c2.size === 0) {
    classScore = 1;
  } else if (c1.size === 0 || c2.size === 0) {
    classScore = 0.3;
  } else {
    const inter = [...c1].filter(x => c2.has(x)).length;
    const union = new Set([...c1, ...c2]).size || 1;
    classScore = inter / union;
  }
  const a1 = new Set(f1.attrs), a2 = new Set(f2.attrs);
  let attrScore;
  if (a1.size === 0 && a2.size === 0) {
    attrScore = 1;
  } else if (a1.size === 0 || a2.size === 0) {
    attrScore = 0.3;
  } else {
    const interA = [...a1].filter(x => a2.has(x)).length;
    const unionA = new Set([...a1, ...a2]).size || 1;
    attrScore = interA / unionA;
  }
  const ct1 = new Set(f1.childTags), ct2 = new Set(f2.childTags);
  const interCT = [...ct1].filter(x => ct2.has(x)).length;
  const unionCT = new Set([...ct1, ...ct2]).size || 1;
  const childScore = interCT / unionCT;
  const textScore = f1.textType === f2.textType ? 1 : 0;

  const weights = (new Set(f1.classes).size === 0 && new Set(f2.classes).size === 0)
    ? { tag: 0.45, class: 0, attr: 0.15, child: 0.3, text: 0.1 }
    : { tag: 0.4, class: 0.25, attr: 0.15, child: 0.2, text: 0.1 };

  return (
    weights.tag * tagScore +
    weights.class * classScore +
    weights.attr * attrScore +
    weights.child * childScore +
    weights.text * textScore
  );
}

function selectSimilarElements(selectedEl, threshold = 0.7) {
  if (!selectedEl) return [];
  const parent = selectedEl.parentElement;
  if (!parent) return [selectedEl];
  const selectedFeatures = getFeatures(selectedEl);
  let candidates = Array.from(parent.children);
  let matches = candidates.filter(el => {
    if (el === selectedEl) return true;
    const score = similarityScore(selectedFeatures, getFeatures(el));
    return score >= threshold;
  });
  if (matches.length <= 1) {
    candidates = Array.from(document.getElementsByTagName(selectedEl.tagName));
    matches = candidates.filter(el => {
      if (el === selectedEl) return true;
      const score = similarityScore(selectedFeatures, getFeatures(el));
      return score >= threshold;
    });
  }
  return matches;
}
