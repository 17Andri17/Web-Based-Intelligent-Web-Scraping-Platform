import { useState, useCallback, useContext, useRef, useMemo } from "react";
import React from "react";
import { actionDefinitions } from "../actions/actionDefinitions";
import { controlDefinitions, isControlStep, isPaginationStep, PAGINATION_CONTROL_TYPES } from "../workflow/controlDefinitions";
import { createAction, createControl } from "../workflow/stepFactory";
import { DndContext, DragOverlay, useDroppable, useDraggable, closestCenter } from "@dnd-kit/core";
import { findStepLocation, attachedGroupSize } from "../workflow/useWorkflow";
import ExtractListFieldsEditor from "./ExtractListFieldsEditor";
import WorkflowVariables from "./WorkflowVariables";
import VariablePicker from "./VariablePicker";
import ConditionBuilder from "./ConditionBuilder";
import { WPCtx } from "./workflowPanelContext";
import "../styles/ExtractListFieldsEditor.css";
import "../styles/WorkflowVariables.css";
import "../styles/VariablePicker.css";
import "../styles/ConditionBuilder.css";

// Context shared across all step components (avoids prop drilling).
// Defined in ./workflowPanelContext so helper components can consume it
// without importing WorkflowPanel (which would be circular).

// Custom collision: only fire on dz: drop zones; pick nearest by center distance
function dzCollision(args) {
  const dzOnly = args.droppableContainers.filter(c => String(c.id).startsWith('dz:'));
  if (!dzOnly.length) return [];
  return closestCenter({ ...args, droppableContainers: dzOnly });
}

const EXTRACTION_TYPES = new Set([
  "EXTRACT_TEXT", "EXTRACT_ATTRIBUTE", "EXTRACT_HTML",
  "EXTRACT_TABLE", "EXTRACT_LIST", "EXTRACT_JSON", "COLLECT_LIST",
]);

// Walk the workflow tree and return every named extraction step as a
// captured-output variable. The variables panel uses this list to show
// users "what's being captured" + which columns table-shaped outputs
// expose, so dot-walking them via `{{name[*].column}}` is obvious.
function collectCapturedOutputs(steps) {
  const out = [];
  const seen = new Set();

  function columnsFromLoop(loopStep) {
    if (!Array.isArray(loopStep.body)) return [];
    const cols = [];
    for (const c of loopStep.body) {
      if (c && c.kind === "action" && EXTRACTION_TYPES.has(c.type)) {
        const lbl = (c.label || "").trim();
        if (lbl) cols.push(lbl);
      }
    }
    return cols;
  }

  function columnsFromExtractList(step) {
    const f = step.params && step.params.fields;
    if (!f || typeof f !== "object") return [];
    return Object.keys(f);
  }

  const walk = (arr) => {
    for (const s of arr || []) {
      if (!s || typeof s !== "object") continue;

      // FOR_EACH_ELEMENTS with extractions inside → a "table" variable
      if (s.kind === "control" && s.type === "FOR_EACH_ELEMENTS"
          && Array.isArray(s.body)
          && s.body.some(c => c?.kind === "action" && EXTRACTION_TYPES.has(c.type))) {
        const name = (s.label || "").trim();
        if (name && !seen.has(name)) {
          out.push({
            name, type: "table", stepId: s.id,
            columns: columnsFromLoop(s),
            included: (s.advanced && s.advanced.includeInOutput) !== false,
          });
          seen.add(name);
        }
      }
      // Standalone extraction → string / list / table / json
      else if (s.kind === "action" && EXTRACTION_TYPES.has(s.type)) {
        const name = (s.label || "").trim();
        if (name && !seen.has(name)) {
          const isList = s.type === "EXTRACT_LIST" || s.type === "EXTRACT_TABLE" || s.params?.multiple;
          const type   = isList ? (s.type === "EXTRACT_LIST" ? "list" : typeForExtractType(s.type)) : typeForExtractType(s.type);
          const columns = s.type === "EXTRACT_LIST"  ? columnsFromExtractList(s)
                        : s.type === "EXTRACT_TABLE" ? ["(table headers)"]
                        : [];
          out.push({
            name, type, stepId: s.id, columns,
            included: (s.advanced && s.advanced.includeInOutput) !== false,
          });
          seen.add(name);
        }
      }
      ["body", "then", "else", "try", "catch"].forEach(k => {
        if (Array.isArray(s[k])) walk(s[k]);
      });
    }
  };
  walk(steps);
  return out;
}
function typeForExtractType(t) {
  switch (t) {
    case "EXTRACT_ATTRIBUTE": return "string";
    case "EXTRACT_HTML":      return "string";
    case "EXTRACT_TABLE":     return "table";
    case "EXTRACT_LIST":      return "list";
    case "EXTRACT_JSON":      return "json";
    default:                  return "string";
  }
}

// For a given step id, return all iteration variables visible to it
// (i.e. the itemVar of every enclosing FOR_EACH / FOR_EACH_ELEMENTS).
// Each entry tells the picker what the iteration item ACTUALLY is —
// a row of a captured table, or a scalar (when the source was a
// column-projection like {{products[*].link}}), or unknown — so the
// picker doesn't lie about object fields that won't exist at runtime.
//
// Shape: { name, source, sourceColumn?, itemKind: 'row'|'scalar'|'unknown', columns? }
function iterationVarsForStep(steps, stepId, capturedOutputs) {
  const out = [];
  const colsByName = {};
  for (const c of capturedOutputs || []) colsByName[c.name] = c.columns;

  function walk(arr, ancestors) {
    for (const s of arr || []) {
      if (!s || typeof s !== "object") continue;
      if (s.id === stepId) { out.push(...ancestors); return true; }

      let here = ancestors;
      if (s.kind === "control" && (s.type === "FOR_EACH" || s.type === "FOR_EACH_ELEMENTS")) {
        const itemVar = s.params?.itemVar
          || (s.type === "FOR_EACH_ELEMENTS" ? "el" : "item");
        const loopLabel = s.label?.trim() || "";

        // FOR_EACH_ELEMENTS iterates over DOM nodes — rows aren't from a
        // captured table; the columns are the labels of its own body's
        // extraction steps. Synthesize a "row" with those columns.
        let itemEntry;
        if (s.type === "FOR_EACH_ELEMENTS") {
          const innerCols = (s.body || [])
            .filter(c => c && c.kind === "action" && EXTRACTION_TYPES.has(c.type))
            .map(c => (c.label || "").trim())
            .filter(Boolean);
          itemEntry = {
            name: itemVar,
            source: loopLabel || null,
            itemKind: "row",
            columns: innerCols.length ? innerCols : null,
            loopType: "FOR_EACH_ELEMENTS",
            loopLabel,
          };
        } else {
          // FOR_EACH iterates over whatever `params.source` evaluates to.
          // The shape of each item depends on the source expression:
          //   - {{table}}            → item is a row of `table`
          //   - {{table[*]}}         → item is a row of `table`
          //   - {{table[*].col}}     → item is the value of `col` (scalar)
          //   - raw identifier       → item is a row if the identifier
          //                            names a captured table, else
          //                            unknown
          const sourceRaw = s.params?.source || "";
          const info = analyseSourceExpr(sourceRaw, colsByName);
          itemEntry = {
            name: itemVar,
            source: info.rootName || null,
            sourceColumn: info.projectedColumn || null,
            itemKind: info.itemKind,
            columns: info.itemKind === "row" ? (colsByName[info.rootName] || null) : null,
            loopType: "FOR_EACH",
            loopLabel,
            sourceRaw,
          };
        }
        // Also expose the loop's index counter so it can be referenced
        // (e.g. {{index}} / {{i}}) just like the item variable. Push index
        // before item so the final reverse lists item first, index second.
        const idxVar = s.params?.indexVar || (s.type === "FOR_EACH_ELEMENTS" ? "i" : "index");
        here = [...ancestors, {
          name: idxVar, itemKind: "scalar", role: "index",
          loopType: s.type, loopLabel,
        }, itemEntry];
      } else if (s.kind === "control" && s.type === "REPEAT") {
        // REPEAT exposes its 0-based index counter so steps inside can
        // reference it (e.g. build a page URL from {{i}}).
        const idxVar = s.params?.indexVar || "i";
        here = [...ancestors, {
          name: idxVar, itemKind: "scalar", role: "index",
          loopType: "REPEAT", loopLabel: s.label?.trim() || "",
        }];
      }
      for (const key of ["body", "then", "else", "try", "catch"]) {
        if (Array.isArray(s[key])) {
          if (walk(s[key], here)) return true;
        }
      }
    }
    return false;
  }
  walk(steps, []);
  // Reverse so the INNERMOST loop's iteration variable is listed first.
  // That's the one the user just nested into; the outer ones are still
  // there but visually below — making it obvious which `item` belongs
  // to which loop when steps are nested several levels deep.
  return out.slice().reverse();
}

// Inspect a FOR_EACH source expression to decide what each iteration's
// item will be. Returns { rootName, projectedColumn, itemKind }.
function analyseSourceExpr(raw, colsByName) {
  if (typeof raw !== "string" || !raw.trim()) {
    return { rootName: "", projectedColumn: null, itemKind: "unknown" };
  }
  const m = /\{\{\s*([a-zA-Z_$][\w$]*)(\[\*\])?((?:\.[a-zA-Z_$][\w$]*)*)\s*\}\}/.exec(raw);
  if (m) {
    const root = m[1];
    const hasStar = !!m[2];
    const path = m[3] ? m[3].slice(1).split(".") : [];
    if (hasStar && path.length > 0) {
      // {{table[*].col}} → each item is the column value (scalar)
      return { rootName: root, projectedColumn: path.join("."), itemKind: "scalar" };
    }
    // {{table}} / {{table[*]}} / {{table.col}} → each item is a row of `table`
    return { rootName: root, projectedColumn: null, itemKind: "row" };
  }
  // Raw identifier — if it names a captured table, item is a row;
  // otherwise we can't be sure.
  const m2 = /^([a-zA-Z_$][\w$]*)/.exec(raw.trim());
  if (m2) {
    const root = m2[1];
    return {
      rootName: root,
      projectedColumn: null,
      itemKind: Array.isArray(colsByName[root]) ? "row" : "unknown",
    };
  }
  return { rootName: "", projectedColumn: null, itemKind: "unknown" };
}

/* ── Icons ── */
function DragDotsIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>; }
function ChevronIcon({ open }) { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transform: open ? "rotate(0)" : "rotate(-90deg)", transition: "200ms" }}><polyline points="6,9 12,15 18,9"/></svg>; }
function EditIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>; }
function TrashIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>; }
function PlusIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>; }
function ActionIcon({ type }) {
  const map = {
    NAVIGATE: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>,
    CLICK_ELEMENT: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="M13 13l6 6"/></svg>,
    DISMISS_COOKIE_BANNER: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><circle cx="9" cy="9.5" r="0.6" fill="currentColor"/><circle cx="14.5" cy="13.5" r="0.6" fill="currentColor"/><circle cx="12" cy="7" r="0.6" fill="currentColor"/><circle cx="8.5" cy="14.5" r="0.6" fill="currentColor"/><circle cx="13" cy="17" r="0.6" fill="currentColor"/></svg>,
    EXTRACT_TEXT: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
    TYPE_TEXT: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4,7 4,4 20,4 20,7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>,
    WAIT: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>,
    SAVE_DATA: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17,21 17,13 7,13 7,21"/><polyline points="7,3 7,8 15,8"/></svg>,
    SET_VARIABLE: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>,
  };
  return map[type] || <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>;
}

/* ── Helpers ── */
// Find a step object anywhere in the tree by id (branches included).
function findStepById(arr, id) {
  for (const s of arr || []) {
    if (!s || typeof s !== "object") continue;
    if (s.id === id) return s;
    for (const k of ["body", "then", "else", "try", "catch"]) {
      if (Array.isArray(s[k])) { const f = findStepById(s[k], id); if (f) return f; }
    }
  }
  return null;
}

function buildDefaultParams(def) {
  const p = {};
  for (const [k, v] of Object.entries(def.inputs || {})) {
    if (v.default !== undefined) { p[k] = v.default; continue; }
    if (v.type === "array" || v.type === "selectorList") { p[k] = []; continue; }
    p[k] = "";
  }
  return p;
}
function buildDefaultAdvanced(def) {
  const a = {};
  for (const [k, v] of Object.entries(def.advanced || {})) if (v.default !== undefined) a[k] = v.default;
  return a;
}
// Declarative field visibility: a field def may carry `showIf: { otherField:
// [allowedValues] }`. The field renders only when EVERY listed sibling param
// matches one of its allowed values. A missing/empty value falls back to that
// sibling's declared default, so newly-added fields behave sensibly for steps
// saved before the field existed. Used to keep RUN_SUBFLOW's mode-specific
// fields (single / iterate / enrich) from all showing at once.
function fieldVisible(spec, inputs, step) {
  const cond = spec && spec.showIf;
  if (!cond) return true;
  const params = step?.params || {};
  return Object.entries(cond).every(([field, allowed]) => {
    const def = inputs?.[field];
    let val = params[field];
    if (val === undefined || val === "") val = def?.default ?? "";
    const list = Array.isArray(allowed) ? allowed : [allowed];
    return list.includes(val);
  });
}
function summariseParams(step, ctx = {}) {
  // RUN_SUBFLOW: resolve the workflowId to a name from the available
  // workflows list (when we have it) so the card reads as
  // "subflow: Product Detail · url list: {{products[*].link}}"
  // instead of the useless numeric id.
  if (step.type === "RUN_SUBFLOW") {
    const out = [];
    const id = step.params?.workflowId;
    if (id != null) {
      const wf = (ctx.availableWorkflows || []).find(w => w.id === id);
      out.push(["subflow", wf ? wf.name : `#${id}`]);
    }
    const mode = step.params?.mode || "single";
    if (mode === "iterate") {
      out.push(["mode", "iterate"]);
      if (step.params?.urlList) out.push(["url list", String(step.params.urlList)]);
    } else if (mode === "enrich") {
      out.push(["mode", "enrich"]);
      if (step.params?.sourceList) out.push(["enrich", String(step.params.sourceList)]);
      if (step.params?.mergeStrategy) out.push(["merge", String(step.params.mergeStrategy)]);
    } else if (step.params?.url) {
      out.push(["url", String(step.params.url)]);
    }
    return out;
  }
  // The cookie-banner step's params are mostly plumbing (selectorType,
  // fallbacks) — say what it will actually do instead.
  if (step.type === "DISMISS_COOKIE_BANNER") {
    return step.params?.selector
      ? [["selector", String(step.params.selector)]]
      : [["detection", "automatic"]];
  }
  // EXTRACT_LIST cards summarise specially: show the container selector
  // plus the comma-separated field names, so the user can see "what
  // they're extracting" at a glance without expanding the editor.
  if (step.type === "EXTRACT_LIST" || step.type === "COLLECT_LIST") {
    const out = [];
    if (step.params?.containerSelector) {
      out.push(["container", String(step.params.containerSelector)]);
    }
    const f = step.params?.fields || {};
    const names = Object.keys(f);
    if (names.length) {
      out.push(["fields", `${names.length} (${names.slice(0, 4).join(", ")}${names.length > 4 ? "…" : ""})`]);
    }
    if (step.type === "COLLECT_LIST") {
      out.push(["mode", "scroll-collect"]);
      if (step.params?.keyField) out.push(["key", String(step.params.keyField)]);
    }
    return out;
  }
  const entries = Object.entries(step.params || {}).filter(([, v]) => v !== null && v !== "" && v !== undefined && !(Array.isArray(v) && !v.length) && !(typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0));
  return entries.slice(0, 2).map(([k, v]) => {
    if (Array.isArray(v)) return [k, v.join(", ")];
    if (typeof v === "object") return [k, `${Object.keys(v).length} entries`];
    return [k, String(v)];
  });
}
function buildControlSummary(step, def) {
  const key = Object.keys(def.params || {})[0];
  if (!key) return null;
  const val = step.params?.[key];
  if (!val && val !== 0) return null;
  const s = String(val);
  return s.slice(0, 56) + (s.length > 56 ? "…" : "");
}

// Human-readable one-liner describing how a native pagination container is
// configured — shown under its header so the loop reads as a single
// semantic step instead of a raw selector / number dump.
function paginationConfigSummary(step) {
  const p = step.params || {};
  switch (step.type) {
    case "PAGINATE_SCROLL":
      return `scrolls until ${p.maxNoChange ?? 3} scrolls add nothing new`;
    case "PAGINATE_BUTTON":
      return p.selector
        ? `clicks “${String(p.selector).slice(0, 40)}” until it disappears`
        : "clicks the next button until it disappears";
    case "PAGINATE_URL":
      return p.urlPattern
        ? `opens ${String(p.urlPattern).slice(0, 44)} until a page has no “${String(p.contentSelector || "…").slice(0, 24)}”`
        : "opens pages by URL until one has no content";
    default:
      return null;
  }
}

/* Build a CUSTOM_ACTION workflow step from a user's custom action definition.
   The step references the action by id and stores user-supplied input values;
   the backend resolves the latest code at execution time. */
function buildCustomActionStep(action) {
  const inputs = {};
  (action.inputs || []).forEach(inp => {
    inputs[inp.name] =
      inp.type === "number"  ? 0 :
      inp.type === "boolean" ? false :
      inp.type === "json"    ? "{}" :
                                "";
  });
  return {
    id:       crypto.randomUUID(),
    kind:     'action',
    type:     'CUSTOM_ACTION',
    label:    action.name,
    params:   { actionId: action.id, inputs },
    advanced: {},
    outputVar: null,
  };
}

/* =====================================================================  MAIN PANEL */
export default function WorkflowPanel({
  steps, totalCount, onAdd, onUpdate, onDelete, onReorder, setSteps,
  insertTarget, onSetInsertTarget, onMoveStep, onToggleAttach, customActions = [],
  offStartUrl = false, pinnedUrl = "", currentPageUrl = "", onReturnToStart,
  socket = null, previewData = {},
  variables = [], onVariablesChange,
  variablesCollapsed = false, onToggleVariablesCollapsed,
  availableWorkflows = [], currentWorkflowId = null,
  listPickStepId = null, onStartListPick, onStopListPick,
}) {
  const [pickerCtx, setPickerCtx]   = useState(null);
  const [editingCtx, setEditingCtx] = useState(null);
  const [activeId,   setActiveId]   = useState(null);

  const handleDragEnd = useCallback(({ active, over }) => {
    setActiveId(null);
    if (!over) return;
    const activeStr = String(active.id);
    const overStr   = String(over.id);
    if (!overStr.startsWith('dz:')) return; // only InsertRow zones are valid drop targets
    const srcLoc = findStepLocation(steps, activeStr);
    if (!srcLoc) return;
    // Attached followers (step.attach — e.g. Close Cookie Banner stuck to
    // its Navigate) travel with the dragged step as one block.
    const groupSize = attachedGroupSize(steps, activeStr);
    try {
      const { cp, idx } = JSON.parse(overStr.slice(3));
      // No-op: dropping onto any slot the group already occupies or borders.
      const sameContainer = JSON.stringify(srcLoc.containerPath) === JSON.stringify(cp);
      if (sameContainer && idx >= srcLoc.index && idx <= srcLoc.index + groupSize) return;
      // moveStepById handles both same-container reorders and cross-level
      // moves (with block-aware index adjustment).
      onMoveStep && onMoveStep(activeStr, cp, idx !== null && idx !== undefined ? idx : undefined, groupSize);
      // A dragged step that was itself attached has left its leader — detach.
      const srcStep = findStepById(steps, activeStr);
      if (srcStep?.attach && onToggleAttach) onToggleAttach(activeStr, false);
    } catch(e) { console.error('DnD error', e); }
  }, [steps, onMoveStep, onToggleAttach]);

  const flatAll = React.useMemo(() => {
    const out = [];
    function walk(arr) { (arr||[]).forEach(s => { out.push(s); ['body','then','else','try','catch'].forEach(k => { if(Array.isArray(s[k])) walk(s[k]); }); }); }
    walk(steps); return out;
  }, [steps]);
  const activeStep = activeId ? flatAll.find(s => s.id === activeId) : null;
  // "+N attached" badge on the drag ghost when the dragged step carries followers.
  const activeGroupExtra = activeId ? attachedGroupSize(steps, activeId) - 1 : 0;
  const capturedOutputs = React.useMemo(() => collectCapturedOutputs(steps), [steps]);

  return (
    <WPCtx.Provider value={{ insertTarget, onSetInsertTarget, onMoveStep, onToggleAttach, activeId, customActions, socket, previewData, availableWorkflows, currentWorkflowId, variables, availableCapturedOutputs: capturedOutputs, steps, listPickStepId, onStartListPick, onStopListPick }}>
    <div className="workflow-designer">
      <div className="workflow-header">
        <div className="workflow-title">
          <h2>Flow Designer</h2>
          <span className="step-count">{totalCount} {totalCount === 1 ? "step" : "steps"}</span>
        </div>
        <div className="workflow-actions">
          <button className="header-btn secondary" onClick={() => setPickerCtx({ containerPath: [], index: null })}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Step
          </button>
        </div>
      </div>
      {offStartUrl && (
        <div className="wf-offstart-banner" title={`Steps added here will be recorded against the current page (${currentPageUrl}), but the workflow always starts from ${pinnedUrl}. Either return to the start URL or add a NAVIGATE step before these new actions.`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          </svg>
          <div className="wf-offstart-text">
            <strong>You're not on the workflow's start URL.</strong>
            <span>New steps will be recorded against <code>{currentPageUrl || "this page"}</code>, but the workflow starts from <code>{pinnedUrl}</code>.</span>
          </div>
          {onReturnToStart && (
            <button className="wf-offstart-btn" onClick={onReturnToStart}>Return to start</button>
          )}
        </div>
      )}
      <div className="workflow-layout">
      <div className="workflow-canvas-area">
      <div className="workflow-canvas">
        <div className="flow-container">
          <div className="flow-start">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
            Start
          </div>
          <div className="flow-connector" />
          {steps.length === 0 ? (
            <div className="empty-state">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5"/>
                <path d="M2 12l10 5 10-5"/>
              </svg>
              <h3>No steps yet</h3>
              <p>Build your workflow — add action steps and control blocks below.</p>
              <button className="add-step-btn" onClick={() => setPickerCtx({ containerPath: [], index: null })}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                Add First Step
              </button>
            </div>
          ) : (
            <DndContext collisionDetection={dzCollision}
              onDragStart={({ active }) => setActiveId(String(active.id))}
              onDragEnd={handleDragEnd}
              onDragCancel={() => setActiveId(null)}
            >
              <StepList steps={steps} containerPath={[]} depth={0}
                onPickerOpen={setPickerCtx} onEditOpen={setEditingCtx}
                onDelete={onDelete} onReorder={onReorder} />
              {/* Bottom "Add Step" — a plain button, not a drop target; StepList already
                  renders an InsertRow after the last step for dropping */}
              {!activeId && (
                <>
                  <div className="flow-connector" />
                  <button className="add-step-btn" onClick={() => setPickerCtx({ containerPath: [], index: null })}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Add Step
                  </button>
                  <div className="flow-connector" />
                  <div className="flow-end">End</div>
                </>
              )}
              <DragOverlay dropAnimation={null}>
                {activeStep ? (
                  <div className="step-card drag-ghost" style={{opacity:0.85,pointerEvents:'none'}}>
                    <div className="step-card-header">
                      <div className="step-icon"><ActionIcon type={activeStep.type} /></div>
                      <div className="step-info">
                        <div className="step-label">{
                          activeStep.type === "CUSTOM_ACTION"
                            ? (customActions.find(a => a.id === activeStep.params?.actionId)?.name || activeStep.label || "Custom action")
                            : (actionDefinitions[activeStep.type]?.label || activeStep.type?.replace(/_/g,' '))
                        }</div>
                      </div>
                      {activeGroupExtra > 0 && (
                        <span className="drag-ghost-attach-badge" title="Attached steps move along">
                          +{activeGroupExtra} attached
                        </span>
                      )}
                    </div>
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          )}
        </div>
      </div>
      </div> {/* /workflow-canvas-area */}
      <WorkflowVariables
        variables={variables}
        capturedOutputs={capturedOutputs}
        collapsed={variablesCollapsed}
        onToggleCollapsed={onToggleVariablesCollapsed}
        onAdd={(v) => onVariablesChange?.([...variables, v])}
        onUpdate={(i, patch) => onVariablesChange?.(variables.map((v, idx) => idx === i ? { ...v, ...patch } : v))}
        onRemove={(i) => onVariablesChange?.(variables.filter((_, idx) => idx !== i))}
        layout="side"
      />
      </div> {/* /workflow-layout */}

      {pickerCtx && (
        <StepPicker
          customActions={customActions}
          onSelect={(kind, type, extra) => {
            let step;
            if (kind === "control") {
              step = createControl(type);
            } else if (kind === "custom") {
              step = buildCustomActionStep(extra);
            } else {
              step = createAction(type, buildDefaultParams(actionDefinitions[type]), buildDefaultAdvanced(actionDefinitions[type]));
            }
            onAdd(step, pickerCtx.containerPath, pickerCtx.index);
            setPickerCtx(null);
            // Auto-point insert target inside any newly added loop
            const LOOP_TYPES = new Set(['FOR_EACH','FOR_EACH_ELEMENTS','WHILE','REPEAT',
              'PAGINATE_SCROLL','PAGINATE_BUTTON','PAGINATE_URL']);
            if (kind === "control" && LOOP_TYPES.has(type)) {
              onSetInsertTarget && onSetInsertTarget({ type: 'inside', stepId: step.id });
            }
          }}
          onClose={() => setPickerCtx(null)}
        />
      )}

      {editingCtx && (
        <StepEditorModal
          step={editingCtx.step}
          customActions={customActions}
          onClose={() => setEditingCtx(null)}
          onSave={(updated) => { onUpdate(editingCtx.containerPath, editingCtx.index, updated); setEditingCtx(null); }}
        />
      )}
    </div>
    </WPCtx.Provider>
  );
}

/* ── InsertRow: + button normally; always-visible drop zone during drag ── */
function InsertRow({ containerPath, index, onPickerOpen, isEnd = false }) {
  const { activeId } = useContext(WPCtx) || {};
  const isDragging = !!activeId;
  const dzId = `dz:${JSON.stringify({ cp: containerPath, idx: index })}`;
  const { setNodeRef, isOver } = useDroppable({ id: dzId });

  if (isDragging) {
    return (
      <div ref={setNodeRef}
        className={`insert-drop-zone${isOver ? ' insert-drop-zone--over' : ''}`}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        <span>{isOver ? 'Drop here' : 'Insert here'}</span>
      </div>
    );
  }

  if (isEnd) {
    return (
      <button className="add-step-btn" onClick={() => onPickerOpen({ containerPath, index: null })}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Add Step
      </button>
    );
  }

  return (
    <div className="step-insert-row">
      <button className="insert-between-btn" title="Insert step here"
        onClick={() => onPickerOpen({ containerPath, index })}>
        <PlusIcon />
      </button>
    </div>
  );
}

/* ── StepList (recursive) ── */
function StepList({ steps, containerPath, depth = 0, onPickerOpen, onEditOpen, onDelete, onReorder }) {
  const { activeId } = useContext(WPCtx) || {};
  const isDragging = !!activeId;

  // Index of the dragged step within THIS container (-1 if from another container)
  const draggedIdx = isDragging ? steps.findIndex(s => s.id === activeId) : -1;

  // A drop zone at position `zoneIdx` is redundant ONLY if it's immediately
  // before the dragged step (Zone[idx] and Zone[idx-1] are visually adjacent).
  // Zone[draggedIdx+1] stays visible — dropping there returns the step to its original position.
  const isNoOp = (zoneIdx) => draggedIdx >= 0 && zoneIdx === draggedIdx;

  // Don't allow ANY insertion above a pinned step (currently only the root-level
  // pinned NAVIGATE qualifies). The pinned step must always be first.
  const isRoot = containerPath.length === 0;
  const blockedBefore = (zoneIdx) => isRoot && zoneIdx === 0 && steps[0]?.pinned;

  // No insertion INSIDE an attached group either: the zone between a step
  // and an `attach` follower would split what's meant to move as one block.
  const insideGroup = (zoneIdx) => zoneIdx > 0 && zoneIdx < steps.length && !!steps[zoneIdx]?.attach;

  return (
    <div className="step-list">
      {/* Drop zone BEFORE first step */}
      {!isNoOp(0) && !blockedBefore(0) && (
        <InsertRow containerPath={containerPath} index={0} onPickerOpen={onPickerOpen} />
      )}

      {steps.map((step, index) => (
        <React.Fragment key={step.id}>
          {!isDragging && (
            index > 0 && step.attach
              ? <AttachLink />
              : <div className="flow-connector" />
          )}
          {isControlStep(step) ? (
            <DraggableControlBlock step={step} index={index} containerPath={containerPath} depth={depth}
              onPickerOpen={onPickerOpen} onEditOpen={onEditOpen} onDelete={onDelete} onReorder={onReorder} />
          ) : (
            <DraggableActionCard step={step} index={index} containerPath={containerPath} depth={depth}
              onEdit={() => onEditOpen({ containerPath, index, step })}
              onDelete={() => onDelete(containerPath, index)} />
          )}
          {/* Warning: any step placed AFTER a pagination loop runs only once
              pagination has finished — i.e. on whatever page it stopped on,
              not on every page. Surfaced whenever a pagination block has at
              least one following sibling (covers both "added after" and
              "reordered behind"). */}
          {!isDragging && isPaginationStep(step) && index < steps.length - 1 && (
            <div className="wf-after-pagination-note" role="note">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              </svg>
              <span>
                Steps below run <strong>after pagination finishes</strong> — on the last page it
                visited, not on every page. To collect data from each page, drag those steps
                <strong> inside</strong> the pagination block.
              </span>
            </div>
          )}
          {/* Drop zone AFTER each step — hidden for the two positions adjacent
              to the dragged item and for slots inside an attached group */}
          {!isNoOp(index + 1) && !insideGroup(index + 1) && (
            <InsertRow containerPath={containerPath} index={index + 1} onPickerOpen={onPickerOpen} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

/* Connector between a step and its attached follower — a chain link instead
   of the plain flow line, signalling "these move together". */
function AttachLink() {
  return (
    <div className="flow-attach-link" title="Attached — moves together with the step above">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
      </svg>
    </div>
  );
}

/* ── Draggable wrappers — drag handle only, NO drop target on the card itself ── */
function DraggableActionCard({ step, index, containerPath, depth, onEdit, onDelete }) {
  // Pinned steps (the workflow's start NAVIGATE) are not draggable — short-circuit
  // useDraggable by disabling it. We still render the card so users can edit it.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: step.id, disabled: !!step.pinned });
  return (
    <div ref={setNodeRef} style={{ opacity: isDragging ? 0.25 : 1 }}>
      <ActionCard step={step} containerPath={containerPath} index={index} depth={depth}
        dragHandleProps={step.pinned ? null : { ...attributes, ...listeners }}
        onEdit={onEdit}
        onDelete={step.pinned ? null : onDelete} />
    </div>
  );
}
function DraggableControlBlock({ step, index, containerPath, depth, onPickerOpen, onEditOpen, onDelete, onReorder }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: step.id });
  return (
    <div ref={setNodeRef} style={{ opacity: isDragging ? 0.25 : 1 }}>
      <ControlBlock step={step} index={index} containerPath={containerPath} depth={depth}
        dragHandleProps={{ ...attributes, ...listeners }}
        onPickerOpen={onPickerOpen} onEditOpen={onEditOpen} onDelete={onDelete} onReorder={onReorder} />
    </div>
  );
}

/* ── ActionCard ── */
function ActionCard({ step, containerPath, index, depth, dragHandleProps, onEdit, onDelete }) {
  const wp  = useContext(WPCtx) || {};
  const { insertTarget, onSetInsertTarget, onMoveStep, onToggleAttach, customActions = [] } = wp;
  const isAttached = !!step.attach && index > 0;
  const isCustom = step.type === "CUSTOM_ACTION";
  const customDef = isCustom ? customActions.find(a => a.id === step.params?.actionId) : null;
  const def = isCustom
    ? (customDef
        ? { label: customDef.name, category: "Custom" }
        : { label: step.label || "Custom action (missing)", category: "Custom" })
    : actionDefinitions[step.type];
  if (!def) return null;
  const summary = summariseParams(step, wp);
  const isTarget = insertTarget?.stepId === step.id && insertTarget?.type === 'after';
  const canMoveOut = depth > 0;

  return (
    <div className={`step-card ${isTarget ? "step-card--insert-target" : ""} ${step.pinned ? "step-card--pinned" : ""} ${isAttached ? "step-card--attached" : ""}`}>
      <div className="step-card-header">
        {step.pinned ? (
          <div className="step-pin-marker" title="Start URL — edit via the URL bar at the top">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
          </div>
        ) : (
          <div className="step-drag-handle" {...(dragHandleProps || {})}><DragDotsIcon /></div>
        )}
        <div className="step-icon"><ActionIcon type={step.type} /></div>
        <div className="step-info">
          <div className="step-label">{def.label}{step.pinned ? <span className="step-pin-tag"> · start URL</span> : null}</div>
          <div className="step-type">{def.category || "Action"}</div>
        </div>
        <div className="step-actions">
          {step.label && EXTRACTION_TYPES.has(step.type) && (
            <div className="step-label-badge" title="Named result — will appear in exported data">
              <span>◈</span> {step.label}
            </div>
          )}
          {onToggleAttach && !step.pinned && index > 0 && (
            <button
              className={`step-action-btn attach-toggle ${isAttached ? "active" : ""}`}
              title={isAttached
                ? "Attached to the step above — click to detach (move separately again)"
                : "Attach to the step above so they move together when dragging"}
              onClick={() => onToggleAttach(step.id, !step.attach)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
              </svg>
            </button>
          )}
          {onSetInsertTarget && (
            <button
              className={`step-action-btn ${isTarget ? "active" : ""}`}
              title={isTarget ? "Clear insert target" : "Insert next step after this"}
              onClick={() => onSetInsertTarget(isTarget ? null : { type: 'after', stepId: step.id })}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="9,18 15,12 9,6"/>
              </svg>
            </button>
          )}
          <button className="step-action-btn" onClick={onEdit} title="Edit"><EditIcon /></button>
          {onDelete && (
            <button className="step-action-btn delete" onClick={onDelete} title="Delete"><TrashIcon /></button>
          )}
        </div>
      </div>
      {(summary.length > 0 || step.label) && (
        <div className="step-card-body">
          {step.label && !EXTRACTION_TYPES.has(step.type) && (
            <div className="step-name-display">{step.label}</div>
          )}
          {summary.length > 0 && (
            <div className="step-params">
              {summary.map(([k, v]) => (
                <div key={k} className="step-param">
                  <span className="step-param-key">{k}:</span>
                  <span className="step-param-value">{v}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── ControlBlock ── */
function ControlBlock({ step, index, containerPath, depth, dragHandleProps, onPickerOpen, onEditOpen, onDelete, onReorder }) {
  const [collapsed, setCollapsed] = useState(false);
  // Pagination loops default to a "simple" view that hides the
  // auto-generated IF/BREAK/click/wait machinery behind an "Advanced
  // controls" toggle. The underlying tree is unchanged, only what's
  // rendered.
  // Native pagination = one of the dedicated PAGINATE_* containers (no
  // hidden infrastructure steps — the loop logic lives in codegen).
  // Legacy pagination = the older While+If/Break recipe tagged via meta.
  const isNativePagination = PAGINATION_CONTROL_TYPES.has(step.type);
  const isLegacyPagination = !isNativePagination && step.meta?.kind === 'pagination';
  const isPagination = isNativePagination || isLegacyPagination;
  const [advanced, setAdvanced] = useState(false);
  const def = controlDefinitions[step.type];
  const wp  = useContext(WPCtx) || {};
  const { insertTarget, onSetInsertTarget, activeId } = wp;
  if (!def) return null;
  const summary = buildControlSummary(step, def);
  const isInsideTarget = insertTarget?.stepId === step.id && insertTarget?.type === 'inside';
  const isAfterTarget  = insertTarget?.stepId === step.id && insertTarget?.type === 'after';

  // For pagination loops we substitute the generic control-type badge
  // and label so the block reads as a single semantic "Pagination"
  // step instead of as a raw While + If.
  const PAGINATION_STRATEGY_LABEL = {
    next_button:  'Pagination — Next button',
    page_numbers: 'Pagination — Page numbers',
    load_more:    'Pagination — Load more',
  };
  // Native containers already carry a descriptive label/icon/colour in their
  // definition, so we use those directly. Legacy loops get the strategy-based
  // substitution that hides the underlying While/If machinery.
  const headerLabel = isLegacyPagination
    ? (PAGINATION_STRATEGY_LABEL[step.meta?.strategy] || 'Pagination loop')
    : `${def.label}${step.label ? ` — ${step.label}` : ''}`;
  const headerIcon  = isLegacyPagination ? '↻' : def.icon;
  const headerColor = isLegacyPagination ? '#58a6ff' : def.color;
  const headerBg    = isLegacyPagination ? 'rgba(88,166,255,0.08)' : def.bgColor;
  const paginationSubtitle = isNativePagination
    ? paginationConfigSummary(step)
    : 'clicks the next-page link until none remains';

  return (
    <div className={`control-block ${isPagination ? 'control-block--pagination' : ''} ${isNativePagination ? 'control-block--native-pagination' : ''} ${isAfterTarget ? 'control-block--insert-target' : ''}`}
         style={{ "--ctrl-color": headerColor, "--ctrl-bg": headerBg }}>
      <div className="control-block-header">
        <div className="step-drag-handle" {...(dragHandleProps || {})}><DragDotsIcon /></div>
        <div className="control-type-badge">{headerIcon}</div>
        <div className="control-info">
          <span className="control-label">{headerLabel}</span>
          {!isPagination && summary && <code className="control-expr">{summary}</code>}
          {isPagination && paginationSubtitle && (
            <code
              className="control-expr"
              title={isLegacyPagination ? "Click ⚙ to view the underlying While/If steps" : undefined}
            >
              {paginationSubtitle}
            </code>
          )}
        </div>
        <div className="step-actions">
          {isLegacyPagination && (
            <button
              className={`step-action-btn ${advanced ? 'active' : ''}`}
              title={advanced ? 'Hide loop control steps' : 'Show advanced loop control steps'}
              onClick={() => setAdvanced(a => !a)}
            >
              {/* gear */}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
          )}
          {onSetInsertTarget && (
            <button
              className={`step-action-btn ${isInsideTarget ? "active" : ""}`}
              title={isInsideTarget ? "Clear — back to default insert" : "Add next steps INSIDE this loop"}
              onClick={() => onSetInsertTarget(isInsideTarget ? null : { type: 'inside', stepId: step.id })}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="9,18 15,12 9,6"/><line x1="4" y1="12" x2="9" y2="12"/>
              </svg>
            </button>
          )}
          {onSetInsertTarget && (
            <button
              className={`step-action-btn ${isAfterTarget ? "active" : ""}`}
              title={isAfterTarget ? "Clear insert target" : "Insert next step AFTER this block"}
              onClick={() => onSetInsertTarget(isAfterTarget ? null : { type: 'after', stepId: step.id })}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="9,18 15,12 9,6"/>
              </svg>
            </button>
          )}
          <button className="step-action-btn" onClick={() => onEditOpen({ containerPath, index, step })} title="Edit"><EditIcon /></button>
          <button className="step-action-btn delete" onClick={() => onDelete(containerPath, index)} title="Delete"><TrashIcon /></button>
          <button className="step-action-btn collapse-btn" onClick={() => setCollapsed(c => !c)} title={collapsed ? "Expand" : "Collapse"}>
            <ChevronIcon open={!collapsed} />
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="control-block-body">
          {def.branches.map((branch, bIdx) => {
            const branchSteps = step[branch.key] || [];
            const branchPath  = [...containerPath, index, branch.key];

            // Pagination simple view: hide the auto-generated infrastructure
            // steps so the user sees only the extractions they've added.
            // We rely on infrastructure being a contiguous suffix of the
            // body (guaranteed by `generatePaginationSteps`); if a user
            // has reordered things in advanced mode, fall back to showing
            // everything so we don't lie about the execution order.
            const infraSuffix = (() => {
              if (!isPagination) return 0;
              let n = 0;
              for (let i = branchSteps.length - 1; i >= 0; i--) {
                if (branchSteps[i].meta?.infrastructure) n++;
                else break;
              }
              return n;
            })();
            const cleanLayout = infraSuffix === branchSteps.filter(s => s.meta?.infrastructure).length;
            const showSimple  = isPagination && !advanced && cleanLayout;
            const userSteps   = showSimple ? branchSteps.slice(0, branchSteps.length - infraSuffix) : branchSteps;
            const userEnd     = branchSteps.length - infraSuffix; // real-index slot where new steps land in simple view

            return (
              <div key={branch.key} className="control-branch">
                {!isLegacyPagination && (
                  <div className="branch-label-row">
                    <div className="branch-label" style={{ color: def.color }}>{branch.label}</div>
                    <div className="branch-line" style={{ background: def.color }} />
                  </div>
                )}
                <div className="branch-body">
                  {userSteps.length === 0 ? (
                    <div className="branch-empty">
                      <span>{isLegacyPagination ? 'Drop your extraction steps here — they run once per page' : branch.emptyLabel}</span>
                      <InsertRow containerPath={branchPath} index={0} onPickerOpen={onPickerOpen} isEnd />
                    </div>
                  ) : (
                    <>
                      <StepList steps={userSteps} containerPath={branchPath} depth={depth + 1}
                        onPickerOpen={onPickerOpen} onEditOpen={onEditOpen}
                        onDelete={onDelete} onReorder={onReorder} />
                      {/* "Add step" button shown only when NOT dragging —
                          StepList's own last InsertRow is the drop target during drag.
                          In pagination simple view it targets the slot right
                          before the hidden infrastructure suffix. */}
                      {!activeId && (
                        <div style={{ display:"flex", justifyContent:"center", marginTop:8 }}>
                          <button className="branch-add-btn" style={{ color: headerColor, borderColor: headerColor }}
                            onClick={() => onPickerOpen({ containerPath: branchPath, index: showSimple ? userEnd : null })}>
                            + Add step
                          </button>
                        </div>
                      )}
                    </>
                  )}

                  {/* Pagination "Advanced controls" footer — collapsed by
                      default. Clicking expands the IF/BREAK/click/wait
                      steps as normal editable cards directly below. */}
                  {showSimple && infraSuffix > 0 && (
                    <button
                      className="pagination-advanced-toggle"
                      onClick={() => setAdvanced(true)}
                      title="Show the underlying loop control steps"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="6,9 12,15 18,9"/>
                      </svg>
                      Advanced loop controls ({infraSuffix} step{infraSuffix !== 1 ? 's' : ''} — stop check, click, wait)
                    </button>
                  )}
                </div>
                {bIdx < def.branches.length - 1 && <div className="branch-separator" />}
              </div>
            );
          })}
        </div>
      )}

      {collapsed && (
        <div className="control-collapsed-hint">
          {isPagination ? (
            <span>
              <strong style={{ color: headerColor }}>{(step.body || []).filter(s => !s.meta?.infrastructure).length}</strong>
              {' '}extraction step{(step.body || []).filter(s => !s.meta?.infrastructure).length !== 1 ? 's' : ''} per page
            </span>
          ) : (
            def.branches.map((b, i) => (
              <span key={b.key}>
                {i > 0 && <span style={{ color: "var(--text-muted)" }}> · </span>}
                <strong style={{ color: def.color }}>{b.label}</strong>{" "}
                {(step[b.key] || []).length} step{(step[b.key] || []).length !== 1 ? "s" : ""}
              </span>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ── Step Picker Modal ── */
function StepPicker({ onSelect, onClose, customActions = [] }) {
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState("all");
  const q = search.toLowerCase();

  // Hidden action types: kept in actionDefinitions so existing workflows
  // still execute, but pruned from the "Add Step" picker so non-technical
  // users see a smaller, scrape-focused catalog. The slim list mirrors
  // ElementInspector's CATEGORIES; if you re-enable an action there, drop
  // it from this set too.
  const HIDDEN_ACTION_TYPES = new Set([
    'HOVER_ELEMENT', 'CLEAR_INPUT', 'PRESS_KEY', 'SCROLL_TO_ELEMENT',
    'UPLOAD_FILE',
    'RELOAD_PAGE', 'OPEN_NEW_TAB', 'SWITCH_TAB',
    'WAIT_FOR_SELECTOR', 'WAIT_FOR_NAVIGATION',
    'CONDITION', 'LOOP',
    'EXTRACT_JSON',
    'SET_VARIABLE', 'TRANSFORM_DATA', 'APPEND_TO_LIST', 'SAVE_DATA',
  ]);

  const actionGroups = {};
  Object.entries(actionDefinitions).forEach(([type, def]) => {
    if (!def) return;
    if (HIDDEN_ACTION_TYPES.has(type)) return;
    if (q && !def.label.toLowerCase().includes(q) && !(def.description || "").toLowerCase().includes(q)) return;
    const cat = def.category || "Other";
    if (!actionGroups[cat]) actionGroups[cat] = [];
    actionGroups[cat].push({ type, def });
  });

  const ctrlItems = Object.entries(controlDefinitions).filter(([, def]) =>
    !q || def.label.toLowerCase().includes(q) || (def.description || "").toLowerCase().includes(q)
  );

  const customItems = customActions.filter(a =>
    !q || a.name.toLowerCase().includes(q) || (a.description || "").toLowerCase().includes(q)
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content picker-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Add Step</h3>
          <button className="modal-close-btn" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div className="modal-search">
          <input placeholder="Search steps…" value={search} onChange={e => setSearch(e.target.value)} autoFocus />
        </div>
        <div className="picker-tabs">
          {[["all","All"],["control","⚙ Control Flow"],["action","▶ Actions"],["custom","✦ Custom"]].map(([id, label]) => (
            <button key={id} className={`picker-tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        <div className="modal-body">
          {(tab === "all" || tab === "custom") && customItems.length > 0 && (
            <div className="action-category">
              <div className="category-title">✦ Your custom actions</div>
              <div className="action-grid">
                {customItems.map(a => (
                  <div key={a.id} className="action-tile" onClick={() => onSelect("custom", "CUSTOM_ACTION", a)}>
                    <div className="action-tile-label">{a.name}</div>
                    <div className="action-tile-desc">{a.description || `${a.inputs.length} input${a.inputs.length !== 1 ? "s" : ""}`}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {tab === "custom" && customItems.length === 0 && (
            <div style={{ color: "var(--text-muted)", padding: "24px", textAlign: "center" }}>
              No custom actions yet — open <strong>Custom actions</strong> from the header to create one.
            </div>
          )}
          {(tab === "all" || tab === "control") && ctrlItems.length > 0 && (
            <div className="action-category">
              <div className="category-title">⚙ Control Flow</div>
              <div className="action-grid control-grid">
                {ctrlItems.map(([type, def]) => (
                  <div key={type} className="action-tile control-tile" style={{ "--tile-color": def.color }} onClick={() => onSelect("control", type)}>
                    <div className="control-tile-icon">{def.icon}</div>
                    <div className="action-tile-label">{def.label}</div>
                    <div className="action-tile-desc">{def.description}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {(tab === "all" || tab === "action") && Object.entries(actionGroups).map(([category, items]) => (
            <div key={category} className="action-category">
              <div className="category-title">{category}</div>
              <div className="action-grid">
                {items.map(({ type, def }) => (
                  <div key={type} className="action-tile" onClick={() => onSelect("action", type)}>
                    <div className="action-tile-label">{def.label}</div>
                    <div className="action-tile-desc">{def.description}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {ctrlItems.length === 0 && Object.keys(actionGroups).length === 0 && customItems.length === 0 && (
            <div style={{ color: "var(--text-muted)", padding: "24px", textAlign: "center" }}>No results for "{search}"</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Step Editor Modal ── */
function StepEditorModal({ step, onClose, onSave, customActions = [] }) {
  const isCtrl = isControlStep(step);
  const isCustom = !isCtrl && step.type === "CUSTOM_ACTION";
  const customDef = isCustom ? customActions.find(a => a.id === step.params?.actionId) : null;

  // Build a virtual "definition" for custom actions so the rest of the form
  // reuses the existing FieldRenderer-driven layout.
  const def = isCtrl
    ? controlDefinitions[step.type]
    : isCustom
      ? customDef && {
          label: customDef.name,
          description: customDef.description,
          inputs: Object.fromEntries((customDef.inputs || []).map(i => [i.name, {
            type: i.type === "selector" ? "string" : i.type === "json" ? "string" : i.type,
            label: i.name,
            placeholder: i.type === "json" ? "{ }" :
                         i.type === "selector" ? "CSS selector" : "",
          }])),
        }
      : actionDefinitions[step.type];

  if (!def) {
    // Custom action was deleted — let the user remove the orphan step.
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content editor-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header"><h3>Custom action unavailable</h3>
            <button className="modal-close-btn" onClick={onClose}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div className="editor-form">
            <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
              The custom action this step refers to (id #{step.params?.actionId}) no longer exists. Delete this step or restore the action.
            </p>
          </div>
          <div className="modal-footer">
            <button className="modal-btn primary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  const [local, setLocal] = useState(step);
  const [showAdv, setShowAdv] = useState(false);
  const setParam = (k, v) => {
    if (isCustom) {
      // For custom actions, params.inputs holds the user's values.
      setLocal(s => ({ ...s, params: { ...s.params, inputs: { ...(s.params?.inputs || {}), [k]: v } } }));
    } else {
      setLocal(s => ({ ...s, params: { ...s.params, [k]: v } }));
    }
  };
  const setAdv   = (k, v) => setLocal(s => ({ ...s, advanced: { ...s.advanced, [k]: v } }));
  const inputs   = isCtrl ? def.params   : (def.inputs   || {});
  const advanced = isCtrl ? {}           : (def.advanced || {});
  // Where to read values from
  const getValue = (k) => isCustom ? local.params?.inputs?.[k] : local.params?.[k];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content editor-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {isCtrl && <span className="control-type-badge" style={{ "--ctrl-color": def.color, fontSize: 16 }}>{def.icon}</span>}
            <h3>Edit: {def.label}</h3>
          </div>
          <button className="modal-close-btn" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div className="editor-form">
          {step.pinned && (
            <div className="label-extraction-banner" style={{ borderColor: "rgba(88,166,255,0.4)" }}>
              <span>◈</span>
              This is the workflow's <strong>start URL</strong>. Changing the URL here also updates the URL bar at the top.
              The step is pinned to the top of the workflow and can't be moved or deleted.
            </div>
          )}
          {/* Step name / result key — always first */}
          <div className="form-group label-group">
            <label>
              Step name
              {!isCtrl && EXTRACTION_TYPES.has(step.type) && (
                <span className="label-extraction-hint"> — becomes the result key in exported data</span>
              )}
            </label>
            <input
              type="text"
              value={local.label || ""}
              placeholder={!isCtrl && EXTRACTION_TYPES.has(step.type)
                ? "e.g. products, prices, titles…"
                : "Optional label"}
              onChange={e => setLocal(s => ({ ...s, label: e.target.value }))}
              style={!isCtrl && EXTRACTION_TYPES.has(step.type) ? { borderColor: "var(--accent-primary)" } : {}}
            />
            {!isCtrl && EXTRACTION_TYPES.has(step.type) && (
              <div className="label-extraction-banner">
                <span>◈</span>
                Named extraction steps are automatically exported when you run the workflow.
                Use a clear name like <code>prices</code> or <code>product_links</code>.
              </div>
            )}
          </div>

          {isCustom && customDef?.outputs?.length > 0 && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: -6 }}>
              Returns: {customDef.outputs.map(o => <code key={o.name} style={{ marginRight: 8 }}>{o.name}</code>)}
            </div>
          )}
          {Object.entries(inputs).filter(([, s]) => fieldVisible(s, inputs, local)).map(([k, s]) => (
            <FieldRenderer
              key={k}
              label={s.label || k}
              type={s.type}
              value={getValue(k)}
              options={s.options}
              placeholder={s.placeholder}
              onChange={v => setParam(k, v)}
              // Extra context: some renderers (the EXTRACT_LIST fields
              // editor in particular) need to know about sibling params
              // on this step and the parent step id to fetch live preview.
              step={local}
              fieldKey={k}
              // Flag the JS-expression condition fields (If/Else, While, Loop)
              // so the renderer offers the no-code Condition Builder above the
              // code box. Detected by the well-known param keys.
              conditionBuilder={k === "expression" || k === "whileExpression"}
              // EXTRACT_LIST auto-detect proposes a Title Case table name;
              // apply it as the step label, but never clobber a name the user
              // already typed.
              onName={(n) => setLocal(s => (s.label && s.label.trim()) ? s : { ...s, label: n })}
            />
          ))}
          {isCustom && Object.keys(inputs).length === 0 && (
            <div style={{ color: "var(--text-muted)", fontSize: 13, padding: "8px 0" }}>
              This custom action has no declared inputs.
            </div>
          )}
          {/* Every extraction step gets an extra "Include in final output"
              toggle that the underlying action definitions don't have to
              declare individually. When off, the step's value still
              becomes a workflow variable (so downstream steps can use it)
              but it doesn't appear in the results JSON — the typical
              case is "extract links, iterate over them, but the final
              output should only contain the per-link details." */}
          {!isCtrl && EXTRACTION_TYPES.has(step.type) && (
            <div className="form-group" style={{ marginTop: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={local.advanced?.includeInOutput !== false}
                  onChange={e => setAdv("includeInOutput", e.target.checked)}
                />
                <span style={{ fontSize: 13 }}>
                  Include in final output
                  <span style={{ fontSize: 11, color: "var(--text-muted, #888)", marginLeft: 6 }}>
                    {local.advanced?.includeInOutput === false
                      ? "(off — this step's data is kept as a variable only, not exported)"
                      : "(on — value appears in the results JSON)"}
                  </span>
                </span>
              </label>
            </div>
          )}
          {Object.keys(advanced).length > 0 && (
            <>
              <button className="adv-toggle-btn" onClick={() => setShowAdv(v => !v)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  style={{ transform: showAdv ? "rotate(180deg)" : "none", transition: "150ms" }}>
                  <polyline points="6,9 12,15 18,9"/>
                </svg>
                {showAdv ? "Hide" : "Show"} advanced options
              </button>
              {showAdv && Object.entries(advanced).map(([k, s]) => (
                <FieldRenderer key={k} label={s.label || k} type={s.type} value={local.advanced?.[k]}
                  options={s.options} placeholder={s.placeholder} onChange={v => setAdv(k, v)} />
              ))}
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-btn secondary" onClick={onClose}>Cancel</button>
          <button className="modal-btn primary" onClick={() => onSave(local)}>Save Changes</button>
        </div>
      </div>
    </div>
  );
}

/* ── Input wrapper with a ServiceNow-style variable picker ────────────
   Wraps a single-line input with a "$" button that opens a popover
   tree of available variables / captured outputs / loop-iteration
   variables. Picking inserts at the current caret position. */
function ScopedTextInput({ value, onChange, placeholder, type = "text", step, expectedKind = "any", showMatchCount = false }) {
  const { variables = [], availableCapturedOutputs = [], steps: allSteps = [], previewData = {} } =
    useContext(WPCtx) || {};
  const inputRef = useRef(null);

  // Live element-match count for selector fields, from the step's preview
  // (previewStep returns totalMatched). Only shown when we actually have a
  // number for this step and the field currently holds a selector.
  const matchCount = (showMatchCount && step && previewData[step.id] &&
    typeof previewData[step.id].totalMatched === "number")
    ? previewData[step.id].totalMatched
    : null;

  // Compute iteration variables visible to THIS step (everything inside
  // a FOR_EACH / FOR_EACH_ELEMENTS that reaches it).
  const iterationVars = React.useMemo(
    () => step ? iterationVarsForStep(allSteps, step.id, availableCapturedOutputs) : [],
    [allSteps, step, availableCapturedOutputs]
  );

  const handlePick = (ref) => {
    const el = inputRef.current;
    if (!el) { onChange((value ?? "") + ref); return; }
    const cur = el.value ?? "";
    const a = el.selectionStart ?? cur.length;
    const b = el.selectionEnd   ?? cur.length;
    const next = cur.slice(0, a) + ref + cur.slice(b);
    onChange(next);
    // Restore caret position after the inserted ref so the user can keep
    // typing in place.
    requestAnimationFrame(() => {
      try {
        el.focus();
        const pos = a + ref.length;
        el.setSelectionRange(pos, pos);
      } catch (_) {}
    });
  };

  // Detect whether the current value looks like a single template
  // reference (e.g. "{{products[*].link}}") and, if so, infer the kind
  // that it would resolve to. Compare against expectedKind — surface a
  // friendly inline warning so the user doesn't run a broken workflow.
  const mismatchWarning = useMemo(
    () => detectInputMismatch(value, expectedKind, { variables, capturedOutputs: availableCapturedOutputs, iterationVars }),
    [value, expectedKind, variables, availableCapturedOutputs, iterationVars]
  );

  return (
    <div className="vpick-input-col">
      <div className="vpick-input-row">
        <input
          ref={inputRef}
          type={type}
          value={value ?? ""}
          placeholder={placeholder || ""}
          onChange={e => onChange(e.target.value)}
          className={mismatchWarning ? "vpick-input-mismatch" : undefined}
        />
        <VariablePicker
          variables={variables}
          capturedOutputs={availableCapturedOutputs}
          iterationVars={iterationVars}
          onPick={handlePick}
          expectedKind={expectedKind}
        />
      </div>
      {mismatchWarning && (
        <div className="vpick-input-warning" title={mismatchWarning}>
          ⚠ {mismatchWarning}
        </div>
      )}
      {matchCount !== null && value && (
        <div className={`vpick-match-badge ${matchCount === 0 ? "vpick-match-badge--empty" : ""}`}>
          {matchCount === 0
            ? "⚠ Matches nothing on this page — try picking the element again."
            : `✓ Matches ${matchCount} element${matchCount === 1 ? "" : "s"} on the page`}
        </div>
      )}
    </div>
  );
}

// Read the value of an input that's a single {{...}} reference, look up
// the variable's kind, and return a human-readable warning when the
// kind doesn't match what the field expects. Returns null when there's
// no mismatch (either the value matches or it's not a pure reference,
// in which case we can't easily decide).
function detectInputMismatch(value, expectedKind, ctx) {
  if (!expectedKind || expectedKind === "any") return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // We only validate inputs that are EXACTLY one variable reference —
  // mixed text + interpolation is always a string at runtime.
  const m = /^\{\{\s*([a-zA-Z_$][\w$]*)(\[\*\])?((?:\.[a-zA-Z_$][\w$]*)*)\s*\}\}$/.exec(trimmed);
  if (!m) return null;
  const root = m[1], hasStar = !!m[2], path = m[3] ? m[3].slice(1).split(".") : [];
  // Determine what the reference resolves to:
  //   {{X}}            → X's own kind
  //   {{X[*]}}         → list  (the whole list)
  //   {{X.field}}      → field on X (scalar if X is a row, else any)
  //   {{X[*].field}}   → list of field values → list
  let refKind = "any";
  if (hasStar && path.length > 0) refKind = "list";
  else if (hasStar) refKind = "list";
  else if (path.length > 0) refKind = "scalar";
  else {
    // Lookup the root: iteration var > captured output > custom var
    const iter = ctx.iterationVars.find(v => v.name === root);
    if (iter) {
      refKind = iter.itemKind === "row" ? "object"
              : iter.itemKind === "scalar" ? "scalar" : "any";
    } else {
      const cap = ctx.capturedOutputs.find(c => c.name === root);
      if (cap) refKind = (cap.type === "list" || cap.type === "table") ? "list" : "scalar";
      else {
        const cust = ctx.variables.find(v => v.name === root);
        if (cust) refKind = cust.type === "json" ? "any" : "scalar";
        else refKind = "any";   // unknown — don't false-flag
      }
    }
  }
  // Compatibility: scalar↔scalar, list↔list, object→scalar OK (often
  // user types it knowingly), any matches anything
  const COMPAT = {
    scalar: new Set(["scalar", "any"]),
    list:   new Set(["list",   "any"]),
    object: new Set(["object", "any"]),
  };
  const allowed = COMPAT[expectedKind];
  if (!allowed) return null;
  if (allowed.has(refKind) || refKind === "any") return null;
  // Build a useful message
  if (expectedKind === "scalar" && refKind === "list") {
    return `${trimmed} is a list — this field expects a single value. Use {{name[*].column}} on a list, or wrap with a FOR_EACH to iterate.`;
  }
  if (expectedKind === "list" && refKind === "scalar") {
    return `${trimmed} is a single value — this field expects a list. Did you mean {{${root}[*].column}} or another list-shaped variable?`;
  }
  if (expectedKind === "list" && refKind === "object") {
    return `${trimmed} is a row, not a list. Use the parent variable (e.g. {{products[*].link}}) instead.`;
  }
  return `${trimmed} is a ${kindLabel(refKind)} but this field expects a ${kindLabel(expectedKind)}.`;
}
function kindLabel(k) {
  return k === "scalar" ? "single value" : k === "list" ? "list" : k === "object" ? "object" : "value";
}

// What shape of value does a step input expect? Used by the variable
// picker to warn the user if the reference they're inserting won't fit
// (a list dropped into a single-string field, etc). Conservative
// defaults: anything not listed is treated as "any" so the picker never
// surprises a user who knows what they're doing.
const FIELD_EXPECTED_KIND = {
  // Most string fields take a single value
  selector:           "scalar",
  url:                "scalar",
  text:               "scalar",
  containerSelector:  "scalar",
  attribute:          "scalar",
  destination:        "scalar",
  searchValue:        "scalar",
  replaceValue:       "scalar",
  variableName:       "scalar",
  scriptSelector:     "scalar",
  jsonPath:           "scalar",
  // RUN_SUBFLOW: single URL vs a list of URLs vs a source table to enrich
  urlList:            "list",
  sourceList:         "list",
  // Variables you set / append into are arrays
  listName:           "list",
  // For-each / loop sources are lists
  source:             "list",
};
function expectedKindForField(stepType, fieldKey) {
  // Override specific (stepType, field) pairs when the field name alone
  // isn't enough. Currently only RUN_SUBFLOW.url is special (single URL)
  // vs the urlList field — both are already covered above.
  return FIELD_EXPECTED_KIND[fieldKey] || "any";
}

/* ── Field Renderer ── */
function FieldRenderer({ label, type, value, options, placeholder, onChange, step, fieldKey, onName, conditionBuilder }) {
  // hidden fields are stored in params but not shown in UI
  if (type === "hidden") return null;

  const expectedKind = expectedKindForField(step?.type, fieldKey);

  // keyvalue: rich fields editor used by EXTRACT_LIST. We pull socket
  // and the latest preview rows out of WPCtx so the AI auto-detect
  // button and per-field sample values work without prop-drilling.
  if (type === "keyvalue") {
    const { socket, previewData, listPickStepId, onStartListPick, onStopListPick } = useContext(WPCtx) || {};
    const previewRows = step && previewData && previewData[step.id]?.previewRows;
    const containerSelector = step?.params?.containerSelector || "";
    const selectorType      = step?.params?.selectorType || "css";
    const pickActive        = !!(step && listPickStepId === step.id);
    return (
      <div className="form-group">
        <label>{label}</label>
        <ExtractListFieldsEditor
          value={value}
          onChange={onChange}
          containerSelector={containerSelector}
          selectorType={selectorType}
          socket={socket}
          previewRows={previewRows}
          pickActive={pickActive}
          onStartPick={() => onStartListPick && onStartListPick(step.id, containerSelector)}
          onStopPick={() => onStopListPick && onStopListPick()}
          onName={onName}
        />
      </div>
    );
  }

  // workflowSelect: dropdown listing the user's saved workflows for the
  // RUN_SUBFLOW step. Excludes the workflow currently being edited so
  // the user can't accidentally call into themselves (the runtime cycle
  // guard is the real safety net, but hiding the option is friendlier).
  if (type === "workflowSelect") {
    const { availableWorkflows, currentWorkflowId } = useContext(WPCtx) || {};
    const list = (availableWorkflows || []).filter(w => w.id !== currentWorkflowId);
    return (
      <div className="form-group">
        <label>{label}</label>
        {list.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--text-muted, #888)", padding: 8,
                        border: "1px dashed var(--border-soft, #2a2a2a)", borderRadius: 4 }}>
            No other saved workflows yet — save another workflow first, then it'll appear here as a subflow option.
          </div>
        ) : (
          <select
            value={value || ""}
            onChange={e => onChange(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">— pick a workflow —</option>
            {list.map(w => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        )}
      </div>
    );
  }

  return (
    <div className="form-group">
      <label>{label}</label>
      {type === "string" && conditionBuilder && (
        <ConditionBuilder onApply={onChange} />
      )}
      {type === "string"  && (
        <ScopedTextInput
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          step={step}
          expectedKind={expectedKind}
          // Show a live "matches N elements" badge for the primary selector
          // fields so a non-technical user immediately sees whether their
          // selector finds anything on the page.
          showMatchCount={fieldKey === "selector" || fieldKey === "containerSelector"}
        />
      )}
      {type === "number"  && <input type="number" value={value ?? ""}   onChange={e => onChange(Number(e.target.value))} />}
      {type === "boolean" && <label style={{ display: "flex", alignItems: "center", gap: 8 }}><input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} /><span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{value ? "Enabled" : "Disabled"}</span></label>}
      {type === "select"  && <select value={value ?? ""} onChange={e => onChange(e.target.value)}>{(options || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}
      {type === "array"   && <input type="text" value={(value || []).join(", ")} placeholder="Comma-separated values" onChange={e => onChange(e.target.value.split(",").map(v => v.trim()).filter(Boolean))} />}
      {type === "selectorList" && <SelectorListEditor value={value} onChange={onChange} />}
    </div>
  );
}

/* ── SelectorListEditor ─────────────────────────────────────────────────────
   Renders the fallback selector list as typed chips with a badge showing
   css/xpath. Each entry is { value: string, type: 'css'|'xpath', strategy? }.
   Users can remove entries or add plain-CSS ones manually.
   ─────────────────────────────────────────────────────────────────────────── */
function SelectorListEditor({ value, onChange }) {
  const items = (value || []);
  const [draft, setDraft] = React.useState("");

  const remove = (i) => onChange(items.filter((_, idx) => idx !== i));

  const addDraft = () => {
    const v = draft.trim();
    if (!v) return;
    const isXPath = v.startsWith("/") || v.startsWith("(");
    onChange([...items, { value: v, type: isXPath ? "xpath" : "css", strategy: "manual" }]);
    setDraft("");
  };

  return (
    <div className="sel-list-editor">
      {items.length === 0 && (
        <div className="sel-list-empty">No fallback selectors</div>
      )}
      {items.map((item, i) => {
        const s = typeof item === "string" ? { value: item, type: "css" } : item;
        return (
          <div key={i} className="sel-chip">
            <span className={`sel-chip-type ${s.type}`}>{s.type === "xpath" ? "XP" : "CSS"}</span>
            <code className="sel-chip-value" title={s.value}>{s.value}</code>
            {s.strategy && <span className="sel-chip-strategy">{s.strategy}</span>}
            <button className="sel-chip-remove" onClick={() => remove(i)} title="Remove">×</button>
          </div>
        );
      })}
      <div className="sel-list-add">
        <input
          type="text"
          className="sel-add-input"
          value={draft}
          placeholder="Add selector (CSS or /xpath)…"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => e.key === "Enter" && addDraft()}
        />
        <button className="sel-add-btn" onClick={addDraft}>+</button>
      </div>
    </div>
  );
}