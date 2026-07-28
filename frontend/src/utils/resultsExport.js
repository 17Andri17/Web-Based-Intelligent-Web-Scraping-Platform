/* =====================================================================
   resultsExport (browser copy)

   The editor's Results download serialises in the browser: a live run's
   results arrive over the socket and the panel has no run id to fetch
   `GET /v1/runs/:id/data?format=csv` through, so it cannot reuse the
   server's serialiser over HTTP.

   This is therefore a deliberate twin of backend/utils/resultsExport.js and
   must produce byte-identical output. backend/test/results-export.test.js
   evaluates THIS file alongside the backend one over shared fixtures and
   fails the build if the two ever drift apart — edit both together.
   ===================================================================== */

// Column that carries scalar rows when an array mixes scalars with records.
const SCALAR_COLUMN = 'value';

export function resultsToCsv(results) {
  return Object.entries(results || {})
    .map(([key, value]) => `# ${key}\n${toCSV(value)}`)
    .join('\n\n');
}

export function toCSV(data) {
  if (data == null) return '';
  if (!Array.isArray(data)) return JSON.stringify(data);
  if (data.length === 0) return '';

  const headers = unionHeaders(data);
  // No record rows at all — a flat list of scalars stays a single unheaded
  // column, but every cell is escaped (a value containing a comma, quote or
  // newline used to be emitted raw and split the row).
  if (headers === null) return data.map(csvCell).join('\n');

  const rows = data.map(row => headers.map(h => recordValue(row, h)).map(csvCell).join(','));
  return [headers.map(csvCell).join(','), ...rows].join('\n');
}

/* First-seen-order union of the keys of every record row, or null when the
   array holds no records at all.

   The header set is a union rather than `Object.keys(data[0])` because rows
   are genuinely heterogeneous in practice: an enrich whose detail page failed
   for the first row contributes none of the enriched columns to it, and
   keying off row 0 alone silently dropped those columns from the export. */
function unionHeaders(data) {
  const headers = [];
  const seen = new Set();
  let sawRecord = false;
  let sawScalar = false;

  for (const row of data) {
    if (isRecord(row)) {
      sawRecord = true;
      for (const k of Object.keys(row)) {
        if (!seen.has(k)) { seen.add(k); headers.push(k); }
      }
    } else {
      sawScalar = true;
    }
  }

  if (!sawRecord) return null;
  // Scalars mixed in among records would otherwise have no column to land in.
  if (sawScalar && !seen.has(SCALAR_COLUMN)) headers.push(SCALAR_COLUMN);
  return headers;
}

function recordValue(row, header) {
  if (isRecord(row)) return row[header];
  return header === SCALAR_COLUMN ? row : undefined;
}

// Arrays are values, not records — Object.keys() on one yields "0","1",… which
// is never a meaningful column set.
function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function csvCell(v) {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // \r is quoted alongside \n per RFC 4180 — a lone CR splits the row in Excel.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
