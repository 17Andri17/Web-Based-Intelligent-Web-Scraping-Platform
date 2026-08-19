'use strict';

const runEvents = require('./runEvents.service');
const { createScreencastPacer } = require('../browser/screencastPacer');

/* ===========================================================================
   debugSession — the parent half of Debug Mode
   ---------------------------------------------------------------------------
   One session per debug run. It owns the two things a run's child process
   cannot own for itself: the socket connections watching it, and the decision
   about when an abandoned session has to be given up.

   Where the pieces sit:

     browser/debugBridge.js   in the child: the pause gate, the page probe,
                              the screencast source
     services/runner.service  the IPC channel between the two
     THIS FILE                fan-out to viewers, frame pacing, lifecycle
     server.js                socket handlers (watchDebug / debugControl)

   ── Why the frames are paced twice ───────────────────────────────────────
   The child holds at most one frame in flight to us and withholds Chrome's ack
   while it waits. We hold at most `maxInFlight` frames on the wire to the
   browser and withhold the child's ack while THOSE wait. Each hop drops stale
   frames rather than queueing them, so the picture is always the newest one
   the slowest link can carry, and capture throttles itself all the way back to
   Chrome. It is the same contract at both hops (browser/screencastPacer.js),
   which is why the existing pacer can be reused here unchanged — including its
   adaptive quality, whose decisions we forward to the child as a 'quality'
   message.

   ── Why a debug session expires ──────────────────────────────────────────
   A paused run is not free: it holds an open Chrome, one of the global run
   slots (services/runner.service.js caps concurrent runs), and a row that says
   'running'. A user who closes the window mid-pause would otherwise strand all
   three indefinitely — the run cannot finish, because nothing is left to
   resume it. So an unwatched session is given a short grace period and then
   cancelled, and no session may sit paused forever even with someone watching.
   ========================================================================= */

// Grace period after the last viewer leaves. Long enough to survive a reload
// or a laptop lid closing for a moment; short enough that a closed window
// doesn't hold a Chrome for the rest of the afternoon.
const ABANDON_MS = Number(process.env.WS_DEBUG_ABANDON_MS) || 120_000;
// A single pause may not outlive this, viewers or not. Debugging is
// interactive by definition; fifteen minutes on one step means the session was
// left, not used.
const MAX_PAUSE_MS = Number(process.env.WS_DEBUG_MAX_PAUSE_MS) || 900_000;
// How often the sweep checks the two rules above.
const SWEEP_MS = 15_000;

// JPEG quality ceiling for the debug stream — the pacer may go below this on a
// slow link, never above it.
const BASE_QUALITY = Number(process.env.WS_DEBUG_QUALITY) || 60;

/** @type {Map<number, object>} runId → session */
const sessions = new Map();
/** @type {Map<number, number>} userId → runId — one debug session per user */
const byUser = new Map();

/**
 * Can this user start a debug run right now?
 * @returns {{ok: true} | {ok: false, reason: string, runId: number}}
 */
function canStart(userId) {
  const existing = byUser.get(Number(userId));
  if (existing && sessions.has(existing)) {
    return {
      ok: false,
      runId: existing,
      reason: `Debug run #${existing} is still open. Stop it before starting another — a paused run holds a browser open.`,
    };
  }
  return { ok: true };
}

/**
 * Register a debug session. Opened as soon as the run has an id — BEFORE the
 * child process exists — because the debug window is addressed by run id and
 * starts connecting the moment the launching tab learns it. A window that gets
 * there first must find a session in the process of starting, not a flat "no
 * such debug run"; the control channel is attached a moment later, and until
 * then commands simply report that they didn't land (nothing can have reached
 * a gate yet anyway).
 *
 * @param {number}   runId
 * @param {object}   opts
 * @param {number}   opts.userId
 * @param {function} [opts.control]  (msg) => boolean — send to the child
 * @param {object}   [opts.forced]   What debug switched off, for the window to show
 */
function open(runId, { userId, control = null, forced = null }) {
  const id = Number(runId);
  close(id);   // a retry of the same run replaces the previous session

  const session = {
    runId: id,
    userId: Number(userId),
    control: control || (() => false),
    live: !!control,
    /* The settings this run is NOT using, so the window can say so. A user
       debugging "why does it break at 8 workers" must never conclude from a
       clean debug session that the workflow is fine — debug runs one page at a
       time, and that difference has to be visible, not buried in a log line. */
    forced: forced || null,
    viewers: new Set(),
    // Last pause payload, kept so a window opening (or reloading) mid-pause
    // renders the current state instead of an empty panel waiting for the
    // next event that will never come — the run is parked, by definition.
    paused: null,
    pausedSince: null,
    url: null,                 // last address the run reported, live
    lastViewerAt: Date.now(),
    breakpoints: [],
    slowMoMs: 0,
    startedAt: Date.now(),
    pacer: null,
    frameSeq: 0,
    lastStepResult: null,
    results: null,          // rows captured so far, pulled by a window on demand
    resultsSummary: null,   // JSON of {key: count}, so a repeat is not rebroadcast
    closed: false,
  };

  /* Frame delivery. The pacer asks us to put a frame on the wire and tells us
     it is done when every viewer has confirmed receipt; only then does the
     child get its ack and capture the next one. */
  session.pacer = createScreencastPacer({
    baseQuality: BASE_QUALITY,
    emitFrame: (buf, onDelivered) => {
      const viewers = Array.from(session.viewers);
      if (!viewers.length) { onDelivered(); return; }
      let outstanding = viewers.length;
      const settle = () => { if (--outstanding <= 0) onDelivered(); };
      for (const socket of viewers) {
        try { socket.emit('debugFrame', buf, settle); } catch (_) { settle(); }
      }
    },
    // "Ack Chrome" one hop further back: the child is what throttles Chrome.
    ackChrome: () => { try { session.control({ t: 'frameAck' }); } catch (_) {} },
    onQualityChange: (q) => { try { session.control({ t: 'quality', q }); } catch (_) {} },
  });

  sessions.set(id, session);
  byUser.set(Number(userId), id);
  return session;
}

function get(runId) {
  return sessions.get(Number(runId)) || null;
}

/** The child now exists; wire its control channel into the waiting session. */
function attachControl(runId, control) {
  const s = get(runId);
  if (!s || typeof control !== 'function') return false;
  s.control = control;
  s.live = true;
  broadcast(s, 'debugReady', { runId: s.runId });
  return true;
}

/** Everything a window needs to draw itself on attach, mid-run. */
function snapshot(runId) {
  const s = get(runId);
  if (!s) return null;
  return {
    runId: s.runId,
    paused: s.paused,
    url: s.url,
    breakpoints: s.breakpoints.slice(),
    slowMoMs: s.slowMoMs,
    viewers: s.viewers.size,
    live: s.live,
    forced: s.forced,
    startedAt: s.startedAt,
  };
}

/* ── Messages from the child ─────────────────────────────────────────────── */

function handleChildMessage(runId, msg) {
  const s = get(runId);
  if (!s || !msg || typeof msg !== 'object') return;

  switch (msg.t) {
    case 'frame':
      // Nobody is watching: drop it and let the child carry on rather than
      // stalling its capture loop waiting for an ack that has no reader.
      if (!s.viewers.size) { try { s.control({ t: 'frameAck' }); } catch (_) {} return; }
      s.pacer.handleFrame({ data: msg.buf, sessionId: ++s.frameSeq, meta: { w: msg.w, h: msg.h } });
      return;

    case 'paused':
      s.paused = msg.payload || null;
      s.pausedSince = Date.now();
      // The stats for the step that just ran, so an 'after' pause can say what
      // it captured and not only what the page looks like now.
      if (s.paused && s.paused.when === 'after' && s.lastStepResult
          && s.paused.step && s.lastStepResult.stepId === s.paused.step.id) {
        s.paused.captured = s.lastStepResult;
      }
      broadcast(s, 'debugPaused', s.paused);
      return;

    case 'resumed':
      s.paused = null;
      s.pausedSince = null;
      broadcast(s, 'debugResumed', { seq: msg.seq });
      return;

    case 'probeResult':
      broadcast(s, 'debugProbeResult', { id: msg.id || null, result: msg.result || null });
      return;

    case 'htmlResult':
      broadcast(s, 'debugHtml', { id: msg.id || null, html: msg.html || null, url: msg.url || null });
      return;

    case 'url':
      /* The address as it changes, not only at a pause. A paginating run walks
         page 2, 3, 4 without ever stopping, and a window that only learns the
         address when the run parks cannot answer the question the user is
         actually asking of it — are the links advancing, or is it re-reading
         page 1 twenty times? Kept on the session too, so a window attaching
         mid-run starts with the right address instead of a blank bar. */
      s.url = msg.url || null;
      broadcast(s, 'debugUrl', { url: s.url });
      return;

    case 'scroll':
      // Folded into the held pause as well as broadcast, so a window that
      // attaches after someone scrolled sees where the page actually is.
      if (s.paused) {
        s.paused.scroll = {
          x: msg.x, y: msg.y, pageHeight: msg.pageHeight, viewportHeight: msg.viewportHeight,
        };
      }
      broadcast(s, 'debugScroll', {
        x: msg.x, y: msg.y, pageHeight: msg.pageHeight, viewportHeight: msg.viewportHeight,
      });
      return;

    case 'cast':
      broadcast(s, 'debugCast', { url: msg.url || null, quality: msg.quality || null });
      return;

    case 'hello':
      broadcast(s, 'debugReady', { pid: msg.pid || null });
      return;

    default:
      return;
  }
}

/** Per-extraction stats from the stdout marker stream, held for the next pause. */
function noteStepResult(runId, stat) {
  const s = get(runId);
  if (s && stat && stat.stepId) s.lastStepResult = stat;
}

/* Rows captured so far.

   Held, and announced only as a SUMMARY — the set of keys and how many rows
   each has. That is a few dozen bytes however large the run gets, so it can be
   pushed on every checkpoint; the rows themselves are fetched by a window that
   is actually looking at them (see readResults), capped, because a panel
   showing a table has no use for the other 40,000 rows. */
function noteResults(runId, results) {
  const s = get(runId);
  if (!s || !results) return;
  s.results = results;
  const summary = {};
  for (const [key, value] of Object.entries(results)) {
    summary[key] = Array.isArray(value) ? value.length : (value == null ? 0 : 1);
  }
  const encoded = JSON.stringify(summary);
  if (encoded === s.resultsSummary) return;   // nothing new to say
  s.resultsSummary = encoded;
  broadcast(s, 'debugResults', { summary });
}

// How many rows of each result set a window may pull. Enough to see the shape
// of the data and spot a column that is coming back empty; far short of
// shipping a large scrape through a socket to fill a preview table.
const RESULTS_PAGE = 200;

/** The captured rows, capped, for a window that is displaying them. */
function readResults(runId) {
  const s = get(runId);
  if (!s || !s.results) return null;
  const out = {};
  const truncated = {};
  for (const [key, value] of Object.entries(s.results)) {
    if (Array.isArray(value)) {
      out[key] = value.slice(0, RESULTS_PAGE);
      if (value.length > RESULTS_PAGE) truncated[key] = value.length;
    } else {
      out[key] = value;
    }
  }
  return { results: out, truncated, limit: RESULTS_PAGE };
}

/* ── Messages from a window ──────────────────────────────────────────────── */

// Only these reach the child. An allowlist rather than a passthrough: the
// control channel runs arbitrary evaluation inside the run's browser, so what
// a socket may ask for is worth stating explicitly.
const ALLOWED = new Set(['resume', 'pause', 'breakpoints', 'mute', 'unmute', 'speed', 'probe', 'html', 'input']);

function command(runId, msg) {
  const s = get(runId);
  if (!s || !msg || !ALLOWED.has(msg.t)) return false;

  // Mirror the state the window is allowed to set, so a second window (or the
  // same one after a reload) sees the breakpoints that are actually in force.
  if (msg.t === 'breakpoints') s.breakpoints = (msg.ids || []).map(String);
  if (msg.t === 'speed')       s.slowMoMs = Math.max(0, Math.min(10000, Number(msg.ms) || 0));

  const ok = s.control(msg);
  if (ok && msg.t === 'breakpoints') broadcast(s, 'debugState', { breakpoints: s.breakpoints });
  return ok;
}

/* ── Viewers ─────────────────────────────────────────────────────────────── */

function attachViewer(runId, socket) {
  const s = get(runId);
  if (!s) return false;
  s.viewers.add(socket);
  s.lastViewerAt = Date.now();
  /* A window arriving while the run is already parked has missed the frame
     that came with the pause — it was dropped, because at the time nobody was
     watching — and no other is coming, because a paused page never repaints.
     Without this the window renders the pause perfectly and shows a blank
     screen next to it. */
  if (s.paused) { try { s.control({ t: 'snap' }); } catch (_) {} }
  return true;
}

function detachViewer(runId, socket) {
  const s = get(runId);
  if (!s) return;
  s.viewers.delete(socket);
  if (!s.viewers.size) s.lastViewerAt = Date.now();
}

/** Drop a disconnecting socket from every session it was watching. */
function detachEverywhere(socket) {
  for (const s of sessions.values()) {
    if (s.viewers.delete(socket) && !s.viewers.size) s.lastViewerAt = Date.now();
  }
}

function broadcast(session, event, payload) {
  for (const socket of session.viewers) {
    try { socket.emit(event, payload); } catch (_) {}
  }
}

/* ── Lifecycle ───────────────────────────────────────────────────────────── */

function close(runId) {
  const id = Number(runId);
  const s = sessions.get(id);
  if (!s) return;
  s.closed = true;
  try { s.pacer.stop(); } catch (_) {}
  broadcast(s, 'debugClosed', { runId: id });
  sessions.delete(id);
  if (byUser.get(s.userId) === id) byUser.delete(s.userId);
}

/* The sweep. Two rules, both about a session nobody is driving any more:
   an unwatched one gets a grace period, and no pause may outlive MAX_PAUSE_MS.
   Cancelling goes through runEvents so it takes exactly the path the Stop
   button takes — the run is finalised, its partial results are kept, and the
   row stops claiming to be running. */
let sweepTimer = null;

function sweep(now = Date.now()) {
  const cancelled = [];
  for (const s of Array.from(sessions.values())) {
    const abandoned = !s.viewers.size && (now - s.lastViewerAt) > ABANDON_MS;
    const stuck = s.pausedSince && (now - s.pausedSince) > MAX_PAUSE_MS;
    if (!abandoned && !stuck) continue;
    const why = abandoned
      ? 'Debug window closed — stopping the run rather than leaving a browser paused.'
      : 'Debug session paused too long — stopping the run.';
    try { runEvents.log(s.runId, { line: `🛑 ${why}`, level: 'error' }); } catch (_) {}
    try { runEvents.cancel(s.runId); } catch (_) {}
    close(s.runId);
    cancelled.push(s.runId);
  }
  return cancelled;
}

function start() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => { try { sweep(); } catch (_) {} }, SWEEP_MS);
  if (sweepTimer.unref) sweepTimer.unref();
}

function stop() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

module.exports = {
  canStart, open, get, attachControl, snapshot, close,
  handleChildMessage, noteStepResult, noteResults, readResults, command,
  attachViewer, detachViewer, detachEverywhere,
  sweep, start, stop,
  ABANDON_MS, MAX_PAUSE_MS, BASE_QUALITY,
};
