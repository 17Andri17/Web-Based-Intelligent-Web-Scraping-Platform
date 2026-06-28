import { useState, useMemo, useEffect } from "react";
import TransformPipelineEditor from "./TransformPipelineEditor";
import { fieldColumnDescriptors, hasPipeline } from "../workflow/fieldTransforms";
import { PAGINATION_CONTROL_TYPES } from "../workflow/controlDefinitions";

// ─── Constants ───────────────────────────────────────────────────────────────

const EXTRACTION_TYPES = new Set([
  "EXTRACT_TEXT", "EXTRACT_ATTRIBUTE", "EXTRACT_HTML",
  "EXTRACT_TABLE", "EXTRACT_LIST", "EXTRACT_JSON",
]);
// Loop types that produce a fixed-shape preview table — one row per
// matched element / iteration index. WHILE is intentionally excluded:
// it has no a-priori iteration count (it runs until a runtime
// condition flips), so we render its body inline instead of as a
// table that would always be empty.
const LOOP_TYPES = new Set(["FOR_EACH_ELEMENTS", "FOR_EACH", "REPEAT"]);
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

function buildSections(steps, inPagination = false) {
  const sections = [];
  // Tag each pushed section with whether it lives inside a pagination loop,
  // so the panel can show a "preview is the current page only" note. Steps
  // that already carry the flag (nested deeper) keep it.
  const tag = (section) => (inPagination ? { ...section, inPagination: true } : section);
  for (const step of steps || []) {
    if (typeof step !== "object" || !step) continue;

    const isPaginationLoop = step.kind === "control" && PAGINATION_CONTROL_TYPES.has(step.type);

    if (step.kind === "control" && (step.type === "WHILE" || isPaginationLoop)) {
      // WHILE / pagination loops have no fixed iteration count — render their
      // body inline so each extraction inside gets its own preview section
      // (the current page's data, just like a top-level extraction). For
      // pagination loops we flag those sections so the user knows the preview
      // reflects the current page only.
      for (const key of BRANCH_KEYS) {
        if (Array.isArray(step[key])) {
          sections.push(...buildSections(step[key], inPagination || isPaginationLoop));
        }
      }
    } else if (step.kind === "control" && LOOP_TYPES.has(step.type)) {
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
        sections.push(tag({ kind: "table", loopStep: step, columns }));
      }
      // Recurse into nested loops
      for (const key of BRANCH_KEYS) {
        if (Array.isArray(step[key])) {
          sections.push(...buildSections(step[key].filter(s => s.kind === "control"), inPagination));
        }
      }
    } else if (step.kind === "action" && step.type === "EXTRACT_LIST") {
      // EXTRACT_LIST renders as its own tabular section — columns come
      // from `params.fields` and rows from previewRows / execResults.
      sections.push(tag({ kind: "list", step }));
    } else if (step.kind === "action" && step.type === "EXTRACT_TABLE") {
      // EXTRACT_TABLE renders as a real grid — headers + rows from
      // previewTable (live) or execResults (post-run array of row objects).
      sections.push(tag({ kind: "tableExtract", step }));
    } else if (step.kind === "action" && step.type === "RUN_SUBFLOW") {
      // Subflow outputs can't be previewed live (they need a separate
      // page that we'd have to navigate during preview), but we DO know
      // they'll appear in the final results — surface that as a
      // placeholder card so users can see the shape of the output.
      sections.push(tag({ kind: "subflow", step }));
    } else if (step.kind === "action" && EXTRACTION_TYPES.has(step.type)) {
      sections.push(tag({ kind: "field", step }));
    }
  }
  return sections;
}

function countAll(steps) {
  let n = 0;
  for (const s of steps || []) {
    if (typeof s !== "object" || !s) continue;
    // Subflows count as "data producers" too — even though we can't
    // preview them, they will contribute keys to the final results JSON.
    if (s.kind === "action" && (EXTRACTION_TYPES.has(s.type) || s.type === "RUN_SUBFLOW")) n++;
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
    // RUN_SUBFLOW is "named" if it has a label or an outputVar.
    if (s.kind === "action" && s.type === "RUN_SUBFLOW" &&
        ((s.label && s.label.trim()) || (s.params?.outputVar && String(s.params.outputVar).trim()))) n++;
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

// ─── List section (EXTRACT_LIST) ─────────────────────────────────────────────
// One row per matched container, one column per declared field. Rows come
// from execResults[step.label] (after a run) or previewData[step.id].previewRows
// (live preview from the backend).

function ListSection({ step, execResults, previewData, onUpdateLabel, onUpdateParams }) {
  const fields = step.params?.fields && typeof step.params.fields === "object" ? step.params.fields : {};
  const editable = typeof onUpdateParams === "function";
  // Column descriptors expand split fields into their resulting columns while
  // remembering which source field each column came from.
  const colDescs = useMemo(() => fieldColumnDescriptors(fields), [fields]);

  // Which field's clean/split editor is open in the modal.
  const [cleanField, setCleanField] = useState(null);

  // Rename a field/column straight from the table header. Preserves column
  // order and refuses to overwrite an existing field. Rows keyed by the old
  // name go blank until the next preview/run regenerates them — expected.
  const renameField = (oldName, rawNew) => {
    const newName = sanitiseFieldName(rawNew);
    if (!newName || newName === oldName || fields[newName]) return;
    const next = {};
    for (const k of Object.keys(fields)) next[k === oldName ? newName : k] = fields[k];
    onUpdateParams(step.id, { fields: next });
  };

  const removeField = (name) => {
    if (!fields[name]) return;
    const next = { ...fields };
    delete next[name];
    onUpdateParams(step.id, { fields: next });
  };

  // Persist a field's clean/split pipeline from the modal editor.
  const setPipeline = (name, { transforms, split }) => {
    const raw = fields[name];
    const base = typeof raw === "string"
      ? { selector: raw, kind: "text", attribute: null }
      : { ...(raw || {}) };
    if (transforms && transforms.length) base.transforms = transforms; else delete base.transforms;
    if (split) base.split = split; else delete base.split;
    onUpdateParams(step.id, { fields: { ...fields, [name]: base } });
  };

  const cleanSpec = cleanField ? normaliseSpec(fields[cleanField]) : null;

  // Determine row source: execResults first (post-run), then live preview.
  let rows = [];
  let isLiveData = null;
  if (execResults && step.label?.trim()) {
    const r = execResults[step.label.trim()];
    if (Array.isArray(r) && r.length > 0 && typeof r[0] === "object") {
      rows = r;
      isLiveData = "results";
    }
  }
  if (rows.length === 0) {
    const pr = previewData[step.id]?.previewRows;
    if (Array.isArray(pr) && pr.length > 0) {
      rows = pr;
      isLiveData = "preview";
    }
  }

  const totalMatched = previewData[step.id]?.totalMatched;

  return (
    <div className="dp-section dp-section--table">
      <div className="dp-section-header">
        <div className="dp-section-header-left">
          <span className="dp-loop-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
              <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
            </svg>
            Extract List
          </span>
          <EditableLabel
            value={step.label || ""}
            placeholder="Name this list…"
            className="dp-loop-label"
            onCommit={v => onUpdateLabel(step.id, v)}
          />
          {isLiveData && (
            <span className={`dp-src-pill ${isLiveData === "results" ? "dp-src--results" : "dp-src--preview"}`}>
              {isLiveData === "results" ? "live results" : "dom preview"}
            </span>
          )}
        </div>
        <div className="dp-section-header-right">
          {rows.length > 0 && (
            <span className="dp-row-count">
              {rows.length} row{rows.length !== 1 ? "s" : ""}
              {totalMatched && totalMatched > rows.length ? ` of ${totalMatched}` : ""}
            </span>
          )}
        </div>
      </div>

      <div className="dp-table-scroll">
        {colDescs.length === 0 ? (
          <div className="dp-table-tip">
            No fields defined yet — open this step and click <strong>✨ Auto-detect fields</strong> or add some manually.
          </div>
        ) : (
          <table className="dp-table">
            <thead className="dp-thead">
              <tr>
                <th className="dp-th dp-th--num">#</th>
                {colDescs.map(desc => {
                  const c = desc.key;
                  const spec = fields[desc.fieldName];
                  const kind = typeof spec === "object" && spec ? (spec.kind || "text") : "text";
                  const piped = hasPipeline(spec);
                  return (
                    <th key={c} className="dp-th">
                      <div className="dp-th-inner">
                        <span className="dp-type-chip" title={kind}>{kindIcon(kind)}</span>
                        {desc.derived ? (
                          <span className="dp-col-label has-value" title={`Split from "${desc.fieldName}"`}>
                            {c}<span className="dp-col-derived">↳ {desc.fieldName}</span>
                          </span>
                        ) : editable ? (
                          <EditableLabel
                            value={c}
                            placeholder="Name field…"
                            className="dp-col-label"
                            onCommit={v => renameField(c, v)}
                          />
                        ) : (
                          <span className="dp-col-label has-value">{c}</span>
                        )}
                        {editable && (
                          <button
                            type="button"
                            className={`dp-col-clean ${piped ? "is-active" : ""}`}
                            title={`Clean / split "${desc.fieldName}"`}
                            onClick={() => setCleanField(desc.fieldName)}
                          >✨</button>
                        )}
                        {editable && !desc.derived && (
                          <button
                            type="button"
                            className="dp-col-remove"
                            title={`Delete field "${c}"`}
                            onClick={() => removeField(c)}
                          >×</button>
                        )}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.length > 0 ? rows.slice(0, 200).map((row, i) => (
                <tr key={i} className={`dp-tr ${i % 2 === 1 ? "dp-tr--alt" : ""}`}>
                  <td className="dp-td dp-td--num">{i + 1}</td>
                  {colDescs.map(desc => {
                    const c = desc.key;
                    const v = row && row[c];
                    if (v === null || v === undefined) {
                      return <td key={c} className="dp-td"><span className="dp-cell-empty">—</span></td>;
                    }
                    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
                    return (
                      <td key={c} className="dp-td">
                        <span className="dp-cell-val" title={s}>{s.length > 90 ? s.slice(0, 90) + "…" : s}</span>
                      </td>
                    );
                  })}
                </tr>
              )) : (
                <tr>
                  <td colSpan={colDescs.length + 1} className="dp-td--hint">
                    No rows yet. Run the workflow, or make sure the container selector matches items on the live page.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {cleanField && cleanSpec && (
        <div className="dp-clean-overlay" onClick={e => { if (e.target === e.currentTarget) setCleanField(null); }}>
          <div className="dp-clean-modal">
            <div className="dp-clean-head">
              <span>Clean / split <code>{cleanField}</code></span>
              <button type="button" className="dp-clean-close" onClick={() => setCleanField(null)} title="Close">✕</button>
            </div>
            <div className="dp-clean-body">
              <TransformPipelineEditor
                fieldName={cleanField}
                transforms={cleanSpec.transforms}
                split={cleanSpec.split}
                sample={firstSample(rows, cleanField)}
                onChange={pipeline => setPipeline(cleanField, pipeline)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Normalise a raw field spec (string or object) for the transform editor.
function normaliseSpec(spec) {
  if (typeof spec === "string") return { selector: spec, kind: "text", attribute: null };
  return spec && typeof spec === "object" ? spec : {};
}

// Best-effort raw sample to seed the editor's live tester. After a field is
// split its original key is gone from the rows, so this is only a hint.
function firstSample(rows, fieldName) {
  for (const r of rows || []) {
    if (r && r[fieldName] != null) return String(r[fieldName]);
  }
  return "";
}

function kindIcon(kind) {
  if (kind === "attr") return "@";
  if (kind === "html") return "</>";
  return "Aa";
}

// Mirrors sanitiseFieldName in ExtractListFieldsEditor — keeps header renames
// producing the same snake_case keys the field editor and codegen expect.
function sanitiseFieldName(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, "")
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

// ─── Table-extract section (EXTRACT_TABLE) ───────────────────────────────────
// Renders the targeted <table> as a real grid. Two data sources, normalised
// to { headers: string[], rows: string[][] }:
//   • live preview  → previewData[id].previewTable { headers, rows, totalRows }
//   • post-run data → execResults[label]: array of row-objects (header mode)
//                     or array of cell-arrays (headerless mode)

function normaliseTableData(execRow, previewTable) {
  // 1. Post-run results take precedence.
  if (Array.isArray(execRow) && execRow.length > 0) {
    const first = execRow[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const headers = Object.keys(first);
      const rows = execRow.map(o => headers.map(h => {
        const v = o ? o[h] : null;
        return v === null || v === undefined ? null : (typeof v === "object" ? JSON.stringify(v) : String(v));
      }));
      return { headers, rows, source: "results", totalRows: rows.length };
    }
    if (Array.isArray(first)) {
      const rows = execRow.map(r => (Array.isArray(r) ? r.map(c => (c == null ? null : String(c))) : []));
      return { headers: [], rows, source: "results", totalRows: rows.length };
    }
  }
  // 2. Live DOM preview.
  if (previewTable && Array.isArray(previewTable.rows)) {
    return {
      headers: Array.isArray(previewTable.headers) ? previewTable.headers : [],
      rows: previewTable.rows.map(r => (Array.isArray(r) ? r.map(c => (c == null ? null : String(c))) : [])),
      source: "preview",
      totalRows: previewTable.totalRows ?? previewTable.rows.length,
    };
  }
  return null;
}

function TableExtractSection({ step, execResults, previewData, onUpdateLabel }) {
  const execRow = execResults && step.label?.trim() ? execResults[step.label.trim()] : null;
  const previewTable = previewData[step.id]?.previewTable || null;
  const previewError = previewData[step.id]?.previewError || null;

  const data = useMemo(
    () => normaliseTableData(execRow, previewTable),
    [execRow, previewTable]
  );

  const colCount = data
    ? Math.max(data.headers.length, ...data.rows.map(r => r.length), 1)
    : 1;
  const headers = data && data.headers.length > 0
    ? data.headers
    : Array.from({ length: colCount }, (_, i) => `Column ${i + 1}`);
  const shownRows = data ? data.rows.slice(0, 200) : [];

  return (
    <div className="dp-section dp-section--table">
      <div className="dp-section-header">
        <div className="dp-section-header-left">
          <span className="dp-loop-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/>
              <line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>
            </svg>
            Extract Table
          </span>
          <EditableLabel
            value={step.label || ""}
            placeholder="Name this table…"
            className="dp-loop-label"
            onCommit={v => onUpdateLabel(step.id, v)}
          />
          {data && (
            <span className={`dp-src-pill ${data.source === "results" ? "dp-src--results" : "dp-src--preview"}`}>
              {data.source === "results" ? "live results" : "dom preview"}
            </span>
          )}
        </div>
        <div className="dp-section-header-right">
          {data && data.rows.length > 0 && (
            <span className="dp-row-count">
              {data.rows.length} row{data.rows.length !== 1 ? "s" : ""}
              {data.totalRows > data.rows.length ? ` of ${data.totalRows}` : ""}
            </span>
          )}
        </div>
      </div>

      <div className="dp-table-scroll">
        <table className="dp-table">
          <thead className="dp-thead">
            <tr>
              <th className="dp-th dp-th--num">#</th>
              {headers.map((h, i) => (
                <th key={i} className="dp-th">
                  <div className="dp-th-inner">
                    <span className="dp-col-label has-value">{h || `Column ${i + 1}`}</span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shownRows.length > 0 ? shownRows.map((row, i) => (
              <tr key={i} className={`dp-tr ${i % 2 === 1 ? "dp-tr--alt" : ""}`}>
                <td className="dp-td dp-td--num">{i + 1}</td>
                {headers.map((_, ci) => {
                  const v = row[ci];
                  if (v === null || v === undefined) {
                    return <td key={ci} className="dp-td"><span className="dp-cell-empty">—</span></td>;
                  }
                  const s = String(v);
                  return (
                    <td key={ci} className="dp-td">
                      <span className="dp-cell-val" title={s}>{s.length > 90 ? s.slice(0, 90) + "…" : s}</span>
                    </td>
                  );
                })}
              </tr>
            )) : (
              <tr>
                <td colSpan={headers.length + 1} className="dp-td--hint">
                  {previewError
                    ? `Couldn't read the table: ${previewError}`
                    : "Run the workflow, or make sure the selector points at a table on the live page"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Subflow section (RUN_SUBFLOW placeholder) ─────────────────────────────
// We can't run a subflow at preview time (it would open a new page and
// navigate away), so this section just SHOWS the user where the
// subflow's output will land in the final results JSON, with the key
// name and whether it'll be one record or an array (iterate mode).

function SubflowSection({ step, execResults, onUpdateLabel }) {
  const outKey = (step.params?.outputVar && String(step.params.outputVar).trim())
              || (step.label || "").trim()
              || `subflow_${step.params?.workflowId || ""}`;
  const isIterate = step.params?.mode === "iterate";

  // After a run we DO have data — fall through to a small record/array
  // preview if it landed on the configured key.
  let realData = null;
  if (execResults && execResults[outKey] !== undefined) {
    realData = execResults[outKey];
  }

  return (
    <div className="dp-section dp-section--subflow">
      <div className="dp-section-header">
        <div className="dp-section-header-left">
          <span className="dp-loop-badge" style={{ background: "rgba(126, 92, 255, 0.12)", color: "#a371f7" }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="9,18 15,12 9,6"/>
            </svg>
            Subflow
          </span>
          <EditableLabel
            value={step.label || ""}
            placeholder="Name this subflow step…"
            className="dp-loop-label"
            onCommit={v => onUpdateLabel(step.id, v)}
          />
          <span className="dp-src-pill dp-src--preview" style={{ background: "rgba(126, 92, 255, 0.08)", color: "#a371f7" }}>
            {realData != null ? "live results" : "filled at run-time"}
          </span>
        </div>
        <div className="dp-section-header-right">
          {isIterate
            ? <span className="dp-row-count">{Array.isArray(realData) ? `${realData.length} rec${realData.length === 1 ? "" : "s"}` : "list"}</span>
            : <span className="dp-row-count">single record</span>}
        </div>
      </div>
      <div className="dp-table-scroll" style={{ padding: "0 12px 12px" }}>
        <div style={{ fontSize: 12, color: "var(--text-secondary, #aaa)", padding: "10px 12px", border: "1px dashed var(--border-soft, #2a2a2a)", borderRadius: 6 }}>
          Output key: <code style={{ color: "var(--text-primary, #e6e6e6)" }}>{outKey}</code>
          <br/>
          {isIterate
            ? <>Each iteration's subflow result is appended to an array under this key.<br/>Source URLs: <code style={{ color: "var(--text-primary, #e6e6e6)" }}>{String(step.params?.urlList || "(none)").slice(0, 80)}</code></>
            : <>The subflow's whole <code>__results__</code> object lands under this key.</>}
        </div>
        {realData != null && (
          <pre style={{ fontSize: 11, maxHeight: 240, overflow: "auto", background: "var(--bg, #0e0e0e)", padding: 8, marginTop: 8 }}>
{JSON.stringify(realData, null, 2)}
          </pre>
        )}
      </div>
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

export default function DataPreviewPanel({ steps, execResults, previewData = {}, onUpdateLabel, onUpdateParams }) {
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
        {sections.map(section => {
          const key = section.loopStep?.id || section.step?.id;
          let node;
          if (section.kind === "table") {
            node = (
              <TableSection
                loopStep={section.loopStep}
                columns={section.columns}
                execResults={execResults}
                previewData={previewData}
                onUpdateLabel={onUpdateLabel}
              />
            );
          } else if (section.kind === "list") {
            node = (
              <ListSection
                step={section.step}
                execResults={execResults}
                previewData={previewData}
                onUpdateLabel={onUpdateLabel}
                onUpdateParams={onUpdateParams}
              />
            );
          } else if (section.kind === "tableExtract") {
            node = (
              <TableExtractSection
                step={section.step}
                execResults={execResults}
                previewData={previewData}
                onUpdateLabel={onUpdateLabel}
              />
            );
          } else if (section.kind === "subflow") {
            node = (
              <SubflowSection
                step={section.step}
                execResults={execResults}
                onUpdateLabel={onUpdateLabel}
              />
            );
          } else {
            node = (
              <FieldSection
                step={section.step}
                execResults={execResults}
                previewData={previewData}
                onUpdateLabel={onUpdateLabel}
              />
            );
          }
          // Steps inside a pagination loop preview only the current page —
          // surface that so the data isn't mistaken for the full crawl.
          if (section.inPagination) {
            return (
              <div key={key} className="dp-section-wrap dp-section-wrap--pagination">
                <div className="dp-pagination-note" title="This step runs inside a pagination loop. The preview reflects the current page only; running the workflow collects every page.">
                  <span className="dp-pagination-note-icon">↻</span>
                  Inside a pagination loop — preview shows the current page only.
                </div>
                {node}
              </div>
            );
          }
          return <div key={key}>{node}</div>;
        })}
      </div>
    </div>
  );
}