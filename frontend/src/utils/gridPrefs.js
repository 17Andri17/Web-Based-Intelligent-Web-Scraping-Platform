/* =====================================================================
   gridPrefs — how you like a particular table arranged, remembered.

   Setting up a thirty-column scrape (hide the noise, drag the identifier
   to the front, go roomy so the descriptions are readable) is a minute of
   work, and before this it was a minute of work you repeated on every
   single run. These are the settings that survive.

   WHAT IS DELIBERATELY NOT SAVED: filters, the search box and the issue
   chips. Everything here changes how rows are ARRANGED; a restored filter
   would change which rows EXIST, and a table that silently opens showing
   nine of four thousand rows — with the reason a scroll away in a filter
   box you forgot you typed in — is a support ticket, not a convenience.
   Sorting is saved because it rearranges without hiding, and the header
   arrow says so on sight.

   Same shape as draftStore: scoped by a caller-supplied key, versioned,
   and best-effort throughout. localStorage can be disabled, full, or
   throw outright in private browsing; losing a column layout must never
   take the grid down with it.
   ===================================================================== */

const PREFIX = "ws";
const VERSION = 1;

// A layout that serialises past this is not a layout — it is a bug, and
// writing it would risk the origin's quota (and the auth token with it).
const MAX_BYTES = 64 * 1024;

const DENSITIES = ["compact", "roomy"];

function storageKey(key) {
  return `${PREFIX}:grid:${VERSION}:${key}`;
}

/* Everything below arrives from localStorage, which the user can edit by
   hand and which may hold a blob written by an older version of this file.
   Sanitise rather than trust: an unreadable preference should degrade to
   the default, never to a broken table. */
function sanitize(raw) {
  if (!raw || typeof raw !== "object") return null;

  const out = {};

  if (Array.isArray(raw.order)) {
    out.order = raw.order.filter(id => typeof id === "string").slice(0, 500);
  }

  if (raw.hidden && typeof raw.hidden === "object" && !Array.isArray(raw.hidden)) {
    const hidden = {};
    for (const id of Object.keys(raw.hidden).slice(0, 500)) {
      if (raw.hidden[id]) hidden[id] = true;
    }
    out.hidden = hidden;
  }

  if (DENSITIES.includes(raw.density)) out.density = raw.density;

  if (Number.isFinite(raw.pageSize) && raw.pageSize > 0 && raw.pageSize <= 1000) {
    out.pageSize = Math.floor(raw.pageSize);
  }

  if (Array.isArray(raw.sorts)) {
    out.sorts = raw.sorts
      .filter(s => s && typeof s.id === "string")
      .map(s => ({ id: s.id, dir: s.dir === "desc" ? "desc" : "asc" }))
      .slice(0, 8);
  }

  return Object.keys(out).length ? out : null;
}

export function loadGridView(key) {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return null;
    return sanitize(JSON.parse(raw));
  } catch (_) {
    return null;
  }
}

export function saveGridView(key, view) {
  if (!key) return;
  try {
    const clean = sanitize(view);
    if (!clean) { clearGridView(key); return; }
    const raw = JSON.stringify(clean);
    if (raw.length > MAX_BYTES) return;
    localStorage.setItem(storageKey(key), raw);
  } catch (_) { /* disabled, full, or private mode — not worth reporting */ }
}

export function clearGridView(key) {
  if (!key) return;
  try { localStorage.removeItem(storageKey(key)); } catch (_) {}
}
