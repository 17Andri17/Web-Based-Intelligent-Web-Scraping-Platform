/* =========================================================================
   Field transform engine — FRONTEND mirror
   -------------------------------------------------------------------------
   Identical logic to backend/workflow/fieldTransforms.js. The backend owns
   the canonical runtime (it both inlines this into generated scripts and
   runs it for live preview), so scraped rows already arrive cleaned/split.

   The frontend uses this module for:
     • effectiveFieldColumns()  → which columns a field yields, so the Data
       Preview table can render split fields as separate columns.
     • cleanValue() / splitValue() → the live "Try it" tester inside the
       transform editor, so users see the effect before running.

   Keep this in sync with the backend copy if you change the semantics.
   ========================================================================= */

export function cleanValue(value, ops) {
  if (!Array.isArray(ops) || ops.length === 0) return value;
  let v = value;
  for (const op of ops) {
    if (!op || typeof op !== "object") continue;
    const s = v == null ? "" : String(v);
    switch (op.op) {
      case "trim":        v = s.trim(); break;
      case "collapse_ws": v = s.replace(/\s+/g, " ").trim(); break;
      case "lowercase":   v = s.toLowerCase(); break;
      case "uppercase":   v = s.toUpperCase(); break;
      case "capitalize":  v = s ? s.charAt(0).toUpperCase() + s.slice(1) : s; break;
      case "replace":
        if (op.all === false) {
          v = s.replace(op.find != null ? String(op.find) : "", op.with != null ? String(op.with) : "");
        } else {
          v = s.split(op.find != null ? String(op.find) : "").join(op.with != null ? String(op.with) : "");
        }
        break;
      case "regex_replace":
        try { v = s.replace(new RegExp(op.pattern || "", op.flags != null ? op.flags : "g"), op.with != null ? String(op.with) : ""); }
        catch (_e) { v = s; }
        break;
      case "remove":
        try { v = s.replace(new RegExp(op.pattern || "", op.flags != null ? op.flags : "g"), ""); }
        catch (_e) { v = s; }
        break;
      case "regex_extract":
        try {
          const m = s.match(new RegExp(op.pattern || "", op.flags || ""));
          if (!m) { v = null; }
          else { const g = op.group != null ? op.group : 0; v = m[g] != null ? m[g] : null; }
        } catch (_e) { v = null; }
        break;
      case "extract_number": {
        const m = s.replace(/(\d),(?=\d{3}\b)/g, "$1").match(/-?\d+(?:\.\d+)?/);
        v = m ? m[0] : null;
        break;
      }
      case "to_number": {
        const n = Number(s.replace(/[^0-9.\-eE+]/g, ""));
        v = Number.isNaN(n) ? null : n;
        break;
      }
      case "prepend": v = (op.text != null ? String(op.text) : "") + s; break;
      case "append":  v = s + (op.text != null ? String(op.text) : ""); break;
      case "slice":   v = s.slice(op.start != null ? Number(op.start) : 0, op.end != null && op.end !== "" ? Number(op.end) : undefined); break;
      case "strip_html": v = s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); break;
      case "default": v = (v == null || s === "") ? (op.value != null ? op.value : "") : v; break;
      case "custom":
        try { v = (new Function("value", "return (" + (op.expr || "value") + ");"))(v); }
        catch (_e) { /* leave value unchanged on error */ }
        break;
      default: break;
    }
  }
  return v;
}

// Single-extraction counterpart of cleanValue: a Get Text / Get Attribute /
// Get HTML step yields one value, or an array of them when multiple=true.
// Mirrors __ftCleanAny in the backend copy.
export function cleanAny(value, ops) {
  if (!Array.isArray(ops) || ops.length === 0) return value;
  if (Array.isArray(value)) return value.map(v => cleanValue(v, ops));
  return cleanValue(value, ops);
}

export function splitValue(value, spec) {
  const out = {};
  if (!spec || typeof spec !== "object") return out;
  const s = value == null ? "" : String(value);
  const parts = Array.isArray(spec.parts) ? spec.parts.filter(Boolean) : [];
  if (spec.mode === "regex") {
    let m = null;
    try { m = s.match(new RegExp(spec.pattern || "", spec.flags || "")); } catch (_e) { m = null; }
    const groups = m && m.groups ? m.groups : null;
    if (groups && Object.keys(groups).length > 0) {
      for (const k of Object.keys(groups)) out[k] = groups[k] != null ? groups[k] : null;
    } else {
      for (let i = 0; i < parts.length; i++) out[parts[i]] = m && m[i + 1] != null ? m[i + 1] : null;
    }
  } else {
    const delim = spec.delimiter != null ? String(spec.delimiter) : ",";
    const pieces = delim === "" ? [s] : s.split(delim);
    for (let i = 0; i < parts.length; i++) {
      let piece = pieces[i] != null ? pieces[i] : null;
      if (piece != null && spec.trim !== false) piece = piece.trim();
      out[parts[i]] = piece;
    }
  }
  return out;
}

export function namedGroups(pattern) {
  const out = [];
  const rx = /\(\?<([a-zA-Z_$][\w$]*)>/g;
  let m;
  while ((m = rx.exec(String(pattern || "")))) out.push(m[1]);
  return out;
}

export function effectiveFieldColumns(name, spec) {
  const split = spec && typeof spec === "object" ? spec.split : null;
  if (!split || typeof split !== "object") return [name];
  const cols = [];
  if (split.keepOriginal) cols.push(name);
  if (split.mode === "regex") {
    const named = namedGroups(split.pattern || "");
    if (named.length) cols.push(...named);
    else if (Array.isArray(split.parts)) cols.push(...split.parts.filter(Boolean));
  } else if (Array.isArray(split.parts)) {
    cols.push(...split.parts.filter(Boolean));
  }
  return cols.length ? cols : [name];
}

// Ordered, de-duplicated column descriptors for a whole fields map. Each
// descriptor says which source field a (possibly derived) column came from,
// so the preview table can wire its header controls back to that field.
export function fieldColumnDescriptors(fields) {
  const out = [];
  const seen = new Set();
  for (const name of Object.keys(fields || {})) {
    const spec = fields[name];
    const cols = effectiveFieldColumns(name, spec);
    const derived = !(cols.length === 1 && cols[0] === name);
    for (const key of cols) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, fieldName: name, derived: derived && key !== name, spec });
    }
  }
  return out;
}

export function hasPipeline(spec) {
  if (!spec || typeof spec !== "object") return false;
  return (Array.isArray(spec.transforms) && spec.transforms.length > 0)
    || (spec.split && typeof spec.split === "object");
}

// ─── No-code op catalogue (drives the transform editor UI) ──────────────────
// `fields` describe the parameter inputs each op needs.
export const CLEAN_OPS = [
  { op: "trim",          label: "Trim whitespace",        group: "Whitespace" },
  { op: "collapse_ws",   label: "Collapse spaces",        group: "Whitespace", hint: "Multiple spaces/newlines → single space" },
  { op: "strip_html",    label: "Strip HTML tags",        group: "Whitespace" },
  { op: "lowercase",     label: "lowercase",              group: "Case" },
  { op: "uppercase",     label: "UPPERCASE",              group: "Case" },
  { op: "capitalize",    label: "Capitalize first",       group: "Case" },
  { op: "replace",       label: "Find & replace (text)",  group: "Replace",
    fields: [
      { key: "find", label: "Find", type: "text", placeholder: "text to find" },
      { key: "with", label: "Replace with", type: "text", placeholder: "(empty = delete)" },
    ] },
  { op: "regex_replace", label: "Replace (regex)",        group: "Replace",
    fields: [
      { key: "pattern", label: "Pattern", type: "text", placeholder: "\\s{2,}" },
      { key: "with",    label: "Replace with", type: "text", placeholder: "$1" },
      { key: "flags",   label: "Flags", type: "text", placeholder: "g", width: 60 },
    ] },
  { op: "remove",        label: "Remove matching (regex)", group: "Replace",
    fields: [
      { key: "pattern", label: "Pattern", type: "text", placeholder: "[^0-9]" },
      { key: "flags",   label: "Flags", type: "text", placeholder: "g", width: 60 },
    ] },
  { op: "regex_extract", label: "Extract (regex)",        group: "Extract", hint: "Keeps the match (or a group)",
    fields: [
      { key: "pattern", label: "Pattern", type: "text", placeholder: "\\d+(?:\\.\\d+)?" },
      { key: "group",   label: "Group #", type: "number", placeholder: "0", width: 70 },
      { key: "flags",   label: "Flags", type: "text", placeholder: "", width: 60 },
    ] },
  { op: "extract_number", label: "Extract number",        group: "Extract", hint: "First number in the text" },
  { op: "to_number",      label: "Convert to number",     group: "Extract" },
  { op: "prepend",       label: "Add prefix",             group: "Edit",
    fields: [{ key: "text", label: "Prefix", type: "text", placeholder: "https://" }] },
  { op: "append",        label: "Add suffix",             group: "Edit",
    fields: [{ key: "text", label: "Suffix", type: "text", placeholder: " zł" }] },
  { op: "slice",         label: "Substring (slice)",      group: "Edit",
    fields: [
      { key: "start", label: "Start", type: "number", placeholder: "0", width: 70 },
      { key: "end",   label: "End", type: "number", placeholder: "(end)", width: 70 },
    ] },
  { op: "default",       label: "Default if empty",       group: "Edit",
    fields: [{ key: "value", label: "Value", type: "text", placeholder: "N/A" }] },
  { op: "custom",        label: "Custom JS…",             group: "Advanced", hint: "value => …",
    fields: [{ key: "expr", label: "JS expression (input is `value`)", type: "textarea",
               placeholder: "value.replace(/\\D+/g, '').padStart(5, '0')" }] },
];

export const CLEAN_OP_MAP = Object.fromEntries(CLEAN_OPS.map(o => [o.op, o]));

export function opSummary(op) {
  const def = CLEAN_OP_MAP[op?.op];
  if (!def) return op?.op || "?";
  if (!def.fields || def.fields.length === 0) return def.label;
  const bits = def.fields
    .map(f => (op[f.key] != null && op[f.key] !== "" ? `${f.key}=${op[f.key]}` : null))
    .filter(Boolean);
  return bits.length ? `${def.label} · ${bits.join(", ")}` : def.label;
}
