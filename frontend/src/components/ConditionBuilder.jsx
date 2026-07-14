import React, { useState, useContext, useMemo } from "react";
import { WPCtx } from "./workflowPanelContext";
import "../styles/ConditionBuilder.css";

/* =====================================================================
   ConditionBuilder
   A no-code helper for the "Condition (JS expression)" fields used by
   If / Else, While, and Loop steps. Non-technical users pick a value, an
   operator, and (when needed) a comparison value; the builder compiles a
   correct JavaScript expression and writes it into the condition field.

   The plain-text code field is always shown beneath it ("edit as code"),
   so power users keep full expressiveness — the builder is scaffolding,
   the code is the source of truth.

   Props:
     onApply(expr)   set the condition field to the compiled expression
   Context (WPCtx): variables, availableCapturedOutputs — used to suggest
   left-hand values the user can compare against.
   ===================================================================== */

const OPERATORS = [
  { value: "contains",     label: "contains",           right: true,  build: (l, r) => `String(${l}).includes(${r})` },
  { value: "not_contains", label: "does not contain",   right: true,  build: (l, r) => `!String(${l}).includes(${r})` },
  { value: "equals",       label: "is equal to",        right: true,  build: (l, r) => `${l} == ${r}` },
  { value: "not_equals",   label: "is not equal to",    right: true,  build: (l, r) => `${l} != ${r}` },
  { value: "gt",           label: "is greater than",    right: true,  build: (l, r) => `Number(${l}) > Number(${r})` },
  { value: "gte",          label: "is at least",        right: true,  build: (l, r) => `Number(${l}) >= Number(${r})` },
  { value: "lt",           label: "is less than",       right: true,  build: (l, r) => `Number(${l}) < Number(${r})` },
  { value: "lte",          label: "is at most",         right: true,  build: (l, r) => `Number(${l}) <= Number(${r})` },
  { value: "empty",        label: "is empty",           right: false, build: (l)    => `!${l}` },
  { value: "not_empty",    label: "is not empty",       right: false, build: (l)    => `!!${l}` },
  { value: "exists",       label: "exists",             right: false, build: (l)    => `${l} != null` },
];

// Turn the comparison value the user typed into a safe JS literal: numbers
// and booleans pass through; anything else becomes a quoted string.
function rightLiteral(raw) {
  const t = String(raw ?? "").trim();
  if (t === "") return '""';
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  if (t === "true" || t === "false") return t;
  return JSON.stringify(t);
}

export default function ConditionBuilder({ onApply }) {
  const { variables = [], availableCapturedOutputs = [] } = useContext(WPCtx) || {};
  const [open, setOpen]   = useState(false);
  const [left, setLeft]   = useState("");
  const [op, setOp]       = useState("contains");
  const [right, setRight] = useState("");

  // Suggested left-hand values: workflow variables + captured extraction
  // outputs, plus a couple of common built-ins the runtime exposes.
  const suggestions = useMemo(() => {
    const out = [];
    for (const v of variables) if (v && v.name) out.push(v.name);
    for (const c of availableCapturedOutputs) {
      if (!c || !c.name) continue;
      // Lists/tables are most useful compared by their length.
      out.push(c.type === "list" || c.type === "table" ? `${c.name}.length` : c.name);
    }
    for (const b of ["results.length", "currentPage"]) if (!out.includes(b)) out.push(b);
    return out;
  }, [variables, availableCapturedOutputs]);

  const opDef = OPERATORS.find(o => o.value === op) || OPERATORS[0];
  const preview = left.trim()
    ? opDef.build(left.trim(), rightLiteral(right))
    : "";

  const apply = () => {
    if (!preview) return;
    onApply(preview);
    setOpen(false);
  };

  if (!open) {
    return (
      <button type="button" className="cb-open-btn" onClick={() => setOpen(true)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 3h18v4H3zM3 10h12v4H3zM3 17h18v4H3z"/>
        </svg>
        Build condition without code
      </button>
    );
  }

  return (
    <div className="cb-panel">
      <div className="cb-row">
        <input
          className="cb-input cb-left"
          list="cb-left-suggestions"
          value={left}
          onChange={e => setLeft(e.target.value)}
          placeholder="value (e.g. a variable)"
        />
        <datalist id="cb-left-suggestions">
          {suggestions.map(s => <option key={s} value={s} />)}
        </datalist>
        <select className="cb-input cb-op" value={op} onChange={e => setOp(e.target.value)}>
          {OPERATORS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {opDef.right && (
          <input
            className="cb-input cb-right"
            value={right}
            onChange={e => setRight(e.target.value)}
            placeholder="value"
          />
        )}
      </div>
      {preview && (
        <div className="cb-preview" title="This is the code the condition will use">
          <code>{preview}</code>
        </div>
      )}
      <div className="cb-actions">
        <button type="button" className="cb-btn cb-cancel" onClick={() => setOpen(false)}>Cancel</button>
        <button type="button" className="cb-btn cb-apply" onClick={apply} disabled={!preview}>Use this condition</button>
      </div>
    </div>
  );
}
