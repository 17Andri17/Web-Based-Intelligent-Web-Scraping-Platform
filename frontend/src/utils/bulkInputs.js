/* =====================================================================
   bulkInputs — parse pasted text into input rows for a bulk run.

   Two shapes, auto-detected:
     • CSV with a header row — the first line's cells all match declared
       variable names; each following line becomes one input object.
     • One value per line — every non-empty line fills a single chosen
       variable (the "list of URLs → url" case).

   Pure and framework-free so it can be unit-tested (backend/test/
   bulk-inputs.test.js evaluates this file directly).
   ===================================================================== */

// Split one delimited line into cells, honouring double-quoted values
// ("a,b" stays one cell; "" is an escaped quote). Minimal RFC-4180-ish.
export function splitLine(line, delim) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map(c => c.trim());
}

/* Parse pasted text into { rows, mode, ... }.
     variables : [{ name }]  the workflow's declared variables
     columnVar : for single-column mode, which variable each line fills
                 (defaults to the first variable)
   Returns { rows, mode: 'csv'|'single'|'none', columns?, target?, error? } */
export function parseBulkRows(text, { variables = [], columnVar = null } = {}) {
  const varNames = variables.map(v => v.name).filter(Boolean);
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return { rows: [], mode: 'none' };

  const delim = lines[0].includes('\t') ? '\t' : ',';
  const firstCells = splitLine(lines[0], delim);

  // Header mode: the first line is >1 cell and every cell names a declared var.
  const isHeader = firstCells.length > 1
    && varNames.length > 0
    && firstCells.every(c => varNames.includes(c));

  if (isHeader) {
    const columns = firstCells;
    const rows = lines.slice(1).map(line => {
      const cells = splitLine(line, delim);
      const obj = {};
      columns.forEach((col, i) => {
        const val = cells[i];
        if (val !== undefined && val !== '') obj[col] = val;
      });
      return obj;
    }).filter(o => Object.keys(o).length > 0);
    return { rows, mode: 'csv', columns };
  }

  // Single-column mode: each line fills one variable.
  const target = columnVar || varNames[0] || null;
  if (!target) {
    return { rows: [], mode: 'none', error: 'This workflow has no variables to fill from a list.' };
  }
  const rows = lines.map(line => ({ [target]: line }));
  return { rows, mode: 'single', target };
}
