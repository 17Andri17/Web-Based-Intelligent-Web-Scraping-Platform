import React, { useState } from "react";

/* =====================================================================
   WorkflowVariables
   ---------------------------------------------------------------------
   ServiceNow-style "Workflow Variables" panel for the scraping flow.
   Shows two things side by side:

     1. Captured outputs — read-only, auto-derived from every named
        extraction step in the workflow tree. These ARE workflow
        variables — they end up as keys in the run's results JSON.

     2. Custom variables — user-defined inputs. The user names them,
        gives them a value, picks a type. The codegen emits them as
        top-level `let` declarations so subsequent steps can reference
        them (via the {{var}} interpolation we'll plug in later).

   Props:
     variables           Array<{name, value, type, description}>
     onAdd(v) / onUpdate(i, patch) / onRemove(i)
     capturedOutputs     Array<{name, type, stepId}>  — auto-derived
     collapsed, onToggleCollapsed
   ===================================================================== */

const TYPES = [
  { id: "string",  label: "Text"    },
  { id: "number",  label: "Number"  },
  { id: "boolean", label: "Yes/No"  },
  { id: "json",    label: "JSON"    },
];

export default function WorkflowVariables({
  variables = [],
  onAdd, onUpdate, onRemove,
  capturedOutputs = [],
  collapsed = false,
  onToggleCollapsed,
  layout = "top",   // "top" (legacy) | "side"
}) {
  const [adding, setAdding] = useState(false);
  const [draft,  setDraft]  = useState({ name: "", value: "", type: "string", description: "" });

  const finishAdd = () => {
    const name = sanitiseName(draft.name);
    if (!name) return;
    onAdd?.({
      name,
      value:       draft.value,
      type:        draft.type,
      description: draft.description.trim(),
    });
    setDraft({ name: "", value: "", type: "string", description: "" });
    setAdding(false);
  };

  // Side layout when collapsed: render a thin rail with a vertical
  // "Variables" label and a count badge — clicking re-opens the panel.
  // This keeps the panel visible (and the count discoverable) without
  // stealing canvas space.
  if (layout === "side" && collapsed) {
    return (
      <button
        type="button"
        className="wvars-rail"
        onClick={() => onToggleCollapsed?.()}
        title="Expand Workflow Variables"
      >
        <span className="wvars-rail-count">
          {capturedOutputs.length + variables.length}
        </span>
        <span className="wvars-rail-label">Variables</span>
        <ChevronIcon collapsed={true} />
      </button>
    );
  }

  return (
    <div className={"wvars" + (layout === "side" ? " wvars--side" : "")}>
      <button type="button" className="wvars-header" onClick={() => onToggleCollapsed?.()}>
        <ChevronIcon collapsed={collapsed} />
        <span className="wvars-title">Workflow Variables</span>
        <span className="wvars-count">
          {capturedOutputs.length + variables.length}
        </span>
        {layout !== "side" && (
          <span className="wvars-tip">
            {capturedOutputs.length} captured · {variables.length} custom
          </span>
        )}
      </button>

      {!collapsed && (
        <div className="wvars-body">
          {/* Quick how-to: where {{var}} actually works */}
          <div className="wvars-help">
            <span className="wvars-help-tag">tip</span>
            Reference a variable anywhere a step takes text — selector, URL, type-text content. Syntax:
            <ul className="wvars-help-list">
              <li><code>{"{{name}}"}</code> — value of a variable</li>
              <li><code>{"{{table.column}}"}</code> — a field of an object</li>
              <li><code>{"{{table[*].column}}"}</code> — the column from EVERY row of a list-of-objects (use this with the Run Subflow step's "URL list" mode to visit every link in a captured table)</li>
            </ul>
            Click a column name below to copy its reference.
          </div>
          {/* ── Captured outputs ─────────────────────────────────── */}
          <div className="wvars-section">
            <div className="wvars-section-title">
              <span>Captured outputs</span>
              <span className="wvars-section-help">automatically tracked from named extraction steps</span>
            </div>
            {capturedOutputs.length === 0 ? (
              <div className="wvars-empty">No extraction steps named yet. Add a label to any extract step to capture it as a variable.</div>
            ) : (
              <div className="wvars-list">
                {capturedOutputs.map(v => (
                  <CapturedRow key={v.stepId} value={v} />
                ))}
              </div>
            )}
          </div>

          {/* ── Custom variables ─────────────────────────────────── */}
          <div className="wvars-section">
            <div className="wvars-section-title">
              <span>Custom variables</span>
              <span className="wvars-section-help">reusable values you can reference inside any step using <code>{"{{name}}"}</code></span>
            </div>

            {variables.length === 0 && !adding && (
              <div className="wvars-empty">No custom variables defined yet.</div>
            )}

            {variables.length > 0 && (
              <div className="wvars-list">
                {variables.map((v, i) => (
                  <CustomVarRow
                    key={i}
                    value={v}
                    onChange={patch => onUpdate?.(i, patch)}
                    onRemove={() => onRemove?.(i)}
                  />
                ))}
              </div>
            )}

            {adding ? (
              <div className="wvars-add-row">
                <input
                  className="wvars-add-name"
                  autoFocus
                  placeholder="variable_name"
                  value={draft.name}
                  onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                  onKeyDown={e => { if (e.key === "Enter") finishAdd(); if (e.key === "Escape") setAdding(false); }}
                />
                <select
                  className="wvars-add-type"
                  value={draft.type}
                  onChange={e => setDraft(d => ({ ...d, type: e.target.value }))}
                >
                  {TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
                <input
                  className="wvars-add-value"
                  placeholder="initial value"
                  value={draft.value}
                  onChange={e => setDraft(d => ({ ...d, value: e.target.value }))}
                  onKeyDown={e => { if (e.key === "Enter") finishAdd(); if (e.key === "Escape") setAdding(false); }}
                />
                <button type="button" className="wvars-add-confirm" onClick={finishAdd} disabled={!draft.name.trim()}>Add</button>
                <button type="button" className="wvars-add-cancel"  onClick={() => setAdding(false)}>×</button>
              </div>
            ) : (
              <button type="button" className="wvars-add-btn" onClick={() => setAdding(true)}>
                + Add variable
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Captured-output row (read-only, table-aware) ──────────────────── */
function CapturedRow({ value }) {
  const isTable = value.type === "table" || value.type === "list";
  const cols = Array.isArray(value.columns) ? value.columns.filter(Boolean) : [];

  const copy = (text) => { try { navigator.clipboard.writeText(text); } catch (_) {} };

  return (
    <div className={"wvars-row wvars-row--captured" + (value.included === false ? " wvars-row--hidden" : "")}
         title={`Captured from step "${value.name}"`}>
      <span className="wvars-pill wvars-pill--captured">▣</span>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="wvars-name">{value.name}</span>
          <span className="wvars-type">{value.type}</span>
          {value.included === false && (
            <span className="wvars-hidden-tag" title="This step's data does NOT appear in the final results JSON — it lives as a workflow variable only">
              variable only
            </span>
          )}
        </div>
        {isTable && cols.length > 0 && (
          <div className="wvars-cols">
            <span className="wvars-cols-label">columns:</span>
            {cols.map(c => {
              const ref = `{{${value.name}[*].${c}}}`;
              return (
                <button
                  key={c}
                  type="button"
                  className="wvars-col-chip"
                  title={`Click to copy ${ref} — produces the list of ${c} values`}
                  onClick={() => copy(ref)}
                >
                  {c}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Single editable row ────────────────────────────────────────────── */
function CustomVarRow({ value, onChange, onRemove }) {
  return (
    <div className="wvars-row">
      <span className="wvars-pill">$</span>
      <input
        className="wvars-name-input"
        value={value.name}
        onChange={e => onChange?.({ name: sanitiseName(e.target.value) })}
        placeholder="variable_name"
      />
      <select
        className="wvars-type-input"
        value={value.type || "string"}
        onChange={e => onChange?.({ type: e.target.value })}
        title="Type"
      >
        {TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>
      <input
        className="wvars-value-input"
        value={value.value || ""}
        onChange={e => onChange?.({ value: e.target.value })}
        placeholder={value.type === "boolean" ? "true / false" : value.type === "number" ? "0" : value.type === "json" ? "{}" : "value"}
      />
      <button type="button" className="wvars-remove" onClick={onRemove} title="Remove">×</button>
    </div>
  );
}

function ChevronIcon({ collapsed }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
         style={{ transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform 150ms" }}>
      <polyline points="6,9 12,15 18,9"/>
    </svg>
  );
}

function sanitiseName(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, "")
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+/g, "")
    .slice(0, 40);
}
