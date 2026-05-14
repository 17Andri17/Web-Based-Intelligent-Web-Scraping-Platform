import { useState, useCallback, useEffect } from "react";

// ─── Step metadata ───────────────────────────────────────────────────────────

const CAT_COLORS = {
  Navigation:   { bg:"#1d3a5f", text:"#58a6ff" },
  Interaction:  { bg:"#1d3a2e", text:"#3fb950" },
  Extraction:   { bg:"#2a1f4e", text:"#a371f7" },
  Flow:         { bg:"#3d2a1a", text:"#d29922" },
};

const TYPE_META = {
  NAVIGATE:            { cat:"Navigation",  short:"NAV" },
  GO_BACK:             { cat:"Navigation",  short:"BCK" },
  RELOAD_PAGE:         { cat:"Navigation",  short:"RLD" },
  CLICK_ELEMENT:       { cat:"Interaction", short:"CLK" },
  HOVER_ELEMENT:       { cat:"Interaction", short:"HVR" },
  TYPE_TEXT:           { cat:"Interaction", short:"TYP" },
  CLEAR_INPUT:         { cat:"Interaction", short:"CLR" },
  PRESS_KEY:           { cat:"Interaction", short:"KEY" },
  SCROLL_TO_ELEMENT:   { cat:"Interaction", short:"SCR" },
  SCROLL_PAGE:         { cat:"Interaction", short:"SCR" },
  EXTRACT_TEXT:        { cat:"Extraction",  short:"TXT" },
  EXTRACT_ATTRIBUTE:   { cat:"Extraction",  short:"ATR" },
  EXTRACT_HTML:        { cat:"Extraction",  short:"HTM" },
  EXTRACT_TABLE:       { cat:"Extraction",  short:"TBL" },
  EXTRACT_LIST:        { cat:"Extraction",  short:"LST" },
  EXTRACT_JSON:        { cat:"Extraction",  short:"JSN" },
  WAIT:                { cat:"Flow",        short:"WIT" },
  WAIT_FOR_SELECTOR:   { cat:"Flow",        short:"WFS" },
  FOR_EACH_ELEMENTS:   { cat:"Flow",        short:"FOR" },
  FOR_EACH:            { cat:"Flow",        short:"FOR" },
  IF_ELEMENT_EXISTS:   { cat:"Flow",        short:"IF"  },
  CONDITION:           { cat:"Flow",        short:"IF"  },
  REPEAT:              { cat:"Flow",        short:"RPT" },
  WHILE:               { cat:"Flow",        short:"WHL" },
};

const HAS_SELECTOR = new Set([
  "CLICK_ELEMENT","HOVER_ELEMENT","SCROLL_TO_ELEMENT","WAIT_FOR_SELECTOR",
  "EXTRACT_TEXT","EXTRACT_ATTRIBUTE","EXTRACT_HTML","EXTRACT_TABLE","EXTRACT_LIST","EXTRACT_JSON",
  "FOR_EACH_ELEMENTS","FOR_EACH","IF_ELEMENT_EXISTS","CLEAR_INPUT","TYPE_TEXT",
]);
const LOOP_TYPES = new Set(["FOR_EACH_ELEMENTS","FOR_EACH","REPEAT","WHILE","CONDITION","IF_ELEMENT_EXISTS"]);
const BRANCH_KEYS = ["body","then","else","try","catch"];

function getMeta(type) {
  const m = TYPE_META[type] || { cat:"Flow", short:(type||"???").slice(0,3) };
  return { ...m, color: CAT_COLORS[m.cat] || CAT_COLORS.Flow };
}

// ─── Flatten steps with forEach context awareness ────────────────────────────
//
// Each emitted item also carries `containerSelector` — the selector of the
// closest enclosing loop (FOR_EACH_ELEMENTS, etc.). The hover handler needs
// this so a child step with selector ':scope' or '.price' resolves to the
// right elements on the page (loop iterator + relative selector).

function flattenSteps(steps, depth=0, path=[], forEachCtxStepId=null, parentLoopId=null, parentLoopSelector="") {
  const out = [];
  (steps||[]).forEach((step, i) => {
    if (typeof step !== "object" || !step) return;
    out.push({
      step, depth, path: [...path, i],
      inActiveLoop: !!forEachCtxStepId && parentLoopId === forEachCtxStepId,
      isActiveLoop: step.id === forEachCtxStepId,
      containerSelector: parentLoopSelector,
    });
    const isLoop = LOOP_TYPES.has(step.type);
    const childLoopSelector = isLoop
      ? (step.params?.selector || step.params?.containerSelector || parentLoopSelector)
      : parentLoopSelector;
    for (const key of BRANCH_KEYS) {
      if (Array.isArray(step[key]) && step[key].length > 0) {
        out.push(...flattenSteps(
          step[key], depth + 1, [...path, i, key],
          forEachCtxStepId,
          isLoop ? step.id : parentLoopId,
          childLoopSelector,
        ));
      }
    }
  });
  return out;
}

// Join a child step's selector with its enclosing loop's iterator selector.
//
//   loop = "a.popular-exam-link", child = ":scope"        → "a.popular-exam-link"
//   loop = "a.popular-exam-link", child = ":scope img"    → "a.popular-exam-link img"
//   loop = "div.card",           child = ".price"         → "div.card .price"
//   loop = "div.card",           child = ""               → "div.card"
//   loop = "",                   child = ".price"         → ".price"
function composeScopedSelector(loopSel, childSel) {
  const child = (childSel || "").trim();
  const loop  = (loopSel  || "").trim();
  if (!loop) {
    // No enclosing loop. A bare `:scope` is useless outside a loop —
    // skip the hover. Anything else passes through as-is.
    return child === ":scope" ? "" : child;
  }
  if (!child || child === ":scope") return loop;
  // Replace a leading :scope (with or without combinator) with the loop sel.
  if (/^:scope\b/.test(child)) {
    return child.replace(/^:scope\s*/, loop + " ").replace(/\s+/g, " ").trim();
  }
  return `${loop} ${child}`;
}

// ─── Inline input ────────────────────────────────────────────────────────────

function InlineInput({ value, placeholder, mono, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");
  useEffect(() => { if (!editing) setDraft(value || ""); }, [value, editing]);
  const commit = () => { setEditing(false); onSave(draft.trim()); };
  const onKey  = e => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(value||""); setEditing(false); } };
  if (editing) return (
    <input
      className={`cws-input ${mono ? "cws-input--mono" : ""}`}
      value={draft} placeholder={placeholder}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit} onKeyDown={onKey} autoFocus
    />
  );
  return (
    <button className={`cws-val ${mono ? "cws-val--mono" : ""}`} onClick={() => setEditing(true)} title={value||placeholder}>
      {value || <span className="cws-placeholder">{placeholder}</span>}
    </button>
  );
}

// ─── Step editor ─────────────────────────────────────────────────────────────

function StepEditor({ step, reselectStepId, onUpdateParams, onUpdateLabel, onReselect, onCancelReselect }) {
  const selector  = step.params?.selector || step.params?.containerSelector || "";
  const attribute = step.params?.attribute || "";
  const multiple  = !!step.params?.multiple;
  const isReselectingMe = reselectStepId === step.id;

  const saveSelector = (val) => {
    const key = step.params?.containerSelector !== undefined ? "containerSelector" : "selector";
    onUpdateParams(step.id, { [key]: val });
  };

  return (
    <div className="cws-editor">
      <div className="cws-field">
        <label className="cws-label">Name</label>
        <InlineInput value={step.label||""} placeholder="Name this step…" onSave={v=>onUpdateLabel(step.id,v)} />
      </div>

      {HAS_SELECTOR.has(step.type) && (
        <div className="cws-field">
          <label className="cws-label">Selector</label>
          {isReselectingMe ? (
            <div className="cws-reselect-active">
              <span className="cws-pulse"/>
              <span>Click element in browser…</span>
              <button className="cws-cancel-btn" onClick={onCancelReselect}>Cancel</button>
            </div>
          ) : (
            <div className="cws-sel-row">
              <InlineInput value={selector} placeholder="CSS / XPath selector" mono onSave={saveSelector} />
              <button className="cws-reselect-btn" onClick={() => onReselect(step.id, LOOP_TYPES.has(step.type))} title="Pick element to update selector">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                </svg>
              </button>
            </div>
          )}
        </div>
      )}

      {step.type === "EXTRACT_ATTRIBUTE" && (
        <div className="cws-field">
          <label className="cws-label">Attribute</label>
          <InlineInput value={attribute} placeholder="href, src, data-id…" onSave={v=>onUpdateParams(step.id,{attribute:v})} />
        </div>
      )}

      {step.type?.startsWith("EXTRACT_") && step.type !== "EXTRACT_JSON" && (
        <label className="cws-checkbox-row">
          <input type="checkbox" checked={multiple} onChange={e=>onUpdateParams(step.id,{multiple:e.target.checked})} />
          Extract all matching elements
        </label>
      )}

      {step.type === "NAVIGATE" && (
        <div className="cws-field">
          <label className="cws-label">URL</label>
          <InlineInput value={step.params?.url||""} placeholder="https://…" onSave={v=>onUpdateParams(step.id,{url:v})} />
        </div>
      )}

      {step.type === "TYPE_TEXT" && (
        <div className="cws-field">
          <label className="cws-label">Text</label>
          <InlineInput value={step.params?.text||""} placeholder="Text to type…" onSave={v=>onUpdateParams(step.id,{text:v})} />
        </div>
      )}
    </div>
  );
}

// ─── Step card ───────────────────────────────────────────────────────────────

function StepCard({ item, isSelected, reselectStepId, onToggle, onHover, onLeave, onReselect, onCancelReselect, onUpdateParams, onUpdateLabel }) {
  const { step, depth, inActiveLoop, isActiveLoop, containerSelector } = item;
  const meta = getMeta(step.type);
  const ownSelector = step.params?.selector || step.params?.containerSelector || "";
  // Resolve to a selector that the page can actually query: a child of a
  // ForEach loop usually has ":scope" or a relative selector that's only
  // meaningful relative to the loop iterator.
  const hoverSelector = composeScopedSelector(containerSelector, ownSelector);
  const displayName = step.label || step.params?.url || step.type?.replace(/_/g," ").toLowerCase() || "step";

  return (
    <div
      className={[
        "cws-step",
        isSelected     ? "cws-step--selected"  : "",
        isActiveLoop   ? "cws-step--active-loop": "",
        inActiveLoop   ? "cws-step--in-loop"    : "",
      ].filter(Boolean).join(" ")}
      style={{ paddingLeft: 10 + depth * 14 }}
      onMouseEnter={() => hoverSelector && onHover(hoverSelector)}
      onMouseLeave={onLeave}
    >
      <div className="cws-step-row" onClick={onToggle}>
        {/* Indent bar — highlighted when inside active forEach */}
        {depth > 0 && (
          <span className={`cws-indent-bar ${inActiveLoop ? "cws-indent-bar--active" : ""}`}/>
        )}

        {/* Type badge */}
        <span className="cws-badge" style={{background:meta.color.bg, color:meta.color.text}}>
          {meta.short}
        </span>

        <div className="cws-step-info">
          <span className="cws-step-name">{displayName.length>26 ? displayName.slice(0,26)+"…":displayName}</span>
          {ownSelector && !isSelected && (
            <span className="cws-step-sel">{ownSelector.length>30 ? ownSelector.slice(0,30)+"…":ownSelector}</span>
          )}
        </div>

        {/* Re-select icon (on hover) */}
        {HAS_SELECTOR.has(step.type) && (
          <button
            className="cws-pick-btn"
            title="Pick new element"
            onClick={e=>{ e.stopPropagation(); onReselect(step.id, LOOP_TYPES.has(step.type)); }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
          </button>
        )}

        <svg className={`cws-chevron ${isSelected?"open":""}`} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="6,9 12,15 18,9"/>
        </svg>
      </div>

      {isSelected && (
        <StepEditor
          step={step}
          reselectStepId={reselectStepId}
          onUpdateParams={onUpdateParams}
          onUpdateLabel={onUpdateLabel}
          onReselect={onReselect}
          onCancelReselect={onCancelReselect}
        />
      )}
    </div>
  );
}

// ─── Insert target indicator (thin accent line) ──────────────────────────────

function InsertLine({ stepId, type, active, onSet }) {
  return (
    <div
      className={`cws-insert-zone ${active ? "cws-insert-zone--active" : ""}`}
      onClick={() => onSet(active ? null : { type, stepId })}
      title={active ? "Clear — remove insert point" : type === 'inside' ? "Insert inside this loop" : "Insert after this step"}
    >
      <div className="cws-insert-line-inner" />
      {active && <span className="cws-insert-dot"/>}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CompactWorkflowSidebar({
  steps, forEachCtx,
  reselectStepId, onReselect, onCancelReselect,
  onHighlight, onClearHighlight,
  onUpdateParams, onUpdateLabel,
  insertTarget, onSetInsertTarget, onMoveStep,
}) {
  const [selectedId, setSelectedId] = useState(null);
  const forEachCtxStepId = forEachCtx?.stepId || null;
  const flat = flattenSteps(steps, 0, [], forEachCtxStepId, null);

  const handleHover = useCallback((sel) => { if (sel) onHighlight(sel); }, [onHighlight]);
  const handleLeave = useCallback(() => { onClearHighlight(); }, [onClearHighlight]);

  const isTargetActive = (stepId, type) =>
    insertTarget && insertTarget.stepId === stepId && insertTarget.type === type;

  const isRootEnd = insertTarget?.type === 'root_end' || (!insertTarget && true); // default

  return (
    <div className="cws-content">
      {/* ForEach context banner */}
      {forEachCtxStepId && (
        <div className="cws-foreach-banner">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="17,1 21,5 17,9"/>
            <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
            <polyline points="7,23 3,19 7,15"/>
            <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
          </svg>
          ForEach mode — steps added inside loop
        </div>
      )}

      {/* Re-select banner */}
      {reselectStepId && (
        <div className="cws-reselect-banner">
          <span className="cws-pulse"/>
          Click element in browser to update selector
          <button className="cws-cancel-btn" onClick={onCancelReselect}>Cancel</button>
        </div>
      )}

      {/* Insert target status */}
      {insertTarget && (
        <div className="cws-target-banner">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="9,18 15,12 9,6"/>
          </svg>
          {insertTarget.type === 'root_end'
            ? "Adding to end of workflow"
            : insertTarget.type === 'inside'
            ? "Adding inside selected loop"
            : "Adding after selected step"}
          <button className="cws-cancel-btn" onClick={() => onSetInsertTarget(null)}>
            Clear
          </button>
        </div>
      )}

      {flat.length === 0 ? (
        <div className="cws-empty">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
            <polyline points="22,12 18,12 15,21 9,3 6,12 2,12"/>
          </svg>
          <p>No steps yet</p>
        </div>
      ) : (
        <div className="cws-list">
          {flat.map((item, idx) => {
            const { step, depth, inActiveLoop, isActiveLoop, containerSelector } = item;
            const meta = getMeta(step.type);
            const ownSelector  = step.params?.selector || step.params?.containerSelector || "";
            const hoverSelector = composeScopedSelector(containerSelector, ownSelector);
            const displayName = step.label || step.params?.url || step.type?.replace(/_/g," ").toLowerCase() || "step";
            const isLoop = LOOP_TYPES.has(step.type);
            const isSelected = selectedId === step.id;
            const isReselectingMe = reselectStepId === step.id;

            // Find the flat item's container path for move buttons
            const prevItem = flat[idx - 1];
            const canMoveInto = prevItem && LOOP_TYPES.has(prevItem.step.type); // prev sibling is a loop
            const canMoveOut  = depth > 0;

            return (
              <div key={step.id}>
                {/* Insert AFTER previous step line */}
                <InsertLine
                  stepId={step.id}
                  type="after"
                  active={isTargetActive(step.id, 'after')}
                  label="Insert after this step"
                  onSet={onSetInsertTarget}
                />

                <div
                  className={[
                    "cws-step",
                    isSelected ? "cws-step--selected" : "",
                    isActiveLoop ? "cws-step--active-loop" : "",
                    inActiveLoop ? "cws-step--in-loop" : "",
                  ].filter(Boolean).join(" ")}
                  style={{ paddingLeft: 10 + depth * 14 }}
                  onMouseEnter={() => hoverSelector && handleHover(hoverSelector)}
                  onMouseLeave={handleLeave}
                >
                  <div className="cws-step-row" onClick={() => setSelectedId(p => p === step.id ? null : step.id)}>
                    {depth > 0 && (
                      <span className={`cws-indent-bar ${inActiveLoop ? "cws-indent-bar--active" : ""}`}/>
                    )}
                    <span className="cws-badge" style={{background:meta.color.bg, color:meta.color.text}}>
                      {meta.short}
                    </span>
                    <div className="cws-step-info">
                      <span className="cws-step-name">{displayName.length>26 ? displayName.slice(0,26)+"…":displayName}</span>
                      {ownSelector && !isSelected && (
                        <span className="cws-step-sel">{ownSelector.length>30 ? ownSelector.slice(0,30)+"…":ownSelector}</span>
                      )}
                    </div>
                    {HAS_SELECTOR.has(step.type) && (
                      <button
                        className="cws-pick-btn"
                        title="Pick new element"
                        onClick={e=>{ e.stopPropagation(); onReselect(step.id, LOOP_TYPES.has(step.type)); }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                        </svg>
                      </button>
                    )}
                    <svg className={`cws-chevron ${isSelected?"open":""}`} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="6,9 12,15 18,9"/>
                    </svg>
                  </div>

                  {/* Insert INSIDE this loop */}
                  {isLoop && (
                    <InsertLine
                      stepId={step.id}
                      type="inside"
                      active={isTargetActive(step.id, 'inside')}
                      label="Insert inside this loop"
                      onSet={onSetInsertTarget}
                    />
                  )}

                  {isSelected && (
                    <StepEditor
                      step={step}
                      reselectStepId={reselectStepId}
                      onUpdateParams={onUpdateParams}
                      onUpdateLabel={onUpdateLabel}
                      onReselect={onReselect}
                      onCancelReselect={onCancelReselect}
                    />
                  )}
                </div>
              </div>
            );
          })}

          {/* Root end insert target */}
          <InsertLine
            stepId="__root_end__"
            type="root_end"
            active={insertTarget?.type === 'root_end'}
            label="Insert at end of workflow"
            onSet={onSetInsertTarget}
          />
        </div>
      )}
    </div>
  );
}