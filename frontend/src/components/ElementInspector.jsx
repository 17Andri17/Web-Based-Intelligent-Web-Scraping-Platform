import { useState, useRef, useEffect } from "react";
import { actionDefinitions } from "../actions/actionDefinitions";
import { createAction, createControl } from "../workflow/stepFactory";
import { CONTROL_TYPES } from "../workflow/controlDefinitions";

// Human-readable label for the detection strategy sent from SelectorTool
function strategyLabel(strategy) {
  if (!strategy) return '';
  const tier = /^tier-(\d+)-of-(\d+)$/.exec(strategy);
  if (tier) return `⬡ scope ${tier[1]}/${tier[2]}`;
  if (strategy === 'structural') return '⚭ siblings';
  if (strategy.startsWith('A')) return '⚭ siblings';
  if (strategy.startsWith('B')) return '⬡ ancestor-relative';
  if (strategy.startsWith('C')) return '▣ ancestor-cards';
  if (strategy.startsWith('D')) return '◎ global-class';
  return strategy;
}

// ─── Action catalogue ──────────────────────────────────────────────────────
//
// What's shown here is a deliberately slimmed-down set focused on web
// scraping. Older / niche actions are still defined in actionDefinitions.js
// and execute correctly in saved workflows — they're just hidden from the
// inspector to keep the choice surface friendly for non-technical users.
//
// Removed from the inspector (still supported in workflows):
//   HOVER_ELEMENT       → uncommon, can be replaced by a CLICK
//   CLEAR_INPUT         → TYPE_TEXT already has a "Clear first" option
//   PRESS_KEY           → TYPE_TEXT already has "Press Enter"; for other
//                          keys, advanced workflows can still hand-add it
//   SCROLL_TO_ELEMENT   → actions auto-wait for the selector (codegen
//                          handles scroll-into-view inside waitForAny)
//   UPLOAD_FILE         → niche
//   RELOAD_PAGE         → niche
//   OPEN_NEW_TAB / SWITCH_TAB → multi-tab flows are confusing and rarely
//                          needed for scraping; we keep them runnable but
//                          out of the menu
//   WAIT_FOR_SELECTOR   → every selector-based action already waits for
//                          the selector (advanced.timeout). WAIT covers
//                          the "no-element delay" case.
//   WAIT_FOR_NAVIGATION → folded into CLICK_ELEMENT's "Wait for navigation"
//   CONDITION           → use the IF control block instead
//   LOOP                → use the For-Each control block instead
//   EXTRACT_JSON        → advanced (still selectable from existing workflows)
//   SET_VARIABLE etc.   → replaced by the Workflow Variables panel
//   SAVE_DATA           → runs auto-persist to the run history now

const CATEGORIES = [
  {
    id: "interaction", label: "Interaction", color: "#3fb950",
    actions: [
      { type: "CLICK_ELEMENT",    needsEl: true,  quickAdd: true,
        smartDefault: (el) => ({ selector: el.selector, selectorType: el.selectorType || "css", fallbackSelectors: el.fallbackSelectors || [] }) },
      { type: "DISMISS_COOKIE_BANNER", needsEl: false,
        smartDefault: (el) => el
          ? { selector: el.selector, selectorType: el.selectorType || "css", fallbackSelectors: el.fallbackSelectors || [] }
          : { selector: "", selectorType: "css", fallbackSelectors: [] } },
      { type: "TYPE_TEXT",        needsEl: true,
        smartDefault: (el) => ({ selector: el.selector, selectorType: el.selectorType || "css", fallbackSelectors: el.fallbackSelectors || [], clearFirst: true, pressEnter: false }),
        showWhen: (el) => el.isInput },
      { type: "SCROLL_PAGE",      needsEl: false, smartDefault: () => ({ direction: "down", amount: 500 }) },
    ],
  },
  {
    id: "extraction", label: "Extraction", color: "#58a6ff",
    actions: [
      { type: "EXTRACT_TEXT",      needsEl: true, quickAdd: true,
        smartDefault: (el) => ({ selector: el.selector, selectorType: el.selectorType || "css", fallbackSelectors: el.fallbackSelectors || [], multiple: false }) },
      { type: "EXTRACT_ATTRIBUTE", needsEl: true,
        smartDefault: (el) => ({ selector: el.selector, selectorType: el.selectorType || "css", fallbackSelectors: el.fallbackSelectors || [], attribute: el.href ? "href" : el.src ? "src" : "", multiple: false }),
        showWhen: (el) => el.isLink || el.isImg || el.href || el.src },
      { type: "EXTRACT_HTML",      needsEl: true,
        smartDefault: (el) => ({ selector: el.selector, selectorType: el.selectorType || "css", fallbackSelectors: el.fallbackSelectors || [], mode: "inner" }) },
      { type: "EXTRACT_TABLE",     needsEl: true, quickAdd: true,
        smartDefault: (el) => ({
          selector:          el.tableSelector?.value     || el.selector,
          selectorType:      el.tableSelector?.type      || el.selectorType || "css",
          fallbackSelectors: el.tableSelector?.fallbacks || el.fallbackSelectors || [],
          hasHeader: true,
        }),
        showWhen: (el) => el.isTable },
      { type: "EXTRACT_LIST",      needsEl: true,
        smartDefault: (el) => ({
          containerSelector: el.softSelector || el.selector,
          selectorType: el.selectorType || "css",
          fallbackSelectors: el.softSelector
            ? (el.softFallbacks || [])
            : (el.fallbackSelectors || []),
        }) },
    ],
  },
  {
    id: "navigation", label: "Navigation", color: "#d29922",
    actions: [
      { type: "NAVIGATE",          needsEl: false, smartDefault: () => ({ url: "" }) },
      { type: "GO_BACK",           needsEl: false, smartDefault: () => ({}), quickAdd: true },
    ],
  },
  {
    id: "flow", label: "Flow", color: "#a371f7",
    actions: [
      { type: "WAIT",              needsEl: false, smartDefault: () => ({ duration: 1000 }), quickAdd: true },
      { type: "BREAK_LOOP",        needsEl: false, smartDefault: () => ({}), quickAdd: true },
    ],
  },
];

// ─── Action icons ──────────────────────────────────────────────────────────
// Monochrome stroke icons (colored via currentColor by the category accent)
// instead of the old emoji set, so the action cards match the rest of the
// app's iconography.
const ACTION_ICON_PATHS = {
  CLICK_ELEMENT:         <><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13 13l6 6"/></>,
  DISMISS_COOKIE_BANNER: <><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><path d="M8.5 8.5v.01"/><path d="M16 15.5v.01"/><path d="M12 13v.01"/></>,
  TYPE_TEXT:             <><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></>,
  SCROLL_PAGE:           <><polyline points="8 18 12 22 16 18"/><polyline points="8 6 12 2 16 6"/><line x1="12" y1="2" x2="12" y2="22"/></>,
  EXTRACT_TEXT:          <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></>,
  EXTRACT_ATTRIBUTE:     <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></>,
  EXTRACT_HTML:          <><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></>,
  EXTRACT_TABLE:         <><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="12" y1="3" x2="12" y2="21"/></>,
  EXTRACT_LIST:          <><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></>,
  EXTRACT_JSON:          <><path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/></>,
  NAVIGATE:              <><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></>,
  GO_BACK:               <><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></>,
  WAIT:                  <><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></>,
  BREAK_LOOP:            <><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></>,
  DEFAULT:               <><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></>,
};

export function ActionIcon({ type, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ACTION_ICON_PATHS[type] || ACTION_ICON_PATHS.DEFAULT}
    </svg>
  );
}

// Multi-selection: only the two actions that genuinely apply to a SET of
// elements — iterate over them (For-Each loop), or extract structured
// fields from each one (Extract List). Single-element interactions like
// Click / Hover / Type are deliberately hidden because they don't make
// sense for N elements at once.
// (Other extraction types are reachable by clicking a single element.)

// ─── Small shared widgets ──────────────────────────────────────────────────

// Copy-to-clipboard icon button with a brief "copied" check flash.
function CopyButton({ text, title = "Copy selector" }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      className={`ei-copy-btn ${copied ? "copied" : ""}`}
      title={title}
      onClick={() => {
        try { navigator.clipboard.writeText(text); } catch (_) {}
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20,6 9,17 4,12"/></svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
      )}
    </button>
  );
}

// Collapsed-by-default disclosure for fallback selectors. They're a safety
// net, not something to study on every selection — so they only take up a
// single toggle line until the user actually asks for them.
function FallbackDisclosure({ count, emptyLabel = null, children }) {
  const [open, setOpen] = useState(false);
  if (!count && !emptyLabel) return null;
  return (
    <div className="ei-fallbacks">
      <button
        type="button"
        className={`ei-fallbacks-toggle ${open ? "open" : ""}`}
        onClick={() => setOpen(v => !v)}
        title="Backup selectors — tried in order if the primary selector stops matching after a site change"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
        {count > 0 ? `${count} fallback selector${count !== 1 ? "s" : ""}` : emptyLabel}
      </button>
      {open && <div className="ei-fallbacks-body">{children}</div>}
    </div>
  );
}

// Read-only chip list for a set of fallback selectors.
function FallbackChipList({ selectors }) {
  return (
    <div className="ei-fallback-list">
      {(selectors || []).map((f, i) => {
        const s = typeof f === "string" ? { value: f, type: "css" } : f;
        return (
          <div key={i} className="ei-fallback-chip">
            <span className={`ei-sel-type-badge ${s.type || "css"}`}>{s.type === "xpath" ? "XP" : "CSS"}</span>
            <code className="ei-fallback-value" title={s.value}>{s.value}</code>
          </div>
        );
      })}
    </div>
  );
}

// Collapsible inspector section with a persisted open/closed state, so a
// user who prefers a leaner panel collapses it ONCE and it stays that way.
// The details are all still there — one click away — but the action cards
// (the reason the inspector exists) keep the prime real estate.
function Section({ id, title, badge, defaultOpen = true, children, dataTour }) {
  const storageKey = `ei.sec.${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(storageKey);
      return v === null ? defaultOpen : v === "1";
    } catch (_) { return defaultOpen; }
  });
  const toggle = () => setOpen(o => {
    try { localStorage.setItem(storageKey, o ? "0" : "1"); } catch (_) {}
    return !o;
  });
  return (
    <div className={`ei-section ${open ? "open" : ""}`} data-tour={dataTour}>
      <button type="button" className="ei-section-head" onClick={toggle}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0)", transition: "120ms" }}>
          <polyline points="9 18 15 12 9 6"/>
        </svg>
        <span className="ei-section-title">{title}</span>
        {badge != null && <span className="ei-section-badge">{badge}</span>}
      </button>
      {open && <div className="ei-section-body">{children}</div>}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────

export default function ElementInspector({
  element, childrenList, forEachCtx,
  onClose, onAddStep,
  onSelectAncestor, onGetChildren, onSelectChild,
  onHoverPickerChild, onHoverAncestor, onUnhoverPickerChild,
  onClearForEachCtx,
  socket, onUpdateParams, onUpdateLabel,
  onAiExtractList,
  onStartManualAdd, onStopManualAdd, onApplyManualSelector, manualSelResult,
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
        onAiExtractList={onAiExtractList}
        onStartManualAdd={onStartManualAdd}
        onStopManualAdd={onStopManualAdd}
        onApplyManualSelector={onApplyManualSelector}
        manualSelResult={manualSelResult}
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
      onStartManualAdd={onStartManualAdd}
    />
  );
}

// ─── Single element inspector ──────────────────────────────────────────────

function SingleInspector({ element, childrenList, forEachCtx, onClose, onAddStep, onSelectAncestor, onGetChildren, onSelectChild, onHoverPickerChild, onHoverAncestor, onUnhoverPickerChild, onClearForEachCtx, onStartManualAdd }) {
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
          {element.classes && <span className="ei-classes" title={element.classes}>{element.classes.slice(0, 50)}</span>}
        </div>
        <button className="ei-close" onClick={onClose} title="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      {/* Whole panel scrolls; the actions come first so they're always in
          reach, with the selector / structure / content details tucked below. */}
      <div className="ei-body">
        {/* ── Subtle hint when similar elements are soft-highlighted ──────── */}
        {element.softHighlightCount > 0 && (
          <div className="ei-similar-hint">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            {(() => {
              const tiers   = element.tierSummary || [];
              const nearest = tiers[0];
              if (nearest) {
                const name = (nearest.label || "").replace(/\s*\(\d+\)\s*$/, "");
                return (
                  <>
                    Click the amber {element.softHighlightCount === 1 ? "item" : "items"} to select{" "}
                    <strong>{name}</strong> ({nearest.count}).
                  </>
                );
              }
              return <>Click an amber item to select all {element.softHighlightCount} similar elements.</>;
            })()}
          </div>
        )}

        {/* ── Category tabs ─────────────────────────────────────────────── */}
        <div className="ei-tabs">
          {CATEGORIES.map(c => (
            <button key={c.id}
              data-tour={c.id === "extraction" ? "cat-extraction" : undefined}
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
                data-tour={actionMeta.type === "EXTRACT_TEXT" ? "capture-text" : undefined}
                className={`ei-action-card ${isSelected ? "selected" : ""} ${isFlashing ? "flash" : ""}`}
                style={isSelected ? { borderColor: cat.color } : {}}
                onClick={() => setSelectedAction(actionMeta)}>
                <div className="ei-action-icon" style={{ color: cat.color }}>
                  <ActionIcon type={actionMeta.type} />
                </div>
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

        {/* ── Add more elements (secondary) ──────────────────────────────── */}
        {onStartManualAdd && (
          <button className="ei-manual-add-entry" onClick={onStartManualAdd}
            title="Click elements anywhere on the page to build a custom selection — the app finds the tightest selector covering them all">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Select multiple elements manually
          </button>
        )}

        {/* ── Details — collapsed, below the actions ─────────────────────── */}
        {element.selector && (
          <Section id="single-selector" title="Selector & fallbacks" defaultOpen={false}>
            <div className="ei-single-sel-code">
              <span className={`ei-sel-type-badge ${element.selectorType === "xpath" ? "xpath" : "css"}`}>
                {element.selectorType === "xpath" ? "XP" : "CSS"}
              </span>
              <code title={element.selector}>{element.selector}</code>
              {element.isRelativeToScope && (
                <span className="ei-relative-badge" title="Relative to the ForEach iterator — works for every iterated element">relative</span>
              )}
              <CopyButton text={element.selector} />
            </div>
            {(element.fallbackSelectors || []).length > 0 && (
              <FallbackDisclosure count={element.fallbackSelectors.length}>
                <FallbackChipList selectors={element.fallbackSelectors} />
              </FallbackDisclosure>
            )}
          </Section>
        )}

        {element.breadcrumb?.length > 0 && (
          <Section id="structure" title="Page structure" badge={element.breadcrumb.length} defaultOpen={false} dataTour="page-structure">
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
          </Section>
        )}

        {(element.text || element.href || element.src) && (
          <Section id="content" title="Content preview" defaultOpen={false}>
            <div className="ei-preview">
              {element.text && <div className="ei-preview-text">"{element.text}"</div>}
              {element.href && <div className="ei-preview-attr"><span className="ei-attr-name">href</span> {element.href}</div>}
              {element.src  && <div className="ei-preview-attr"><span className="ei-attr-name">src</span> {element.src}</div>}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

// ─── Multi-element inspector ───────────────────────────────────────────────

function MultiInspector({ selection, forEachCtx, onClose, onAddStep, onClearForEachCtx, onAiExtractList,
                          onStartManualAdd, onStopManualAdd, onApplyManualSelector, manualSelResult }) {
  // For multi-selection only two actions make sense:
  //   1. Add a ForEach loop that iterates over the matched elements
  //   2. Add an Extract List step that pulls structured fields out of each
  //      element — optionally with an AI prompt that auto-populates the
  //      field mappings on add.
  //
  // Adding an Extract List (either way) immediately opens the step's editor
  // in the workflow sidebar — which unmounts this inspector — so the AI
  // request itself is owned by the AppShell (onAiExtractList): the fields
  // land on the step and show up in the open editor whenever the answer
  // arrives.
  const [addedFlash, setAddedFlash]       = useState(null);     // 'FOREACH'
  const [aiMode, setAiMode]               = useState(false);    // is the AI prompt panel open?
  const [aiHint, setAiHint]               = useState("");
  const [aiError, setAiError]             = useState(null);

  const handleAddForEach = () => {
    const control = createControl(CONTROL_TYPES.FOR_EACH_ELEMENTS, {
      selector: selection.commonSelector,
      fallbackSelectors: selection.fallbackSelectors || [],
      itemVar: "el",
      indexVar: "i",
    });
    control.previewElements = selection.elements || [];
    onAddStep(control, { isForEach: true });
    setAddedFlash("FOREACH");
    setTimeout(() => setAddedFlash(null), 800);
  };

  const buildExtractListStep = () => {
    const def = actionDefinitions.EXTRACT_LIST;
    const params = {
      ...buildDefaultParams(def),
      containerSelector: selection.commonSelector,
      selectorType: "css",
      fallbackSelectors: selection.fallbackSelectors || [],
      fields: {},
    };
    const step = createAction("EXTRACT_LIST", params, buildDefaultAdvanced(def));
    step.previewValue    = `${selection.matchCount} list items`;
    step.previewSelector = selection.commonSelector || "";
    return step;
  };

  const handleAddExtractList = () => {
    const step = buildExtractListStep();
    onAddStep(step);   // opens the step's editor in the workflow sidebar
  };

  const handleAddExtractListWithAI = () => {
    setAiError(null);
    if (!selection.commonSelector) {
      setAiError("No selector available for this selection.");
      return;
    }
    // Create the step first so its editor can open in the sidebar, then hand
    // the AI request to the AppShell — it outlives this inspector.
    const step = buildExtractListStep();
    onAddStep(step);
    onAiExtractList?.(step.id, selection.commonSelector, aiHint);
  };

  return (
    <div className="ei-panel ei-multi-panel">
      {/* ── ForEach context banner ──────────────────────────────────────── */}
      {forEachCtx && <ForEachContextBanner forEachCtx={forEachCtx} onClear={onClearForEachCtx} />}

      {/* ── Header (sticky) ────────────────────────────────────────────── */}
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

      {/* Whole panel scrolls — content is ordered by importance so the
          primary actions sit at the very top and never get pushed off. */}
      <div className="ei-body">
        {/* Active manual-add stays pinned above everything while picking, so
            the live count + Done are always in reach. */}
        {selection.manualAdd && onStartManualAdd && (
          <ManualAddPanel selection={selection} onStart={onStartManualAdd} onStop={onStopManualAdd} />
        )}

        {/* ── 1. ACTIONS (the whole point — kept first) ──────────────────── */}
        {!forEachCtx && (
          <div className="ei-foreach-banner">
            <div className="ei-foreach-banner-text">
              <span className="ei-foreach-icon">∀</span>
              <div>
                <div className="ei-foreach-title">For-Each Loop</div>
                <div className="ei-foreach-desc">Run steps on each of the {selection.matchCount} elements.</div>
              </div>
            </div>
            <button
              className={`ei-foreach-btn ${addedFlash === "FOREACH" ? "flash" : ""}`}
              onClick={handleAddForEach}>
              {addedFlash === "FOREACH" ? <><CheckIcon /> Added!</> : <><PlusIcon /> Add Loop</>}
            </button>
          </div>
        )}

        <div className="ei-extract-list-card">
          <div className="ei-extract-list-header">
            <span className="ei-extract-list-icon"><ActionIcon type="EXTRACT_LIST" size={17} /></span>
            <div className="ei-extract-list-text">
              <div className="ei-extract-list-title">Extract List</div>
              <div className="ei-extract-list-desc">Pull fields (text, links…) from every item.</div>
            </div>
          </div>

          {!aiMode && (
            <div className="ei-extract-list-actions">
              <button className="ei-foreach-btn" onClick={handleAddExtractList}>
                <PlusIcon /> Add &amp; pick fields
              </button>
              <button
                data-tour="use-ai"
                className="ei-extract-list-ai-btn"
                onClick={() => setAiMode(true)}
                title="Add with AI-detected fields">
                ✨ Use AI…
              </button>
            </div>
          )}

          {aiMode && (
            <div className="ei-extract-list-ai">
              <textarea
                rows={3}
                value={aiHint}
                placeholder={'What to extract — e.g. "title, price, image URL and link".'}
                onChange={e => setAiHint(e.target.value)}
              />
              <div className="ei-extract-list-ai-actions">
                <button data-tour="add-ai" className="ei-foreach-btn" onClick={handleAddExtractListWithAI}>
                  ✨ Add with AI
                </button>
                <button
                  className="ei-extract-list-cancel"
                  onClick={() => { setAiMode(false); setAiError(null); }}>
                  Cancel
                </button>
              </div>
              {aiError && <div className="ei-extract-list-ai-error">{aiError}</div>}
            </div>
          )}
        </div>

        {/* ── 2. Add more elements (manual multi-add entry) ──────────────── */}
        {!selection.manualAdd && onStartManualAdd && (
          <ManualAddPanel selection={selection} onStart={onStartManualAdd} onStop={onStopManualAdd} />
        )}

        {/* Tier widening hint — compact, only while an automatic tier flow is
            live (not during manual add). */}
        {!selection.manualAdd && typeof selection.tierCount === "number" && selection.tierCount > 1 && (
          <div className="ei-tier-progress">
            <div className="ei-tier-progress-head">
              <span className="ei-tier-progress-title">⬡ Scope</span>
              <span className="ei-tier-progress-step">
                {(selection.tierIndex ?? 0) + 1}/{selection.tierCount}
              </span>
            </div>
            <div className="ei-tier-progress-bar">
              {Array.from({ length: selection.tierCount }).map((_, i) => (
                <div key={i} className={`ei-tier-progress-seg ${i <= (selection.tierIndex ?? 0) ? "filled" : ""}`} />
              ))}
            </div>
            {selection.nextTier ? (
              <div className="ei-tier-progress-next">
                Click an <strong>amber</strong> item to widen (+{selection.nextTier.added}), or a green one to stop.
              </div>
            ) : (
              <div className="ei-tier-progress-done">Widest scope — every match on the page.</div>
            )}
          </div>
        )}

        {/* ── 3. Selector & details (collapsed, at the bottom) ───────────── */}
        <div className="ei-multi-selector-block">
          <Section id="multisel" title="Selector & fallbacks" defaultOpen={false}>
            <div className="ei-multi-selector-header">
              <span className="ei-multi-selector-label">Selector</span>
              {selection.strategy && (
                <span className="ei-multi-strategy-badge" title={`Detection strategy: ${selection.strategy}`}>
                  {strategyLabel(selection.strategy)}
                </span>
              )}
              <CopyButton text={selection.commonSelector} />
            </div>
            {selection.commonSelector ? (
              <code className="ei-multi-selector-code">{selection.commonSelector}</code>
            ) : (
              <span className="ei-multi-selector-empty">No selector generated — elements selected by position</span>
            )}
            <FallbackDisclosure count={(selection.fallbackSelectors || []).length}>
              <FallbackChipList selectors={selection.fallbackSelectors} />
            </FallbackDisclosure>

            {/* Power-user selector editor — last resort, behind its own toggle. */}
            {onApplyManualSelector && (
              <ManualSelectorEditor
                selection={selection}
                onApply={onApplyManualSelector}
                result={manualSelResult}
              />
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

// ─── Manual multi-add panel ────────────────────────────────────────────────
//
// The "select more similar elements yourself" escape hatch. The automatic
// tier ladder only widens within one similarity basis (a shared class, a
// structural twin set); this lets the user click any elements on the page —
// across classes/sections — and the backend derives the tightest comma-free
// selector covering them all. Rarely needed, but the release valve when the
// automatic grouping can't express the exact set.

function ManualAddPanel({ selection, onStart, onStop }) {
  const active = !!selection.manualAdd;
  if (active) {
    const n = selection.sampleCount ?? 0;
    return (
      <div className="ei-manual-add active">
        <div className="ei-manual-add-head">
          <span className="ei-manual-add-dot" />
          <span className="ei-manual-add-title">Manual selection active</span>
          <button className="ei-manual-add-done" onClick={onStop}>Done</button>
        </div>
        <div className="ei-manual-add-body">
          Click elements on the page to add them — click a blue one again to remove it.
          <div className="ei-manual-add-stats">
            <span className="ei-manual-add-picks">{n} picked</span>
            <span className="ei-manual-add-sep">·</span>
            <span className="ei-manual-add-matches">matches {selection.matchCount}</span>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="ei-manual-add">
      <div className="ei-manual-add-pitch">
        <div className="ei-manual-add-pitch-title">Not the right group?</div>
        <div className="ei-manual-add-pitch-desc">
          Hand-pick elements across colours or sections — the tightest selector is built for you.
        </div>
      </div>
      <button className="ei-manual-add-start" onClick={onStart}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Add elements manually
      </button>
    </div>
  );
}

// ─── Manual selector editor (power user) ───────────────────────────────────
//
// A deliberate last resort for technical users: pick the primary or any
// fallback as a starting point, edit the raw selector, and apply it — the
// backend highlights the new match set on the page and regenerates fresh
// fallbacks for it. Behind its own disclosure so it never crowds the
// point-and-click flow the rest of the panel is built around.

function ManualSelectorEditor({ selection, onApply, result }) {
  const [open, setOpen]   = useState(false);
  const [value, setValue] = useState(selection.commonSelector || "");
  const [type,  setType]  = useState(selection.selectorType === "xpath" ? "xpath" : "css");
  // Which known selector the text box was last seeded from (so switching the
  // dropdown reloads it, but hand-edits are preserved until then).
  const [source, setSource] = useState("primary");

  // Build the choose-a-starting-point options: primary + each fallback.
  const options = [
    { key: "primary", label: "Primary", value: selection.commonSelector || "", type: selection.selectorType || "css" },
    ...(selection.fallbackSelectors || []).map((f, i) => {
      const s = typeof f === "string" ? { value: f, type: "css" } : f;
      return { key: `fb${i}`, label: `Fallback ${i + 1}`, value: s.value, type: s.type || "css" };
    }),
  ];

  // Re-seed the editor whenever the underlying selection changes (e.g. after an
  // apply regenerates fallbacks, or a new group is selected).
  useEffect(() => {
    setValue(selection.commonSelector || "");
    setType(selection.selectorType === "xpath" ? "xpath" : "css");
    setSource("primary");
  }, [selection.commonSelector]);

  const loadOption = (key) => {
    const opt = options.find(o => o.key === key);
    if (!opt) return;
    setSource(key);
    setValue(opt.value);
    setType(opt.type === "xpath" ? "xpath" : "css");
  };

  const apply = () => {
    const v = value.trim();
    if (!v) return;
    // Auto-detect XPath so the user doesn't have to touch the type toggle.
    const looksXPath = /^\s*(\.?\/\/|\.?\/|\()/.test(v);
    onApply(v, looksXPath ? "xpath" : type);
  };

  const dirty = value.trim() !== (selection.commonSelector || "").trim();

  return (
    <div className="ei-seladjust">
      <button
        type="button"
        className={`ei-seladjust-toggle ${open ? "open" : ""}`}
        onClick={() => setOpen(o => !o)}
        title="Advanced: hand-edit the selector and regenerate its fallbacks"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
        Adjust selector manually
      </button>
      {open && (
        <div className="ei-seladjust-body">
          <div className="ei-seladjust-hint">
            Last-resort control for technical users. Edit the selector and apply —
            the page re-highlights the matches and fresh fallbacks are generated.
          </div>

          {options.length > 1 && (
            <label className="ei-seladjust-field">
              <span className="ei-seladjust-label">Start from</span>
              <select className="ei-select" value={source} onChange={e => loadOption(e.target.value)}>
                {options.map(o => (
                  <option key={o.key} value={o.key}>{o.label} — {o.value.slice(0, 48)}</option>
                ))}
              </select>
            </label>
          )}

          <label className="ei-seladjust-field">
            <span className="ei-seladjust-label">Selector</span>
            <textarea
              className="ei-seladjust-input"
              rows={2}
              value={value}
              spellCheck={false}
              placeholder="CSS selector, or an /xpath expression"
              onChange={e => setValue(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) apply(); }}
            />
          </label>

          <div className="ei-seladjust-actions">
            <div className="ei-seladjust-type">
              <button type="button" className={type === "css" ? "on" : ""} onClick={() => setType("css")}>CSS</button>
              <button type="button" className={type === "xpath" ? "on" : ""} onClick={() => setType("xpath")}>XPath</button>
            </div>
            <button className="ei-seladjust-apply" onClick={apply} disabled={!value.trim()}>
              Apply &amp; regenerate fallbacks
            </button>
          </div>

          {result && (
            <div className={`ei-seladjust-result ${result.ok ? "ok" : "err"}`}>
              {result.ok
                ? <>✓ Applied — matches <strong>{result.matchCount}</strong> element{result.matchCount !== 1 ? "s" : ""}{result.fallbacks?.length ? `, ${result.fallbacks.length} fallback${result.fallbacks.length !== 1 ? "s" : ""} regenerated` : ""}.</>
                : <>✕ {result.error || "Invalid selector"}</>}
            </div>
          )}
          {dirty && !result && (
            <div className="ei-seladjust-dirty">Unapplied edits — click Apply to test them on the page.</div>
          )}
        </div>
      )}
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

  // All hooks run before the `!def` bail-out below — a hook that only runs on
  // some renders changes the hook count and makes React throw "Rendered more
  // hooks than during the previous render", which unmounts the whole app.
  // The lazy initialisers keep buildDefaultParams/Advanced off the hot path
  // and safe to call when `def` is missing (they run only on first render).
  const smartDefaults = actionMeta.smartDefault ? actionMeta.smartDefault(element) : {};
  const [params,   setParams]   = useState(() => (def ? { ...buildDefaultParams(def), ...smartDefaults } : {}));
  const [advanced, setAdvanced] = useState(() => (def ? buildDefaultAdvanced(def) : {}));
  const [added,    setAdded]    = useState(false);
  const [showAdv,  setShowAdv]  = useState(false);

  if (!def) return null;

  const setParam = (k, v) => setParams(p => ({ ...p, [k]: v }));
  const setAdv   = (k, v) => setAdvanced(a => ({ ...a, [k]: v }));

  const handleAdd = () => {
    onAdd(params, advanced);
    setAdded(true);
    setTimeout(() => setAdded(false), 1000);
  };

  const hasAdvanced = def.advanced && Object.keys(def.advanced).length > 0;

  return (
    <div className="ei-configurator">
      <div className="ei-config-header">
        <span className="ei-config-icon" style={{ color: accentColor }}>
          <ActionIcon type={actionMeta.type} size={15} />
        </span>
        <span className="ei-config-title">{def.label}</span>
        {def.description && <span className="ei-config-desc">{def.description}</span>}
      </div>

      {actionMeta.needsEl && element?.selector && (
        <div className="ei-config-selector-block">
          <div className="ei-config-selector">
            <span className={`ei-sel-type-badge ${element.selectorType || "css"}`}>
              {element.selectorType === "xpath" ? "XP" : "CSS"}
            </span>
            <code title={params.selector || element.selector}>{params.selector || element.selector}</code>
            <CopyButton text={params.selector || element.selector} />
          </div>
        </div>
      )}

      <div className="ei-config-fields">
        {Object.entries(def.inputs || {}).map(([key, inputDef]) => {
          if (key === "selector" || key === "selectorType" || key === "containerSelector") return null;
          if (inputDef.type === "hidden") return null;
          if (key === "fallbackSelectors") {
            // Tucked behind a disclosure — the fallbacks are a safety net
            // that would otherwise crowd out the fields the user actually
            // came here to fill in.
            const count = (params[key] || []).length;
            return (
              <FallbackDisclosure key={key} count={count} emptyLabel="Add fallback selectors…">
                <InlineSelectorListEditor value={params[key] || []} onChange={v => setParam(key, v)} accentColor={accentColor} />
              </FallbackDisclosure>
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

      <button data-tour="add-step" className="ei-add-btn" style={{ background: added ? "#3fb950" : accentColor }} onClick={handleAdd}>
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