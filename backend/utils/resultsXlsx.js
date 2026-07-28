'use strict';

/* ===========================================================================
   resultsXlsx
   ---------------------------------------------------------------------------
   Run results → .xlsx workbook (one worksheet per output key). The columns,
   header union, and cell coercion match utils/resultsExport.js exactly, so
   the Excel export and the CSV export line up field-for-field — resultsXlsx
   reuses that module's helpers rather than re-deriving them.

   Non-technical users live in Excel, and the CSV export concatenates every
   output key into one `# section` file that Excel parses as garbage. A real
   workbook with one sheet per list is the friendly delivery format.

   Returns a Node Buffer (async — exceljs streams the zip).
   ========================================================================= */

const ExcelJS = require('exceljs');
const { unionHeaders, recordValue, isRecord, SCALAR_COLUMN } = require('./resultsExport');

async function resultsToXlsx(results) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Intelligent Web Scraping Platform';
  wb.created = new Date();

  const entries = Object.entries(results || {});
  const used = new Set();

  if (entries.length === 0) {
    // A workbook must have at least one sheet to be a valid .xlsx.
    wb.addWorksheet('data');
  }

  for (const [key, data] of entries) {
    const ws = wb.addWorksheet(uniqueSheetName(key, used));
    fillSheet(ws, data);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

function fillSheet(ws, data) {
  if (data == null) return;

  // A non-array value (scalar or lone object) → one cell, matching toCSV's
  // JSON.stringify for the non-array case.
  if (!Array.isArray(data)) {
    ws.addRow([cell(data)]);
    return;
  }
  if (data.length === 0) return;

  const headers = unionHeaders(data);

  // Flat scalar list → a single unheaded column (same shape as the CSV).
  if (headers === null) {
    for (const v of data) ws.addRow([cell(v)]);
    return;
  }

  const headerRow = ws.addRow(headers);
  headerRow.font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }]; // keep headers visible while scrolling

  for (const row of data) {
    ws.addRow(headers.map(h => cell(recordValue(row, h))));
  }

  autoWidth(ws, headers);
}

/* Cell coercion mirrors csvCell: objects/arrays become JSON text; null and
   undefined become blank. Scalars are passed through with their native type
   preserved (a number stays a real Excel number, not a string) so Excel can
   sum and sort — the CSV can't express that distinction, but nothing about it
   changes which value lands in the cell. */
function cell(v) {
  if (v == null) return null;
  if (isRecord(v) || Array.isArray(v)) return JSON.stringify(v);
  return v;
}

// Excel worksheet names: ≤31 chars, none of \ / ? * [ ] :, non-empty, unique
// within the workbook (case-insensitive).
function uniqueSheetName(key, used) {
  let base = String(key == null ? '' : key).replace(/[\\/?*[\]:]/g, ' ').trim();
  if (!base) base = 'data';
  if (base.length > 31) base = base.slice(0, 31);

  let name = base;
  let n = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` (${n})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
    n += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

// Best-effort column widths from the header and a sample of rows, clamped so a
// long JSON cell can't blow the sheet out to thousands of columns wide.
function autoWidth(ws, headers) {
  const SAMPLE = 200;
  headers.forEach((h, i) => {
    let max = String(h).length;
    const col = ws.getColumn(i + 1);
    let seen = 0;
    col.eachCell({ includeEmpty: false }, (c) => {
      if (seen++ > SAMPLE) return;
      const len = c.value == null ? 0 : String(c.value).length;
      if (len > max) max = len;
    });
    col.width = Math.min(Math.max(max + 2, 8), 60);
  });
}

module.exports = { resultsToXlsx };
