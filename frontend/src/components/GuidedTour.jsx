import React, { useEffect, useState, useCallback, useRef } from "react";
import "../styles/GuidedTour.css";

/* =====================================================================
   GuidedTour — an interactive, forced product tour.

   Dims the whole screen and cuts a spotlight "hole" over the current
   step's target; everything outside the hole is click-blocked, so the
   only thing the user can interact with is what the tour points at. A
   step advances only when the user performs its exact action.

   Going BACK is safe: a step only auto-advances while it is the FRONTIER
   (furthest-reached) step. Revisited (already-completed) steps show a
   plain Next button and never auto-jump forward — which fixes the "Back
   immediately bounces to the current step" problem.

   Target kinds:
     • app-chrome DOM element — a CSS selector (often a [data-tour="…"]).
     • a region on the streamed canvas — { canvas: "<demo selector>" },
       resolved via the backend getElementRect + mapPageRectToScreen().
     • null — a centered callout with no spotlight.

   A step advances when (whichever applies, at the frontier):
     • info:true        → user clicks Next
     • gate(state)      → returns true (reads live editor state)
     • domGate:"<css>"  → that element exists in the document

   Progress is resumable: the host passes startIdx/startMaxIdx to reopen the
   tour where the user left it, and receives every move through onProgress so
   it can persist it. That persistence belongs to the TOUR, not to the user's
   drafts — the demo workflow built along the way is never one of their
   scrapers.

   Props: open, onClose, onFinish, steps, state, socket,
          mapPageRectToScreen(pageRect), api, startIdx, startMaxIdx,
          onProgress({ idx, maxIdx, total })
   ===================================================================== */

const PAD = 6;

export default function GuidedTour({
  open, onClose, onFinish, steps = [], state, socket, mapPageRectToScreen, api,
  startIdx = 0, startMaxIdx = 0, onProgress,
}) {
  const [idx, setIdx] = useState(0);
  const [maxIdx, setMaxIdx] = useState(0);
  const [hole, setHole] = useState(null);
  const [hl, setHl] = useState([]); // extra labeled highlights (soft explainers)
  const enteredRef = useRef(-1);

  const step = open ? steps[idx] : null;
  const total = steps.length;
  const atFrontier = idx >= maxIdx;
  // "soft" (showcase) steps don't darken the screen or block clicks — they just
  // highlight something and describe it, and the user can click anywhere. They
  // advance on Next (and also on their gate/domGate, if any).
  const soft = !!step && !!step.soft;
  // Run the auto-advance check at the frontier whenever a condition exists.
  const canGate = !!step && atFrontier && (typeof step.gate === "function" || !!step.domGate);

  const finish = useCallback(() => { onFinish?.(); onClose?.(); }, [onFinish, onClose]);

  // Opening seeks to the caller's saved position, so a refresh (or an exit
  // and a later "Resume") picks the walkthrough back up instead of starting
  // over at step 1. Intentionally keyed on `open` ALONE: startIdx changes on
  // every advance (the host persists it), and re-running this on those
  // changes would fight the user's own Back button.
  useEffect(() => {
    if (!open) return;
    const last = Math.max(0, steps.length - 1);
    const from = Math.min(Math.max(0, Math.trunc(startIdx) || 0), last);
    setIdx(from);
    setMaxIdx(Math.min(Math.max(from, Math.trunc(startMaxIdx) || 0), last));
    enteredRef.current = -1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Report every move so the host can persist it. `onProgress` must be
  // referentially stable (useCallback) — it is called from an effect.
  useEffect(() => {
    if (!open) return;
    onProgress?.({ idx, maxIdx, total: steps.length });
  }, [open, idx, maxIdx, steps.length, onProgress]);

  const advance = useCallback(() => {
    setIdx(i => {
      const next = i + 1;
      if (next >= total) { finish(); return i; }
      setMaxIdx(m => Math.max(m, next));
      return next;
    });
  }, [total, finish]);

  // Run a step's onEnter once each time it becomes active.
  useEffect(() => {
    if (!open || !step) return;
    if (enteredRef.current === idx) return;
    enteredRef.current = idx;
    try { step.onEnter?.(api || {}); } catch (_) {}
  }, [open, step, idx, api]);

  // ── spotlight measurement ────────────────────────────────────────────────
  const measureDom = useCallback(() => {
    if (!step) { setHole(null); setHl([]); return; }
    const t = step.target;
    if (!t) { setHole(null); }
    else if (typeof t === "string") {
      const el = document.querySelector(t);
      const r = el && el.getBoundingClientRect();
      if (!r || (r.width === 0 && r.height === 0)) setHole(null);
      else setHole({ left: r.left - PAD, top: r.top - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 });
    }
    // Extra labeled highlights (DOM only) — used by soft explainer steps to
    // point at several controls at once.
    if (Array.isArray(step.highlights) && step.highlights.length) {
      const out = [];
      for (const h of step.highlights) {
        if (!h || typeof h.target !== "string") continue;
        const el = document.querySelector(h.target);
        const r = el && el.getBoundingClientRect();
        if (r && (r.width || r.height)) {
          out.push({ left: r.left - 3, top: r.top - 3, width: r.width + 6, height: r.height + 6, label: h.label });
        }
      }
      setHl(out);
    } else setHl([]);
  }, [step]);

  useEffect(() => {
    if (!open) return;
    measureDom();
    const iv = setInterval(measureDom, 350);
    window.addEventListener("resize", measureDom);
    window.addEventListener("scroll", measureDom, true);
    return () => { clearInterval(iv); window.removeEventListener("resize", measureDom); window.removeEventListener("scroll", measureDom, true); };
  }, [open, measureDom]);

  // canvas targets: ask the backend for the demo element's rect, map to screen.
  useEffect(() => {
    if (!open || !step || !socket) return;
    const t = step.target;
    if (!t || typeof t !== "object" || !t.canvas) return;
    let alive = true;
    const onRect = (payload) => {
      if (!alive || !payload || !payload.ok || payload.selector !== t.canvas) return;
      const s = mapPageRectToScreen?.(payload.rect);
      if (s && s.width > 0) setHole({ left: s.left - PAD, top: s.top - PAD, width: s.width + PAD * 2, height: s.height + PAD * 2 });
    };
    socket.on("elementRect", onRect);
    const ask = () => socket.emit("getElementRect", { selector: t.canvas, selectorType: "css" });
    ask();
    const iv = setInterval(ask, 600);
    return () => { alive = false; socket.off("elementRect", onRect); clearInterval(iv); };
  }, [open, step, socket, mapPageRectToScreen]);

  // ── advance-on-action (frontier only) ─────────────────────────────────────
  useEffect(() => {
    if (!canGate || !step) return;
    const check = () => {
      let ok = false;
      if (typeof step.gate === "function") { try { ok = step.gate(state || {}); } catch (_) { ok = false; } }
      if (!ok && step.domGate) { try { ok = !!document.querySelector(step.domGate); } catch (_) { ok = false; } }
      if (ok) advance();
    };
    // Check immediately (state-driven) and poll (covers domGate + late updates).
    check();
    const iv = setInterval(check, 300);
    return () => clearInterval(iv);
  }, [canGate, step, state, advance]);

  if (!open || !step) return null;

  // Keep the callout clear of everything it's pointing at (the target + any
  // labeled highlights), and drop it into the largest free band of the screen.
  const avoid = boundingBox([hole, ...hl].filter(Boolean));
  const callout = placeCallout(avoid, step.place);
  // Forced action steps wait; info, soft, and revisited steps show Next.
  const showNext = step.info || soft || !atFrontier;

  return (
    <div className="gt-root" aria-live="polite">
      {/* Forced steps put a LIGHT click-guard around the highlighted target —
          the rest of the platform stays fully visible (only lightly dimmed) so
          the user can see what's going on, but clicks land only on the target.
          Crucially we NEVER cover the whole screen: if the target isn't
          measured yet (async canvas rect, a control that hasn't rendered), we
          block nothing and keep polling, so the user can never get stuck behind
          an opaque overlay. Soft steps add no guard at all. */}
      {!soft && hole && (
        <>
          <div className="gt-mask" style={{ left: 0, top: 0, width: "100%", height: Math.max(0, hole.top) }} />
          <div className="gt-mask" style={{ left: 0, top: hole.top, width: Math.max(0, hole.left), height: hole.height }} />
          <div className="gt-mask" style={{ left: hole.left + hole.width, top: hole.top, right: 0, height: hole.height }} />
          <div className="gt-mask" style={{ left: 0, top: hole.top + hole.height, width: "100%", bottom: 0 }} />
        </>
      )}
      {hole && <div className={`gt-ring ${soft ? "gt-ring--soft" : ""}`} style={{ left: hole.left, top: hole.top, width: hole.width, height: hole.height }} />}

      {/* Labeled highlights — several controls pointed out at once. */}
      {hl.map((h, i) => (
        <React.Fragment key={i}>
          <div className="gt-ring gt-ring--soft" style={{ left: h.left, top: h.top, width: h.width, height: h.height }} />
          {h.label && (
            <div className="gt-hl-label" style={labelPos(h)}>{h.label}</div>
          )}
        </React.Fragment>
      ))}

      <div className={`gt-callout gt-callout--${callout.side} ${soft ? "gt-callout--soft" : ""}`} style={callout.style}>
        <div className="gt-callout-head">
          <span className="gt-step-count">Step {idx + 1} of {total}</span>
          <button className="gt-exit" onClick={onClose} title="Leave the tour">Exit</button>
        </div>
        {step.title && <div className="gt-title">{step.title}</div>}
        {step.body && <div className="gt-body">{step.body}</div>}
        <div className="gt-actions">
          {idx > 0 && <button className="gt-btn ghost" onClick={() => setIdx(i => Math.max(0, i - 1))}>Back</button>}
          {showNext
            ? <button className="gt-btn primary" onClick={advance}>{idx + 1 >= total ? "Finish" : "Next"}</button>
            : <span className="gt-waiting">{step.waiting || "Do the highlighted step to continue"}</span>}
        </div>
      </div>
    </div>
  );
}

// Smallest rect enclosing all the given rects (or null).
function boundingBox(rects) {
  if (!rects.length) return null;
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const x of rects) { l = Math.min(l, x.left); t = Math.min(t, x.top); r = Math.max(r, x.left + x.width); b = Math.max(b, x.top + x.height); }
  return { left: l, top: t, width: r - l, height: b - t };
}

/* Place the callout so it NEVER covers what it points at (`avoid`), in the side
   with the most free space. A step may force a side with `place`
   ('below'|'above'|'left'|'right'). Falls back to a corner if nothing fits. */
function placeCallout(avoid, place) {
  const W = 340, H = 180, M = 16;
  const vw = window.innerWidth, vh = window.innerHeight;
  if (!avoid) return { side: "center", style: { left: (vw - W) / 2, top: Math.max(M, (vh - H) / 2), width: W } };

  const space = {
    below: vh - (avoid.top + avoid.height) - M,
    above: avoid.top - M,
    right: vw - (avoid.left + avoid.width) - M,
    left:  avoid.left - M,
  };
  const fits = { below: space.below >= H, above: space.above >= H, right: space.right >= W, left: space.left >= W };

  const pos = (side) => {
    if (side === "below") return { left: clamp(centerX(avoid) - W / 2, M, vw - W - M), top: avoid.top + avoid.height + M };
    if (side === "above") return { left: clamp(centerX(avoid) - W / 2, M, vw - W - M), top: avoid.top - H - M };
    if (side === "right") return { left: avoid.left + avoid.width + M, top: clamp(centerY(avoid) - H / 2, M, vh - H - M) };
    return { left: Math.max(M, avoid.left - W - M), top: clamp(centerY(avoid) - H / 2, M, vh - H - M) }; // left
  };

  // Preference: an explicit `place` (if it fits), else the side with the most
  // room among the ones that fit, else the roomiest overall.
  const order = ["below", "above", "right", "left"];
  let side = null;
  if (place && fits[place]) side = place;
  if (!side) {
    const fitting = order.filter(s => fits[s]);
    side = (fitting.length ? fitting : order).sort((a, b) => space[b] - space[a])[0];
  }
  return { side, style: { ...pos(side), width: W } };
}

function centerX(r) { return r.left + r.width / 2; }
function centerY(r) { return r.top + r.height / 2; }
function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

// A small label bubble for a highlight — below it if there's room, else above.
function labelPos(h) {
  const belowRoom = window.innerHeight - (h.top + h.height) > 34;
  return belowRoom
    ? { left: clamp(h.left, 6, window.innerWidth - 160), top: h.top + h.height + 6 }
    : { left: clamp(h.left, 6, window.innerWidth - 160), top: Math.max(6, h.top - 30) };
}
