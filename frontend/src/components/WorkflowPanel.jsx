import { useState } from "react";
import { actionDefinitions } from "../actions/actionDefinitions";
import { createAction } from "../workflow/stepFactory";

import {
  DndContext,
  closestCenter
} from "@dnd-kit/core";

import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";

import { CSS } from "@dnd-kit/utilities";

export default function WorkflowPanel({
  steps,
  onUpdate,
  onAddStep,
  setSteps
}) {
  const [editingStep, setEditingStep] = useState(null);
  const [pickerIndex, setPickerIndex] = useState(null);

  /* ========================= DRAG ========================= */
  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = steps.findIndex((s) => s.id === active.id);
    const newIndex = steps.findIndex((s) => s.id === over.id);

    setSteps((prev) => arrayMove(prev, oldIndex, newIndex));
  };

  /* ========================= ADD STEP ========================= */
  const handleAddClick = (index) => {
    setPickerIndex(index);
  };

  const handleSelectAction = (type) => {
    const def = actionDefinitions[type];
    const params = buildDefaultParams(def);
    const advanced = buildDefaultAdvanced(def);
    const step = createAction(type, params, advanced);

    onAddStep(step, pickerIndex);
    setPickerIndex(null);
  };

  /* ========================= DELETE STEP ========================= */
  const handleDeleteStep = (index) => {
    if (window.confirm("Delete this step?")) {
      setSteps((prev) => prev.filter((_, i) => i !== index));
    }
  };

  /* ========================= GET ACTION ICON ========================= */
  const getActionIcon = (type) => {
    switch (type) {
      case 'NAVIGATE':
        return (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="2" y1="12" x2="22" y2="12"/>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
          </svg>
        );
      case 'EXTRACT_TEXT':
        return (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14,2 14,8 20,8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
            <polyline points="10,9 9,9 8,9"/>
          </svg>
        );
      case 'CLICK_ELEMENT':
        return (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/>
            <path d="M13 13l6 6"/>
          </svg>
        );
      default:
        return (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
        );
    }
  };

  return (
    <div className="workflow-designer">
      <div className="workflow-header">
        <div className="workflow-title">
          <h2>Flow Designer</h2>
          <span className="step-count">{steps.length} {steps.length === 1 ? 'step' : 'steps'}</span>
        </div>
        <div className="workflow-actions">
          <button className="header-btn secondary" onClick={() => handleAddClick(steps.length)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Add Step
          </button>
        </div>
      </div>

      <div className="workflow-canvas">
        <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={steps.map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="flow-container">
              {/* Start Node */}
              <div className="flow-start">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="5,3 19,12 5,21"/>
                </svg>
                Start
              </div>

              {steps.length === 0 ? (
                <div className="empty-state">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                    <path d="M2 17l10 5 10-5"/>
                    <path d="M2 12l10 5 10-5"/>
                  </svg>
                  <h3>No steps yet</h3>
                  <p>Start building your workflow by adding steps. Use the Live Browser to navigate and select elements.</p>
                  <button className="add-step-btn" onClick={() => handleAddClick(0)}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="12" y1="5" x2="12" y2="19"/>
                      <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    Add First Step
                  </button>
                </div>
              ) : (
                <>
                  {steps.map((step, index) => {
                    const def = actionDefinitions[step.type];
                    if (!def) return null;

                    return (
                      <div key={step.id}>
                        {/* Connector line */}
                        <div className="flow-connector" />
                        
                        {/* Add step button (inline) */}
                        <button 
                          className="add-step-inline"
                          onClick={() => handleAddClick(index)}
                          title="Add step here"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="12" y1="5" x2="12" y2="19"/>
                            <line x1="5" y1="12" x2="19" y2="12"/>
                          </svg>
                        </button>

                        {/* Connector line */}
                        <div className="flow-connector" />

                        <SortableStep
                          step={step}
                          def={def}
                          icon={getActionIcon(step.type)}
                          onEdit={() => setEditingStep({ step, index })}
                          onDelete={() => handleDeleteStep(index)}
                        />
                      </div>
                    );
                  })}

                  {/* Final connector and add button */}
                  <div className="flow-connector" />
                  <button 
                    className="add-step-btn"
                    onClick={() => handleAddClick(steps.length)}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="12" y1="5" x2="12" y2="19"/>
                      <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    Add Step
                  </button>
                </>
              )}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {/* Step Picker Modal */}
      {pickerIndex !== null && (
        <StepPicker
          onSelect={handleSelectAction}
          onClose={() => setPickerIndex(null)}
        />
      )}

      {/* Editor Modal */}
      {editingStep && (
        <StepEditorOverlay
          step={editingStep.step}
          index={editingStep.index}
          def={actionDefinitions[editingStep.step.type]}
          onClose={() => setEditingStep(null)}
          onUpdate={(updated) => {
            onUpdate(editingStep.index, updated);
            setEditingStep(null);
          }}
        />
      )}
    </div>
  );
}

/* ========================= SORTABLE STEP ========================= */

function SortableStep({ step, def, icon, onEdit, onDelete }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition
  } = useSortable({ id: step.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  return (
    <div ref={setNodeRef} style={style}>
      <StepCard
        step={step}
        def={def}
        icon={icon}
        dragHandleProps={{ ...attributes, ...listeners }}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </div>
  );
}

/* ========================= STEP CARD ========================= */

function StepCard({ step, def, icon, dragHandleProps, onEdit, onDelete }) {
  return (
    <div className="step-card">
      <div className="step-card-header">
        <div className="step-drag-handle" {...dragHandleProps}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="6" r="1.5"/>
            <circle cx="15" cy="6" r="1.5"/>
            <circle cx="9" cy="12" r="1.5"/>
            <circle cx="15" cy="12" r="1.5"/>
            <circle cx="9" cy="18" r="1.5"/>
            <circle cx="15" cy="18" r="1.5"/>
          </svg>
        </div>
        
        <div className="step-icon">
          {icon}
        </div>

        <div className="step-info">
          <div className="step-label">{def.label}</div>
          <div className="step-type">{def.category || 'Action'}</div>
        </div>

        <div className="step-actions">
          <button className="step-action-btn" onClick={onEdit} title="Edit">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button className="step-action-btn delete" onClick={onDelete} title="Delete">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3,6 5,6 21,6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>

      <div className="step-card-body">
        <div className="step-params">
          {Object.entries(step.params || {}).map(([key, value]) => (
            <div key={key} className="step-param">
              <span className="step-param-key">{key}:</span>
              <span className="step-param-value">
                {Array.isArray(value) ? value.join(', ') : String(value)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ========================= STEP PICKER ========================= */

function StepPicker({ onSelect, onClose }) {
  const [search, setSearch] = useState("");

  const grouped = {};
  Object.entries(actionDefinitions).forEach(([type, def]) => {
    if (!def) return;
    const category = def.category || "Other";
    if (!grouped[category]) grouped[category] = [];
    grouped[category].push({ type, def });
  });

  const searchLower = search.toLowerCase();
  const filtered = Object.entries(actionDefinitions)
    .filter(([_, def]) => {
      if (!searchLower) return true;
      return (
        def.label.toLowerCase().includes(searchLower) ||
        (def.category || "").toLowerCase().includes(searchLower) ||
        (def.description || "").toLowerCase().includes(searchLower)
      );
    })
    .map(([type, def]) => ({ type, def }));

  const isSearching = search.trim().length > 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Add Step</h3>
          <button className="modal-close-btn" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="modal-search">
          <input
            placeholder="Search actions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </div>

        <div className="modal-body">
          {!isSearching ? (
            Object.entries(grouped).map(([category, actions]) => (
              <div key={category} className="action-category">
                <div className="category-title">{category}</div>
                <div className="action-grid">
                  {actions.map(({ type, def }) => (
                    <div 
                      key={type}
                      className="action-tile"
                      onClick={() => onSelect(type)}
                    >
                      <div className="action-tile-label">{def.label}</div>
                      <div className="action-tile-desc">{def.description}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <div className="action-grid">
              {filtered.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', padding: '20px' }}>No results found</div>
              ) : (
                filtered.map(({ type, def }) => (
                  <div 
                    key={type}
                    className="action-tile"
                    onClick={() => onSelect(type)}
                  >
                    <div className="action-tile-label">{def.label}</div>
                    <div className="action-tile-desc">{def.description}</div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ========================= STEP EDITOR ========================= */

function StepEditorOverlay({ step, def, onClose, onUpdate }) {
  const [localStep, setLocalStep] = useState(step);

  const updateParam = (key, value) => {
    setLocalStep({
      ...localStep,
      params: {
        ...localStep.params,
        [key]: value
      }
    });
  };

  const updateAdvanced = (key, value) => {
    setLocalStep({
      ...localStep,
      advanced: {
        ...localStep.advanced,
        [key]: value
      }
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content editor-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Edit: {def.label}</h3>
          <button className="modal-close-btn" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="editor-form">
          {Object.entries(def.inputs || {}).map(([key, inputDef]) => (
            <FieldRenderer
              key={key}
              label={inputDef.label}
              type={inputDef.type}
              value={localStep.params?.[key]}
              options={inputDef.options}
              onChange={(val) => updateParam(key, val)}
            />
          ))}

          {def.advanced && Object.keys(def.advanced).length > 0 && (
            <>
              <div className="form-section-title">Advanced Options</div>
              {Object.entries(def.advanced).map(([key, advDef]) => (
                <FieldRenderer
                  key={key}
                  label={advDef.label}
                  type={advDef.type}
                  value={localStep.advanced?.[key]}
                  options={advDef.options}
                  onChange={(val) => updateAdvanced(key, val)}
                />
              ))}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="modal-btn secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="modal-btn primary" onClick={() => onUpdate(localStep)}>
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}

/* ========================= FIELD RENDERER ========================= */

function FieldRenderer({ label, type, value, options, onChange }) {
  return (
    <div className="form-group">
      <label>{label}</label>

      {type === "string" && (
        <input 
          type="text"
          value={value || ""} 
          onChange={(e) => onChange(e.target.value)} 
        />
      )}

      {type === "number" && (
        <input
          type="number"
          value={value ?? ""}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      )}

      {type === "boolean" && (
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            {value ? 'Enabled' : 'Disabled'}
          </span>
        </label>
      )}

      {type === "select" && (
        <select value={value || ""} onChange={(e) => onChange(e.target.value)}>
          {(options || []).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      )}

      {type === "array" && (
        <input
          type="text"
          value={(value || []).join(", ")}
          onChange={(e) =>
            onChange(e.target.value.split(",").map((v) => v.trim()).filter(Boolean))
          }
          placeholder="Comma-separated values"
        />
      )}
    </div>
  );
}

/* ========================= HELPERS ========================= */

function buildDefaultParams(def) {
  const params = {};

  for (const [key, input] of Object.entries(def.inputs || {})) {
    if (input.default !== undefined) {
      params[key] = input.default;
    } else {
      params[key] = input.type === "array" ? [] : "";
    }
  }

  return params;
}

function buildDefaultAdvanced(def) {
  const advanced = {};

  for (const [key, adv] of Object.entries(def.advanced || {})) {
    if (adv.default !== undefined) {
      advanced[key] = adv.default;
    }
  }

  return advanced;
}