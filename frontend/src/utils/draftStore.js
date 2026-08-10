/* =====================================================================
   draftStore — browser-local persistence for work that isn't saved
   server-side yet.

   Three independent slots, all scoped per user (a shared browser must not
   leak one account's in-progress scraper to the next person who signs in):

     draft   — the unsaved workflow currently in the editor, so a refresh,
               a crashed tab or an accidental close doesn't destroy it.
     tour    — the guided tour's own progress (step index + the workflow it
               has built so far). Deliberately SEPARATE from `draft`: the
               tour builds a throwaway DemoMart scraper that must never
               surface as one of the user's own drafts.
     prefs   — whether this user has finished or dismissed the tour, so the
               first-run prompt doesn't nag.

   Everything here is best-effort. localStorage can be disabled, full, or
   throw in private-browsing modes; a persistence failure must never break
   the editor, so every access is wrapped and failures degrade to "no
   draft".
   ===================================================================== */

const PREFIX = "ws";
const VERSION = 1;

// Drafts older than this are ignored (and dropped on read). Long enough to
// survive a weekend, short enough that a months-old draft doesn't ambush
// someone who has long since moved on.
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// localStorage is ~5 MB for the whole origin. A workflow that serialises
// past this is pathological (usually transient preview data that escaped
// the strip below) — skip the write rather than blowing the quota and
// taking the auth token down with it.
const MAX_BYTES = 2 * 1024 * 1024;

// Transient, re-derivable fields that must not be persisted. `previewElements`
// is a snapshot of matched DOM nodes hung off FOR_EACH/list steps — it can be
// megabytes on a big page and is refetched from the live page anyway.
const TRANSIENT_STEP_KEYS = ["previewElements"];

const BRANCH_KEYS = ["body", "then", "else", "try", "catch"];

/** Deep-copy a step tree minus transient fields. */
function stripTransient(steps) {
  return (steps || []).map((step) => {
    if (!step || typeof step !== "object") return step;
    const out = { ...step };
    for (const k of TRANSIENT_STEP_KEYS) delete out[k];
    for (const key of BRANCH_KEYS) {
      if (Array.isArray(out[key])) out[key] = stripTransient(out[key]);
    }
    return out;
  });
}

// A user key that is safe inside a storage key and doesn't change between
// sessions for the same account.
function scope(userKey) {
  return String(userKey || "anon").replace(/[^a-zA-Z0-9_.-]/g, "_");
}

const draftKey = (u) => `${PREFIX}.${scope(u)}.draft.v${VERSION}`;
const tourKey  = (u) => `${PREFIX}.${scope(u)}.tour.v${VERSION}`;
const prefsKey = (u) => `${PREFIX}.${scope(u)}.tourPrefs.v${VERSION}`;

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    // Corrupt entry — drop it so it can't keep failing on every load.
    try { localStorage.removeItem(key); } catch (_) {}
    return null;
  }
}

function writeJson(key, value) {
  try {
    const raw = JSON.stringify(value);
    if (raw.length > MAX_BYTES) {
      console.warn(`[draftStore] ${key} too large to persist (${raw.length} bytes) — skipped`);
      return false;
    }
    localStorage.setItem(key, raw);
    return true;
  } catch (err) {
    // Quota exceeded / storage disabled. Not fatal — the editor keeps
    // working, it just can't offer a restore later.
    console.warn(`[draftStore] could not persist ${key}:`, err?.message || err);
    return false;
  }
}

function remove(key) {
  try { localStorage.removeItem(key); } catch (_) {}
}

function fresh(entry) {
  if (!entry || typeof entry.updatedAt !== "number") return false;
  return Date.now() - entry.updatedAt < MAX_AGE_MS;
}

/* ── Unsaved workflow draft ──────────────────────────────────────────── */

/**
 * Persist the editor's current workflow.
 * @param {string} userKey
 * @param {{steps:Array, variables:Array, meta:object, workflowId:number|null,
 *          workflowName:string, perfSettings:object, proxy:object|null,
 *          url:string}} draft
 */
export function saveDraft(userKey, draft) {
  if (!draft || !Array.isArray(draft.steps) || draft.steps.length === 0) {
    // Nothing worth restoring — make sure a stale draft doesn't linger.
    clearDraft(userKey);
    return false;
  }
  return writeJson(draftKey(userKey), {
    ...draft,
    steps: stripTransient(draft.steps),
    updatedAt: Date.now(),
  });
}

/** The stored draft, or null when absent, corrupt, empty or expired. */
export function loadDraft(userKey) {
  const key = draftKey(userKey);
  const entry = readJson(key);
  if (!entry) return null;
  if (!fresh(entry) || !Array.isArray(entry.steps) || entry.steps.length === 0) {
    remove(key);
    return null;
  }
  return entry;
}

export function clearDraft(userKey) {
  remove(draftKey(userKey));
}

/* ── Guided-tour progress ────────────────────────────────────────────── */

/**
 * Persist where the user is in the tour AND the throwaway workflow it has
 * built, so a refresh mid-tour resumes the tour instead of dumping the user
 * into a half-built demo scraper with no context.
 *
 * @param {string} userKey
 * @param {{idx:number, maxIdx:number, steps:Array, variables:Array}} progress
 */
export function saveTourProgress(userKey, progress) {
  if (!progress || typeof progress.idx !== "number") return false;
  return writeJson(tourKey(userKey), {
    idx: progress.idx,
    maxIdx: typeof progress.maxIdx === "number" ? progress.maxIdx : progress.idx,
    total: progress.total ?? null,
    steps: stripTransient(progress.steps || []),
    variables: progress.variables || [],
    updatedAt: Date.now(),
  });
}

export function loadTourProgress(userKey) {
  const key = tourKey(userKey);
  const entry = readJson(key);
  if (!entry) return null;
  if (!fresh(entry) || typeof entry.idx !== "number") {
    remove(key);
    return null;
  }
  return entry;
}

export function clearTourProgress(userKey) {
  remove(tourKey(userKey));
}

/* ── Tour preferences ────────────────────────────────────────────────── */

/** @returns {{completed:boolean, promptDismissed:boolean}} */
export function loadTourPrefs(userKey) {
  const entry = readJson(prefsKey(userKey)) || {};
  return {
    completed: !!entry.completed,
    promptDismissed: !!entry.promptDismissed,
  };
}

/** Shallow-merge a patch into the stored prefs. */
export function saveTourPrefs(userKey, patch) {
  const next = { ...loadTourPrefs(userKey), ...(patch || {}), updatedAt: Date.now() };
  return writeJson(prefsKey(userKey), next);
}
