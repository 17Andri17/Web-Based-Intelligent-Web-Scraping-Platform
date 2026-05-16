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
};

export default function VariablePicker({
  variables = [],
  capturedOutputs = [],
  iterationVars = [],
  onPick,
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
                />
              ))}
            </ul>
          )}

          <div className="vpick-tip">
            Click a leaf to insert its reference at the cursor.
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Tree nodes ─────────────────────────────────────────────────────── */

function GroupNode({ node, expanded, setExpanded, onPick }) {
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
          />
        ))}
      </ul>
    </li>
  );
}

function Node({ node, depth, expanded, setExpanded, onPick }) {
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  const isOpen = !!expanded[node.id];

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
          className={"vpick-leaf" + (node.disabled ? " vpick-leaf--disabled" : "")}
          onClick={() => !node.disabled && onPick(node.ref)}
          disabled={!!node.disabled}
          title={node.disabled ? "Reference can't be inserted directly" : `Insert ${node.ref}`}
        >
          <span className={"vpick-icon vpick-icon--" + (node.iconClass || "string")}>{node.icon || "$"}</span>
          <span className="vpick-name">{node.name}</span>
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
            />
          ))}
        </ul>
      )}
    </li>
  );
}

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
  return {
    id: `c:${v.name}`,
    name: v.name,
    icon: "$",
    iconClass: v.type || "string",
    typeLabel: TYPE_LABEL[v.type] || v.type,
    ref: `{{${v.name}}}`,
  };
}

function buildCapturedNode(v) {
  const isTable = (v.type === "table" || v.type === "list") && Array.isArray(v.columns) && v.columns.length > 0;
  const node = {
    id: `cap:${v.name}`,
    name: v.name,
    icon: "▣",
    iconClass: v.type || "string",
    typeLabel: TYPE_LABEL[v.type] || v.type,
    ref: `{{${v.name}}}`,
  };
  if (isTable) {
    // For a table-shaped variable, two ways to dot-walk:
    //  - pick a column at the [*] level → inserts {{name[*].col}}
    //    (an array of that column's values, ideal for RUN_SUBFLOW
    //    iterate mode)
    //  - the whole variable is also clickable to insert {{name}}
    node.children = v.columns.filter(Boolean).map(col => ({
      id: `cap:${v.name}.${col}`,
      name: col,
      icon: "·",
      iconClass: "column",
      typeLabel: "column of " + (v.type || "list"),
      ref: `{{${v.name}[*].${col}}}`,
    }));
  }
  return node;
}

function buildIterVarNode(iv) {
  // iv: { name: 'product', source?: 'products', columns?: ['title','link'] }
  const node = {
    id: `it:${iv.name}`,
    name: iv.name,
    icon: "→",
    iconClass: "iter",
    typeLabel: iv.source ? `row of ${iv.source}` : "loop item",
    ref: `{{${iv.name}}}`,
  };
  if (Array.isArray(iv.columns) && iv.columns.length > 0) {
    node.children = iv.columns.filter(Boolean).map(col => ({
      id: `it:${iv.name}.${col}`,
      name: col,
      icon: "·",
      iconClass: "column",
      typeLabel: "field",
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
