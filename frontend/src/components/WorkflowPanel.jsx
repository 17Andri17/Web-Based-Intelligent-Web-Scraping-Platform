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

  return (
    <div style={{ marginTop: "20px" }}>
      <h3>Workflow</h3>

      <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext
          items={steps.map((s) => s.id)}
          strategy={verticalListSortingStrategy}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {steps.map((step, index) => {
              const def = actionDefinitions[step.type];
              if (!def) return null;

              return (
                <div key={step.id}>
                  <AddStepButton onClick={() => handleAddClick(index)} />

                  <SortableStep
                    step={step}
                    def={def}
                    onEdit={() => setEditingStep({ step, index })}
                  />
                </div>
              );
            })}

            <AddStepButton onClick={() => handleAddClick(steps.length)} />
          </div>
        </SortableContext>
      </DndContext>

      {/* 🔥 STEP PICKER */}
      {pickerIndex !== null && (
        <StepPicker
          onSelect={handleSelectAction}
          onClose={() => setPickerIndex(null)}
        />
      )}

      {/* 🔥 EDITOR */}
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

function SortableStep({ step, def, onEdit }) {
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
        dragHandleProps={{ ...attributes, ...listeners }}
        onEdit={onEdit}
      />
    </div>
  );
}

/* ========================= STEP CARD ========================= */

function StepCard({ step, def, dragHandleProps, onEdit }) {
  return (
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: "12px",
        padding: "12px",
        background: "#fff",
        boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center"
      }}
    >
      <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
        <div
          {...dragHandleProps}
          style={{
            cursor: "grab",
            padding: "4px",
            background: "#eee",
            borderRadius: "6px"
          }}
        >
          ☰
        </div>

        <div>
          <b>{def.label}</b>
          <div style={{ fontSize: "12px", color: "#666" }}>
            {Object.entries(step.params || {})
              .map(([k, v]) =>
                `${k}: ${Array.isArray(v) ? v.join(",") : v}`
              )
              .join(" | ")}
          </div>
        </div>
      </div>

      <button onClick={onEdit}>Edit</button>
    </div>
  );
}

/* ========================= ADD STEP ========================= */

function AddStepButton({ onClick }) {
  return (
    <div
      style={{
        textAlign: "center",
        opacity: 0.4,
        cursor: "pointer"
      }}
      onClick={onClick}
    >
      <div
        style={{
          display: "inline-block",
          padding: "4px 10px",
          border: "1px dashed #aaa",
          borderRadius: "20px",
          fontSize: "12px"
        }}
      >
        + Add Step
      </div>
    </div>
  );
}

/* ========================= STEP PICKER ========================= */

function StepPicker({ onSelect, onClose }) {
  const [search, setSearch] = useState("");

  /* ========================= GROUP BY CATEGORY ========================= */

  const grouped = {};

  Object.entries(actionDefinitions).forEach(([type, def]) => {
    if (!def) return;
    const category = def.category || "Other";

    if (!grouped[category]) grouped[category] = [];

    grouped[category].push({ type, def });
  });

  /* ========================= SEARCH FILTER ========================= */

  const searchLower = search.toLowerCase();

  const filtered = Object.entries(actionDefinitions)
    .filter(([_, def]) => {
      if (!searchLower) return true;

      return (
        def.label.toLowerCase().includes(searchLower) ||
        (def.category || "").toLowerCase().includes(searchLower)
      );
    })
    .map(([type, def]) => ({ type, def }));

  const isSearching = search.trim().length > 0;

  return (
    <div style={overlayStyle}>
      <div style={modalStyleLarge}>
        <h3>Add Step</h3>

        {/* 🔍 SEARCH */}
        <input
          placeholder="Search actions..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={searchInputStyle}
        />

        {/* 🔥 CONTENT */}
        <div style={{ marginTop: "15px" }}>
          {!isSearching ? (
            /* ========================= CATEGORY VIEW ========================= */
            Object.entries(grouped).map(([category, actions]) => (
              <div key={category} style={{ marginBottom: "20px" }}>
                <h4 style={categoryStyle}>{category}</h4>

                <div style={gridStyle}>
                  {actions.map(({ type, def }) => (
                    <StepTile
                      key={type}
                      def={def}
                      onClick={() => onSelect(type)}
                    />
                  ))}
                </div>
              </div>
            ))
          ) : (
            /* ========================= SEARCH VIEW ========================= */
            <div style={gridStyle}>
              {filtered.length === 0 && (
                <div style={{ color: "#999" }}>No results</div>
              )}

              {filtered.map(({ type, def }) => (
                <StepTile
                  key={type}
                  def={def}
                  highlight={search}
                  onClick={() => onSelect(type)}
                />
              ))}
            </div>
          )}
        </div>

        <button onClick={onClose} style={{ marginTop: "15px" }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function StepTile({ def, onClick, highlight }) {
  return (
    <div onClick={onClick} style={tileStyle}>
      <div style={{ fontWeight: "bold" }}>
        {highlightText(def.label, highlight)}
      </div>

      <div style={{ fontSize: "12px", color: "#666" }}>
        {def.description}
      </div>

      <div style={categoryBadge}>
        {def.category || "Other"}
      </div>
    </div>
  );
}

function highlightText(text, search) {
  if (!search) return text;

  const regex = new RegExp(`(${search})`, "gi");

  return text.split(regex).map((part, i) =>
    part.toLowerCase() === search.toLowerCase() ? (
      <span key={i} style={{ background: "#ffe58a" }}>
        {part}
      </span>
    ) : (
      part
    )
  );
}

const modalStyleLarge = {
  background: "#fff",
  padding: "20px",
  borderRadius: "12px",
  width: "600px",
  maxHeight: "80vh",
  overflow: "auto"
};

const searchInputStyle = {
  width: "100%",
  padding: "10px",
  borderRadius: "8px",
  border: "1px solid #ccc"
};

const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
  gap: "10px"
};

const tileStyle = {
  border: "1px solid #ddd",
  borderRadius: "10px",
  padding: "10px",
  cursor: "pointer",
  background: "#fafafa",
  transition: "0.2s"
};

const categoryStyle = {
  marginBottom: "10px",
  color: "#555"
};

const categoryBadge = {
  marginTop: "6px",
  fontSize: "10px",
  color: "#888"
};

/* ========================= EDITOR ========================= */

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
    <div style={overlayStyle}>
      <div style={modalStyle}>
        <h3>{def.label}</h3>

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

        {def.advanced && (
          <>
            <h4>Advanced</h4>
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

        <div style={{ marginTop: "15px" }}>
          <button onClick={() => onUpdate(localStep)}>Save</button>
          <button onClick={onClose} style={{ marginLeft: "10px" }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/* ========================= FIELD ========================= */

function FieldRenderer({ label, type, value, options, onChange }) {
  return (
    <div style={{ marginBottom: "10px" }}>
      <label>{label}</label>

      {type === "string" && (
        <input value={value || ""} onChange={(e) => onChange(e.target.value)} />
      )}

      {type === "number" && (
        <input
          type="number"
          value={value ?? ""}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      )}

      {type === "boolean" && (
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
        />
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
          value={(value || []).join(", ")}
          onChange={(e) =>
            onChange(e.target.value.split(",").map((v) => v.trim()))
          }
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

/* ========================= STYLES ========================= */

const overlayStyle = {
  position: "fixed",
  top: 0,
  left: 0,
  width: "100%",
  height: "100%",
  background: "rgba(0,0,0,0.4)",
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  zIndex: 1000
};

const modalStyle = {
  background: "#fff",
  padding: "20px",
  borderRadius: "10px",
  width: "400px",
  maxHeight: "80vh",
  overflow: "auto"
};