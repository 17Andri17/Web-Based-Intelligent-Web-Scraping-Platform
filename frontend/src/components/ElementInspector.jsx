import { useState, useRef, useEffect } from "react";
import { actionDefinitions } from "../actions/actionDefinitions";
import { createAction, createControl } from "../workflow/stepFactory";
import { CONTROL_TYPES } from "../workflow/controlDefinitions";

// Human-readable label for the detection strategy sent from SelectorTool
function strategyLabel(strategy) {
  if (!strategy) return '';
  if (strategy.startsWith('A')) return '⚭ siblings';
  if (strategy.startsWith('B')) return '⬡ ancestor-relative';
  if (strategy.startsWith('C')) return '▣ ancestor-cards';
  if (strategy.startsWith('D')) return '◎ global-class';
  return strategy;
}

// ─── Action catalogue ──────────────────────────────────────────────────────

const CATEGORIES = [
  {
    id: "interaction", label: "Interaction", color: "#3fb950",
    actions: [
      { type: "CLICK_ELEMENT",    icon: "▶", needsEl: true,  quickAdd: true,
        smartDefault: (el) => ({ selector: el.selector, selectorType: el.selectorType || "css", fallbackSelectors: el.fallbackSelectors || [] }) },
      { type: "HOVER_ELEMENT",    icon: "✋", needsEl: true,
        smartDefault: (el) => ({ selector: el.selector, selectorType: el.selectorType || "css", fallbackSelectors: el.fallbackSelectors || [] }) },
      { type: "TYPE_TEXT",        icon: "✏️", needsEl: true,
        smartDefault: (el) => ({ selector: el.selector, selectorType: el.selectorType || "css", fallbackSelectors: el.fallbackSelectors || [], clearFirst: true, pressEnter: false }),
        showWhen: (el) => el.isInput },
      { type: "CLEAR_INPUT",      icon: "🗑️", needsEl: true,
        smartDefault: (el) => ({ selector: el.selector, selectorType: el.selectorType || "css", fallbackSelectors: el.fallbackSelectors || [] }),
        showWhen: (el) => el.isInput },
      { type: "SCROLL_TO_ELEMENT",icon: "⬇", needsEl: true,
        smartDefault: (el) => ({ selector: el.selector, selectorType: el.selectorType || "css", fallbackSelectors: el.fallbackSelectors || [] }) },
      { type: "PRESS_KEY",        icon: "⌨️", needsEl: false, smartDefault: () => ({ key: "Enter", count: 1 }) },
      { type: "SCROLL_PAGE",      icon: "📜", needsEl: false, smartDefault: () => ({ direction: "down", amount: 500 }) },
      { type: "UPLOAD_FILE",      icon: "📎", needsEl: true,
        smartDefault: (el) => ({ selector: el.selector, selectorType: el.selectorType || "css", fallbackSelectors: el.fallbackSelectors || [] }),
        showWhen: (el) => el.tag === "input" },
    ],
  },
  {
    id: "extraction", label: "Extraction", color: "#58a6ff",
    actions: [
      { type: "EXTRACT_TEXT",      icon: "📝", needsEl: true, quickAdd: true,
        smartDefault: (el) => ({ selector: el.selector, selectorType: el.selectorType || "css", fallbackSelectors: el.fallbackSelectors || [], multiple: false }) },
      { type: "EXTRACT_ATTRIBUTE", icon: "🔗", needsEl: true,
        smartDefault: (el) => ({ selector: el.selector, selectorType: el.selectorType || "css", fallbackSelectors: el.fallbackSelectors || [], attribute: el.href ? "href" : el.src ? "src" : "", multiple: false }),
        showWhen: (el) => el.isLink || el.isImg || el.href || el.src },
      { type: "EXTRACT_HTML",      icon: "🧩", needsEl: true,
        smartDefault: (el) => ({ selector: el.selector, selectorType: el.selectorType || "css", fallbackSelectors: el.fallbackSelectors || [], mode: "inner" }) },
      { type: "EXTRACT_TABLE",     icon: "📋", needsEl: true, quickAdd: true,
        smartDefault: (el) => ({ selector: el.selector, selectorType: el.selectorType || "css", fallbackSelectors: el.fallbackSelectors || [], hasHeader: true }),
        showWhen: (el) => el.isTable },
      { type: "EXTRACT_LIST",      icon: "📑", needsEl: true,
        smartDefault: (el) => ({ containerSelector: el.selector, selectorType: el.selectorType || "css", fallbackSelectors: el.fallbackSelectors || [] }) },
      { type: "EXTRACT_JSON",      icon: "{ }", needsEl: false, smartDefault: () => ({ source: "jsonld" }) },
    ],
  },
  {
    id: "navigation", label: "Navigation", color: "#d29922",
    actions: [
      { type: "NAVIGATE",          icon: "🌐", needsEl: false, smartDefault: () => ({ url: "" }) },
      { type: "GO_BACK",           icon: "◀",  needsEl: false, smartDefault: () => ({}), quickAdd: true },
      { type: "RELOAD_PAGE",       icon: "🔄", needsEl: false, smartDefault: () => ({}), quickAdd: true },
      { type: "OPEN_NEW_TAB",      icon: "➕", needsEl: false, smartDefault: () => ({ url: "" }) },
      { type: "SWITCH_TAB",        icon: "⇄",  needsEl: false, smartDefault: () => ({ tabIndex: 0 }) },
    ],
  },
  {
    id: "flow", label: "Flow Control", color: "#a371f7",
    actions: [
      { type: "WAIT",              icon: "⏱️", needsEl: false, smartDefault: () => ({ duration: 1000 }), quickAdd: true },
      { type: "WAIT_FOR_SELECTOR", icon: "👁️", needsEl: false, smartDefault: (el) => ({ selector: el?.selector || "", state: "visible", timeout: 30000 }) },
      { type: "WAIT_FOR_NAVIGATION", icon: "⏳", needsEl: false, smartDefault: () => ({}) },
      { type: "CONDITION",         icon: "🔀", needsEl: false, smartDefault: () => ({ expression: "" }) },
      { type: "LOOP",              icon: "🔁", needsEl: false, smartDefault: () => ({ mode: "forEach", source: "", count: 10 }) },
      { type: "BREAK_LOOP",        icon: "⛔", needsEl: false, smartDefault: () => ({}), quickAdd: true },
    ],
  },
  {
    id: "data", label: "Data", color: "#f78166",
    actions: [
      { type: "SET_VARIABLE",   icon: "📦", needsEl: false, smartDefault: () => ({ name: "", value: "" }) },
      { type: "TRANSFORM_DATA", icon: "🔧", needsEl: false, smartDefault: () => ({ source: "", operation: "trim" }) },
      { type: "APPEND_TO_LIST", icon: "➕", needsEl: false, smartDefault: () => ({ listName: "results", item: "" }) },
      { type: "SAVE_DATA",      icon: "💾", needsEl: false, smartDefault: () => ({ source: "results", format: "json", destination: "./output/results.json" }) },
    ],
  },
];

// Multi-selection: only extraction-safe actions (no single-element interaction)
const MULTI_CATEGORIES = [
  {
    id: "extraction", label: "Extraction", color: "#58a6ff",
    actions: [
      { type: "EXTRACT_TEXT",  icon: "📝", quickAdd: true,
        smartDefault: (sel) => ({ selector: sel.commonSelector, selectorType: "css", fallbackSelectors: [], multiple: true }) },
      { type: "EXTRACT_ATTRIBUTE", icon: "🔗",
        smartDefault: (sel) => ({ selector: sel.commonSelector, selectorType: "css", fallbackSelectors: [], attribute: "", multiple: true }) },
      { type: "EXTRACT_HTML",  icon: "🧩",
        smartDefault: (sel) => ({ selector: sel.commonSelector, selectorType: "css", fallbackSelectors: [], mode: "inner" }) },
      { type: "EXTRACT_LIST",  icon: "📑", quickAdd: true,
        smartDefault: (sel) => ({ containerSelector: sel.commonSelector, selectorType: "css", fallbackSelectors: {}, fields: {} }) },
    ],
  },
  {
    id: "flow", label: "Flow", color: "#a371f7",
    actions: [
      { type: "WAIT",              icon: "⏱️", quickAdd: true, smartDefault: () => ({ duration: 1000 }) },
      { type: "WAIT_FOR_SELECTOR", icon: "👁️",
        smartDefault: (sel) => ({ selector: sel.commonSelector, state: "visible", timeout: 30000 }) },
    ],
  },
];

// ─── Main component ────────────────────────────────────────────────────────

export default function ElementInspector({
  element, childrenList, forEachCtx,
  onClose, onAddStep,
  onSelectAncestor, onGetChildren, onSelectChild,
  onHoverPickerChild, onHoverAncestor, onUnhoverPickerChild,
  onClearForEachCtx,
}) {
  if (!element) return null;

  if (element.isMultiSelection) {
    return (
      <MultiInspector
        selection={element}
        childrenList={childrenList}
        forEachCtx={forEachCtx}
        onClose={onClose}
        onAddStep={onAddStep}
        onClearForEachCtx={onClearForEachCtx}
      />
    );
  }

  return (
    <SingleInspector
      element={element}
      childrenList={childrenList}
      forEachCtx={forEachCtx}
      onClose={onClose}
      onAddStep={onAddStep}
      onSelectAncestor={onSelectAncestor}
      onGetChildren={onGetChildren}
      onSelectChild={onSelectChild}
      onHoverPickerChild={onHoverPickerChild}
      onHoverAncestor={onHoverAncestor}
      onUnhoverPickerChild={onUnhoverPickerChild}
      onClearForEachCtx={onClearForEachCtx}
    />
  );
}

// ─── Single element inspector ──────────────────────────────────────────────

function SingleInspector({ element, childrenList, forEachCtx, onClose, onAddStep, onSelectAncestor, onGetChildren, onSelectChild, onHoverPickerChild, onHoverAncestor, onUnhoverPickerChild, onClearForEachCtx }) {
  const [activeCategory, setActiveCategory] = useState("interaction");
  const [selectedAction, setSelectedAction] = useState(null);
  const [addedFlash, setAddedFlash] = useState(null);

  const cat = CATEGORIES.find(c => c.id === activeCategory);
  const visibleActions = cat ? cat.actions.filter(a => !a.showWhen || a.showWhen(element)) : [];

  const EXTRACTION_PREVIEW_FN = {
    EXTRACT_TEXT:      () => element.text || "",
    EXTRACT_ATTRIBUTE: () => element.href || element.src || element.text || "",
    EXTRACT_HTML:      () => element.text ? element.text.slice(0, 80) + "..." : "(inner HTML)",
    EXTRACT_TABLE:     () => "(table data)",
    EXTRACT_LIST:      () => "(list items)",
    EXTRACT_JSON:      () => "(JSON-LD structured data)",
  };

  const handleQuickAdd = (actionMeta) => {
    const def = actionDefinitions[actionMeta.type];
    if (!def) return;
    const smartParams = actionMeta.smartDefault ? actionMeta.smartDefault(element) : {};
    const step = createAction(actionMeta.type, { ...buildDefaultParams(def), ...smartParams }, buildDefaultAdvanced(def));
    if (EXTRACTION_PREVIEW_FN[actionMeta.type]) {
      step.previewValue    = EXTRACTION_PREVIEW_FN[actionMeta.type]();
      step.previewSelector = element.selector || "";
    }
    onAddStep(step);
    setAddedFlash(actionMeta.type);
    setTimeout(() => setAddedFlash(null), 800);
  };

  return (
    <div className="ei-panel">
      {/* ── ForEach context banner ──────────────────────────────────────── */}
      {forEachCtx && (
        <ForEachContextBanner forEachCtx={forEachCtx} onClear={onClearForEachCtx} />
      )}

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="ei-header">
        <div className="ei-header-info">
          <span className="ei-tag">&lt;{element.tag}&gt;</span>
          {element.classes && <span className="ei-classes">{element.classes.slice(0, 50)}</span>}
        </div>
        <button className="ei-close" onClick={onClose} title="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      {/* ── Selector pill ───────────────────────────────────────────────── */}
      <div className="ei-selector-row">
        <span className="ei-selector-icon">🎯</span>
        <code className="ei-selector">{element.selector}</code>
        {element.isRelativeToScope && (
          <span className="ei-relative-badge" title="Selector is relative to the ForEach iterator — works for every iterated element">
            relative
          </span>
        )}
        {element.softHighlightCount > 0 && (
          <span className="ei-similar-badge" title="Similar elements are highlighted in amber — click one to select the group">
            +{element.softHighlightCount} similar
          </span>
        )}
      </div>

      {/* ── Interactive breadcrumb ──────────────────────────────────────── */}
      {element.breadcrumb?.length > 0 && (
        <InteractiveBreadcrumb
          breadcrumb={element.breadcrumb}
          element={element}
          childrenList={childrenList}
          onSelectAncestor={onSelectAncestor}
          onGetChildren={onGetChildren}
          onSelectChild={onSelectChild}
          onHoverAncestor={onHoverAncestor}
          onHoverPickerChild={onHoverPickerChild}
          onUnhoverPickerChild={onUnhoverPickerChild}
        />
      )}

      {/* ── Element preview ──────────────────────────────────────────────── */}
      {(element.text || element.href || element.src) && (
        <div className="ei-preview">
          {element.text && <div className="ei-preview-text">"{element.text}"</div>}
          {element.href && <div className="ei-preview-attr"><span className="ei-attr-name">href</span> {element.href}</div>}
          {element.src  && <div className="ei-preview-attr"><span className="ei-attr-name">src</span> {element.src}</div>}
        </div>
      )}

      {/* ── Subtle hint when similar elements are soft-highlighted ──────── */}
      {element.softHighlightCount > 0 && (
        <div className="ei-similar-hint">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          {element.softHighlightCount} similar element{element.softHighlightCount !== 1 ? "s" : ""} highlighted in amber — click one to select all of them
        </div>
      )}

      <div className="ei-body">
        {/* ── Category tabs ─────────────────────────────────────────────── */}
        <div className="ei-tabs">
          {CATEGORIES.map(c => (
            <button key={c.id}
              className={`ei-tab ${activeCategory === c.id ? "active" : ""}`}
              style={activeCategory === c.id ? { borderColor: c.color, color: c.color } : {}}
              onClick={() => { setActiveCategory(c.id); setSelectedAction(null); }}>
              {c.label}
            </button>
          ))}
        </div>

        {/* ── Action cards ──────────────────────────────────────────────── */}
        <div className="ei-action-grid">
          {visibleActions.map(actionMeta => {
            const def = actionDefinitions[actionMeta.type];
            if (!def) return null;
            const isSelected = selectedAction?.type === actionMeta.type;
            const isFlashing = addedFlash === actionMeta.type;
            return (
              <div key={actionMeta.type}
                className={`ei-action-card ${isSelected ? "selected" : ""} ${isFlashing ? "flash" : ""}`}
                style={isSelected ? { borderColor: cat.color } : {}}
                onClick={() => setSelectedAction(actionMeta)}>
                <div className="ei-action-icon">{actionMeta.icon}</div>
                <div className="ei-action-label">{def.label}</div>
                {actionMeta.quickAdd && (
                  <button className="ei-quick-add" title="Add with defaults"
                    onClick={e => { e.stopPropagation(); handleQuickAdd(actionMeta); }}>+</button>
                )}
              </div>
            );
          })}
        </div>

        {/* ── Action configurator ───────────────────────────────────────── */}
        {selectedAction && (
          <ActionConfigurator
            key={selectedAction.type}
            actionMeta={selectedAction}
            element={element}
            accentColor={cat?.color}
            onAdd={(params, advanced) => {
              const step = createAction(selectedAction.type, params, advanced);
              if (EXTRACTION_PREVIEW_FN[selectedAction.type]) {
                step.previewValue    = EXTRACTION_PREVIEW_FN[selectedAction.type]();
                step.previewSelector = element.selector || "";
              }
              onAddStep(step);
              setAddedFlash(selectedAction.type);
              setTimeout(() => setAddedFlash(null), 800);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ─── Multi-element inspector ───────────────────────────────────────────────

function MultiInspector({ selection, forEachCtx, onClose, onAddStep, onClearForEachCtx }) {
  const [activeCategory, setActiveCategory] = useState("extraction");
  const [selectedAction, setSelectedAction] = useState(null);
  const [addedFlash, setAddedFlash] = useState(null);

  const cat = MULTI_CATEGORIES.find(c => c.id === activeCategory);

  const handleQuickAdd = (actionMeta) => {
    const def = actionDefinitions[actionMeta.type];
    if (!def) return;
    const smartParams = actionMeta.smartDefault ? actionMeta.smartDefault(selection) : {};
    const step = createAction(actionMeta.type, { ...buildDefaultParams(def), ...smartParams }, buildDefaultAdvanced(def));
    // Capture multi-element preview
    const MULTI_PREVIEW = {
      EXTRACT_TEXT:      () => `${selection.matchCount} elements matched`,
      EXTRACT_ATTRIBUTE: () => `${selection.matchCount} attribute values`,
      EXTRACT_HTML:      () => `${selection.matchCount} HTML fragments`,
      EXTRACT_LIST:      () => `${selection.matchCount} list items`,
    };
    if (MULTI_PREVIEW[actionMeta.type]) {
      step.previewValue    = MULTI_PREVIEW[actionMeta.type]();
      step.previewSelector = selection.commonSelector || "";
    }
    onAddStep(step);
    setAddedFlash(actionMeta.type);
    setTimeout(() => setAddedFlash(null), 800);
  };

  const handleAddForEach = () => {
    const control = createControl(CONTROL_TYPES.FOR_EACH_ELEMENTS, {
      selector: selection.commonSelector,
      itemVar: "el",
      indexVar: "i",
    });
    // Attach all matched elements so DataPreviewPanel can show real preview rows
    control.previewElements = selection.elements || [];
    onAddStep(control, { isForEach: true });
    setAddedFlash("FOREACH");
    setTimeout(() => setAddedFlash(null), 800);
  };

  return (
    <div className="ei-panel ei-multi-panel">
      {/* ── ForEach context banner ──────────────────────────────────────── */}
      {forEachCtx && <ForEachContextBanner forEachCtx={forEachCtx} onClear={onClearForEachCtx} />}

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="ei-header ei-multi-header">
        <div className="ei-header-info">
          <span className="ei-multi-icon">⬡</span>
          <span className="ei-multi-title">{selection.matchCount} elements selected</span>
        </div>
        <button className="ei-close" onClick={onClose} title="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      {/* ── Selector pill ───────────────────────────────────────────────── */}
      <div className="ei-selector-row ei-multi-selector-row">
        <span className="ei-selector-icon">🎯</span>
        <code className="ei-selector">{selection.commonSelector}</code>
        <span className="ei-multi-match-badge">{selection.matchCount}</span>
      </div>

      {/* ── CSS Selector display ─────────────────────────────────────────── */}
      <div className="ei-multi-selector-block">
        <div className="ei-multi-selector-header">
          <span className="ei-multi-selector-label">CSS Selector</span>
          {selection.strategy && (
            <span className="ei-multi-strategy-badge" title={`Detection strategy: ${selection.strategy}`}>
              {strategyLabel(selection.strategy)}
            </span>
          )}
          <button
            className="ei-multi-selector-copy"
            title="Copy selector"
            onClick={() => { try { navigator.clipboard.writeText(selection.commonSelector); } catch (_) {} }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
        </div>
        {selection.commonSelector ? (
          <code className="ei-multi-selector-code">{selection.commonSelector}</code>
        ) : (
          <span className="ei-multi-selector-empty">No selector generated — elements selected by position</span>
        )}
        <div className="ei-multi-selector-meta">
          Matches exactly <strong>{selection.matchCount}</strong> element{selection.matchCount !== 1 ? 's' : ''}
        </div>
      </div>

      {/* ── ForEach banner ───────────────────────────────────────────────── */}
      {!forEachCtx && (
        <div className="ei-foreach-banner">
          <div className="ei-foreach-banner-text">
            <span className="ei-foreach-icon">∀</span>
            <div>
              <div className="ei-foreach-title">Add as ForEach Loop</div>
              <div className="ei-foreach-desc">Iterate over all {selection.matchCount} matched elements</div>
            </div>
          </div>
          <button
            className={`ei-foreach-btn ${addedFlash === "FOREACH" ? "flash" : ""}`}
            onClick={handleAddForEach}>
            {addedFlash === "FOREACH" ? <><CheckIcon /> Added!</> : <><PlusIcon /> Add Loop</>}
          </button>
        </div>
      )}

      <div className="ei-body">
        {/* ── Notice ───────────────────────────────────────────────────── */}
        <div className="ei-multi-notice">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          Single-element actions (Click, Hover…) are hidden for multi-selections.
        </div>

        {/* ── Category tabs ─────────────────────────────────────────────── */}
        <div className="ei-tabs">
          {MULTI_CATEGORIES.map(c => (
            <button key={c.id}
              className={`ei-tab ${activeCategory === c.id ? "active" : ""}`}
              style={activeCategory === c.id ? { borderColor: c.color, color: c.color } : {}}
              onClick={() => { setActiveCategory(c.id); setSelectedAction(null); }}>
              {c.label}
            </button>
          ))}
        </div>

        {/* ── Action cards ──────────────────────────────────────────────── */}
        <div className="ei-action-grid">
          {(cat?.actions || []).map(actionMeta => {
            const def = actionDefinitions[actionMeta.type];
            if (!def) return null;
            const isSelected = selectedAction?.type === actionMeta.type;
            const isFlashing = addedFlash === actionMeta.type;
            return (
              <div key={actionMeta.type}
                className={`ei-action-card ${isSelected ? "selected" : ""} ${isFlashing ? "flash" : ""}`}
                style={isSelected ? { borderColor: cat.color } : {}}
                onClick={() => setSelectedAction(actionMeta)}>
                <div className="ei-action-icon">{actionMeta.icon}</div>
                <div className="ei-action-label">{def.label}</div>
                {actionMeta.quickAdd && (
                  <button className="ei-quick-add" title="Add with defaults"
                    onClick={e => { e.stopPropagation(); handleQuickAdd(actionMeta); }}>+</button>
                )}
              </div>
            );
          })}
        </div>

        {selectedAction && (
          <ActionConfigurator
            key={selectedAction.type}
            actionMeta={selectedAction}
            element={{ ...selection, selector: selection.commonSelector }}
            accentColor={cat?.color}
            onAdd={(params, advanced) => {
              const step = createAction(selectedAction.type, params, advanced);
              const MULTI_PREVIEW_FN = {
                EXTRACT_TEXT:      () => `${selection.matchCount} elements matched`,
                EXTRACT_ATTRIBUTE: () => `${selection.matchCount} attribute values`,
                EXTRACT_HTML:      () => `${selection.matchCount} HTML fragments`,
                EXTRACT_LIST:      () => `${selection.matchCount} list items`,
              };
              if (MULTI_PREVIEW_FN[selectedAction.type]) {
                step.previewValue    = MULTI_PREVIEW_FN[selectedAction.type]();
                step.previewSelector = selection.commonSelector || "";
              }
              onAddStep(step);
              setAddedFlash(selectedAction.type);
              setTimeout(() => setAddedFlash(null), 800);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ─── ForEach context banner ───────────────────────────────────────────────

export function ForEachContextBanner({ forEachCtx, onClear }) {
  return (
    <div className="ei-foreach-ctx-banner">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ flexShrink: 0, marginTop: 2 }}>
        <polyline points="17,1 21,5 17,9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/>
        <polyline points="7,23 3,19 7,15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
      </svg>
      <div className="ei-foreach-ctx-text">
        <span><strong>ForEach loop context</strong> — click any highlighted element or one of its children to select it</span>
        {forEachCtx?.iteratorSelector && (
          <code className="ei-foreach-ctx-scope">Iterating: {forEachCtx.iteratorSelector}</code>
        )}
      </div>
      <button className="ei-foreach-ctx-clear" onClick={onClear} title="Exit loop context">✕</button>
    </div>
  );
}

// ─── Interactive breadcrumb ────────────────────────────────────────────────

function InteractiveBreadcrumb({ breadcrumb, element, childrenList, onSelectAncestor, onGetChildren, onSelectChild, onHoverAncestor, onHoverPickerChild, onUnhoverPickerChild }) {
  const [openPickerAt, setOpenPickerAt] = useState(null); // breadcrumb index (or 'current')
  const [pickerPos,    setPickerPos]    = useState({ top: 0, left: 0 });
  const pickerRef  = useRef(null);
  const chevronRefs = useRef({}); // keyed by index or 'current'

  // Close picker on outside click
  useEffect(() => {
    if (openPickerAt === null) return;
    const handler = (e) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) {
        setOpenPickerAt(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openPickerAt]);

  // Compute fixed position from the chevron button's bounding rect
  function openPicker(key, buttonEl) {
    const rect = buttonEl.getBoundingClientRect();
    // Try to show below; if not enough space show above
    const spaceBelow = window.innerHeight - rect.bottom;
    const pickerH = 260; // estimated max height
    const top = spaceBelow >= pickerH
      ? rect.bottom + 4
      : rect.top - pickerH - 4;
    setPickerPos({ top: Math.max(4, top), left: rect.left });
    setOpenPickerAt(key);
  }

  function closePicker() {
    setOpenPickerAt(null);
    onUnhoverPickerChild?.();
  }

  // levelsUp relative to the current element
  // breadcrumb[last] = current element (levelsUp=0)
  // breadcrumb[last-1] = parent (levelsUp=1), etc.
  const lastIdx = breadcrumb.length - 1;

  function levelsUpForIdx(i) {
    return lastIdx - i; // index i in breadcrumb → how many levels above current
  }

  function handleAncestorClick(i) {
    const lvl = levelsUpForIdx(i);
    if (lvl === 0) return; // current element — no-op on label click
    onSelectAncestor(lvl);
    closePicker();
  }

  function handleChevronClick(key, buttonEl) {
    if (openPickerAt === key) { closePicker(); return; }
    // key is either a breadcrumb index (ancestor) or 'current'
    const lvl = key === 'current' ? 0 : levelsUpForIdx(key);
    openPicker(key, buttonEl);
    onGetChildren(lvl);
  }

  function handleChildPick(key, childIndex) {
    const lvl = key === 'current' ? 0 : levelsUpForIdx(key);
    onSelectChild(lvl, childIndex);
    closePicker();
  }

  // Which children to show in the picker
  const pickerChildren = (childrenList && openPickerAt !== null) ? childrenList.children : null;

  // Does the current element have children? We show the trailing chevron
  // regardless and let "No children" appear if needed.
  const hasChildren = element && (element.tag !== 'input' && element.tag !== 'img' && element.tag !== 'br' && element.tag !== 'hr');

  return (
    <div className="ei-breadcrumb">
      {breadcrumb.map((seg, i) => {
        const isLast  = i === lastIdx;
        const isOpen  = openPickerAt === i;

        return (
          <span key={i} className="ei-bc-item-wrap">
            {/* Segment label */}
            <button
              className={`ei-bc-seg ${isLast ? 'ei-bc-seg--current' : 'ei-bc-seg--ancestor'}`}
              onClick={() => handleAncestorClick(i)}
              disabled={isLast}
              title={isLast ? 'Current element' : `Select ${seg.label}`}
              onMouseEnter={() => !isLast && onHoverAncestor?.(levelsUpForIdx(i))}
              onMouseLeave={() => !isLast && onUnhoverPickerChild?.()}
            >
              {seg.label}
            </button>

            {/* Chevron between segments (ancestor → next) */}
            {!isLast && (
              <button
                ref={el => { chevronRefs.current[i] = el; }}
                className={`ei-bc-chevron ${isOpen ? 'open' : ''}`}
                onClick={e => handleChevronClick(i, e.currentTarget)}
                title={`Browse children of ${seg.label}`}
              >›</button>
            )}
          </span>
        );
      })}

      {/* Trailing chevron for the current element — drill into its children */}
      {hasChildren && (
        <button
          ref={el => { chevronRefs.current['current'] = el; }}
          className={`ei-bc-chevron ei-bc-chevron--trail ${openPickerAt === 'current' ? 'open' : ''}`}
          onClick={e => handleChevronClick('current', e.currentTarget)}
          title="Browse children of current element"
        >›</button>
      )}

      {/* Picker rendered with position:fixed so it escapes overflow:auto */}
      {openPickerAt !== null && (
        <div
          ref={pickerRef}
          className="ei-bc-children-picker"
          style={{ position: 'fixed', top: pickerPos.top, right: pickerPos.right, zIndex: 9999 }}
        >
          <div className="ei-bc-picker-title">
            Children of{' '}
            <code>
              {openPickerAt === 'current'
                ? breadcrumb[lastIdx]?.label
                : breadcrumb[openPickerAt]?.label}
            </code>
          </div>
          {!pickerChildren ? (
            <div className="ei-bc-picker-loading">Loading…</div>
          ) : pickerChildren.length === 0 ? (
            <div className="ei-bc-picker-loading">No children</div>
          ) : (
            <div className="ei-bc-picker-list">
              {pickerChildren.slice(0, 24).map((child, ci) => (
                <button
                  key={ci}
                  className="ei-bc-picker-item"
                  onClick={() => handleChildPick(openPickerAt, child.childIndex ?? ci)}
                  onMouseEnter={() => onHoverPickerChild?.(
                    openPickerAt === 'current' ? 0 : levelsUpForIdx(openPickerAt),
                    child.childIndex ?? ci
                  )}
                  onMouseLeave={() => onUnhoverPickerChild?.()}
                >
                  <span className="ei-bc-picker-tag">&lt;{child.tag}&gt;</span>
                  {child.classes && <span className="ei-bc-picker-cls">{child.classes.slice(0, 28)}</span>}
                  {child.text   && <span className="ei-bc-picker-text">{child.text.slice(0, 40)}</span>}
                </button>
              ))}
              {pickerChildren.length > 24 && (
                <div className="ei-bc-picker-more">+{pickerChildren.length - 24} more children</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Action configurator ───────────────────────────────────────────────────

function ActionConfigurator({ actionMeta, element, accentColor, onAdd }) {
  const def = actionDefinitions[actionMeta.type];
  if (!def) return null;

  const smartDefaults = actionMeta.smartDefault ? actionMeta.smartDefault(element) : {};
  const [params,   setParams]   = useState({ ...buildDefaultParams(def),   ...smartDefaults });
  const [advanced, setAdvanced] = useState(buildDefaultAdvanced(def));
  const [added,    setAdded]    = useState(false);

  const setParam = (k, v) => setParams(p => ({ ...p, [k]: v }));
  const setAdv   = (k, v) => setAdvanced(a => ({ ...a, [k]: v }));

  const handleAdd = () => {
    onAdd(params, advanced);
    setAdded(true);
    setTimeout(() => setAdded(false), 1000);
  };

  const hasAdvanced = def.advanced && Object.keys(def.advanced).length > 0;
  const [showAdv, setShowAdv] = useState(false);

  return (
    <div className="ei-configurator">
      <div className="ei-config-header">
        <span style={{ color: accentColor }}>{actionMeta.icon}</span>
        <span className="ei-config-title">{def.label}</span>
        {def.description && <span className="ei-config-desc">{def.description}</span>}
      </div>

      {actionMeta.needsEl && element?.selector && (
        <div className="ei-config-selector-block">
          <div className="ei-config-selector">
            <span className={`ei-sel-type-badge ${element.selectorType || "css"}`}>
              {element.selectorType === "xpath" ? "XP" : "CSS"}
            </span>
            <code>{params.selector || element.selector}</code>
          </div>
          {(params.fallbackSelectors || element.fallbackSelectors || []).length > 0 && (
            <div className="ei-fallback-list">
              <span className="ei-fallback-label">Fallbacks:</span>
              {(params.fallbackSelectors || element.fallbackSelectors || []).slice(0, 3).map((f, i) => {
                const s = typeof f === "string" ? { value: f, type: "css" } : f;
                return (
                  <div key={i} className="ei-fallback-chip">
                    <span className={`ei-sel-type-badge ${s.type}`}>{s.type === "xpath" ? "XP" : "CSS"}</span>
                    <code className="ei-fallback-value" title={s.value}>{s.value}</code>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="ei-config-fields">
        {Object.entries(def.inputs || {}).map(([key, inputDef]) => {
          if (key === "selector" || key === "selectorType" || key === "containerSelector") return null;
          if (inputDef.type === "hidden") return null;
          if (key === "fallbackSelectors") {
            return (
              <div key={key} className="ei-field">
                <label className="ei-field-label">Fallback selectors</label>
                <InlineSelectorListEditor value={params[key] || []} onChange={v => setParam(key, v)} accentColor={accentColor} />
              </div>
            );
          }
          return (
            <ConfigField key={key} fieldKey={key} def={inputDef} value={params[key]}
              onChange={v => setParam(key, v)} accentColor={accentColor} />
          );
        })}
      </div>

      {hasAdvanced && (
        <button className="ei-adv-toggle" onClick={() => setShowAdv(v => !v)}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            style={{ transform: showAdv ? "rotate(180deg)" : "rotate(0)", transition: "150ms" }}>
            <polyline points="6,9 12,15 18,9"/>
          </svg>
          {showAdv ? "Hide" : "Show"} advanced options
        </button>
      )}
      {showAdv && hasAdvanced && (
        <div className="ei-config-fields ei-adv-fields">
          {Object.entries(def.advanced).map(([key, advDef]) => (
            <ConfigField key={key} fieldKey={key} def={advDef} value={advanced[key]}
              onChange={v => setAdv(key, v)} accentColor={accentColor} />
          ))}
        </div>
      )}

      <button className="ei-add-btn" style={{ background: added ? "#3fb950" : accentColor }} onClick={handleAdd}>
        {added ? <><CheckIcon /> Added!</> : <><PlusIcon /> Add to workflow</>}
      </button>
    </div>
  );
}

// ─── Field renderer ────────────────────────────────────────────────────────

function ConfigField({ fieldKey, def, value, onChange, accentColor }) {
  const label    = def.label || fieldKey;
  const required = def.required;
  if (def.type === "hidden") return null;

  return (
    <div className="ei-field">
      <label className="ei-field-label">
        {label}{required && <span className="ei-required">*</span>}
      </label>
      {def.type === "string" && (
        <input className="ei-input" type="text" value={value ?? ""} placeholder={def.placeholder || ""}
          onChange={e => onChange(e.target.value)} style={{ "--accent": accentColor }} />
      )}
      {def.type === "number" && (
        <input className="ei-input" type="number" value={value ?? (def.default ?? "")}
          onChange={e => onChange(Number(e.target.value))} style={{ "--accent": accentColor }} />
      )}
      {def.type === "boolean" && (
        <label className="ei-checkbox-label">
          <input type="checkbox" className="ei-checkbox" checked={!!value}
            onChange={e => onChange(e.target.checked)} style={{ accentColor }} />
          <span>{value ? "Enabled" : "Disabled"}</span>
        </label>
      )}
      {def.type === "select" && (
        <select className="ei-select" value={value ?? def.default ?? ""} onChange={e => onChange(e.target.value)}>
          {(def.options || []).map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
        </select>
      )}
      {def.type === "array" && (
        <input className="ei-input" type="text" value={(value || []).join(", ")}
          placeholder="Comma-separated values"
          onChange={e => onChange(e.target.value.split(",").map(v => v.trim()).filter(Boolean))}
          style={{ "--accent": accentColor }} />
      )}
      {def.type === "selectorList" && (
        <InlineSelectorListEditor value={value || []} onChange={onChange} accentColor={accentColor} />
      )}
      {def.type === "keyvalue" && (
        <KeyValueEditor value={value || {}} onChange={onChange} accentColor={accentColor} />
      )}
    </div>
  );
}

function InlineSelectorListEditor({ value, onChange, accentColor }) {
  const [draft, setDraft] = useState("");
  const items = value || [];
  const remove = (i) => onChange(items.filter((_, idx) => idx !== i));
  const addDraft = () => {
    const v = draft.trim(); if (!v) return;
    const isXPath = v.startsWith("/") || v.startsWith("(");
    onChange([...items, { value: v, type: isXPath ? "xpath" : "css", strategy: "manual" }]);
    setDraft("");
  };
  return (
    <div className="ei-inline-sel-list">
      {items.map((item, i) => {
        const s = typeof item === "string" ? { value: item, type: "css" } : item;
        return (
          <div key={i} className="ei-fallback-chip">
            <span className={`ei-sel-type-badge ${s.type}`}>{s.type === "xpath" ? "XP" : "CSS"}</span>
            <code className="ei-fallback-value" title={s.value}>{s.value}</code>
            <button className="ei-fb-remove" onClick={() => remove(i)}>×</button>
          </div>
        );
      })}
      <div className="ei-fb-add-row">
        <input className="ei-input ei-fb-input" type="text" value={draft}
          placeholder="Add selector (CSS or /xpath)…"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => e.key === "Enter" && addDraft()}
          style={{ "--accent": accentColor }} />
        <button className="ei-fb-add-btn" onClick={addDraft} style={{ color: accentColor, borderColor: accentColor }}>+</button>
      </div>
    </div>
  );
}

function KeyValueEditor({ value, onChange, accentColor }) {
  const entries = Object.entries(value);
  const setEntry = (i, k, v) => { const next = [...entries]; next[i] = [k, v]; onChange(Object.fromEntries(next)); };
  const addEntry = () => onChange({ ...value, "": "" });
  const removeEntry = (i) => onChange(Object.fromEntries(entries.filter((_, idx) => idx !== i)));
  return (
    <div className="ei-kv">
      {entries.map(([k, v], i) => (
        <div key={i} className="ei-kv-row">
          <input className="ei-input ei-kv-input" placeholder="field name" value={k} onChange={e => setEntry(i, e.target.value, v)} />
          <span className="ei-kv-arrow">→</span>
          <input className="ei-input ei-kv-input" placeholder="child selector" value={v} onChange={e => setEntry(i, k, e.target.value)} />
          <button className="ei-kv-remove" onClick={() => removeEntry(i)} title="Remove">×</button>
        </div>
      ))}
      <button className="ei-kv-add" onClick={addEntry} style={{ color: accentColor }}>+ Add field</button>
    </div>
  );
}

// ─── Icons ────────────────────────────────────────────────────────────────

function PlusIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
}
function CheckIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20,6 9,17 4,12"/></svg>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function buildDefaultParams(def) {
  const params = {};
  for (const [key, input] of Object.entries(def.inputs || {})) {
    params[key] = input.default !== undefined ? input.default : (input.type === "array" ? [] : "");
  }
  return params;
}

function buildDefaultAdvanced(def) {
  const advanced = {};
  for (const [key, adv] of Object.entries(def.advanced || {})) {
    if (adv.default !== undefined) advanced[key] = adv.default;
  }
  return advanced;
}