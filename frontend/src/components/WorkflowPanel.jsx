import { useState, useCallback, useContext } from "react";
import React from "react";
import { actionDefinitions } from "../actions/actionDefinitions";
import { controlDefinitions, isControlStep } from "../workflow/controlDefinitions";
import { createAction, createControl } from "../workflow/stepFactory";
import { DndContext, DragOverlay, useDroppable, useDraggable, closestCenter } from "@dnd-kit/core";
import { findStepLocation } from "../workflow/useWorkflow";

// Context shared across all step components (avoids prop drilling)
const WPCtx = React.createContext(null);

// Custom collision: only fire on dz: drop zones; pick nearest by center distance
function dzCollision(args) {
  const dzOnly = args.droppableContainers.filter(c => String(c.id).startsWith('dz:'));
  if (!dzOnly.length) return [];
  return closestCenter({ ...args, droppableContainers: dzOnly });
}

const EXTRACTION_TYPES = new Set([
  "EXTRACT_TEXT", "EXTRACT_ATTRIBUTE", "EXTRACT_HTML",
  "EXTRACT_TABLE", "EXTRACT_LIST", "EXTRACT_JSON",
]);

/* ── Icons ── */
function DragDotsIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>; }
function ChevronIcon({ open }) { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transform: open ? "rotate(0)" : "rotate(-90deg)", transition: "200ms" }}><polyline points="6,9 12,15 18,9"/></svg>; }
function EditIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>; }
function TrashIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>; }
function PlusIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>; }
function ActionIcon({ type }) {
  const map = {
    NAVIGATE: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
    CLICK_ELEMENT: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13 13l6 6"/></svg>,
    EXTRACT_TEXT: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
    TYPE_TEXT: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4,7 4,4 20,4 20,7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>,
    WAIT: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>,
    SAVE_DATA: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17,21 17,13 7,13 7,21"/><polyline points="7,3 7,8 15,8"/></svg>,
    SET_VARIABLE: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>,
  };
  return map[type] || <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>;
}

/* ── Helpers ── */
function buildDefaultParams(def) {
  const p = {};
  for (const [k, v] of Object.entries(def.inputs || {})) {
    if (v.default !== undefined) { p[k] = v.default; continue; }
    if (v.type === "array" || v.type === "selectorList") { p[k] = []; continue; }
    p[k] = "";
  }
  return p;
}
function buildDefaultAdvanced(def) {
  const a = {};
  for (const [k, v] of Object.entries(def.advanced || {})) if (v.default !== undefined) a[k] = v.default;
  return a;
}
function summariseParams(step) {
  const entries = Object.entries(step.params || {}).filter(([, v]) => v !== null && v !== "" && v !== undefined && !(Array.isArray(v) && !v.length));
  return entries.slice(0, 2).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]);
}
function buildControlSummary(step, def) {
  const key = Object.keys(def.params || {})[0];
  if (!key) return null;
  const val = step.params?.[key];
  if (!val && val !== 0) return null;
  const s = String(val);
  return s.slice(0, 56) + (s.length > 56 ? "…" : "");
}

/* Build a CUSTOM_ACTION workflow step from a user's custom action definition.
   The step references the action by id and stores user-supplied input values;
   the backend resolves the latest code at execution time. */
function buildCustomActionStep(action) {
  const inputs = {};
  (action.inputs || []).forEach(inp => {
    inputs[inp.name] =
      inp.type === "number"  ? 0 :
      inp.type === "boolean" ? false :
      inp.type === "json"    ? "{}" :
                                "";
  });
  return {
    id:       crypto.randomUUID(),
    kind:     'action',
    type:     'CUSTOM_ACTION',
    label:    action.name,
    params:   { actionId: action.id, inputs },
    advanced: {},
    outputVar: null,
  };
}

/* =====================================================================  MAIN PANEL */
export default function WorkflowPanel({ steps, totalCount, onAdd, onUpdate, onDelete, onReorder, setSteps, insertTarget, onSetInsertTarget, onMoveStep, customActions = [], offStartUrl = false, pinnedUrl = "", currentPageUrl = "", onReturnToStart }) {
  const [pickerCtx, setPickerCtx]   = useState(null);
  const [editingCtx, setEditingCtx] = useState(null);
  const [activeId,   setActiveId]   = useState(null);

  const handleDragEnd = useCallback(({ active, over }) => {
    setActiveId(null);
    if (!over) return;
    const activeStr = String(active.id);
    const overStr   = String(over.id);
    if (!overStr.startsWith('dz:')) return; // only InsertRow zones are valid drop targets
    const srcLoc = findStepLocation(steps, activeStr);
    if (!srcLoc) return;
    try {
      const { cp, idx } = JSON.parse(overStr.slice(3));
      // No-op: same container, adjacent position
      const sameContainer = JSON.stringify(srcLoc.containerPath) === JSON.stringify(cp);
      if (sameContainer && (idx === srcLoc.index || idx === srcLoc.index + 1)) return;
      if (sameContainer) {
        // Reorder within same list
        const targetIdx = idx > srcLoc.index ? idx - 1 : idx;
        onReorder(srcLoc.containerPath, srcLoc.index, targetIdx);
      } else {
        // Cross-level move
        onMoveStep && onMoveStep(activeStr, cp, idx !== null && idx !== undefined ? idx : undefined);
      }
    } catch(e) { console.error('DnD error', e); }
  }, [steps, onReorder, onMoveStep]);

  const flatAll = React.useMemo(() => {
    const out = [];
    function walk(arr) { (arr||[]).forEach(s => { out.push(s); ['body','then','else','try','catch'].forEach(k => { if(Array.isArray(s[k])) walk(s[k]); }); }); }
    walk(steps); return out;
  }, [steps]);
  const activeStep = activeId ? flatAll.find(s => s.id === activeId) : null;

  return (
    <WPCtx.Provider value={{ insertTarget, onSetInsertTarget, onMoveStep, activeId, customActions }}>
    <div className="workflow-designer">
      <div className="workflow-header">
        <div className="workflow-title">
          <h2>Flow Designer</h2>
          <span className="step-count">{totalCount} {totalCount === 1 ? "step" : "steps"}</span>
        </div>
        <div className="workflow-actions">
          <button className="header-btn secondary" onClick={() => setPickerCtx({ containerPath: [], index: null })}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Step
          </button>
        </div>
      </div>
      {offStartUrl && (
        <div className="wf-offstart-banner" title={`Steps added here will be recorded against the current page (${currentPageUrl}), but the workflow always starts from ${pinnedUrl}. Either return to the start URL or add a NAVIGATE step before these new actions.`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          </svg>
          <div className="wf-offstart-text">
            <strong>You're not on the workflow's start URL.</strong>
            <span>New steps will be recorded against <code>{currentPageUrl || "this page"}</code>, but the workflow starts from <code>{pinnedUrl}</code>.</span>
          </div>
          {onReturnToStart && (
            <button className="wf-offstart-btn" onClick={onReturnToStart}>Return to start</button>
          )}
        </div>
      )}
      <div className="workflow-canvas">
        <div className="flow-container">
          <div className="flow-start">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
            Start
          </div>
          <div className="flow-connector" />
          {steps.length === 0 ? (
            <div className="empty-state">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5"/>
                <path d="M2 12l10 5 10-5"/>
              </svg>
              <h3>No steps yet</h3>
              <p>Build your workflow — add action steps and control blocks below.</p>
              <button className="add-step-btn" onClick={() => setPickerCtx({ containerPath: [], index: null })}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                Add First Step
              </button>
            </div>
          ) : (
            <DndContext collisionDetection={dzCollision}
              onDragStart={({ active }) => setActiveId(String(active.id))}
              onDragEnd={handleDragEnd}
              onDragCancel={() => setActiveId(null)}
            >
              <StepList steps={steps} containerPath={[]} depth={0}
                onPickerOpen={setPickerCtx} onEditOpen={setEditingCtx}
                onDelete={onDelete} onReorder={onReorder} />
              {/* Bottom "Add Step" — a plain button, not a drop target; StepList already
                  renders an InsertRow after the last step for dropping */}
              {!activeId && (
                <>
                  <div className="flow-connector" />
                  <button className="add-step-btn" onClick={() => setPickerCtx({ containerPath: [], index: null })}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Add Step
                  </button>
                  <div className="flow-connector" />
                  <div className="flow-end">End</div>
                </>
              )}
              <DragOverlay dropAnimation={null}>
                {activeStep ? (
                  <div className="step-card drag-ghost" style={{opacity:0.85,pointerEvents:'none'}}>
                    <div className="step-card-header">
                      <div className="step-icon"><ActionIcon type={activeStep.type} /></div>
                      <div className="step-info">
                        <div className="step-label">{
                          activeStep.type === "CUSTOM_ACTION"
                            ? (customActions.find(a => a.id === activeStep.params?.actionId)?.name || activeStep.label || "Custom action")
                            : (actionDefinitions[activeStep.type]?.label || activeStep.type?.replace(/_/g,' '))
                        }</div>
                      </div>
                    </div>
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          )}
        </div>
      </div>

      {pickerCtx && (
        <StepPicker
          customActions={customActions}
          onSelect={(kind, type, extra) => {
            let step;
            if (kind === "control") {
              step = createControl(type);
            } else if (kind === "custom") {
              step = buildCustomActionStep(extra);
            } else {
              step = createAction(type, buildDefaultParams(actionDefinitions[type]), buildDefaultAdvanced(actionDefinitions[type]));
            }
            onAdd(step, pickerCtx.containerPath, pickerCtx.index);
            setPickerCtx(null);
            // Auto-point insert target inside any newly added loop
            const LOOP_TYPES = new Set(['FOR_EACH','FOR_EACH_ELEMENTS','WHILE','REPEAT']);
            if (kind === "control" && LOOP_TYPES.has(type)) {
              onSetInsertTarget && onSetInsertTarget({ type: 'inside', stepId: step.id });
            }
          }}
          onClose={() => setPickerCtx(null)}
        />
      )}

      {editingCtx && (
        <StepEditorModal
          step={editingCtx.step}
          customActions={customActions}
          onClose={() => setEditingCtx(null)}
          onSave={(updated) => { onUpdate(editingCtx.containerPath, editingCtx.index, updated); setEditingCtx(null); }}
        />
      )}
    </div>
    </WPCtx.Provider>
  );
}

/* ── InsertRow: + button normally; always-visible drop zone during drag ── */
function InsertRow({ containerPath, index, onPickerOpen, isEnd = false }) {
  const { activeId } = useContext(WPCtx) || {};
  const isDragging = !!activeId;
  const dzId = `dz:${JSON.stringify({ cp: containerPath, idx: index })}`;
  const { setNodeRef, isOver } = useDroppable({ id: dzId });

  if (isDragging) {
    return (
      <div ref={setNodeRef}
        className={`insert-drop-zone${isOver ? ' insert-drop-zone--over' : ''}`}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        <span>{isOver ? 'Drop here' : 'Insert here'}</span>
      </div>
    );
  }

  if (isEnd) {
    return (
      <button className="add-step-btn" onClick={() => onPickerOpen({ containerPath, index: null })}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Add Step
      </button>
    );
  }

  return (
    <div className="step-insert-row">
      <button className="insert-between-btn" title="Insert step here"
        onClick={() => onPickerOpen({ containerPath, index })}>
        <PlusIcon />
      </button>
    </div>
  );
}

/* ── StepList (recursive) ── */
function StepList({ steps, containerPath, depth = 0, onPickerOpen, onEditOpen, onDelete, onReorder }) {
  const { activeId } = useContext(WPCtx) || {};
  const isDragging = !!activeId;

  // Index of the dragged step within THIS container (-1 if from another container)
  const draggedIdx = isDragging ? steps.findIndex(s => s.id === activeId) : -1;

  // A drop zone at position `zoneIdx` is redundant ONLY if it's immediately
  // before the dragged step (Zone[idx] and Zone[idx-1] are visually adjacent).
  // Zone[draggedIdx+1] stays visible — dropping there returns the step to its original position.
  const isNoOp = (zoneIdx) => draggedIdx >= 0 && zoneIdx === draggedIdx;

  // Don't allow ANY insertion above a pinned step (currently only the root-level
  // pinned NAVIGATE qualifies). The pinned step must always be first.
  const isRoot = containerPath.length === 0;
  const blockedBefore = (zoneIdx) => isRoot && zoneIdx === 0 && steps[0]?.pinned;

  return (
    <div className="step-list">
      {/* Drop zone BEFORE first step */}
      {!isNoOp(0) && !blockedBefore(0) && (
        <InsertRow containerPath={containerPath} index={0} onPickerOpen={onPickerOpen} />
      )}

      {steps.map((step, index) => (
        <React.Fragment key={step.id}>
          {!isDragging && <div className="flow-connector" />}
          {isControlStep(step) ? (
            <DraggableControlBlock step={step} index={index} containerPath={containerPath} depth={depth}
              onPickerOpen={onPickerOpen} onEditOpen={onEditOpen} onDelete={onDelete} onReorder={onReorder} />
          ) : (
            <DraggableActionCard step={step} index={index} containerPath={containerPath} depth={depth}
              onEdit={() => onEditOpen({ containerPath, index, step })}
              onDelete={() => onDelete(containerPath, index)} />
          )}
          {/* Drop zone AFTER each step — hidden for the two positions adjacent to the dragged item */}
          {!isNoOp(index + 1) && (
            <InsertRow containerPath={containerPath} index={index + 1} onPickerOpen={onPickerOpen} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

/* ── Draggable wrappers — drag handle only, NO drop target on the card itself ── */
function DraggableActionCard({ step, index, containerPath, depth, onEdit, onDelete }) {
  // Pinned steps (the workflow's start NAVIGATE) are not draggable — short-circuit
  // useDraggable by disabling it. We still render the card so users can edit it.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: step.id, disabled: !!step.pinned });
  return (
    <div ref={setNodeRef} style={{ opacity: isDragging ? 0.25 : 1 }}>
      <ActionCard step={step} containerPath={containerPath} index={index} depth={depth}
        dragHandleProps={step.pinned ? null : { ...attributes, ...listeners }}
        onEdit={onEdit}
        onDelete={step.pinned ? null : onDelete} />
    </div>
  );
}
function DraggableControlBlock({ step, index, containerPath, depth, onPickerOpen, onEditOpen, onDelete, onReorder }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: step.id });
  return (
    <div ref={setNodeRef} style={{ opacity: isDragging ? 0.25 : 1 }}>
      <ControlBlock step={step} index={index} containerPath={containerPath} depth={depth}
        dragHandleProps={{ ...attributes, ...listeners }}
        onPickerOpen={onPickerOpen} onEditOpen={onEditOpen} onDelete={onDelete} onReorder={onReorder} />
    </div>
  );
}

/* ── ActionCard ── */
function ActionCard({ step, containerPath, index, depth, dragHandleProps, onEdit, onDelete }) {
  const wp  = useContext(WPCtx) || {};
  const { insertTarget, onSetInsertTarget, onMoveStep, customActions = [] } = wp;
  const isCustom = step.type === "CUSTOM_ACTION";
  const customDef = isCustom ? customActions.find(a => a.id === step.params?.actionId) : null;
  const def = isCustom
    ? (customDef
        ? { label: customDef.name, category: "Custom" }
        : { label: step.label || "Custom action (missing)", category: "Custom" })
    : actionDefinitions[step.type];
  if (!def) return null;
  const summary = summariseParams(step);
  const isTarget = insertTarget?.stepId === step.id && insertTarget?.type === 'after';
  const canMoveOut = depth > 0;

  return (
    <div className={`step-card ${isTarget ? "step-card--insert-target" : ""} ${step.pinned ? "step-card--pinned" : ""}`}>
      <div className="step-card-header">
        {step.pinned ? (
          <div className="step-pin-marker" title="Start URL — edit via the URL bar at the top">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
          </div>
        ) : (
          <div className="step-drag-handle" {...(dragHandleProps || {})}><DragDotsIcon /></div>
        )}
        <div className="step-icon"><ActionIcon type={step.type} /></div>
        <div className="step-info">
          <div className="step-label">{def.label}{step.pinned ? <span className="step-pin-tag"> · start URL</span> : null}</div>
          <div className="step-type">{def.category || "Action"}</div>
        </div>
        <div className="step-actions">
          {step.label && EXTRACTION_TYPES.has(step.type) && (
            <div className="step-label-badge" title="Named result — will appear in exported data">
              <span>◈</span> {step.label}
            </div>
          )}
          {onSetInsertTarget && (
            <button
              className={`step-action-btn ${isTarget ? "active" : ""}`}
              title={isTarget ? "Clear insert target" : "Insert next step after this"}
              onClick={() => onSetInsertTarget(isTarget ? null : { type: 'after', stepId: step.id })}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="9,18 15,12 9,6"/>
              </svg>
            </button>
          )}
          <button className="step-action-btn" onClick={onEdit} title="Edit"><EditIcon /></button>
          {onDelete && (
            <button className="step-action-btn delete" onClick={onDelete} title="Delete"><TrashIcon /></button>
          )}
        </div>
      </div>
      {(summary.length > 0 || step.label) && (
        <div className="step-card-body">
          {step.label && !EXTRACTION_TYPES.has(step.type) && (
            <div className="step-name-display">{step.label}</div>
          )}
          {summary.length > 0 && (
            <div className="step-params">
              {summary.map(([k, v]) => (
                <div key={k} className="step-param">
                  <span className="step-param-key">{k}:</span>
                  <span className="step-param-value">{v}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── ControlBlock ── */
function ControlBlock({ step, index, containerPath, depth, dragHandleProps, onPickerOpen, onEditOpen, onDelete, onReorder }) {
  const [collapsed, setCollapsed] = useState(false);
  const def = controlDefinitions[step.type];
  const wp  = useContext(WPCtx) || {};
  const { insertTarget, onSetInsertTarget, activeId } = wp;
  if (!def) return null;
  const summary = buildControlSummary(step, def);
  const isInsideTarget = insertTarget?.stepId === step.id && insertTarget?.type === 'inside';
  const isAfterTarget  = insertTarget?.stepId === step.id && insertTarget?.type === 'after';

  return (
    <div className={`control-block ${isAfterTarget ? "control-block--insert-target" : ""}`} style={{ "--ctrl-color": def.color, "--ctrl-bg": def.bgColor }}>
      <div className="control-block-header">
        <div className="step-drag-handle" {...(dragHandleProps || {})}><DragDotsIcon /></div>
        <div className="control-type-badge">{def.icon}</div>
        <div className="control-info">
          <span className="control-label">{def.label}{step.label ? ` — ${step.label}` : ""}</span>
          {summary && <code className="control-expr">{summary}</code>}
        </div>
        <div className="step-actions">
          {onSetInsertTarget && (
            <button
              className={`step-action-btn ${isInsideTarget ? "active" : ""}`}
              title={isInsideTarget ? "Clear — back to default insert" : "Add next steps INSIDE this loop"}
              onClick={() => onSetInsertTarget(isInsideTarget ? null : { type: 'inside', stepId: step.id })}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="9,18 15,12 9,6"/><line x1="4" y1="12" x2="9" y2="12"/>
              </svg>
            </button>
          )}
          {onSetInsertTarget && (
            <button
              className={`step-action-btn ${isAfterTarget ? "active" : ""}`}
              title={isAfterTarget ? "Clear insert target" : "Insert next step AFTER this block"}
              onClick={() => onSetInsertTarget(isAfterTarget ? null : { type: 'after', stepId: step.id })}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="9,18 15,12 9,6"/>
              </svg>
            </button>
          )}
          <button className="step-action-btn" onClick={() => onEditOpen({ containerPath, index, step })} title="Edit"><EditIcon /></button>
          <button className="step-action-btn delete" onClick={() => onDelete(containerPath, index)} title="Delete"><TrashIcon /></button>
          <button className="step-action-btn collapse-btn" onClick={() => setCollapsed(c => !c)} title={collapsed ? "Expand" : "Collapse"}>
            <ChevronIcon open={!collapsed} />
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="control-block-body">
          {def.branches.map((branch, bIdx) => {
            const branchSteps = step[branch.key] || [];
            const branchPath  = [...containerPath, index, branch.key];
            return (
              <div key={branch.key} className="control-branch">
                <div className="branch-label-row">
                  <div className="branch-label" style={{ color: def.color }}>{branch.label}</div>
                  <div className="branch-line" style={{ background: def.color }} />
                </div>
                <div className="branch-body">
                  {branchSteps.length === 0 ? (
                    <div className="branch-empty">
                      <span>{branch.emptyLabel}</span>
                      <InsertRow containerPath={branchPath} index={0} onPickerOpen={onPickerOpen} isEnd />
                    </div>
                  ) : (
                    <>
                      <StepList steps={branchSteps} containerPath={branchPath} depth={depth + 1}
                        onPickerOpen={onPickerOpen} onEditOpen={onEditOpen}
                        onDelete={onDelete} onReorder={onReorder} />
                      {/* "Add step" button shown only when NOT dragging —
                          StepList's own last InsertRow is the drop target during drag */}
                      {!activeId && (
                        <div style={{ display:"flex", justifyContent:"center", marginTop:8 }}>
                          <button className="branch-add-btn" style={{ color: def.color, borderColor: def.color }}
                            onClick={() => onPickerOpen({ containerPath: branchPath, index: null })}>
                            + Add step
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
                {bIdx < def.branches.length - 1 && <div className="branch-separator" />}
              </div>
            );
          })}
        </div>
      )}

      {collapsed && (
        <div className="control-collapsed-hint">
          {def.branches.map((b, i) => (
            <span key={b.key}>
              {i > 0 && <span style={{ color: "var(--text-muted)" }}> · </span>}
              <strong style={{ color: def.color }}>{b.label}</strong>{" "}
              {(step[b.key] || []).length} step{(step[b.key] || []).length !== 1 ? "s" : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Step Picker Modal ── */
function StepPicker({ onSelect, onClose, customActions = [] }) {
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("all");
  const q = search.toLowerCase();

  const actionGroups = {};
  Object.entries(actionDefinitions).forEach(([type, def]) => {
    if (!def) return;
    if (q && !def.label.toLowerCase().includes(q) && !(def.description || "").toLowerCase().includes(q)) return;
    const cat = def.category || "Other";
    if (!actionGroups[cat]) actionGroups[cat] = [];
    actionGroups[cat].push({ type, def });
  });

  const ctrlItems = Object.entries(controlDefinitions).filter(([, def]) =>
    !q || def.label.toLowerCase().includes(q) || (def.description || "").toLowerCase().includes(q)
  );

  const customItems = customActions.filter(a =>
    !q || a.name.toLowerCase().includes(q) || (a.description || "").toLowerCase().includes(q)
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content picker-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Add Step</h3>
          <button className="modal-close-btn" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div className="modal-search">
          <input placeholder="Search steps…" value={search} onChange={e => setSearch(e.target.value)} autoFocus />
        </div>
        <div className="picker-tabs">
          {[["all","All"],["control","⚙ Control Flow"],["action","▶ Actions"],["custom","✦ Custom"]].map(([id, label]) => (
            <button key={id} className={`picker-tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        <div className="modal-body">
          {(tab === "all" || tab === "custom") && customItems.length > 0 && (
            <div className="action-category">
              <div className="category-title">✦ Your custom actions</div>
              <div className="action-grid">
                {customItems.map(a => (
                  <div key={a.id} className="action-tile" onClick={() => onSelect("custom", "CUSTOM_ACTION", a)}>
                    <div className="action-tile-label">{a.name}</div>
                    <div className="action-tile-desc">{a.description || `${a.inputs.length} input${a.inputs.length !== 1 ? "s" : ""}`}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {tab === "custom" && customItems.length === 0 && (
            <div style={{ color: "var(--text-muted)", padding: "24px", textAlign: "center" }}>
              No custom actions yet — open <strong>Custom actions</strong> from the header to create one.
            </div>
          )}
          {(tab === "all" || tab === "control") && ctrlItems.length > 0 && (
            <div className="action-category">
              <div className="category-title">⚙ Control Flow</div>
              <div className="action-grid control-grid">
                {ctrlItems.map(([type, def]) => (
                  <div key={type} className="action-tile control-tile" style={{ "--tile-color": def.color }} onClick={() => onSelect("control", type)}>
                    <div className="control-tile-icon">{def.icon}</div>
                    <div className="action-tile-label">{def.label}</div>
                    <div className="action-tile-desc">{def.description}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {(tab === "all" || tab === "action") && Object.entries(actionGroups).map(([category, items]) => (
            <div key={category} className="action-category">
              <div className="category-title">{category}</div>
              <div className="action-grid">
                {items.map(({ type, def }) => (
                  <div key={type} className="action-tile" onClick={() => onSelect("action", type)}>
                    <div className="action-tile-label">{def.label}</div>
                    <div className="action-tile-desc">{def.description}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {ctrlItems.length === 0 && Object.keys(actionGroups).length === 0 && customItems.length === 0 && (
            <div style={{ color: "var(--text-muted)", padding: "24px", textAlign: "center" }}>No results for "{search}"</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Step Editor Modal ── */
function StepEditorModal({ step, onClose, onSave, customActions = [] }) {
  const isCtrl = isControlStep(step);
  const isCustom = !isCtrl && step.type === "CUSTOM_ACTION";
  const customDef = isCustom ? customActions.find(a => a.id === step.params?.actionId) : null;

  // Build a virtual "definition" for custom actions so the rest of the form
  // reuses the existing FieldRenderer-driven layout.
  const def = isCtrl
    ? controlDefinitions[step.type]
    : isCustom
      ? customDef && {
          label: customDef.name,
          description: customDef.description,
          inputs: Object.fromEntries((customDef.inputs || []).map(i => [i.name, {
            type: i.type === "selector" ? "string" : i.type === "json" ? "string" : i.type,
            label: i.name,
            placeholder: i.type === "json" ? "{ }" :
                         i.type === "selector" ? "CSS selector" : "",
          }])),
        }
      : actionDefinitions[step.type];

  if (!def) {
    // Custom action was deleted — let the user remove the orphan step.
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content editor-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header"><h3>Custom action unavailable</h3>
            <button className="modal-close-btn" onClick={onClose}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div className="editor-form">
            <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
              The custom action this step refers to (id #{step.params?.actionId}) no longer exists. Delete this step or restore the action.
            </p>
          </div>
          <div className="modal-footer">
            <button className="modal-btn primary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  const [local, setLocal] = useState(step);
  const [showAdv, setShowAdv] = useState(false);
  const setParam = (k, v) => {
    if (isCustom) {
      // For custom actions, params.inputs holds the user's values.
      setLocal(s => ({ ...s, params: { ...s.params, inputs: { ...(s.params?.inputs || {}), [k]: v } } }));
    } else {
      setLocal(s => ({ ...s, params: { ...s.params, [k]: v } }));
    }
  };
  const setAdv   = (k, v) => setLocal(s => ({ ...s, advanced: { ...s.advanced, [k]: v } }));
  const inputs   = isCtrl ? def.params   : (def.inputs   || {});
  const advanced = isCtrl ? {}           : (def.advanced || {});
  // Where to read values from
  const getValue = (k) => isCustom ? local.params?.inputs?.[k] : local.params?.[k];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content editor-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {isCtrl && <span className="control-type-badge" style={{ "--ctrl-color": def.color, fontSize: 16 }}>{def.icon}</span>}
            <h3>Edit: {def.label}</h3>
          </div>
          <button className="modal-close-btn" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div className="editor-form">
          {step.pinned && (
            <div className="label-extraction-banner" style={{ borderColor: "rgba(88,166,255,0.4)" }}>
              <span>◈</span>
              This is the workflow's <strong>start URL</strong>. Changing the URL here also updates the URL bar at the top.
              The step is pinned to the top of the workflow and can't be moved or deleted.
            </div>
          )}
          {/* Step name / result key — always first */}
          <div className="form-group label-group">
            <label>
              Step name
              {!isCtrl && EXTRACTION_TYPES.has(step.type) && (
                <span className="label-extraction-hint"> — becomes the result key in exported data</span>
              )}
            </label>
            <input
              type="text"
              value={local.label || ""}
              placeholder={!isCtrl && EXTRACTION_TYPES.has(step.type)
                ? "e.g. products, prices, titles…"
                : "Optional label"}
              onChange={e => setLocal(s => ({ ...s, label: e.target.value }))}
              style={!isCtrl && EXTRACTION_TYPES.has(step.type) ? { borderColor: "var(--accent-primary)" } : {}}
            />
            {!isCtrl && EXTRACTION_TYPES.has(step.type) && (
              <div className="label-extraction-banner">
                <span>◈</span>
                Named extraction steps are automatically exported when you run the workflow.
                Use a clear name like <code>prices</code> or <code>product_links</code>.
              </div>
            )}
          </div>

          {isCustom && customDef?.outputs?.length > 0 && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -6 }}>
              Returns: {customDef.outputs.map(o => <code key={o.name} style={{ marginRight: 8 }}>{o.name}</code>)}
            </div>
          )}
          {Object.entries(inputs).map(([k, s]) => (
            <FieldRenderer key={k} label={s.label || k} type={s.type} value={getValue(k)}
              options={s.options} placeholder={s.placeholder} onChange={v => setParam(k, v)} />
          ))}
          {isCustom && Object.keys(inputs).length === 0 && (
            <div style={{ color: "var(--text-muted)", fontSize: 13, padding: "8px 0" }}>
              This custom action has no declared inputs.
            </div>
          )}
          {Object.keys(advanced).length > 0 && (
            <>
              <button className="adv-toggle-btn" onClick={() => setShowAdv(v => !v)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  style={{ transform: showAdv ? "rotate(180deg)" : "none", transition: "150ms" }}>
                  <polyline points="6,9 12,15 18,9"/>
                </svg>
                {showAdv ? "Hide" : "Show"} advanced options
              </button>
              {showAdv && Object.entries(advanced).map(([k, s]) => (
                <FieldRenderer key={k} label={s.label || k} type={s.type} value={local.advanced?.[k]}
                  options={s.options} placeholder={s.placeholder} onChange={v => setAdv(k, v)} />
              ))}
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-btn secondary" onClick={onClose}>Cancel</button>
          <button className="modal-btn primary" onClick={() => onSave(local)}>Save Changes</button>
        </div>
      </div>
    </div>
  );
}

/* ── Field Renderer ── */
function FieldRenderer({ label, type, value, options, placeholder, onChange }) {
  // hidden fields are stored in params but not shown in UI
  if (type === "hidden") return null;

  return (
    <div className="form-group">
      <label>{label}</label>
      {type === "string"  && <input type="text"   value={value ?? ""}   placeholder={placeholder || ""} onChange={e => onChange(e.target.value)} />}
      {type === "number"  && <input type="number" value={value ?? ""}   onChange={e => onChange(Number(e.target.value))} />}
      {type === "boolean" && <label style={{ display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} /><span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{value ? "Enabled" : "Disabled"}</span></label>}
      {type === "select"  && <select value={value ?? ""} onChange={e => onChange(e.target.value)}>{(options || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}
      {type === "array"   && <input type="text" value={(value || []).join(", ")} placeholder="Comma-separated values" onChange={e => onChange(e.target.value.split(",").map(v => v.trim()).filter(Boolean))} />}
      {type === "selectorList" && <SelectorListEditor value={value} onChange={onChange} />}
    </div>
  );
}

/* ── SelectorListEditor ─────────────────────────────────────────────────────
   Renders the fallback selector list as typed chips with a badge showing
   css/xpath. Each entry is { value: string, type: 'css'|'xpath', strategy? }.
   Users can remove entries or add plain-CSS ones manually.
   ─────────────────────────────────────────────────────────────────────────── */
function SelectorListEditor({ value, onChange }) {
  const items = (value || []);
  const [draft, setDraft] = React.useState("");

  const remove = (i) => onChange(items.filter((_, idx) => idx !== i));

  const addDraft = () => {
    const v = draft.trim();
    if (!v) return;
    const isXPath = v.startsWith("/") || v.startsWith("(");
    onChange([...items, { value: v, type: isXPath ? "xpath" : "css", strategy: "manual" }]);
    setDraft("");
  };

  return (
    <div className="sel-list-editor">
      {items.length === 0 && (
        <div className="sel-list-empty">No fallback selectors</div>
      )}
      {items.map((item, i) => {
        const s = typeof item === "string" ? { value: item, type: "css" } : item;
        return (
          <div key={i} className="sel-chip">
            <span className={`sel-chip-type ${s.type}`}>{s.type === "xpath" ? "XP" : "CSS"}</span>
            <code className="sel-chip-value" title={s.value}>{s.value}</code>
            {s.strategy && <span className="sel-chip-strategy">{s.strategy}</span>}
            <button className="sel-chip-remove" onClick={() => remove(i)} title="Remove">×</button>
          </div>
        );
      })}
      <div className="sel-list-add">
        <input
          type="text"
          className="sel-add-input"
          value={draft}
          placeholder="Add selector (CSS or /xpath)…"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => e.key === "Enter" && addDraft()}
        />
        <button className="sel-add-btn" onClick={addDraft}>+</button>
      </div>
    </div>
  );
}