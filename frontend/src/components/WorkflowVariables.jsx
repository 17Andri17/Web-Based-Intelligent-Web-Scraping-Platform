import React, { useState } from "react";

/* =====================================================================
   WorkflowVariables
   ---------------------------------------------------------------------
   Compact, narrow-sidebar-friendly "Workflow Variables" panel. Two lists:

     1. Captured outputs — read-only, auto-derived from every named
        extraction step in the workflow tree. These ARE workflow
        variables — they end up as keys in the run's results JSON.

     2. Custom variables — user-defined inputs. Each editable card stacks
        its controls vertically so it (and the Add button) always fit,
        even in the narrow side column. All explanatory text lives behind
        the header "?" toggle so it never eats vertical space.

   Props:
     variables           Array<{name, value, type, description, input}>
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

const EMPTY_DRAFT = { name: "", value: "", type: "string", description: "", input: false };

export default function WorkflowVariables({
  variables = [],
  onAdd, onUpdate, onRemove,
  capturedOutputs = [],
  collapsed = false,
  onToggleCollapsed,
  layout = "top",   // "top" (legacy) | "side"
}) {
  const [adding, setAdding] = useState(false);
  const [draft,  setDraft]  = useState(EMPTY_DRAFT);
  const [showHelp, setShowHelp] = useState(false);

  const finishAdd = () => {
    const name = sanitiseName(draft.name);
    if (!name) return;
    onAdd?.({
      name,
      value:       draft.value,
      type:        draft.type,
      description: draft.description.trim(),
      input:       !!draft.input,
    });
    setDraft(EMPTY_DRAFT);
    setAdding(false);
  };
  const cancelAdd = () => { setDraft(EMPTY_DRAFT); setAdding(false); };

  // Side layout when collapsed: render a thin rail with a vertical
  // "Variables" label and a count badge — clicking re-opens the panel.
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
      {/* Header: collapse toggle + a "?" help toggle (help stays hidden
          until asked for, so the panel isn't dominated by prose). */}
      <div className="wvars-header">
        <button type="button" className="wvars-header-toggle" onClick={() => onToggleCollapsed?.()}>
          <ChevronIcon collapsed={collapsed} />
          <span className="wvars-title">Workflow Variables</span>
          <span className="wvars-count">
            {capturedOutputs.length + variables.length}
          </span>
        </button>
        {!collapsed && (
          <button
            type="button"
            className={"wvars-help-btn" + (showHelp ? " active" : "")}
            onClick={() => setShowHelp(h => !h)}
            title={showHelp ? "Hide help" : "Show help"}
            aria-label="Toggle help"
          >?</button>
        )}
      </div>

      {!collapsed && (
        <div className="wvars-body">
          {showHelp && <HelpCard />}

          {/* ── Captured outputs ─────────────────────────────────── */}
          <div className="wvars-section">
            <div className="wvars-section-title">
              <span>Captured outputs</span>
              <span className="wvars-section-count">{capturedOutputs.length}</span>
            </div>
            {capturedOutputs.length === 0 ? (
              <div className="wvars-empty">Name any extract step to capture it here.</div>
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
              <span className="wvars-section-count">{variables.length}</span>
            </div>

            {variables.length === 0 && !adding && (
              <div className="wvars-empty">No custom variables yet.</div>
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
              <div className="wvars-card wvars-card--adding">
                <div className="wvars-card-head">
                  <span className="wvars-pill" title={draft.input ? "Input variable" : "Custom variable"}>
                    {draft.input ? "⇥" : "$"}
                  </span>
                  <input
                    className="wvars-name-input"
                    autoFocus
                    placeholder="variable_name"
                    value={draft.name}
                    onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                    onKeyDown={e => { if (e.key === "Enter") finishAdd(); if (e.key === "Escape") cancelAdd(); }}
                  />
                  <button type="button" className="wvars-remove" onClick={cancelAdd} title="Cancel">×</button>
                </div>
                <div className="wvars-card-opts">
                  <select
                    className="wvars-type-input"
                    value={draft.type}
                    onChange={e => setDraft(d => ({ ...d, type: e.target.value }))}
                    title="Type"
                  >
                    {TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                  <label className="wvars-input-toggle" title="Input variable — supplied by the parent when this workflow runs as a subflow">
                    <input
                      type="checkbox"
                      checked={!!draft.input}
                      onChange={e => setDraft(d => ({ ...d, input: e.target.checked }))}
                    />
                    input
                  </label>
                </div>
                <input
                  className="wvars-value-input"
                  placeholder={draft.input ? "sample value (used while building)" : "value"}
                  value={draft.value}
                  onChange={e => setDraft(d => ({ ...d, value: e.target.value }))}
                  onKeyDown={e => { if (e.key === "Enter") finishAdd(); if (e.key === "Escape") cancelAdd(); }}
                />
                <button
                  type="button"
                  className="wvars-add-confirm"
                  onClick={finishAdd}
                  disabled={!draft.name.trim()}
                >Add variable</button>
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

/* ── Help card (only rendered when the header "?" is toggled on) ─────── */
function HelpCard() {
  return (
    <div className="wvars-help">
      <div className="wvars-help-block">
        <span className="wvars-help-tag">tip</span>
        <strong>Referencing variables</strong>
        <p>Use a variable anywhere a step takes text — selector, URL, type-text:</p>
        <ul className="wvars-help-list">
          <li><code>{"{{name}}"}</code> — a variable's value</li>
          <li><code>{"{{table.column}}"}</code> — a field of an object</li>
          <li><code>{"{{table[*].column}}"}</code> — that column from every row of a list</li>
        </ul>
        <p>Click a captured column chip below to copy its reference.</p>
      </div>
      <div className="wvars-help-block">
        <span className="wvars-help-tag wvars-help-tag--input">input</span>
        <strong>Input variables</strong>
        <p>
          Tick <em>input</em> to turn this workflow into a reusable, parameterised
          subflow. Build it once against the sample value; when another workflow
          runs it via <strong>Run Subflow</strong>, it maps its own data (e.g. a
          list column) onto each input — great for “one URL → visit
          {" "}<code>{"{{url}}"}</code>, <code>{"{{url}}/reviews"}</code>, …”.
        </p>
      </div>
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

/* ── Single editable custom-variable card (stacks vertically) ───────── */
function CustomVarRow({ value, onChange, onRemove }) {
  const isInput = !!value.input;
  return (
    <div className={"wvars-card" + (isInput ? " wvars-card--input" : "")}>
      <div className="wvars-card-head">
        <span className="wvars-pill" title={isInput ? "Input variable" : "Custom variable"}>{isInput ? "⇥" : "$"}</span>
        <input
          className="wvars-name-input"
          value={value.name}
          onChange={e => onChange?.({ name: sanitiseName(e.target.value) })}
          placeholder="variable_name"
        />
        <button type="button" className="wvars-remove" onClick={onRemove} title="Remove">×</button>
      </div>
      <div className="wvars-card-opts">
        <select
          className="wvars-type-input"
          value={value.type || "string"}
          onChange={e => onChange?.({ type: e.target.value })}
          title="Type"
        >
          {TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <label className="wvars-input-toggle" title="Input variable — supplied by the parent when this workflow runs as a subflow">
          <input
            type="checkbox"
            checked={isInput}
            onChange={e => onChange?.({ input: e.target.checked })}
          />
          input
        </label>
      </div>
      <input
        className="wvars-value-input"
        value={value.value || ""}
        onChange={e => onChange?.({ value: e.target.value })}
        placeholder={isInput
          ? "sample value (used while building)"
          : value.type === "boolean" ? "true / false" : value.type === "number" ? "0" : value.type === "json" ? "{}" : "value"}
        title={isInput ? "Sample value — used while building; the parent supplies the real value when run as a subflow" : undefined}
      />
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
