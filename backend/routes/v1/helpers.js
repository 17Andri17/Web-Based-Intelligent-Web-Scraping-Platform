'use strict';

/* ===========================================================================
   Shared helpers for the public /v1 routes: id/limit/cursor parsing and the
   cursor-pagination envelope. List endpoints fetch `limit + 1` rows so
   `has_more` is exact without a COUNT query; the cursor is the last row's id
   (lists are id DESC, so the next page is everything with id < cursor).
   ========================================================================= */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Positive-integer path/query id, or null when malformed.
function parseId(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function parseLimit(raw) {
  if (raw == null || raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(n, MAX_LIMIT);
}

// Cursors are run/workflow ids issued by us in `next_cursor`.
// Returns: undefined (absent), null (malformed), or the numeric id.
function parseCursor(raw) {
  if (raw == null || raw === '') return undefined;
  return parseId(String(raw));
}

// rows must have been fetched with LIMIT limit+1.
function pageEnvelope(rows, limit, serialize) {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    object: 'list',
    data: page.map(serialize),
    has_more: hasMore,
    next_cursor: hasMore ? String(page[page.length - 1].id) : null,
  };
}

// Cross-dialect unique-constraint detection (SQLite message / Postgres code),
// used by the idempotent run trigger.
function isUniqueViolation(err) {
  if (!err) return false;
  if (err.code === '23505') return true; // pg
  return /UNIQUE constraint failed/i.test(err.message || '');
}

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

module.exports = { parseId, parseLimit, parseCursor, pageEnvelope, isUniqueViolation, safeJson, DEFAULT_LIMIT, MAX_LIMIT };
