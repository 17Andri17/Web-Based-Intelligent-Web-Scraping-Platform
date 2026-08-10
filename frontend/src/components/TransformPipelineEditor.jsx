import { useMemo, useState } from "react";
import {
  CLEAN_OPS, CLEAN_OP_MAP,
  cleanValue, splitValue, effectiveFieldColumns, namedGroups,
} from "../workflow/fieldTransforms";
import "../styles/TransformPipelineEditor.css";

/* =====================================================================
   TransformPipelineEditor
   ---------------------------------------------------------------------
   A no-code (with an advanced JS escape hatch) editor for a single
   field's CLEAN pipeline + SPLIT spec. Used both inside the Extract
   List field editor and from the Data Preview "Clean" button.

   Props:
     fieldName   — the field's key (for the split-column hints)
     transforms  — array of clean ops (or undefined)
     split       — split spec (or null/undefined)
     allowSplit  — show the split section (default true). Off for single-value
                   extraction steps, whose output is a scalar with no columns.
     sample      — optional sample raw string to power the live tester
     onChange({ transforms, split })  — emit the updated pipeline
   ===================================================================== */

export default function TransformPipelineEditor({
  fieldName, transforms, split, sample, onChange, allowSplit = true,
}) {
  const ops = Array.isArray(transforms) ? transforms : [];
  const [adding, setAdding] = useState(false);
  const [test, setTest] = useState(sample != null ? String(sample) : "");

  const emit = (nextOps, nextSplit) =>
    onChange({
      transforms: nextOps && nextOps.length ? nextOps : undefined,
      split: nextSplit || undefined,
    });

  const setOps   = (next) => emit(next, split);
  const setSplit = (next) => emit(ops, next);

  const addOp = (opName) => {
    setAdding(false);
    if (!opName) return;
    setOps([...ops, { op: opName }]);
  };
  const updateOp = (i, patch) => setOps(ops.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));
  const removeOp = (i) => setOps(ops.filter((_, idx) => idx !== i));
  const moveOp   = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= ops.length) return;
    const next = ops.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setOps(next);
  };

  // ── Live tester ─────────────────────────────────────────────────────────
  const tester = useMemo(() => {
    if (test === "") return null;
    let cleaned;
    try { cleaned = cleanValue(test, ops); } catch (_e) { cleaned = "(error)"; }
    const parts = split ? safeSplit(cleaned, split) : null;
    return { cleaned, parts };
  }, [test, ops, split]);

  const splitCols = split ? effectiveFieldColumns(fieldName || "field", { split }) : [];

  return (
    <div className="tpe-root">
      {/* ── Clean pipeline ─────────────────────────────────────────── */}
      <div className="tpe-section">
        <div className="tpe-section-head">
          <span className="tpe-section-title">Clean steps</span>
          <span className="tpe-section-sub">Run top-to-bottom on the value</span>
        </div>

        {ops.length === 0 && (
          <div className="tpe-empty">No cleaning yet — add a step below.</div>
        )}

        <div className="tpe-ops">
          {ops.map((op, i) => {
            const def = CLEAN_OP_MAP[op.op];
            return (
              <div key={i} className="tpe-op">
                <div className="tpe-op-head">
                  <span className="tpe-op-idx">{i + 1}</span>
                  <span className="tpe-op-name">{def ? def.label : op.op}</span>
                  <div className="tpe-op-actions">
                    <button type="button" className="tpe-icon" disabled={i === 0} onClick={() => moveOp(i, -1)} title="Move up">↑</button>
                    <button type="button" className="tpe-icon" disabled={i === ops.length - 1} onClick={() => moveOp(i, 1)} title="Move down">↓</button>
                    <button type="button" className="tpe-icon tpe-icon--danger" onClick={() => removeOp(i)} title="Remove">×</button>
                  </div>
                </div>
                {def?.hint && <div className="tpe-op-hint">{def.hint}</div>}
                {def?.fields && def.fields.length > 0 && (
                  <div className="tpe-op-fields">
                    {def.fields.map((f) => (
                      <label key={f.key} className="tpe-field" style={f.width ? { flex: `0 0 ${f.width}px` } : undefined}>
                        <span className="tpe-field-label">{f.label}</span>
                        {f.type === "textarea" ? (
                          <textarea
                            className="tpe-input tpe-input--mono"
                            rows={2}
                            value={op[f.key] ?? ""}
                            placeholder={f.placeholder || ""}
                            onChange={(e) => updateOp(i, { [f.key]: e.target.value })}
                          />
                        ) : (
                          <input
                            className={`tpe-input ${f.key === "pattern" ? "tpe-input--mono" : ""}`}
                            type={f.type === "number" ? "number" : "text"}
                            value={op[f.key] ?? ""}
                            placeholder={f.placeholder || ""}
                            onChange={(e) => updateOp(i, {
                              [f.key]: f.type === "number"
                                ? (e.target.value === "" ? undefined : Number(e.target.value))
                                : e.target.value,
                            })}
                          />
                        )}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {adding ? (
          <select
            className="tpe-add-select"
            autoFocus
            defaultValue=""
            onChange={(e) => addOp(e.target.value)}
            onBlur={() => setAdding(false)}
          >
            <option value="" disabled>Choose a cleaning step…</option>
            {groupOps(CLEAN_OPS).map(([group, items]) => (
              <optgroup key={group} label={group}>
                {items.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
              </optgroup>
            ))}
          </select>
        ) : (
          <button type="button" className="tpe-add-btn" onClick={() => setAdding(true)}>+ Add cleaning step</button>
        )}
      </div>

      {/* ── Split into columns ───────────────────────────────────────
          Hidden for single-value extraction (allowSplit={false}): a Get Text
          step produces one value, not a row, so there are no columns to split
          it into. */}
      {allowSplit && (
      <div className="tpe-section">
        <div className="tpe-section-head">
          <span className="tpe-section-title">Split into columns</span>
          <label className="tpe-toggle">
            <input
              type="checkbox"
              checked={!!split}
              onChange={(e) => setSplit(e.target.checked
                ? { mode: "delimiter", delimiter: ",", parts: ["part_1", "part_2"], trim: true }
                : null)}
            />
            <span>{split ? "On" : "Off"}</span>
          </label>
        </div>

        {split && (
          <div className="tpe-split">
            <div className="tpe-split-modes">
              <label className={`tpe-mode ${split.mode !== "regex" ? "is-active" : ""}`}>
                <input type="radio" name={`splitmode_${fieldName}`} checked={split.mode !== "regex"}
                  onChange={() => setSplit({ ...split, mode: "delimiter", delimiter: split.delimiter ?? "," })} />
                By delimiter
              </label>
              <label className={`tpe-mode ${split.mode === "regex" ? "is-active" : ""}`}>
                <input type="radio" name={`splitmode_${fieldName}`} checked={split.mode === "regex"}
                  onChange={() => setSplit({ ...split, mode: "regex", pattern: split.pattern ?? "" })} />
                By regex
              </label>
            </div>

            {split.mode === "regex" ? (
              <>
                <label className="tpe-field">
                  <span className="tpe-field-label">Pattern — use (?&lt;name&gt;…) groups for column names</span>
                  <input className="tpe-input tpe-input--mono" value={split.pattern ?? ""}
                    placeholder="(?<code>\\d+)\\s+(?<city>.+)"
                    onChange={(e) => setSplit({ ...split, pattern: e.target.value })} />
                </label>
                <div className="tpe-row">
                  <label className="tpe-field" style={{ flex: "0 0 80px" }}>
                    <span className="tpe-field-label">Flags</span>
                    <input className="tpe-input" value={split.flags ?? ""} placeholder="i"
                      onChange={(e) => setSplit({ ...split, flags: e.target.value })} />
                  </label>
                  {namedGroups(split.pattern || "").length === 0 && (
                    <label className="tpe-field">
                      <span className="tpe-field-label">Column names (numbered groups, comma-separated)</span>
                      <input className="tpe-input" value={(split.parts || []).join(", ")}
                        placeholder="first, second"
                        onChange={(e) => setSplit({ ...split, parts: parseNames(e.target.value) })} />
                    </label>
                  )}
                </div>
              </>
            ) : (
              <div className="tpe-row">
                <label className="tpe-field" style={{ flex: "0 0 130px" }}>
                  <span className="tpe-field-label">Delimiter</span>
                  <input className="tpe-input tpe-input--mono" value={split.delimiter ?? ""}
                    placeholder=", "
                    onChange={(e) => setSplit({ ...split, delimiter: e.target.value })} />
                </label>
                <label className="tpe-field">
                  <span className="tpe-field-label">Column names (comma-separated, in order)</span>
                  <input className="tpe-input" value={(split.parts || []).join(", ")}
                    placeholder="first_name, last_name"
                    onChange={(e) => setSplit({ ...split, parts: parseNames(e.target.value) })} />
                </label>
              </div>
            )}

            <label className="tpe-checkline">
              <input type="checkbox" checked={!!split.keepOriginal}
                onChange={(e) => setSplit({ ...split, keepOriginal: e.target.checked })} />
              Keep the original "{fieldName}" column too
            </label>

            {splitCols.length > 0 && (
              <div className="tpe-cols">
                Produces: {splitCols.map((c) => <code key={c} className="tpe-col-chip">{c}</code>)}
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {/* ── Live tester ────────────────────────────────────────────── */}
      <div className="tpe-section tpe-tester">
        <div className="tpe-section-head">
          <span className="tpe-section-title">Try it</span>
          <span className="tpe-section-sub">Paste a sample value</span>
        </div>
        <input className="tpe-input" value={test} placeholder="e.g. raw scraped value"
          onChange={(e) => setTest(e.target.value)} />
        {tester && (
          <div className="tpe-test-out">
            <div className="tpe-test-row">
              <span className="tpe-test-label">Cleaned</span>
              <span className="tpe-test-val">{fmt(tester.cleaned)}</span>
            </div>
            {tester.parts && Object.keys(tester.parts).map((k) => (
              <div className="tpe-test-row" key={k}>
                <span className="tpe-test-label">{k}</span>
                <span className="tpe-test-val">{fmt(tester.parts[k])}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function groupOps(list) {
  const map = new Map();
  for (const o of list) {
    if (!map.has(o.group)) map.set(o.group, []);
    map.get(o.group).push(o);
  }
  return Array.from(map.entries());
}

function parseNames(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, ""))
    .filter(Boolean);
}

function safeSplit(value, spec) {
  try { return splitValue(value, spec); } catch (_e) { return null; }
}

function fmt(v) {
  if (v === null || v === undefined) return "—";
  if (v === "") return "(empty)";
  return String(v);
}
