'use strict';

/* ===========================================================================
   resultsExport
   ---------------------------------------------------------------------------
   Run results → CSV. Extracted from routes/runs.routes.js so the internal
   dashboard download and the public GET /v1/runs/:id/data?format=csv emit
   byte-identical exports (see docs/API_ARCHITECTURE.md, "reuse — extract
   into a shared serializer").

   A run's results object maps output keys to values (usually arrays of
   records); the CSV is one `# key` section per output key.
   ========================================================================= */

function resultsToCsv(results) {
  return Object.entries(results || {})
    .map(([key, value]) => `# ${key}\n${toCSV(value)}`)
    .join('\n\n');
}

function toCSV(data) {
  if (data == null) return '';
  if (!Array.isArray(data)) return JSON.stringify(data);
  if (data.length === 0) return '';
  if (typeof data[0] !== 'object' || data[0] === null) return data.join('\n');
  const headers = Object.keys(data[0]);
  const rows = data.map(r => headers.map(h => csvCell(r[h])).join(','));
  return [headers.join(','), ...rows].join('\n');
}

function csvCell(v) {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = { resultsToCsv, toCSV, csvCell };
