import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import "../styles/GuidedTour.css";

/* =====================================================================
   GuidedTour — a guide that sits BESIDE the product, not on top of it.

   The previous version dimmed the screen, cut a spotlight hole, blocked
   every click outside it, ringed several controls at once and floated its
   callout wherever there was room. In practice that meant overlapping
   rings nobody could read, a panel that wandered off-screen, and a first
   impression of the app that was mostly a grey sheet. This one inverts
   all of that:

     • NOTHING is blocked. Every control stays live the whole way through,
       so the walkthrough is a real session with a guide next to it rather
       than a rail the user is pushed along.
     • ONE highlight at a time. Exactly one ring, ever — overlapping rings
       were unreadable, and "look at these three things" is not a step.
     • The panel is DOCKED and always on screen. It keeps one position and
       only moves when it would otherwise cover the thing it is pointing
       at (dodgeAnchor below).
     • It can be HIDDEN. Collapsing leaves a small pill in the corner, so
       the user can see the whole page unobstructed and bring the guide
       back when they want it.

   ── Checking the user is on track ────────────────────────────────────
   A step can describe what "wrong" looks like via hint(state). When that
   fires, the panel shows what happened and — where it makes sense — a
   single button that puts it right. That is deliberately a nudge, not a
   block: the user stays in control, they just aren't left stuck.

   ── Going back ───────────────────────────────────────────────────────
   A step that changes the workflow carries undo(api) which reverses it.
   Back then genuinely rolls the step back rather than just moving a
   counter, and "Redo this step" re-arms the current one after a mistake.
   After either, the advance check is DISARMED until it has been seen to
   be false once — otherwise a step whose effect couldn't be fully undone
   would instantly re-complete and bounce the user forward again.

   ── Step shape ───────────────────────────────────────────────────────
     id, title, body
     target      app CSS selector | { canvas: "<selector on the page>" } | null
     gate(state) advance when true            \ forced steps: exactly one
     domGate     advance when this exists     / of these two
     soft        true → a "look at this" step; advances on Next
     optional    true → offer a Skip link (never leave anyone stuck)
     waiting     what the panel says while it waits
     hint(state) → { text, action?: { label, run(api) } } | null
     undo(api)   reverse this step's effect (enables Back / Redo)
     onEnter(api)
     place       'bottom-right'|'bottom-left'|'top-right'|'top-left' preference

   Props: open, onClose, onFinish, steps, state, socket,
          mapPageRectToScreen(pageRect), api, startIdx, startMaxIdx,
          onProgress({ idx, maxIdx, total })
   ===================================================================== */

const PANEL_W   = 352;   // must match .gt-panel width in GuidedTour.css
const MARGIN    = 18;    // gap between the panel and the viewport edge
const RING_PAD  = 7;     // breathing room around the highlighted element
const CLEARANCE = 14;    // gap the panel keeps from the highlighted element

export default function GuidedTour({
  open, onClose, onFinish, steps = [], state, socket, mapPageRectToScreen, api,
  startIdx = 0, startMaxIdx = 0, onProgress,
}) {
  const [idx, setIdx]           = useState(0);
  const [maxIdx, setMaxIdx]     = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [hole, setHole]         = useState(null);
  // Where the panel currently sits. Sticky on purpose: a guide that hops to
  // a different corner on every step is exhausting to follow, so it stays
  // put until it would actually cover what it is pointing at.
  const [anchor, setAnchor]     = useState(() => cornerPos("bottom-right", 260));
  // Bumped to force onEnter to run again for the same step ("Redo this step").
  const [enterNonce, setEnterNonce] = useState(0);

  const panelRef   = useRef(null);
  const enteredRef = useRef(-1);
  const idxRef     = useRef(0);
  // The target is re-measured a few times a second so the ring follows a
  // control that moves. Storing a fresh object each time would re-render (and
  // recompute the panel's position) three times a second for the whole tour
  // even when nothing has moved at all, so only a real change is committed.
  const setHoleIfMoved = useCallback((next) => {
    setHole(prev => (sameRect(prev, next) ? prev : next));
  }, []);
  // False while an advance check is waiting to see its condition go false —
  // see the "going back" note above.
  const armedRef   = useRef(true);

  const step  = open ? steps[idx] : null;
  const total = steps.length;
  const atFrontier = idx >= maxIdx;
  const soft = !!step && !!step.soft;
  // Targets on the streamed page are ringed inside the page, not by this
  // overlay — the rect we hold for them is for dodging only.
  const onCanvas = !!(step && step.target && typeof step.target === "object" && step.target.canvas);
  const canGate = !!step && atFrontier && !soft
    && (typeof step.gate === "function" || !!step.domGate);

  useEffect(() => { idxRef.current = idx; }, [idx]);

  const finish = useCallback(() => { onFinish?.(); onClose?.(); }, [onFinish, onClose]);

  /* Opening seeks to the caller's saved position, so a refresh (or an exit
     and a later "Resume") picks the walkthrough back up instead of starting
     over. Keyed on `open` ALONE: startIdx changes on every advance (the host
     persists it), and re-running this then would fight the user's own Back. */
  useEffect(() => {
    if (!open) return;
    const last = Math.max(0, steps.length - 1);
    const from = Math.min(Math.max(0, Math.trunc(startIdx) || 0), last);
    setIdx(from);
    setMaxIdx(Math.min(Math.max(from, Math.trunc(startMaxIdx) || 0), last));
    setCollapsed(false);
    enteredRef.current = -1;
    armedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Report every move so the host can persist it. `onProgress` must be
  // referentially stable (useCallback) — it is called from an effect.
  useEffect(() => {
    if (!open) return;
    onProgress?.({ idx, maxIdx, total: steps.length });
  }, [open, idx, maxIdx, steps.length, onProgress]);

  const advance = useCallback(() => {
    const next = idxRef.current + 1;
    if (next >= total) { finish(); return; }
    armedRef.current = true;
    setMaxIdx(m => Math.max(m, next));
    setIdx(next);
  }, [total, finish]);

  /* Back rolls the previous step's effect back where it can (undo), rather
     than only moving a counter — so "I added the wrong thing" is recoverable
     without restarting. Undoing also makes that step the frontier again, so
     its advance check re-arms and the user really does redo it. */
  const goBack = useCallback(() => {
    const prev = idxRef.current - 1;
    if (prev < 0) return;
    const prevStep = steps[prev];
    if (typeof prevStep?.undo === "function") {
      try { prevStep.undo(api || {}); } catch (_) {}
      setMaxIdx(m => Math.min(m, prev));
      armedRef.current = false;
    }
    setIdx(prev);
  }, [steps, api]);

  // Wipe what this step did and wait for it again — the escape hatch for
  // "I clicked the wrong thing and now the step looks done".
  const redoStep = useCallback(() => {
    const s = steps[idxRef.current];
    if (typeof s?.undo === "function") { try { s.undo(api || {}); } catch (_) {} }
    setMaxIdx(m => Math.min(m, idxRef.current));
    armedRef.current = false;
    enteredRef.current = -1;
    setEnterNonce(n => n + 1);
  }, [steps, api]);

  // Run a step's onEnter once each time it becomes active.
  useEffect(() => {
    if (!open || !step) return;
    if (enteredRef.current === idx) return;
    enteredRef.current = idx;
    try { step.onEnter?.(api || {}); } catch (_) {}
  }, [open, step, idx, api, enterNonce]);

  /* ── Measuring the one highlighted element ────────────────────────────── */
  const measureDom = useCallback(() => {
    if (!step) { setHoleIfMoved(null); return; }
    const t = step.target;
    // Canvas targets are measured by the effect below (they need a round-trip
    // to the browser process), so leave whatever it last resolved in place.
    if (t && typeof t === "object") return;
    if (!t) { setHoleIfMoved(null); return; }
    const el = document.querySelector(t);
    const r = el && el.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) { setHoleIfMoved(null); return; }
    setHoleIfMoved(rectWithPad(r));
  }, [step, setHoleIfMoved]);

  useEffect(() => {
    if (!open) return;
    measureDom();
    const iv = setInterval(measureDom, 300);
    window.addEventListener("resize", measureDom);
    window.addEventListener("scroll", measureDom, true);
    return () => {
      clearInterval(iv);
      window.removeEventListener("resize", measureDom);
      window.removeEventListener("scroll", measureDom, true);
    };
  }, [open, measureDom]);

  /* Canvas targets are highlighted BY THE PAGE, not by this overlay.

     An overlay ring positioned from a polled rect trailed the content
     whenever the page scrolled, and — living above the canvas rather than
     inside it — followed a target that had scrolled out of view straight
     over the app's toolbar. The page draws its own ring in document
     coordinates instead (server.js → 'tourHighlight'), so it moves with what
     it marks, gets clipped by the page's viewport, and arrives in the same
     frame as the content.

     Re-emitted on a slow poll because a navigation wipes it; the handler
     ignores a repeat of the same selector, so this costs nothing. */
  useEffect(() => {
    if (!open || !socket) return;
    const t = step?.target;
    const sel = t && typeof t === "object" ? t.canvas : null;
    socket.emit("tourHighlight", { selector: sel || null, selectorType: "css" });
    if (!sel) return;
    const iv = setInterval(
      () => socket.emit("tourHighlight", { selector: sel, selectorType: "css" }), 1000);
    // Clear on the way out, or the ring outlives the tour.
    return () => { clearInterval(iv); socket.emit("tourHighlight", { selector: null }); };
  }, [open, socket, step]);

  /* The rect is still needed — but only so the panel knows what to dodge, not
     to draw anything. mapPageRectToScreen clips it to the canvas and returns
     null once the target has scrolled out of view, so the panel never flees
     the toolbar on account of something that isn't on screen. */
  useEffect(() => {
    if (!open || !step || !socket) return;
    const t = step.target;
    if (!t || typeof t !== "object" || !t.canvas) return;
    let alive = true;
    const onRect = (payload) => {
      if (!alive || !payload || !payload.ok || payload.selector !== t.canvas) return;
      setHoleIfMoved(mapPageRectToScreen?.(payload.rect) || null);
    };
    socket.on("elementRect", onRect);
    const ask = () => socket.emit("getElementRect", { selector: t.canvas, selectorType: "css" });
    ask();
    const iv = setInterval(ask, 550);
    return () => { alive = false; socket.off("elementRect", onRect); clearInterval(iv); };
  }, [open, step, socket, mapPageRectToScreen, setHoleIfMoved]);

  // A step with no target has nothing to point at — clear a stale ring
  // immediately rather than leaving the last step's highlight behind.
  useEffect(() => { if (step && !step.target) setHoleIfMoved(null); }, [step, setHoleIfMoved]);

  /* ── Advance on the user actually doing it ────────────────────────────── */
  useEffect(() => {
    if (!canGate || !step) return;
    const check = () => {
      let ok = false;
      if (typeof step.gate === "function") { try { ok = !!step.gate(state || {}); } catch (_) { ok = false; } }
      if (!ok && step.domGate) { try { ok = !!document.querySelector(step.domGate); } catch (_) { ok = false; } }
      // Disarmed after Back / Redo: wait until the condition is genuinely
      // unsatisfied before it is allowed to complete the step again.
      if (!armedRef.current) { if (!ok) armedRef.current = true; return; }
      if (ok) advance();
    };
    check();
    const iv = setInterval(check, 280);
    return () => clearInterval(iv);
  }, [canGate, step, state, advance]);

  /* ── Keeping the panel out of the way ─────────────────────────────────── */
  useEffect(() => {
    if (!open || collapsed) return;
    const reposition = () => {
      const h = panelRef.current?.offsetHeight || 260;
      setAnchor(prev => dodgeAnchor(prev, hole, h, step?.place));
    };
    reposition();
    window.addEventListener("resize", reposition);
    return () => window.removeEventListener("resize", reposition);
  }, [open, collapsed, hole, step]);

  // Esc hides the guide rather than abandoning it — the common intent is
  // "get out of my way for a second", not "throw away my progress".
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); setCollapsed(c => !c); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const hint = useMemo(() => {
    if (!step || typeof step.hint !== "function" || !atFrontier) return null;
    try { return step.hint(state || {}) || null; } catch (_) { return null; }
  }, [step, state, atFrontier]);

  if (!open || !step) return null;

  const pct = Math.round(((idx + (atFrontier ? 0 : 1)) / total) * 100);
  // Forced steps wait for the action; soft steps and already-completed ones
  // move on with a button.
  const showNext = soft || !atFrontier;
  const canUndo = typeof step.undo === "function" && atFrontier;
  const last = idx + 1 >= total;

  if (collapsed) {
    return (
      <button className="gt-pill" onClick={() => setCollapsed(false)} title="Show the guide (Esc)">
        <span className="gt-pill-mark" aria-hidden="true" />
        <span className="gt-pill-text">Guide</span>
        <span className="gt-pill-count">{idx + 1}/{total}</span>
      </button>
    );
  }

  return (
    <div className="gt-root" aria-live="polite">
      {/* Exactly one highlight, and it never swallows a click. Only for app
          controls: a target on the streamed page is ringed by the page itself
          (see the tourHighlight effect), so drawing one here too would be two
          rings on one thing — and the overlay is the one that lags. */}
      {hole && !onCanvas && (
        <div
          className={`gt-ring ${soft ? "gt-ring--soft" : ""}`}
          style={{ left: hole.left, top: hole.top, width: hole.width, height: hole.height }}
        />
      )}

      <section
        className="gt-panel"
        ref={panelRef}
        style={{ left: anchor.left, top: anchor.top, width: PANEL_W }}
        role="dialog"
        aria-label={`Guided tour, step ${idx + 1} of ${total}`}
      >
        <header className="gt-head">
          <span className="gt-brand">
            <span className="gt-brand-mark" aria-hidden="true" />
            Guided tour
          </span>
          <span className="gt-head-actions">
            <span className="gt-count">{idx + 1}/{total}</span>
            <button className="gt-icon-btn" onClick={() => setCollapsed(true)}
              title="Hide the guide and look around (Esc)" aria-label="Hide the guide">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button className="gt-icon-btn" onClick={onClose}
              title="Leave the tour (your place is kept)" aria-label="Leave the tour">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          </span>
        </header>

        <div className="gt-progress"><span style={{ width: `${pct}%` }} /></div>

        <div className="gt-body">
          {soft && <span className="gt-tag">Good to know</span>}
          {step.title && <h2 className="gt-title">{step.title}</h2>}
          {step.text && <p className="gt-text">{step.text}</p>}
          {step.body && <p className="gt-text">{step.body}</p>}
        </div>

        {/* On-track check: what looks wrong, and the one click that fixes it. */}
        {hint && (
          <div className="gt-hint">
            <span className="gt-hint-icon" aria-hidden="true">!</span>
            <div className="gt-hint-body">
              <span>{hint.text}</span>
              {hint.action && (
                <button className="gt-hint-fix" onClick={() => { try { hint.action.run?.(api || {}); } catch (_) {} }}>
                  {hint.action.label}
                </button>
              )}
            </div>
          </div>
        )}

        <footer className="gt-foot">
          <div className="gt-foot-left">
            {idx > 0 && (
              <button className="gt-btn gt-btn--ghost" onClick={goBack}
                title={typeof steps[idx - 1]?.undo === "function"
                  ? "Undo the previous step and go back to it"
                  : "Go back a step"}>
                Back
              </button>
            )}
            {canUndo && (
              <button className="gt-btn gt-btn--ghost" onClick={redoStep} title="Undo this step and try it again">
                Redo this step
              </button>
            )}
          </div>
          <div className="gt-foot-right">
            {!showNext && <span className="gt-waiting">{step.waiting || "Do the highlighted step to continue"}</span>}
            {!showNext && step.optional && (
              <button className="gt-btn gt-btn--ghost" onClick={advance}>Skip</button>
            )}
            {showNext && (
              <button className="gt-btn gt-btn--primary" onClick={advance}>{last ? "Finish" : "Next"}</button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}

/* ── geometry ─────────────────────────────────────────────────────────── */

// Rects are compared to the pixel: the ring is drawn on integer-ish screen
// coordinates, and sub-pixel jitter from the streamed canvas would otherwise
// count as movement and defeat the whole point of the check.
function sameRect(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return Math.abs(a.left - b.left) < 1 && Math.abs(a.top - b.top) < 1
      && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
}

function rectWithPad(r) {
  return {
    left: r.left - RING_PAD, top: r.top - RING_PAD,
    width: r.width + RING_PAD * 2, height: r.height + RING_PAD * 2,
  };
}

const CORNERS = ["bottom-right", "bottom-left", "top-right", "top-left"];

function cornerPos(corner, h) {
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const left = corner.endsWith("right") ? vw - PANEL_W - MARGIN : MARGIN;
  const top  = corner.startsWith("bottom") ? vh - h - MARGIN : MARGIN;
  return { left: Math.max(MARGIN, left), top: Math.max(MARGIN, top), corner };
}

function overlap(a, b) {
  if (!a || !b) return 0;
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/* Pick where the panel sits. It stays exactly where it is unless it would
   cover the highlighted element, which is the one thing a guide must never
   do — and it is always fully inside the viewport, which is the other. Ties
   go to the corner furthest from the target, so the panel drifts away from
   the action rather than hugging it. */
function dodgeAnchor(prev, target, panelH, preferred) {
  const grown = target
    ? { left: target.left - CLEARANCE, top: target.top - CLEARANCE,
        width: target.width + CLEARANCE * 2, height: target.height + CLEARANCE * 2 }
    : null;
  const rectFor = (p) => ({ left: p.left, top: p.top, width: PANEL_W, height: panelH });

  const order = [
    ...(preferred ? [preferred] : []),
    ...(prev?.corner ? [prev.corner] : []),
    ...CORNERS,
  ].filter((c, i, a) => CORNERS.includes(c) && a.indexOf(c) === i);

  let best = null;
  for (const corner of order) {
    const pos = cornerPos(corner, panelH);
    const hit = overlap(rectFor(pos), grown);
    if (hit === 0) return pos;                    // first clean option wins
    const dist = grown
      ? Math.hypot((pos.left + PANEL_W / 2) - (grown.left + grown.width / 2),
                   (pos.top + panelH / 2) - (grown.top + grown.height / 2))
      : 0;
    if (!best || hit < best.hit || (hit === best.hit && dist > best.dist)) {
      best = { pos, hit, dist };
    }
  }
  // Everything overlaps (a target that fills the screen) — take the least-bad
  // corner. The panel is still readable and the ring still shows through.
  return best ? best.pos : cornerPos("bottom-right", panelH);
}
