import React, { useEffect, useMemo, useRef, useState } from "react";

/* =====================================================================
   VariablePicker
   ---------------------------------------------------------------------
   ServiceNow-style "$" button + popover that lets a user click a
   variable to insert its reference into a text field. Handles:

     - Custom workflow variables (`{{my_var}}`)
     - Captured outputs (`{{products}}`)
     - Table columns via dot-walk (`{{products[*].link}}`)
     - Iteration variables visible inside loops (`{{product.link}}` when
       the editor is on a step nested inside a FOR_EACH that iterates
       over a captured-list)
     - Free search box that filters the tree by name / column

   Usage:

     <VariablePicker
       variables={…custom…}
       capturedOutputs={[{ name, type, columns?, stepId }, …]}
       iterationVars={[{ name, source, columns? }, …]}
       onPick={(ref) => insertAtCaret(ref)}
     />

   The picker renders as a small "$" button. Clicking it opens a
   floating panel anchored under the button. `onPick` is called with
   the string the user clicked (`{{name}}` or `{{table[*].col}}` etc.).
   ===================================================================== */

const TYPE_LABEL = {
  string:  "text",
  number:  "number",
  boolean: "yes/no",
  json:    "json",
  list:    "list",
  table:   "table",
  scalar:  "value",
};

// Each picker node carries a "kind" describing its run-time shape.
// `expectedKind` on the picker lets us flag references that look like
// type mismatches (a list ref dropped into a single-value field, or
// vice versa). The kinds intentionally collapse the JS type space to
// what matters for field assignment:
//   scalar = string / number / boolean
//   list   = array (of anything)
//   object = plain object / row
//   any    = unknown / freeform (e.g. raw JSON variable)
const COMPATIBLE = {
  // expected:  compatible kinds
  scalar: new Set(["scalar", "any"]),
  list:   new Set(["list",   "any"]),
  object: new Set(["object", "any"]),
  any:    new Set(["scalar", "list", "object", "any"]),
};
function isCompatible(expectedKind, refKind) {
  if (!expectedKind || expectedKind === "any") return true;
  const allowed = COMPATIBLE[expectedKind];
  return allowed ? allowed.has(refKind || "any") : true;
}

export default function VariablePicker({
  variables = [],
  capturedOutputs = [],
  iterationVars = [],
  onPick,
  expectedKind = "any",
}) {
  const [open, setOpen]     = useState(false);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState({});  // nodeKey → bool
  const rootRef = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Build the tree once per render
  const tree = useMemo(
    () => buildTree({ variables, capturedOutputs, iterationVars }),
    [variables, capturedOutputs, iterationVars]
  );

  const q = search.trim().toLowerCase();
  const filteredTree = q ? filterTree(tree, q) : tree;

  const handlePick = (ref) => {
    if (typeof onPick === "function") onPick(ref);
    setOpen(false);
  };

  return (
    <div className="vpick-root" ref={rootRef}>
      <button
        type="button"
        className={"vpick-btn" + (open ? " vpick-btn--open" : "")}
        onClick={() => setOpen(o => !o)}
        title="Insert a variable reference (click to pick a workflow variable, captured output or column)"
      >$</button>

      {open && (
        <div className="vpick-popover" role="menu">
          <div className="vpick-search-row">
            <input
              autoFocus
              type="text"
              className="vpick-search"
              placeholder="Search variables / columns…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          {filteredTree.length === 0 ? (
            <div className="vpick-empty">
              {variables.length + capturedOutputs.length + iterationVars.length === 0
                ? "No variables yet. Define one in the Workflow Variables panel, or label an extraction step to capture its output."
                : "No match. Try a different search."}
            </div>
          ) : (
            <ul className="vpick-tree">
              {filteredTree.map(group => (
                <GroupNode
                  key={group.id}
                  node={group}
                  expanded={expanded}
                  setExpanded={setExpanded}
                  onPick={handlePick}
                  expectedKind={expectedKind}
                />
              ))}
            </ul>
          )}

          <div className="vpick-tip">
            {expectedKind && expectedKind !== "any"
              ? <>This field expects a <strong>{expectedKindLabel(expectedKind)}</strong>. Mismatching references are dimmed — click to insert anyway.</>
              : <>Click a leaf to insert its reference at the cursor.</>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Tree nodes ─────────────────────────────────────────────────────── */

function GroupNode({ node, expanded, setExpanded, onPick, expectedKind }) {
  return (
    <li className="vpick-group">
      <div className="vpick-group-header">{node.label}</div>
      <ul>
        {node.children.map(child => (
          <Node
            key={child.id}
            node={child}
            depth={0}
            expanded={expanded}
            setExpanded={setExpanded}
            onPick={onPick}
            expectedKind={expectedKind}
          />
        ))}
      </ul>
    </li>
  );
}

function Node({ node, depth, expanded, setExpanded, onPick, expectedKind }) {
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  const isOpen = !!expanded[node.id];

  // Type compatibility: dim nodes whose ref-shape doesn't match the
  // field's expected kind, but still let the user click them (people
  // sometimes know better — e.g. they want a string version of a list
  // for logging). The tooltip explains the mismatch.
  const compatible = isCompatible(expectedKind, node.kind);
  const mismatchTip = !compatible
    ? `This is a ${kindLabel(node.kind)} but the field expects a ${kindLabel(expectedKind)}. Click to insert anyway.`
    : null;

  return (
    <li className="vpick-node">
      <div
        className="vpick-row"
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="vpick-chevron"
            onClick={() => setExpanded(s => ({ ...s, [node.id]: !s[node.id] }))}
            title={isOpen ? "Collapse" : "Expand"}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform 120ms" }}>
              <polyline points="9,6 15,12 9,18"/>
            </svg>
          </button>
        ) : (
          <span className="vpick-chevron-placeholder" />
        )}

        <button
          type="button"
          className={"vpick-leaf"
            + (node.disabled  ? " vpick-leaf--disabled"   : "")
            + (!compatible    ? " vpick-leaf--mismatch"   : "")}
          onClick={() => !node.disabled && onPick(node.ref)}
          disabled={!!node.disabled}
          title={node.disabled ? "Reference can't be inserted directly" : (mismatchTip || `Insert ${node.ref}`)}
        >
          <span className={"vpick-icon vpick-icon--" + (node.iconClass || "string")}>{node.icon || "$"}</span>
          <span className="vpick-name">{node.name}</span>
          {!compatible && <span className="vpick-mismatch-tag">type mismatch</span>}
          {node.typeLabel && <span className="vpick-type">{node.typeLabel}</span>}
        </button>
      </div>
      {hasChildren && isOpen && (
        <ul>
          {node.children.map(child => (
            <Node
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              setExpanded={setExpanded}
              onPick={onPick}
              expectedKind={expectedKind}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function kindLabel(k) {
  switch (k) {
    case "scalar": return "single value";
    case "list":   return "list";
    case "object": return "object";
    case "any":    return "any";
    default:       return "value";
  }
}
function expectedKindLabel(k) { return kindLabel(k); }

/* ── Tree shape: build groups ──────────────────────────────────────── */

function buildTree({ variables, capturedOutputs, iterationVars }) {
  const groups = [];

  if (iterationVars.length > 0) {
    groups.push({
      id: "iteration",
      label: "Iteration (current loop)",
      children: iterationVars.map(v => buildIterVarNode(v)),
    });
  }

  if (capturedOutputs.length > 0) {
    groups.push({
      id: "captured",
      label: "Captured outputs",
      children: capturedOutputs.map(v => buildCapturedNode(v)),
    });
  }

  if (variables.length > 0) {
    groups.push({
      id: "custom",
      label: "Custom variables",
      children: variables.map(v => buildCustomNode(v)),
    });
  }

  return groups;
}

function buildCustomNode(v) {
  // Custom variables are typed by the user. number/string/boolean → scalar;
  // json could be anything so we don't pretend to know.
  const kind = (v.type === "json") ? "any" : "scalar";
  return {
    id: `c:${v.name}`,
    name: v.name,
    icon: "$",
    iconClass: v.type || "string",
    typeLabel: TYPE_LABEL[v.type] || v.type,
    kind,
    ref: `{{${v.name}}}`,
  };
}

function buildCapturedNode(v) {
  const isTable = (v.type === "table" || v.type === "list") && Array.isArray(v.columns) && v.columns.length > 0;
  // The variable itself: a list/table → kind=list; anything else → scalar.
  const ownKind = (v.type === "list" || v.type === "table") ? "list" : "scalar";
  const node = {
    id: `cap:${v.name}`,
    name: v.name,
    icon: "▣",
    iconClass: v.type || "string",
    typeLabel: TYPE_LABEL[v.type] || v.type,
    kind: ownKind,
    ref: `{{${v.name}}}`,
  };
  if (isTable) {
    // {{table[*].col}} is the COLUMN — i.e. a list of scalars from each
    // row's `col`. That's a list ref, not a scalar.
    node.children = v.columns.filter(Boolean).map(col => ({
      id: `cap:${v.name}.${col}`,
      name: col,
      icon: "·",
      iconClass: "column",
      typeLabel: "column of " + (v.type || "list"),
      kind: "list",
      ref: `{{${v.name}[*].${col}}}`,
    }));
  }
  return node;
}

function buildIterVarNode(iv) {
  // iv: { name, source?, itemKind, columns?, sourceColumn?, loopType?, loopLabel? }
  const itemKind  = iv.itemKind || "unknown";
  const refKind   = itemKind === "row" ? "object"
                  : itemKind === "scalar" ? "scalar"
                  : "any";

  // Helpful, accurate type label so users know what their item REALLY is.
  // Always include "in loop: <label or type>" when we have it, so a step
  // nested in multiple loops can be visually disambiguated.
  let baseLabel;
  if (itemKind === "scalar") {
    baseLabel = iv.sourceColumn && iv.source
      ? `${iv.sourceColumn} from each ${iv.source}`
      : "loop value";
  } else if (itemKind === "row") {
    baseLabel = iv.source ? `row of ${iv.source}` : "loop row";
  } else {
    baseLabel = "loop item";
  }
  const loopTag = iv.loopLabel
    ? `from "${iv.loopLabel}"`
    : iv.loopType === "FOR_EACH_ELEMENTS" ? "from for-each-elements"
    : "from for-each";
  const typeLabel = `${baseLabel} · ${loopTag}`;

  const node = {
    id: `it:${iv.name}`,
    name: iv.name,
    icon: "→",
    iconClass: "iter",
    typeLabel,
    kind: refKind,
    ref: `{{${iv.name}}}`,
  };

  // Only expose `item.field` children when each iteration's item is
  // actually an object. For a column projection like
  // `{{exam_link[*].author_link}}`, the item is a STRING — surfacing
  // `item.author_link` was the bug the user hit.
  if (itemKind === "row" && Array.isArray(iv.columns) && iv.columns.length > 0) {
    node.children = iv.columns.filter(Boolean).map(col => ({
      id: `it:${iv.name}.${col}`,
      name: col,
      icon: "·",
      iconClass: "column",
      typeLabel: "field",
      kind: "scalar",
      ref: `{{${iv.name}.${col}}}`,
    }));
  }
  return node;
}

/* ── Search filter ─────────────────────────────────────────────────── */

function filterTree(tree, q) {
  const out = [];
  for (const group of tree) {
    const kept = (group.children || []).map(c => filterNode(c, q)).filter(Boolean);
    if (kept.length > 0) out.push({ ...group, children: kept });
  }
  return out;
}
function filterNode(node, q) {
  const hit = (node.name || "").toLowerCase().includes(q);
  const kids = (node.children || []).map(c => filterNode(c, q)).filter(Boolean);
  if (hit || kids.length > 0) return { ...node, children: kids };
  return null;
}
