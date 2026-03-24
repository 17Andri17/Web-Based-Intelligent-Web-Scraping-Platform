import { useState } from "react";
import { actionDefinitions } from "../actions/actionDefinitions";

export default function WorkflowPanel({ steps, onUpdate }) {
  return (
    <div style={{ marginTop: "20px" }}>
      <h3>Workflow</h3>

      {steps.map((step, index) => {
        const def = actionDefinitions[step.type];
        if (!def) return null;

        return (
          <StepCard
            key={step.id}
            step={step}
            def={def}
            index={index}
            onUpdate={onUpdate}
          />
        );
      })}
    </div>
  );
}

// 🔹 Separate component = cleaner
function StepCard({ step, def, index, onUpdate }) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const updateParam = (key, value) => {
    onUpdate(index, {
      ...step,
      params: {
        ...step.params,
        [key]: value
      }
    });
  };

  const updateAdvanced = (key, value) => {
    onUpdate(index, {
      ...step,
      advanced: {
        ...step.advanced,
        [key]: value
      }
    });
  };

  return (
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: "10px",
        padding: "15px",
        marginBottom: "15px",
        background: "#fafafa",
        boxShadow: "0 2px 6px rgba(0,0,0,0.05)"
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: "10px" }}>
        <b style={{ fontSize: "16px" }}>{def.label}</b>
      </div>

      {/* 🔹 INPUTS */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {Object.entries(def.inputs || {}).map(([key, inputDef]) => (
          <FieldRenderer
            key={key}
            label={inputDef.label}
            type={inputDef.type}
            value={step.params?.[key]}
            options={inputDef.options}
            onChange={(val) => updateParam(key, val)}
          />
        ))}
      </div>

      {/* 🔹 ADVANCED TOGGLE */}
      {def.advanced && (
        <div style={{ marginTop: "10px" }}>
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            style={{
              fontSize: "12px",
              background: "transparent",
              border: "none",
              color: "#007bff",
              cursor: "pointer"
            }}
          >
            {showAdvanced ? "Hide Advanced" : "Show Advanced"}
          </button>

          {showAdvanced && (
            <div
              style={{
                marginTop: "10px",
                padding: "10px",
                border: "1px dashed #ccc",
                borderRadius: "8px",
                background: "#fff"
              }}
            >
              {Object.entries(def.advanced).map(([key, advDef]) => (
                <FieldRenderer
                  key={key}
                  label={advDef.label}
                  type={advDef.type}
                  value={step.advanced?.[key]}
                  options={advDef.options}
                  onChange={(val) => updateAdvanced(key, val)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// 🔥 Dynamic field renderer (important)
function FieldRenderer({ label, type, value, options, onChange }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <label style={{ fontSize: "12px", marginBottom: "2px" }}>{label}</label>

      {/* STRING */}
      {type === "string" && (
        <input
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          style={inputStyle}
        />
      )}

      {/* BOOLEAN */}
      {type === "boolean" && (
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
        />
      )}

      {/* SELECT */}
      {type === "select" && (
        <select
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          style={inputStyle}
        >
          {(options || []).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      )}

      {/* ARRAY (simple comma-separated for now) */}
      {type === "array" && (
        <input
          value={(value || []).join(", ")}
          onChange={(e) =>
            onChange(e.target.value.split(",").map((v) => v.trim()))
          }
          placeholder="comma separated values"
          style={inputStyle}
        />
      )}
    </div>
  );
}

const inputStyle = {
  padding: "6px",
  borderRadius: "6px",
  border: "1px solid #ccc",
  fontSize: "13px"
};