import { useState, useMemo, useEffect } from "react";

// ─── Constants ───────────────────────────────────────────────────────────────

const EXTRACTION_TYPES = new Set([
  "EXTRACT_TEXT", "EXTRACT_ATTRIBUTE", "EXTRACT_HTML",
  "EXTRACT_TABLE", "EXTRACT_LIST", "EXTRACT_JSON",
]);
const LOOP_TYPES = new Set(["FOR_EACH_ELEMENTS", "FOR_EACH", "REPEAT", "WHILE"]);
const BRANCH_KEYS = ["body", "then", "else", "try", "catch"];

const TYPE_ICON = {
  EXTRACT_TEXT:      "Aa",
  EXTRACT_ATTRIBUTE: "🔗",
  EXTRACT_HTML:      "</>",
  EXTRACT_TABLE:     "⊞",
  EXTRACT_LIST:      "≡",
  EXTRACT_JSON:      "{}",
};

// ─── Tree walk → sections ────────────────────────────────────────────────────

function buildSections(steps) {
  const sections = [];
  for (const step of steps || []) {
    if (typeof step !== "object" || !step) continue;

    if (step.kind === "control" && LOOP_TYPES.has(step.type)) {
      // Collect direct extraction children from branch arrays only
      const columns = [];
      for (const key of BRANCH_KEYS) {
        if (Array.isArray(step[key])) {
          for (const s of step[key]) {
            if (s.kind === "action" && EXTRACTION_TYPES.has(s.type)) columns.push(s);
          }
        }
      }
      if (columns.length > 0) {
        sections.push({ kind: "table", loopStep: step, columns });
      }
      // Recurse into nested loops
      for (const key of BRANCH_KEYS) {
        if (Array.isArray(step[key])) {
          sections.push(...buildSections(step[key].filter(s => s.kind === "control")));
        }
      }
    } else if (step.kind === "action" && EXTRACTION_TYPES.has(step.type)) {
      sections.push({ kind: "field", step });
    }
  }
  return sections;
}

function countAll(steps) {
  let n = 0;
  for (const s of steps || []) {
    if (typeof s !== "object" || !s) continue;
    if (s.kind === "action" && EXTRACTION_TYPES.has(s.type)) n++;
    for (const key of BRANCH_KEYS) {
      if (Array.isArray(s[key])) n += countAll(s[key]);
    }
  }
  return n;
}

function countNamed(steps) {
  let n = 0;
  for (const s of steps || []) {
    if (typeof s !== "object" || !s) continue;
    if (s.kind === "action" && EXTRACTION_TYPES.has(s.type) && s.label?.trim()) n++;
    for (const key of BRANCH_KEYS) {
      if (Array.isArray(s[key])) n += countNamed(s[key]);
    }
  }
  return n;
}

// ─── Build table rows from previewData / execResults ────────────────────────

function buildRows(columns, loopStepId, execResults, previewData) {
  // 1. Post-run results (keyed by field label)
  if (execResults) {
    const arrays = columns.map(col => {
      if (!col.label?.trim()) return null;
      const val = execResults[col.label.trim()];
      if (Array.isArray(val)) return val.map(v => (v !== null && v !== undefined ? String(v) : null));
      if (val !== undefined && val !== null) return [String(val)];
      return null;
    });
    const rowCount = arrays.reduce((mx, a) => a ? Math.max(mx, a.length) : mx, 0);
    if (rowCount > 0) {
      return Array.from({ length: rowCount }, (_, i) => {
        const row = {};
        columns.forEach((col, ci) => {
          const a = arrays[ci];
          row[col.id] = a && a[i] !== undefined ? a[i] : null;
        });
        return row;
      });
    }
  }

  // 2. Live preview data from backend
  // Row count = length of the loop's previewElements (one per matched container)
  const loopPreview = previewData[loopStepId] || {};
  const elements    = loopPreview.previewElements || [];
  const rowCount    = Math.max(
    elements.length,
    ...columns.map(col => (previewData[col.id]?.previewValues || []).length)
  );

  if (rowCount > 0) {
    return Array.from({ length: rowCount }, (_, i) => {
      const row = {};
      columns.forEach(col => {
        const colPreview = previewData[col.id];
        if (colPreview?.previewValues?.length > 0) {
          // Per-row scoped value from backend (sub-selector inside each container)
          const v = colPreview.previewValues[i];
          row[col.id] = v !== null && v !== undefined ? String(v) : null;
        } else {
          row[col.id] = null;
        }
      });
      return row;
    });
  }

  return [];
}

// ─── Inline editable label ───────────────────────────────────────────────────

function EditableLabel({ value, placeholder, className, onCommit }) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(value || "");

  useEffect(() => { if (!editing) setDraft(value || ""); }, [value, editing]);

  const commit = () => { setEditing(false); onCommit(draft.trim()); };
  const onKey  = e => {
    if (e.key === "Enter")  commit();
    if (e.key === "Escape") { setDraft(value || ""); setEditing(false); }
  };

  if (editing) {
    return (
      <input
        className={`dp-inline-input ${className || ""}`}
        value={draft}
        placeholder={placeholder}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
        autoFocus
      />
    );
  }
  return (
    <button
      className={`dp-inline-label ${className || ""} ${value ? "has-value" : "empty"}`}
      onClick={() => setEditing(true)}
      title={value ? `Rename "${value}"` : placeholder}
    >
      {value || <span className="dp-label-hint">{placeholder}</span>}
    </button>
  );
}

// ─── Table section (ForEach loop) ────────────────────────────────────────────

function TableSection({ loopStep, columns, execResults, previewData, onUpdateLabel }) {
  const loopLabel =
    loopStep.type === "FOR_EACH_ELEMENTS" ? "For Each Element" :
    loopStep.type === "FOR_EACH"          ? "For Each Item"    :
    loopStep.type === "REPEAT"            ? `Repeat ${loopStep.params?.count || "N"} times` :
                                            "While Loop";

  const rows        = useMemo(
    () => buildRows(columns, loopStep.id, execResults, previewData),
    [columns, loopStep.id, execResults, previewData]
  );
  const unnamedCols = columns.filter(c => !c.label?.trim());
  const isLiveData  = execResults ? "results" : (rows.length > 0 ? "preview" : null);

  return (
    <div className="dp-section dp-section--table">
      <div className="dp-section-header">
        <div className="dp-section-header-left">
          <span className="dp-loop-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="17,1 21,5 17,9"/>
              <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
              <polyline points="7,23 3,19 7,15"/>
              <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
            </svg>
            {loopLabel}
          </span>
          <EditableLabel
            value={loopStep.label || ""}
            placeholder="Name this table…"
            className="dp-loop-label"
            onCommit={v => onUpdateLabel(loopStep.id, v)}
          />
          {isLiveData && (
            <span className={`dp-src-pill ${isLiveData === "results" ? "dp-src--results" : "dp-src--preview"}`}>
              {isLiveData === "results" ? "live results" : "dom preview"}
            </span>
          )}
        </div>
        <div className="dp-section-header-right">
          {rows.length > 0 && (
            <span className="dp-row-count">{rows.length} row{rows.length !== 1 ? "s" : ""}</span>
          )}
          {unnamedCols.length > 0 && (
            <span className="dp-unnamed-warn">⚠ {unnamedCols.length} unnamed</span>
          )}
        </div>
      </div>

      <div className="dp-table-scroll">
        <table className="dp-table">
          <thead className="dp-thead">
            <tr>
              <th className="dp-th dp-th--num">#</th>
              {columns.map(col => (
                <th key={col.id} className={`dp-th ${!col.label?.trim() ? "dp-th--unnamed" : ""}`}>
                  <div className="dp-th-inner">
                    <span className="dp-type-chip">{TYPE_ICON[col.type] || "◈"}</span>
                    <EditableLabel
                      value={col.label || ""}
                      placeholder="Name field…"
                      className="dp-col-label"
                      onCommit={v => onUpdateLabel(col.id, v)}
                    />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length > 0 ? rows.map((row, i) => (
              <tr key={i} className={`dp-tr ${i % 2 === 1 ? "dp-tr--alt" : ""}`}>
                <td className="dp-td dp-td--num">{i + 1}</td>
                {columns.map(col => {
                  const val = row[col.id];
                  return (
                    <td key={col.id} className="dp-td">
                      {val !== null && val !== undefined
                        ? <span className="dp-cell-val" title={val}>{val.length > 90 ? val.slice(0, 90) + "…" : val}</span>
                        : <span className="dp-cell-empty">—</span>
                      }
                    </td>
                  );
                })}
              </tr>
            )) : (
              <tr>
                <td colSpan={columns.length + 1} className="dp-td--hint">
                  {unnamedCols.length > 0
                    ? "Name your fields above, then run the workflow to see data here"
                    : "Run the workflow to populate this table"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {unnamedCols.length > 0 && (
        <div className="dp-table-tip">
          ↑ Click a column header to name it — names become keys in your exported rows
        </div>
      )}
    </div>
  );
}

// ─── Field section (standalone extraction) ───────────────────────────────────

function FieldSection({ step, execResults, previewData, onUpdateLabel }) {
  let val      = null;
  let notFound = false;

  // 1. Post-run result
  if (execResults && step.label?.trim()) {
    const r = execResults[step.label.trim()];
    if (r !== undefined && r !== null)
      val = Array.isArray(r) ? r.join(", ") : String(r);
  }

  // 2. Live preview from backend (populated after previewStep response)
  if (val === null) {
    const p = previewData[step.id];
    if (p?.notFound) {
      notFound = true;
    } else if (p?.previewValue !== undefined && p.previewValue !== "") {
      val = String(p.previewValue);
    } else if (Array.isArray(p?.previewValues) && p.previewValues.length > 0) {
      val = p.previewValues.filter(Boolean).join(", ");
    }
  }

  // 3. Captured at step-creation time (instant, before backend responds)
  if (val === null && !notFound && step.previewValue !== undefined && step.previewValue !== "") {
    val = String(step.previewValue);
  }

  const isLong = val && val.length > 160;
  const [expanded, setExpanded] = useState(false);
  const displayVal = isLong && !expanded ? val.slice(0, 160) + "…" : val;

  return (
    <div className={`dp-section dp-section--field ${step.label?.trim() ? "dp-section--named" : "dp-section--unnamed"}`}>
      <div className="dp-field-label-row">
        <EditableLabel
          value={step.label || ""}
          placeholder="Name this field…"
          className="dp-field-label"
          onCommit={v => onUpdateLabel(step.id, v)}
        />
        <span className="dp-field-type-tag">
          {TYPE_ICON[step.type] || "◈"}&nbsp;{step.type.replace("EXTRACT_", "").replace(/_/g, " ").toLowerCase()}
        </span>
      </div>
      {val !== null ? (
        <div className="dp-field-value-box">
          <span className="dp-field-value">{displayVal}</span>
          {isLong && (
            <button className="dp-expand-btn" onClick={() => setExpanded(e => !e)}>
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      ) : notFound ? (
        <div className="dp-field-not-found">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          Element not found on current page — may also be missing during execution
        </div>
      ) : (
        <div className="dp-field-no-value">Fetching preview…</div>
      )}
    </div>
  );
}

// ─── Root ────────────────────────────────────────────────────────────────────

export default function DataPreviewPanel({ steps, execResults, previewData = {}, onUpdateLabel }) {
  const sections = useMemo(() => buildSections(steps), [steps]);
  const total    = useMemo(() => countAll(steps), [steps]);
  const named    = useMemo(() => countNamed(steps), [steps]);
  const allDone  = total > 0 && named === total;

  if (total === 0) {
    return (
      <div className="dp-panel">
        <div className="dp-empty">
          <div className="dp-empty-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <path d="M3 9h18M9 21V9"/>
            </svg>
          </div>
          <h3>No data fields yet</h3>
          <p>In <strong>Live Browser</strong>, click an element and add an <em>Extraction</em> step. Fields appear here automatically — name them to shape your output.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="dp-panel">
      <div className="dp-topbar">
        <span className="dp-topbar-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>
          </svg>
          Data Preview
        </span>
        {allDone ? (
          <span className="dp-status dp-status--ok">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="20,6 9,17 4,12"/>
            </svg>
            All {total} fields named
          </span>
        ) : (
          <span className="dp-status dp-status--warn">{named}/{total} named</span>
        )}
      </div>

      <div className="dp-sections">
        {sections.map(section =>
          section.kind === "table" ? (
            <TableSection
              key={section.loopStep.id}
              loopStep={section.loopStep}
              columns={section.columns}
              execResults={execResults}
              previewData={previewData}
              onUpdateLabel={onUpdateLabel}
            />
          ) : (
            <FieldSection
              key={section.step.id}
              step={section.step}
              execResults={execResults}
              previewData={previewData}
              onUpdateLabel={onUpdateLabel}
            />
          )
        )}
      </div>
    </div>
  );
}