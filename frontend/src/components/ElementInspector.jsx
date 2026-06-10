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
      { type: "CLICK_ELEMENT",    icon: "▶", needsEl: true,  quickAdd: true,
        smartDefault: (el) => ({ selector: el.selector, selectorType: el.selectorType || "css", fallbackSelectors: el.fallbackSelectors || [] }) },
      { type: "TYPE_TEXT",        icon: "✏️", needsEl: true,
        smartDefault: (el) => ({ selector: el.selector, selectorType: el.selectorType || "css", fallbackSelectors: el.fallbackSelectors || [], clearFirst: true, pressEnter: false }),
        showWhen: (el) => el.isInput },
      { type: "SCROLL_PAGE",      icon: "📜", needsEl: false, smartDefault: () => ({ direction: "down", amount: 500 }) },
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
        smartDefault: (el) => ({
          selector:          el.tableSelector?.value     || el.selector,
          selectorType:      el.tableSelector?.type      || el.selectorType || "css",
          fallbackSelectors: el.tableSelector?.fallbacks || el.fallbackSelectors || [],
          hasHeader: true,
        }),
        showWhen: (el) => el.isTable },
      { type: "EXTRACT_LIST",      icon: "📑", needsEl: true,
        smartDefault: (el) => ({ containerSelector: el.selector, selectorType: el.selectorType || "css", fallbackSelectors: el.fallbackSelectors || [] }) },
    ],
  },
  {
    id: "navigation", label: "Navigation", color: "#d29922",
    actions: [
      { type: "NAVIGATE",          icon: "🌐", needsEl: false, smartDefault: () => ({ url: "" }) },
      { type: "GO_BACK",           icon: "◀",  needsEl: false, smartDefault: () => ({}), quickAdd: true },
    ],
  },
  {
    id: "flow", label: "Flow", color: "#a371f7",
    actions: [
      { type: "WAIT",              icon: "⏱️", needsEl: false, smartDefault: () => ({ duration: 1000 }), quickAdd: true },
      { type: "BREAK_LOOP",        icon: "⛔", needsEl: false, smartDefault: () => ({}), quickAdd: true },
    ],
  },
];

// Multi-selection: only the two actions that genuinely apply to a SET of
// elements — iterate over them (For-Each loop), or extract structured
// fields from each one (Extract List). Single-element interactions like
// Click / Hover / Type are deliberately hidden because they don't make
// sense for N elements at once.
// (Other extraction types are reachable by clicking a single element.)

// ─── Main component ────────────────────────────────────────────────────────

export default function ElementInspector({
  element, childrenList, forEachCtx,
  onClose, onAddStep,
  onSelectAncestor, onGetChildren, onSelectChild,
  onHoverPickerChild, onHoverAncestor, onUnhoverPickerChild,
  onClearForEachCtx,
  socket, onUpdateParams,
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
        socket={socket}
        onUpdateParams={onUpdateParams}
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
          {(() => {
            const tiers   = element.tierSummary || [];
            const nearest = tiers[0];
            if (nearest) {
              const name = (nearest.label || "").replace(/\s*\(\d+\)\s*$/, "");
              const more = tiers.length > 1;
              return (
                <>
                  Click the amber {element.softHighlightCount === 1 ? "item" : "items"} to select{" "}
                  <strong>{name}</strong> ({nearest.count} element{nearest.count !== 1 ? "s" : ""})
                  {more ? " — then keep clicking amber to widen the scope step by step" : ""}.
                </>
              );
            }
            return (
              <>
                {element.softHighlightCount} similar element{element.softHighlightCount !== 1 ? "s" : ""} highlighted in amber — click one to select all of them
              </>
            );
          })()}
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

function MultiInspector({ selection, forEachCtx, onClose, onAddStep, onClearForEachCtx, socket, onUpdateParams }) {
  // For multi-selection only two actions make sense:
  //   1. Add a ForEach loop that iterates over the matched elements
  //   2. Add an Extract List step that pulls structured fields out of each
  //      element — optionally with an AI prompt that auto-populates the
  //      field mappings on add.
  const [addedFlash, setAddedFlash]       = useState(null);     // 'FOREACH' | 'EXTRACT_LIST' | 'EXTRACT_LIST_AI'
  const [aiMode, setAiMode]               = useState(false);    // is the AI prompt panel open?
  const [aiHint, setAiHint]               = useState("");
  const [aiBusy, setAiBusy]               = useState(false);
  const [aiError, setAiError]             = useState(null);
  // Track the ID we asked the AI to fill so we ignore stale responses
  // (e.g. user adds two AI-Extract steps back to back).
  const pendingRef = useRef(null);

  // Subscribe to the AI response once. Each request carries a unique
  // requestId so we know which step's params to patch when the answer
  // returns. The inspector may have been closed in the meantime — that's
  // fine, we still hold a reference to onUpdateParams.
  useEffect(() => {
    if (!socket) return;
    const onResult = (payload) => {
      const pending = pendingRef.current;
      if (!pending || payload.requestId !== pending.requestId) return;
      pendingRef.current = null;
      setAiBusy(false);

      if (!payload.ok) {
        setAiError(formatAiError(payload));
        return;
      }

      // Convert the verified array [{name, selector, kind, attribute}] into
      // the params.fields object shape expected by the editor + codegen.
      // An empty selector is VALID — it means "use the container element
      // itself" (e.g. for an anchor container, exam_url has selector="" and
      // attribute="href"). Only drop entries that lack a name or a usable
      // selector string (we keep "" but reject undefined/null).
      const fieldsObj = {};
      for (const f of payload.fields || []) {
        if (!f || !f.name) continue;
        if (typeof f.selector !== "string") continue;
        const kind = f.kind === "attr" || f.kind === "html" ? f.kind : "text";
        // For attribute-kind, we still need an attribute name
        if (kind === "attr" && !f.attribute) continue;
        fieldsObj[f.name] = {
          selector: f.selector,
          kind,
          attribute: kind === "attr" ? f.attribute : null,
        };
      }

      if (Object.keys(fieldsObj).length === 0) {
        setAiError("The AI didn't return any usable fields. Add some manually from the step's editor.");
        return;
      }

      onUpdateParams?.(pending.stepId, { fields: fieldsObj });
      setAiError(null);
      setAiHint("");
      setAiMode(false);
      // Surface useful provenance: heuristic-only / mixed / pure AI. This
      // helps the user understand that "✨ Added!" might mean the AI
      // failed and we fell back to the built-in detector.
      const source = payload.source || 'ai';
      const flash =
        source === 'heuristic' ? 'EXTRACT_LIST_HEUR_DONE' :
        source === 'mixed'     ? 'EXTRACT_LIST_MIX_DONE'  :
                                 'EXTRACT_LIST_AI_DONE';
      setAddedFlash(flash);
      setTimeout(() => setAddedFlash(null), 1600);
    };
    socket.on("aiExtractListFieldsResult", onResult);
    return () => socket.off("aiExtractListFieldsResult", onResult);
  }, [socket, onUpdateParams]);

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
    onAddStep(step);
    setAddedFlash("EXTRACT_LIST");
    setTimeout(() => setAddedFlash(null), 800);
  };

  const handleAddExtractListWithAI = () => {
    setAiError(null);
    if (!socket) {
      setAiError("Not connected to the backend.");
      return;
    }
    if (!selection.commonSelector) {
      setAiError("No selector available for this selection.");
      return;
    }
    // Create the step first so the user sees it in the workflow and the
    // editor can land on it. The fields will fill in when the AI answers.
    const step = buildExtractListStep();
    onAddStep(step);

    const requestId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    pendingRef.current = { requestId, stepId: step.id };
    setAiBusy(true);
    socket.emit("aiExtractListFields", {
      containerSelector: selection.commonSelector,
      selectorType: "css",
      hint: aiHint,
      existingFields: {},
      requestId,
    });
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

      {/* ── Hierarchical similarity-scope progress ─────────────────────────── */}
      {typeof selection.tierCount === "number" && selection.tierCount > 1 && (
        <div className="ei-tier-progress" style={{
          margin: "0 12px 10px", padding: "10px 12px",
          background: "rgba(210,153,34,0.06)", border: "1px solid rgba(210,153,34,0.25)",
          borderRadius: 8, fontSize: 12,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <span style={{ color: "#d29922", fontWeight: 600 }}>⬡ Similarity scope</span>
            <span style={{ marginLeft: "auto", color: "#8b949e" }}>
              step {(selection.tierIndex ?? 0) + 1} of {selection.tierCount}
            </span>
          </div>
          <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
            {Array.from({ length: selection.tierCount }).map((_, i) => (
              <div key={i} style={{
                flex: 1, height: 4, borderRadius: 2,
                background: i <= (selection.tierIndex ?? 0) ? "#3fb950" : "rgba(255,255,255,0.12)",
              }} />
            ))}
          </div>
          <div style={{ color: "#c9d1d9" }}>
            Currently selecting{" "}
            <strong style={{ color: "#3fb950" }}>{selection.tierLabel || `${selection.matchCount} elements`}</strong>.
          </div>
          {selection.nextTier ? (
            <div style={{ marginTop: 6, color: "#d29922" }}>
              ➕ Click any <strong>amber</strong> element on the page to widen to{" "}
              <strong>{selection.nextTier.label}</strong> (+{selection.nextTier.added}), or click a
              green item to stop here.
            </div>
          ) : (
            <div style={{ marginTop: 6, color: "#8b949e" }}>
              Widest scope reached — this is every matching element on the page.
            </div>
          )}
        </div>
      )}

      {/* ── Fallback selectors (robustness after DOM changes) ──────────────── */}
      {(selection.fallbackSelectors || []).length > 0 && (
        <div style={{ margin: "0 12px 10px", fontSize: 11, color: "#8b949e" }}>
          <div style={{ marginBottom: 4 }}>
            Fallback selectors ({selection.fallbackSelectors.length}) — tried in order if the primary breaks:
          </div>
          {selection.fallbackSelectors.slice(0, 3).map((f, i) => (
            <code key={i} style={{
              display: "block", padding: "3px 6px", marginBottom: 3,
              background: "rgba(255,255,255,0.04)", borderRadius: 4,
              color: "#79c0ff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{typeof f === "string" ? f : f.value}</code>
          ))}
        </div>
      )}

      <div className="ei-body">
        <div className="ei-multi-notice">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          For a set of elements there are two useful actions — pick one below.
        </div>

        {/* ── 1. For-Each loop ───────────────────────────────────────────── */}
        {!forEachCtx && (
          <div className="ei-foreach-banner">
            <div className="ei-foreach-banner-text">
              <span className="ei-foreach-icon">∀</span>
              <div>
                <div className="ei-foreach-title">Add as For-Each Loop</div>
                <div className="ei-foreach-desc">Run a series of steps inside every one of {selection.matchCount} matched elements.</div>
              </div>
            </div>
            <button
              className={`ei-foreach-btn ${addedFlash === "FOREACH" ? "flash" : ""}`}
              onClick={handleAddForEach}>
              {addedFlash === "FOREACH" ? <><CheckIcon /> Added!</> : <><PlusIcon /> Add Loop</>}
            </button>
          </div>
        )}

        {/* ── 2. Extract List (with / without AI) ────────────────────────── */}
        <div className={`ei-extract-list-card ${["EXTRACT_LIST", "EXTRACT_LIST_AI_DONE", "EXTRACT_LIST_HEUR_DONE", "EXTRACT_LIST_MIX_DONE"].includes(addedFlash) ? "flash" : ""}`}>
          <div className="ei-extract-list-header">
            <span className="ei-extract-list-icon">📑</span>
            <div className="ei-extract-list-text">
              <div className="ei-extract-list-title">Add as Extract List</div>
              <div className="ei-extract-list-desc">
                Pull structured fields (text or attributes) out of each item. Add it now and configure fields later, or let the AI propose them from a sample.
              </div>
            </div>
          </div>

          {/* Action buttons */}
          {!aiMode && (
            <div className="ei-extract-list-actions">
              <button
                className="ei-foreach-btn"
                onClick={handleAddExtractList}
                disabled={aiBusy}>
                {addedFlash === "EXTRACT_LIST" ? <><CheckIcon /> Added!</> : <><PlusIcon /> Add (configure later)</>}
              </button>
              <button
                className="ei-extract-list-ai-btn"
                onClick={() => setAiMode(true)}
                disabled={aiBusy}
                title="Open AI prompt and add with auto-detected fields">
                ✨ Add with AI prompt…
              </button>
            </div>
          )}

          {/* AI prompt panel */}
          {aiMode && (
            <div className="ei-extract-list-ai">
              <textarea
                rows={3}
                value={aiHint}
                placeholder={'Describe what to extract — e.g. "product title, price, image URL and link. Ignore the rating stars."'}
                onChange={e => setAiHint(e.target.value)}
                disabled={aiBusy}
              />
              <div className="ei-extract-list-ai-actions">
                <button
                  className="ei-foreach-btn"
                  onClick={handleAddExtractListWithAI}
                  disabled={aiBusy}>
                  {aiBusy
                    ? "Analysing…"
                    : addedFlash === "EXTRACT_LIST_AI_DONE"   ? <><CheckIcon /> Fields added!</>
                    : addedFlash === "EXTRACT_LIST_MIX_DONE"  ? <><CheckIcon /> AI + heuristics added!</>
                    : addedFlash === "EXTRACT_LIST_HEUR_DONE" ? <><CheckIcon /> Fallback fields added!</>
                    : <>✨ Add with AI</>}
                </button>
                <button
                  className="ei-extract-list-cancel"
                  onClick={() => { setAiMode(false); setAiError(null); }}
                  disabled={aiBusy}>
                  Cancel
                </button>
              </div>
              {aiError && <div className="ei-extract-list-ai-error">{aiError}</div>}
              {!aiError && aiBusy && (
                <div className="ei-extract-list-ai-busy">
                  Analysing a sample item and verifying selectors on the live page…
                </div>
              )}
              {!aiError && !aiBusy && (
                <div className="ei-extract-list-ai-hint">
                  AI proposes field mappings (text or attribute). Every selector is verified live before being added — you can edit them in the step's editor afterwards.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── AI error → friendly message ──────────────────────────────────────────
function formatAiError(payload) {
  if (!payload) return "Unknown AI error";
  const code = payload.code || "";
  switch (code) {
    case "NO_API_KEY":   return "AI is not configured on the server (set LLM_API_KEY). Add fields manually from the step's editor.";
    case "NO_PAGE":      return "No active browser page — navigate to the target URL first.";
    case "NO_SAMPLE":    return payload.error || "No matching element on the live page.";
    case "BAD_JSON":
    case "BAD_FIELDS":   return "The AI didn't return a usable suggestion. Add fields manually or try a more specific hint.";
    case "LLM_FAIL":
    default:             return payload.error || `AI request failed (${code || "unknown"}).`;
  }
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