import { useState, useCallback } from "react";
import React from "react";
import { actionDefinitions } from "../actions/actionDefinitions";
import { controlDefinitions, isControlStep } from "../workflow/controlDefinitions";
import { createAction, createControl } from "../workflow/stepFactory";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

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

/* =====================================================================  MAIN PANEL */
export default function WorkflowPanel({ steps, totalCount, onAdd, onUpdate, onDelete, onReorder, setSteps }) {
  const [pickerCtx, setPickerCtx]   = useState(null);
  const [editingCtx, setEditingCtx] = useState(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  return (
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

      <div className="workflow-canvas">
        <div className="flow-container">
          <div className="flow-start">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
            Start
          </div>

          {steps.length === 0 ? (
            <div className="empty-state">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
              <h3>No steps yet</h3>
              <p>Build your workflow — add action steps and control blocks below.</p>
              <button className="add-step-btn" onClick={() => setPickerCtx({ containerPath: [], index: null })}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Add First Step
              </button>
            </div>
          ) : (
            <>
              <DndContext sensors={sensors} collisionDetection={closestCenter}
                onDragEnd={({ active, over }) => {
                  if (!over || active.id === over.id) return;
                  const f = steps.findIndex(s => s.id === active.id), t = steps.findIndex(s => s.id === over.id);
                  if (f !== -1 && t !== -1) setSteps(arrayMove(steps, f, t));
                }}>
                <SortableContext items={steps.map(s => s.id)} strategy={verticalListSortingStrategy}>
                  <StepList steps={steps} containerPath={[]} depth={0}
                    onPickerOpen={setPickerCtx} onEditOpen={setEditingCtx}
                    onDelete={onDelete} onReorder={onReorder} sortable />
                </SortableContext>
              </DndContext>
              <div className="flow-connector" />
              <button className="add-step-btn" onClick={() => setPickerCtx({ containerPath: [], index: null })}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Add Step
              </button>
              <div className="flow-connector" />
              <div className="flow-end">End</div>
            </>
          )}
        </div>
      </div>

      {pickerCtx && (
        <StepPicker
          onSelect={(kind, type) => {
            const step = kind === "control" ? createControl(type) : createAction(type, buildDefaultParams(actionDefinitions[type]), buildDefaultAdvanced(actionDefinitions[type]));
            onAdd(step, pickerCtx.containerPath, pickerCtx.index);
            setPickerCtx(null);
          }}
          onClose={() => setPickerCtx(null)}
        />
      )}

      {editingCtx && (
        <StepEditorModal
          step={editingCtx.step}
          onClose={() => setEditingCtx(null)}
          onSave={(updated) => { onUpdate(editingCtx.containerPath, editingCtx.index, updated); setEditingCtx(null); }}
        />
      )}
    </div>
  );
}

/* ── StepList (recursive) ── */
function StepList({ steps, containerPath, depth, onPickerOpen, onEditOpen, onDelete, onReorder, sortable }) {
  return (
    <div className="step-list">
      {steps.map((step, index) => (
        <div key={step.id} className="step-list-item">
          <div className="step-insert-row">
            <button className="insert-between-btn" title="Insert here" onClick={() => onPickerOpen({ containerPath, index })}>
              <PlusIcon />
            </button>
          </div>
          <div className="flow-connector" />
          {isControlStep(step) ? (
            sortable
              ? <SortableControlBlock key={step.id} step={step} index={index} containerPath={containerPath} depth={depth} onPickerOpen={onPickerOpen} onEditOpen={onEditOpen} onDelete={onDelete} onReorder={onReorder} />
              : <ControlBlock step={step} index={index} containerPath={containerPath} depth={depth} onPickerOpen={onPickerOpen} onEditOpen={onEditOpen} onDelete={onDelete} onReorder={onReorder} />
          ) : (
            sortable
              ? <SortableActionCard step={step} index={index} containerPath={containerPath} onEdit={() => onEditOpen({ containerPath, index, step })} onDelete={() => onDelete(containerPath, index)} />
              : <ActionCard step={step} dragHandleProps={{}} onEdit={() => onEditOpen({ containerPath, index, step })} onDelete={() => onDelete(containerPath, index)} />
          )}
        </div>
      ))}
    </div>
  );
}

/* ── Sortable wrappers ── */
function SortableActionCard({ step, index, containerPath, onEdit, onDelete }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: step.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1, width: "100%" }}>
      <ActionCard step={step} dragHandleProps={{ ...attributes, ...listeners }} onEdit={onEdit} onDelete={onDelete} />
    </div>
  );
}
function SortableControlBlock({ step, index, containerPath, depth, onPickerOpen, onEditOpen, onDelete, onReorder }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: step.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1, width: "100%" }}>
      <ControlBlock step={step} index={index} containerPath={containerPath} depth={depth} dragHandleProps={{ ...attributes, ...listeners }}
        onPickerOpen={onPickerOpen} onEditOpen={onEditOpen} onDelete={onDelete} onReorder={onReorder} />
    </div>
  );
}

/* ── ActionCard ── */
function ActionCard({ step, dragHandleProps, onEdit, onDelete }) {
  const def = actionDefinitions[step.type];
  if (!def) return null;
  const summary = summariseParams(step);
  return (
    <div className="step-card">
      <div className="step-card-header">
        <div className="step-drag-handle" {...(dragHandleProps || {})}><DragDotsIcon /></div>
        <div className="step-icon"><ActionIcon type={step.type} /></div>
        <div className="step-info">
          <div className="step-label">{def.label}</div>
          <div className="step-type">{def.category || "Action"}</div>
        </div>
        <div className="step-actions">
          {step.label && EXTRACTION_TYPES.has(step.type) && (
            <div className="step-label-badge" title="Named result — will appear in exported data">
              <span>◈</span> {step.label}
            </div>
          )}
          <button className="step-action-btn" onClick={onEdit} title="Edit"><EditIcon /></button>
          <button className="step-action-btn delete" onClick={onDelete} title="Delete"><TrashIcon /></button>
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
  if (!def) return null;
  const summary = buildControlSummary(step, def);

  return (
    <div className="control-block" style={{ "--ctrl-color": def.color, "--ctrl-bg": def.bgColor }}>
      <div className="control-block-header">
        <div className="step-drag-handle" {...(dragHandleProps || {})}><DragDotsIcon /></div>
        <div className="control-type-badge">{def.icon}</div>
        <div className="control-info">
          <span className="control-label">{def.label}</span>
          {summary && <code className="control-expr">{summary}</code>}
        </div>
        <div className="step-actions">
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
                      <button className="branch-add-btn" style={{ color: def.color, borderColor: def.color }}
                        onClick={() => onPickerOpen({ containerPath: branchPath, index: null })}>
                        + Add step
                      </button>
                    </div>
                  ) : (
                    <>
                      <DndContext collisionDetection={closestCenter}
                        onDragEnd={({ active, over }) => {
                          if (!over || active.id === over.id) return;
                          const f = branchSteps.findIndex(s => s.id === active.id), t = branchSteps.findIndex(s => s.id === over.id);
                          if (f !== -1 && t !== -1) onReorder(branchPath, f, t);
                        }}>
                        <SortableContext items={branchSteps.map(s => s.id)} strategy={verticalListSortingStrategy}>
                          <StepList steps={branchSteps} containerPath={branchPath} depth={depth + 1}
                            onPickerOpen={onPickerOpen} onEditOpen={onEditOpen}
                            onDelete={onDelete} onReorder={onReorder} sortable />
                        </SortableContext>
                      </DndContext>
                      <div style={{ display: "flex", justifyContent: "center", marginTop: 8 }}>
                        <button className="branch-add-btn" style={{ color: def.color, borderColor: def.color }}
                          onClick={() => onPickerOpen({ containerPath: branchPath, index: null })}>
                          + Add step
                        </button>
                      </div>
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
function StepPicker({ onSelect, onClose }) {
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
          {[["all","All"],["control","⚙ Control Flow"],["action","▶ Actions"]].map(([id, label]) => (
            <button key={id} className={`picker-tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        <div className="modal-body">
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
          {ctrlItems.length === 0 && Object.keys(actionGroups).length === 0 && (
            <div style={{ color: "var(--text-muted)", padding: "24px", textAlign: "center" }}>No results for "{search}"</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Step Editor Modal ── */
function StepEditorModal({ step, onClose, onSave }) {
  const isCtrl = isControlStep(step);
  const def = isCtrl ? controlDefinitions[step.type] : actionDefinitions[step.type];
  if (!def) return null;
  const [local, setLocal] = useState(step);
  const [showAdv, setShowAdv] = useState(false);
  const setParam = (k, v) => setLocal(s => ({ ...s, params: { ...s.params, [k]: v } }));
  const setAdv   = (k, v) => setLocal(s => ({ ...s, advanced: { ...s.advanced, [k]: v } }));
  const inputs   = isCtrl ? def.params   : (def.inputs   || {});
  const advanced = isCtrl ? {}           : (def.advanced || {});

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

          {Object.entries(inputs).map(([k, s]) => (
            <FieldRenderer key={k} label={s.label || k} type={s.type} value={local.params?.[k]}
              options={s.options} placeholder={s.placeholder} onChange={v => setParam(k, v)} />
          ))}
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