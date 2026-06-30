'use strict';

/* =========================================================================
   Field transform runtime
   -------------------------------------------------------------------------
   A small, dependency-free engine that cleans and/or splits a single
   extracted string value. It powers three places that must agree exactly:

     1. The GENERATED workflow script (these function bodies are inlined
        verbatim via RUNTIME_SRC — see workflowCodegen.js).
     2. The live "Data Preview" path (server.js previewStep), which calls
        these functions directly so the preview matches the final output.
     3. The frontend mirror (frontend/src/workflow/fieldTransforms.js),
        which keeps an identical copy for column-name derivation in the UI.

   Keep these functions pure and self-contained (no closures, no imports)
   so `Function.prototype.toString()` produces inlinable source. If you
   change the logic here, mirror it in the frontend copy.
   ========================================================================= */

// Apply an ordered list of cleaning operations to a single value. Text ops
// coerce through String; the result may be a non-string (number / null).
function __ftCleanValue(value, ops) {
  if (!Array.isArray(ops) || ops.length === 0) return value;
  let v = value;
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    const s = v == null ? '' : String(v);
    switch (op.op) {
      case 'trim':        v = s.trim(); break;
      case 'collapse_ws': v = s.replace(/\s+/g, ' ').trim(); break;
      case 'lowercase':   v = s.toLowerCase(); break;
      case 'uppercase':   v = s.toUpperCase(); break;
      case 'capitalize':  v = s ? s.charAt(0).toUpperCase() + s.slice(1) : s; break;
      case 'replace':
        if (op.all === false) {
          v = s.replace(op.find != null ? String(op.find) : '', op.with != null ? String(op.with) : '');
        } else {
          v = s.split(op.find != null ? String(op.find) : '').join(op.with != null ? String(op.with) : '');
        }
        break;
      case 'regex_replace':
        try { v = s.replace(new RegExp(op.pattern || '', op.flags != null ? op.flags : 'g'), op.with != null ? String(op.with) : ''); }
        catch (_e) { v = s; }
        break;
      case 'remove':
        try { v = s.replace(new RegExp(op.pattern || '', op.flags != null ? op.flags : 'g'), ''); }
        catch (_e) { v = s; }
        break;
      case 'regex_extract':
        try {
          const m = s.match(new RegExp(op.pattern || '', op.flags || ''));
          if (!m) { v = null; }
          else { const g = op.group != null ? op.group : 0; v = m[g] != null ? m[g] : null; }
        } catch (_e) { v = null; }
        break;
      case 'extract_number': {
        const m = s.replace(/(\d),(?=\d{3}\b)/g, '$1').match(/-?\d+(?:\.\d+)?/);
        v = m ? m[0] : null;
        break;
      }
      case 'to_number': {
        const n = Number(s.replace(/[^0-9.\-eE+]/g, ''));
        v = Number.isNaN(n) ? null : n;
        break;
      }
      case 'prepend': v = (op.text != null ? String(op.text) : '') + s; break;
      case 'append':  v = s + (op.text != null ? String(op.text) : ''); break;
      case 'slice':   v = s.slice(op.start != null ? Number(op.start) : 0, op.end != null && op.end !== '' ? Number(op.end) : undefined); break;
      case 'strip_html': v = s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); break;
      case 'default': v = (v == null || s === '') ? (op.value != null ? op.value : '') : v; break;
      case 'custom':
        try { v = (new Function('value', 'return (' + (op.expr || 'value') + ');'))(v); }
        catch (_e) { /* leave value unchanged on error */ }
        break;
      default: break;
    }
  }
  return v;
}

// Split a single value into a { columnName: part } object. Column names come
// from a regex's named capture groups, or from spec.parts (delimiter mode and
// numbered regex groups). Missing pieces become null.
function __ftSplitValue(value, spec) {
  const out = {};
  if (!spec || typeof spec !== 'object') return out;
  const s = value == null ? '' : String(value);
  const parts = Array.isArray(spec.parts) ? spec.parts.filter(Boolean) : [];
  if (spec.mode === 'regex') {
    let m = null;
    try { m = s.match(new RegExp(spec.pattern || '', spec.flags || '')); } catch (_e) { m = null; }
    const groups = m && m.groups ? m.groups : null;
    if (groups && Object.keys(groups).length > 0) {
      for (const k of Object.keys(groups)) out[k] = groups[k] != null ? groups[k] : null;
    } else {
      for (let i = 0; i < parts.length; i++) out[parts[i]] = m && m[i + 1] != null ? m[i + 1] : null;
    }
  } else {
    const delim = spec.delimiter != null ? String(spec.delimiter) : ',';
    const pieces = delim === '' ? [s] : s.split(delim);
    for (let i = 0; i < parts.length; i++) {
      let piece = pieces[i] != null ? pieces[i] : null;
      if (piece != null && spec.trim !== false) piece = piece.trim();
      out[parts[i]] = piece;
    }
  }
  return out;
}

// Turn a RAW extracted row { fieldName: value } into the final row, applying
// each field's transform pipeline and split spec. Split fields contribute
// their part columns (and optionally the original) instead of the raw key.
function __ftMaterializeRow(rawRow, fields) {
  const out = {};
  for (const name of Object.keys(fields || {})) {
    const spec = fields[name] && typeof fields[name] === 'object' ? fields[name] : {};
    let val = rawRow ? rawRow[name] : null;
    if (Array.isArray(spec.transforms) && spec.transforms.length) val = __ftCleanValue(val, spec.transforms);
    if (spec.split && typeof spec.split === 'object') {
      if (spec.split.keepOriginal) out[name] = val;
      const partsObj = __ftSplitValue(val, spec.split);
      for (const k of Object.keys(partsObj)) out[k] = partsObj[k];
    } else {
      out[name] = val;
    }
  }
  return out;
}

// Names of the regex named-capture groups in a pattern, in order.
function __ftNamedGroups(pattern) {
  const out = [];
  const rx = /\(\?<([a-zA-Z_$][\w$]*)>/g;
  let m;
  while ((m = rx.exec(String(pattern || '')))) out.push(m[1]);
  return out;
}

// The output column names a single field yields once transforms/split run.
function __ftEffectiveColumns(name, spec) {
  const split = spec && typeof spec === 'object' ? spec.split : null;
  if (!split || typeof split !== 'object') return [name];
  const cols = [];
  if (split.keepOriginal) cols.push(name);
  if (split.mode === 'regex') {
    const named = __ftNamedGroups(split.pattern || '');
    if (named.length) cols.push(...named);
    else if (Array.isArray(split.parts)) cols.push(...split.parts.filter(Boolean));
  } else if (Array.isArray(split.parts)) {
    cols.push(...split.parts.filter(Boolean));
  }
  return cols.length ? cols : [name];
}

// True when a field actually needs Node-side post-processing.
function __ftHasPipeline(spec) {
  if (!spec || typeof spec !== 'object') return false;
  return (Array.isArray(spec.transforms) && spec.transforms.length > 0)
    || (spec.split && typeof spec.split === 'object');
}

// Inlinable source for the generated workflow script. materializeRow depends
// on cleanValue + splitValue, so all three travel together.
const RUNTIME_SRC = [__ftCleanValue, __ftSplitValue, __ftMaterializeRow]
  .map((f) => f.toString())
  .join('\n\n');

module.exports = {
  __ftCleanValue,
  __ftSplitValue,
  __ftMaterializeRow,
  __ftNamedGroups,
  __ftEffectiveColumns,
  __ftHasPipeline,
  RUNTIME_SRC,
};
