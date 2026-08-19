import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import io from "socket.io-client";
import { useAuth } from "../auth/AuthContext";
import { API_BASE } from "../api/client";
import HtmlInspectorPanel from "../components/HtmlInspectorPanel";
import { FlowNode, DataPreview } from "../components/ExecutionPanel";
import "../styles/DebugWindow.css";

/* ===========================================================================
   DebugWindow — /debug/:runId
   ---------------------------------------------------------------------------
   Opened in its own browser window by the Run menu's "Debug run". Same origin,
   so it authenticates its own socket from the shared session and attaches to a
   run by id — it is a watcher like any other, plus two things only a debug run
   has: the frame stream and the control channel into the running child.

   The layout answers, top to bottom, the questions someone opens it with:

     the picture      what does the page look like right now
     the step         what is about to happen, and will it find anything
     the page         what is actually in the DOM (auto-fetched when open)
     the log          what has happened so far

   Nothing here re-derives run state. Steps, their status and the log arrive on
   the same events the main window's Execution panel uses, because the window
   joins the run's room too — the only debug-specific state is the pause.
   ========================================================================= */

const SERVER_URL = API_BASE || undefined;

export default function DebugWindow({ runId }) {
  const { token, loading: authLoading } = useAuth();

  const [socket, setSocket] = useState(null);
  const [attach, setAttach] = useState({ state: "connecting", error: null });
  const [session, setSession] = useState(null);      // { paused, breakpoints, forced, live }
  const [paused, setPaused] = useState(null);
  const [status, setStatus] = useState("running");
  const [logs, setLogs] = useState([]);
  const [flowTree, setFlowTree] = useState([]);
  const [stepStates, setStepStates] = useState({});
  const [iterations, setIterations] = useState({});
  const [stepTimes, setStepTimes] = useState({});
  const [rowsCaptured, setRowsCaptured] = useState(0);
  // The step the run is executing right now (from the ordinary step stream),
  // as opposed to the step it is parked on.
  const [liveStep, setLiveStep] = useState(null);
  // { key: rowCount } for what has been captured so far — pushed on every
  // checkpoint because it is tiny. The rows are fetched by the Data tab.
  const [resultSummary, setResultSummary] = useState(null);
  // The address the run is on RIGHT NOW, not the one it was on when it last
  // parked — the difference is the whole point while pagination is walking.
  const [liveUrl, setLiveUrl] = useState(null);
  const [takeControl, setTakeControl] = useState(false);
  /* Shown the first time the user touches the page, and only then. Putting it
     up front would be a warning about something nobody had tried yet, and
     leaving it out entirely would let someone scroll a page into a state their
     next step then reads — without ever being told that was possible. */
  const [interactionNotice, setInteractionNotice] = useState(null);   // 'open' | 'dismissed' | null
  const [breakpoints, setBreakpoints] = useState(() => new Set());
  const [muted, setMuted] = useState(() => new Set());
  const [speed, setSpeed] = useState(0);
  const [tab, setTab] = useState("step");

  const canvasRef = useRef(null);
  const latestFrameRef = useRef(null);
  const rafRef = useRef(null);
  const logEndRef = useRef(null);
  // Which step is currently running. A ref, not state: it exists only to
  // resolve the previous step when the next one begins (the runner emits no
  // "step ended" marker), and nothing renders from it.
  const lastStepIdRef = useRef(null);

  /* ── Socket ─────────────────────────────────────────────────────────────
     Its own connection, not the opener's: this is a separate window and may
     outlive or precede the tab that launched the run. */
  useEffect(() => {
    if (authLoading || !token || !Number.isFinite(runId)) return;
    const s = io(SERVER_URL, { auth: { token }, transports: ["websocket"] });
    setSocket(s);

    const watch = () => {
      s.emit("watchDebug", { runId }, (res) => {
        if (!res || !res.ok) {
          setAttach({ state: "error", error: (res && res.error) || "Could not attach to this run" });
          if (res && res.status) setStatus(res.status);
          return;
        }
        setAttach({ state: "attached", error: null });
        setSession(res.debug || null);
        setPaused((res.debug && res.debug.paused) || null);
        if (res.debug && Array.isArray(res.debug.breakpoints)) setBreakpoints(new Set(res.debug.breakpoints));
        if (res.debug && res.debug.url) setLiveUrl(res.debug.url);
        if (res.status) setStatus(res.status);
        // The run's own snapshot — flow tree, step states, timings, the recent
        // log tail — so a window that opens late is not blank.
        const snap = res.run;
        if (snap) {
          setFlowTree(snap.flowTree || []);
          setStepStates(snap.stepStates || {});
          setIterations(snap.iterations || {});
          setStepTimes(snap.stepTimes || {});
          lastStepIdRef.current = snap.lastStepId || null;
          /* Seed the live step from the snapshot too. A window that opens
             mid-run has missed the stepBegin for whatever is executing right
             now, and would otherwise say "starting…" until the NEXT step
             begins — which on a slow step is exactly when someone opens the
             window to find out what is taking so long. */
          if (snap.lastStepId) {
            const cur = findStep(snap.flowTree || [], snap.lastStepId);
            setLiveStep(cur
              ? { id: cur.id, type: cur.type, label: cur.label, kind: cur.kind }
              : { id: snap.lastStepId });
          }
          setRowsCaptured(snap.rowsCaptured || 0);
          setLogs(snap.logs || []);
          if (snap.status) setStatus(snap.status);
        }
      });
    };

    s.on("connect", watch);
    s.on("connect_error", (err) => setAttach({ state: "error", error: err.message }));

    /* Frames. Acked on RECEIPT, before decoding or drawing: the server paces
       the stream against this ack, so anything done first is measured as
       network latency and charged against the frame rate. */
    s.on("debugFrame", (data, ack) => {
      latestFrameRef.current = data;
      if (typeof ack === "function") ack();
    });

    s.on("debugPaused", (p) => { setPaused(p || null); if (p && p.url) setLiveUrl(p.url); });
    s.on("debugResumed", () => setPaused(null));
    s.on("debugUrl", ({ url }) => setLiveUrl(url || null));
    // Just the counts — the rows themselves are pulled by the Data tab.
    s.on("debugResults", ({ summary }) => setResultSummary(summary || null));
    // The page moved under the user's own scrolling — keep the readout on the
    // page they are actually looking at, not the one the run parked on.
    s.on("debugScroll", (pos) => setPaused((p) => (p ? { ...p, scroll: pos } : p)));
    s.on("debugReady", () => setSession((v) => (v ? { ...v, live: true } : v)));
    s.on("debugClosed", () => setSession((v) => (v ? { ...v, live: false } : v)));

    // The ordinary run stream — identical to what the main window listens to.
    s.on("executionLog", (entry) => setLogs((prev) => [...prev.slice(-400), entry]));
    /* The runner emits no "step ended" marker, so a step is only known to have
       finished when the next one starts — the same rule runEvents applies
       server-side. Without it every step that ever ran keeps its spinner and
       the tree shows a dozen things running at once. */
    s.on("executionStepBegin", (info) => {
      if (!info || !info.id) return;
      const prevId = lastStepIdRef.current;
      lastStepIdRef.current = info.id;
      // What the run is doing RIGHT NOW. Without this the inspector has
      // nothing to say between pauses, which is most of a run — and "pause to
      // find out what is happening" is a poor answer when the thing you want
      // to know is what it is doing at speed.
      setLiveStep({ ...info, startedAt: Date.now() });
      setStepStates((prev) => {
        const next = { ...prev };
        if (prevId && next[prevId] === "running") next[prevId] = "done";
        next[info.id] = "running";
        return next;
      });
    });
    // Per-step timings and the running row count, exactly as the Flow tab
    // receives them.
    s.on("executionPartial", (info) => {
      if (!info) return;
      if (info.times) setStepTimes((prev) => ({ ...prev, ...info.times }));
      if (typeof info.rows === "number") setRowsCaptured(info.rows);
    });
    s.on("executionStepError", (info) => {
      const id = info && info.step && info.step.id;
      if (id) setStepStates((prev) => ({ ...prev, [id]: "error" }));
    });
    s.on("executionIteration", (info) => {
      if (!info || !info.stepId) return;
      setIterations((prev) => {
        const cur = prev[info.stepId] || {};
        if (info.kind === "start") return { ...prev, [info.stepId]: { total: info.total || 0, index: 0, running: true } };
        if (info.kind === "tick")  return { ...prev, [info.stepId]: { ...cur, index: (info.index ?? 0) + 1, running: true } };
        return { ...prev, [info.stepId]: { ...cur, running: false } };
      });
    });
    s.on("executionDone", (d) => {
      const finalStatus = (d && d.status) || "done";
      setStatus(finalStatus);
      setPaused(null);
      /* Nothing follows the last step, so nothing would ever move it off the
         spinner — the tree would sit there claiming a step is running under a
         run that finished. Resolve it to match the outcome, the same rule
         runEvents applies to its own snapshot. */
      setStepStates((prev) => {
        const ok = finalStatus === "success";
        const next = { ...prev };
        for (const id of Object.keys(next)) {
          if (next[id] === "running") next[id] = ok ? "done" : "error";
        }
        return next;
      });
      setIterations((prev) => {
        const next = {};
        for (const [id, v] of Object.entries(prev)) next[id] = { ...v, running: false };
        return next;
      });
      lastStepIdRef.current = null;
    });

    return () => {
      try { s.emit("unwatchDebug", { runId }); } catch (_) {}
      s.close();
    };
  }, [authLoading, token, runId]);

  /* Draw the newest frame once per animation frame rather than once per
     arrival: on a fast page several frames can land inside one repaint, and
     drawing all of them is work nobody sees. */
  useEffect(() => {
    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      const data = latestFrameRef.current;
      const canvas = canvasRef.current;
      if (!data || !canvas) return;
      latestFrameRef.current = null;
      const blob = new Blob([data], { type: "image/jpeg" });
      createImageBitmap(blob).then((bmp) => {
        if (!canvasRef.current) return;
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        }
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
      }).catch(() => {});
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs, tab]);

  /* ── Controls ───────────────────────────────────────────────────────────── */

  const send = useCallback((msg) => {
    if (!socket) return;
    socket.emit("debugControl", { runId, ...msg });
  }, [socket, runId]);

  const resume = useCallback((mode) => {
    if (paused) setPaused(null);          // optimistic: the button must feel instant
    send({ t: "resume", mode });
  }, [send, paused]);

  const skipStep = useCallback(() => {
    const id = paused && paused.step && paused.step.id;
    if (!id) return resume("run");
    // "Stop stopping here" — the escape from a loop body that would otherwise
    // park on every one of 500 items.
    setMuted((prev) => new Set(prev).add(id));
    setPaused(null);
    send({ t: "resume", mode: "step", muteStep: true, stepId: id });
  }, [paused, send, resume]);

  const toggleBreakpoint = useCallback((stepId) => {
    setBreakpoints((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId); else next.add(stepId);
      send({ t: "breakpoints", ids: Array.from(next) });
      return next;
    });
  }, [send]);

  const unmute = useCallback((stepId) => {
    setMuted((prev) => { const next = new Set(prev); next.delete(stepId); return next; });
    send({ t: "unmute", stepId });
  }, [send]);

  const changeSpeed = useCallback((ms) => { setSpeed(ms); send({ t: "speed", ms }); }, [send]);

  // Mouse and keyboard into the paused page. Refused server-side unless the
  // run is actually parked, so a stray event can never race a running step.
  const sendInput = useCallback((input) => { send({ t: "input", ...input }); }, [send]);

  // Raised on the first touch of the page, whatever kind — a scroll, a drag,
  // a click. Once dismissed it stays dismissed for the rest of the session.
  const noteInteraction = useCallback(() => {
    setInteractionNotice((v) => (v === null ? "open" : v));
  }, []);

  const stop = useCallback(() => {
    socket?.emit("cancelRun", { runId });
  }, [socket, runId]);

  const running = status === "running" || status === "queued";
  const isPaused = !!paused;
  const totalRows = resultSummary
    ? Object.values(resultSummary).reduce((n, v) => n + (Number(v) || 0), 0)
    : 0;

  /* Keyboard, because stepping through anything with a mouse gets old fast.
     F8 continue / F10 step / F9 breakpoint on the paused step — the bindings
     a browser devtools user already has in their fingers. */
  useEffect(() => {
    const onKey = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === "F8")  { e.preventDefault(); isPaused ? resume("run") : send({ t: "pause" }); }
      if (e.key === "F10") { e.preventDefault(); resume("step"); }
      if (e.key === "F9" && paused && paused.step) { e.preventDefault(); toggleBreakpoint(paused.step.id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPaused, paused, resume, send, toggleBreakpoint]);

  /* The window opens before the run has an id (it has to — see handleRun), so
     "no id yet" is the normal first state, not an error. The opener points it
     at /debug/<id> as soon as the backend has created the row. */
  if (!Number.isFinite(runId)) {
    return <Shell><p className="dbg-empty">Starting the run…</p></Shell>;
  }
  if (authLoading) return <Shell><p className="dbg-empty">Connecting…</p></Shell>;
  if (!token) return <Shell><p className="dbg-empty">Sign in first, then reopen this window.</p></Shell>;

  return (
    <div className="dbg-root">
      <Toolbar
        runId={runId}
        paused={paused}
        running={running}
        status={status}
        live={session ? session.live : false}
        speed={speed}
        onResume={() => resume("run")}
        onStep={() => resume("step")}
        onPause={() => send({ t: "pause" })}
        onSkip={skipStep}
        onStop={stop}
        onSpeed={changeSpeed}
        takeControl={takeControl}
        onTakeControl={(on) => { setTakeControl(on); if (on) noteInteraction(); }}
      />

      {attach.state === "error" && (
        <div className="dbg-banner error">
          {attach.error}
          {" — "}
          <button className="dbg-link" onClick={() => window.close()}>close this window</button>
        </div>
      )}

      <ForcedBanner forced={session && session.forced} />

      {interactionNotice === "open" && (
        <div className="dbg-banner warn">
          <strong>You&rsquo;re touching the live page.</strong>{" "}
          Anything you do here can change what the following steps see.
          <button className="dbg-link" onClick={() => setInteractionNotice("dismissed")}>Got it</button>
        </div>
      )}

      <div className="dbg-body">
        <aside className="dbg-steps">
          <div className="dbg-steps-head">
            Flow
            <span className="dbg-hint">
              {rowsCaptured > 0 ? `${rowsCaptured.toLocaleString()} rows · ` : ""}click ● to break
            </span>
          </div>
          {/* The Execution panel's own Flow tree, with a breakpoint gutter
              added. Same component, so the step states, spinners, loop
              counters and per-step timings are the same ones the main window
              shows — there is no second implementation to drift. */}
          <div className="dbg-flow ep-flow">
            {flowTree.length === 0 ? (
              <p className="dbg-empty small">Waiting for the step list…</p>
            ) : (
              <ul className="ep-flow-tree">
                {flowTree.map((s) => (
                  <FlowNode
                    key={s.id}
                    step={s}
                    depth={0}
                    stepStates={stepStates}
                    iterations={iterations}
                    stepTimes={stepTimes}
                    debug={{
                      breakpoints,
                      muted,
                      currentId: paused && paused.step ? paused.step.id : null,
                      onToggleBreakpoint: toggleBreakpoint,
                      onUnmute: unmute,
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </aside>

        <main className="dbg-stage">
          <div className="dbg-urlbar" title={liveUrl || ""}>
            {liveUrl || (running ? "starting…" : "—")}
          </div>
          <PageStage
            canvasRef={canvasRef}
            paused={paused}
            takeControl={takeControl}
            onInput={sendInput}
            onInteract={noteInteraction}
          />
        </main>

        <section className="dbg-inspect">
          <div className="dbg-tabs">
            {["step", "data", "page", "probe", "log"].map((t) => (
              <button key={t} className={`dbg-tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
                {t === "step" ? "Step" : t === "data" ? "Data" : t === "page" ? "Page HTML"
                  : t === "probe" ? "Selector" : "Log"}
                {t === "data" && totalRows > 0 && <span className="dbg-tab-count">{totalRows.toLocaleString()}</span>}
              </button>
            ))}
          </div>

          <div className="dbg-tabbody">
            {tab === "step"  && (
              <StepInspector
                paused={paused} running={running} status={status}
                liveStep={liveStep} flowTree={flowTree} liveUrl={liveUrl}
                rowsCaptured={rowsCaptured} iterations={iterations}
              />
            )}
            {tab === "data"  && <DataTab socket={socket} runId={runId} summary={resultSummary} />}
            {tab === "page"  && <PageInspector socket={socket} runId={runId} paused={paused} />}
            {tab === "probe" && <ProbeBox socket={socket} runId={runId} enabled={isPaused} />}
            {tab === "log"   && (
              <div className="dbg-log">
                {logs.map((l, i) => (
                  <div key={i} className={`dbg-logline ${l.level === "error" ? "err" : ""}`}>{l.line}</div>
                ))}
                <div ref={logEndRef} />
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ── The stage ────────────────────────────────────────────────────────────
   The picture, and — while the run is parked — a surface you can scroll.

   Scrolling is on whenever the run is paused. It is the difference between
   seeing one viewport and seeing the page, and it is the reason a screencast
   alone is not enough to answer "what is actually on this page". The run puts
   the scroll position back on resume (see debugBridge's __dbgRestoreScroll),
   so looking around cannot change what the next step does.

   Clicking and typing are a different act — they change the page the workflow
   is about to work on — so they are behind an explicit switch, off by default,
   and the run's log records that it happened.

   Coordinates: the frame is a JPEG scaled to fit, so a point on the canvas has
   to be mapped back through both the browser's layout scaling and the capture
   scaling. The paused page reports its own viewport size for exactly this. */
function PageStage({ canvasRef, paused, takeControl, onInput, onInteract }) {
  const wrapRef = useRef(null);
  const isPaused = !!paused;
  const viewport = paused && paused.viewport;
  const [dragging, setDragging] = useState(false);
  // Where the drag began, in page space, plus the scroll offset at that
  // moment — the target is computed from the ORIGIN of the drag rather than
  // accumulated per move, so a dropped or coalesced event cannot make the page
  // drift away from the pointer.
  const dragRef = useRef(null);
  const movedRef = useRef(false);

  // Canvas point → page point. Uses the canvas's DISPLAYED rectangle, so it
  // stays correct when the window is resized and the image is letterboxed.
  const toPage = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas || !viewport) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = ((e.clientX - rect.left) / rect.width) * viewport.w;
    const y = ((e.clientY - rect.top) / rect.height) * viewport.h;
    if (x < 0 || y < 0 || x > viewport.w || y > viewport.h) return null;
    return { x: Math.round(x), y: Math.round(y) };
  }, [canvasRef, viewport]);

  /* Wheel is bound natively rather than through React's onWheel: React
     attaches it passively at the root, and a passive listener cannot
     preventDefault — so the debug window itself would scroll instead of the
     page inside it. */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !isPaused) return;
    const onWheel = (e) => {
      const pt = toPage(e);
      if (!pt) return;
      e.preventDefault();
      onInteract();
      onInput({ kind: "wheel", x: pt.x, y: pt.y, deltaX: e.deltaX, deltaY: e.deltaY });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [isPaused, toPage, onInput, onInteract]);

  /* Drag to pan, the way you would push a sheet of paper around a desk. A
     trackpad user has two-finger scrolling and a mouse user has a wheel, but
     neither is much good for moving a long way down a page, and grabbing it is
     the gesture everyone already knows from maps and PDF viewers.

     Absolute (scrollTo) rather than relative deltas: a drag is a continuous
     gesture, and computing each target from where the drag STARTED keeps the
     page glued to the pointer even if some moves are coalesced away. */
  const onMouseDown = (e) => {
    if (!isPaused || e.button !== 0) return;
    const pt = toPage(e);
    if (!pt) return;
    const scroll = (paused && paused.scroll) || { x: 0, y: 0 };
    dragRef.current = { originX: e.clientX, originY: e.clientY, scrollX: scroll.x || 0, scrollY: scroll.y || 0 };
    movedRef.current = false;
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    const canvas = canvasRef.current;
    const rect = canvas && canvas.getBoundingClientRect();
    // Page pixels per screen pixel — the frame is scaled to fit, so a 10px
    // drag on a half-size image has to move the page 20px.
    const scale = rect && rect.width && viewport ? viewport.w / rect.width : 1;

    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = (e.clientX - d.originX) * scale;
      const dy = (e.clientY - d.originY) * scale;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        if (!movedRef.current) { movedRef.current = true; onInteract(); }
        // Dragging DOWN pulls the page down, which means scrolling up.
        onInput({ kind: "scrollTo", sx: Math.max(0, d.scrollX - dx), sy: Math.max(0, d.scrollY - dy) });
      }
    };
    const onUp = () => { dragRef.current = null; setDragging(false); };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, canvasRef, viewport, onInput, onInteract]);

  const onClick = (e) => {
    if (!isPaused || !takeControl) return;
    // A drag that ends over the page must not also click it — the gesture was
    // "move the page", and a stray click there could navigate away from the
    // thing the user was dragging into view.
    if (movedRef.current) { movedRef.current = false; return; }
    const pt = toPage(e);
    if (pt) { onInteract(); onInput({ kind: "click", x: pt.x, y: pt.y }); }
  };

  const onKeyDown = (e) => {
    if (!isPaused || !takeControl) return;
    // Leave the window's own shortcuts alone.
    if (["F8", "F9", "F10"].includes(e.key)) return;
    e.preventDefault();
    onInteract();
    if (e.key.length === 1) onInput({ kind: "text", text: e.key });
    else onInput({ kind: "key", key: e.key });
  };

  const scroll = paused && paused.scroll;
  const scrolled = scroll && scroll.y > 0;
  // How far down the page the view is, when the page reports its own height.
  const depth = scrolled && scroll.pageHeight && scroll.viewportHeight
    ? Math.min(100, Math.round(((scroll.y + scroll.viewportHeight) / scroll.pageHeight) * 100))
    : null;

  return (
    <div
      ref={wrapRef}
      className={`dbg-canvas-wrap ${isPaused ? "paused" : ""} ${takeControl && isPaused ? "control" : ""} ${dragging ? "dragging" : ""}`}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onKeyDown={onKeyDown}
      tabIndex={takeControl && isPaused ? 0 : -1}
    >
      <canvas ref={canvasRef} className="dbg-canvas" />
      {isPaused && (
        <div className="dbg-stage-badges">
          <span className="dbg-paused-pill">Paused</span>
          {viewport && !scrolled && <span className="dbg-scroll-pill">scroll to look around</span>}
          {scrolled && (
            <span className="dbg-scroll-pill" title="Put back where the run left it when you resume">
              scrolled to {scroll.y}px{depth != null ? ` · ${depth}%` : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function Shell({ children }) {
  return <div className="dbg-root"><div className="dbg-body"><div className="dbg-stage">{children}</div></div></div>;
}

/* ── Toolbar ──────────────────────────────────────────────────────────────── */

function Toolbar({ runId, paused, running, status, live, speed, onResume, onStep, onPause, onSkip, onStop, onSpeed,
                   takeControl, onTakeControl }) {
  const isPaused = !!paused;
  // The very first gate of the run: nothing has executed yet. The child's
  // sequence counter starts at 1, so this also reads correctly for a window
  // that attached to a run already waiting on its first step.
  const atStart = isPaused && paused.seq === 1 && paused.when === "before";
  return (
    <header className="dbg-toolbar">
      <span className="dbg-title">Debug · run #{runId}</span>

      <div className="dbg-controls">
        {isPaused ? (
          /* A debug run opens parked before its first step, so the first press
             of this button starts the workflow rather than continuing one —
             "Continue" there asks the user to continue something that has not
             happened yet. It says Continue from the second pause onward. */
          <button className="dbg-btn primary" onClick={onResume}
                  title={atStart ? "Start the run (F8)" : "Continue to the next breakpoint (F8)"}>
            <PlayIcon /> {atStart ? "Start" : "Continue"}
          </button>
        ) : (
          <button className="dbg-btn" onClick={onPause} disabled={!running} title="Pause at the next step (F8)">
            <PauseIcon /> Pause
          </button>
        )}
        <button className="dbg-btn" onClick={onStep} disabled={!running}
                title={atStart ? "Run just the first step, then pause (F10)" : "Run this step, then pause (F10)"}>
          <StepIcon /> {atStart ? "Step in" : "Step"}
        </button>
        {/* The loop escape. Only meaningful while parked on a step, which is
            also the only time the user knows which step is trapping them. */}
        <button className="dbg-btn" onClick={onSkip} disabled={!isPaused}
                title="Don't pause on this step again for the rest of the run">
          Skip this step
        </button>
        <button className="dbg-btn danger" onClick={onStop} disabled={!running} title="Stop the run">
          <StopIcon /> Stop
        </button>
      </div>

      {/* Scrolling is always available at a pause and is put back on resume.
          Clicking and typing are not: they change the page the next step will
          act on, which is a thing to opt into rather than discover. */}
      <label className={`dbg-control-toggle ${takeControl ? "on" : ""}`}
             title="Also click and type into the paused page. This changes the page the run continues on — scrolling alone is undone when you resume, this is not.">
        <input type="checkbox" checked={!!takeControl} disabled={!isPaused}
               onChange={(e) => onTakeControl(e.target.checked)} />
        Click &amp; type
      </label>

      <label className="dbg-speed" title="Wait before each step, so the run can be watched without stepping">
        Slow-mo
        <select value={speed} onChange={(e) => onSpeed(Number(e.target.value))}>
          <option value={0}>off</option>
          <option value={250}>0.25s</option>
          <option value={500}>0.5s</option>
          <option value={1000}>1s</option>
          <option value={2000}>2s</option>
        </select>
      </label>

      <span className={`dbg-status ${status}`}>
        {running ? (isPaused ? "paused" : (live ? "running" : "starting…")) : status}
      </span>
    </header>
  );
}

/* What this run is deliberately not doing. Shown rather than logged, because a
   debug session that behaves unlike the real run — and doesn't say so — is how
   someone concludes their parallel workflow is fine after watching it work one
   page at a time. */
function ForcedBanner({ forced }) {
  if (!forced) return null;
  const notes = [];
  if (forced.concurrency > 1) notes.push(`one page at a time (this workflow is set to ${forced.concurrency})`);
  if (forced.blockResources)  notes.push("images and stylesheets loaded");
  if (forced.httpFirst)       notes.push("HTTP fast path off");
  if (forced.healing)         notes.push("self-healing and retries off");
  if (!notes.length) return null;
  return (
    <div className="dbg-banner">
      <strong>Debug run:</strong> {notes.join(" · ")}. Notifications and deliveries are skipped.
    </div>
  );
}

/* ── Step inspector ───────────────────────────────────────────────────────── */

/* Find a step in the flow tree, wherever it is nested. The live step stream
   carries an id and a label; the tree is where its configuration lives. */
function findStep(steps, id) {
  for (const s of steps || []) {
    if (!s) continue;
    if (s.id === id) return s;
    for (const key of ["body", "then", "else", "try", "catch", "subflowSteps"]) {
      const hit = findStep(s[key], id);
      if (hit) return hit;
    }
  }
  return null;
}

function StepInspector({ paused, running, status, liveStep, flowTree, liveUrl, rowsCaptured, iterations }) {
  /* Between pauses. The panel used to say only "pause to inspect the page",
     which is unhelpful for the majority of a run: what the user wants to know
     while it moves is what it is doing and where. The live probe genuinely
     does need a pause — a selector evaluated against a page that is mid-step
     describes neither the before nor the after — so that part says so. */
  if (!paused) {
    if (!running) return <p className="dbg-empty small">Run {status}.</p>;
    // The tree a debug run publishes carries each step's selector (see
    // buildFlowTree's withSelectors) — what the running step is targeting.
    const cfg = liveStep ? findStep(flowTree, liveStep.id) : null;
    const selector = cfg && cfg.selector;
    const target = cfg && cfg.url;
    const iter = liveStep && iterations && iterations[liveStep.id];
    return (
      <div className="dbg-inspector">
        <div className="dbg-when">
          <span className="dbg-when-pill running">running now</span>
          <strong>{liveStep ? (liveStep.label || liveStep.type) : "starting…"}</strong>
        </div>
        <dl className="dbg-facts">
          <dt>Step</dt><dd>{liveStep ? String(liveStep.type || "").toLowerCase().replace(/_/g, " ") : "—"}</dd>
          {selector && <><dt>Selector</dt><dd className="mono break">{selector}</dd></>}
          {target && <><dt>Target</dt><dd className="mono break">{target}</dd></>}
          {iter && iter.total > 0 && (
            <><dt>Iteration</dt><dd>{iter.index || 0} of {iter.total}</dd></>
          )}
          <dt>Page</dt><dd className="mono break">{liveUrl || "—"}</dd>
          <dt>Rows</dt><dd>{(rowsCaptured || 0).toLocaleString()} captured so far</dd>
        </dl>
        <p className="dbg-empty small">
          Pause, or set a breakpoint on a step, to test selectors against the page and read its HTML.
        </p>
      </div>
    );
  }
  const { step, when, url, title, nodes, probe, captured, lane } = paused;
  /* Before the first navigation the tab is the empty document a browser starts
     with. Its URL is about:blank and it contains exactly three elements —
     <html>, <head>, <body> — which is true, useless, and reads as if the run
     had loaded a page with almost nothing on it. Say what is actually going
     on instead. */
  const blank = !url || url === "about:blank";
  return (
    <div className="dbg-inspector">
      <div className="dbg-when">
        <span className={`dbg-when-pill ${when}`}>
          {when === "before" ? "about to run" : when === "after" ? "just finished" : "failed"}
        </span>
        <strong>{(step && (step.label || step.type)) || "step"}</strong>
        {lane && lane.item != null && <span className="dbg-lane">item {lane.item}</span>}
      </div>

      {blank ? (
        <p className="dbg-blank">
          No page loaded yet — this runs on the empty tab the browser starts with.
        </p>
      ) : (
        <dl className="dbg-facts">
          <dt>URL</dt><dd className="mono break">{url}</dd>
          <dt>Title</dt><dd>{title || "—"}</dd>
          <dt>Elements</dt><dd>{nodes != null ? nodes.toLocaleString() : "—"}</dd>
        </dl>
      )}

      {/* The question the debugger exists for: does this step's own selector
          match anything on the page as it stands right now? */}
      <h4>Selector{probe && probe.length > 1 ? "s" : ""} for this step</h4>
      {!probe || !probe.length ? (
        <p className="dbg-empty small">
          {blank ? "Nothing to match against until a page is loaded." : "This step doesn't use a selector."}
        </p>
      ) : (
        <ul className="dbg-probe">
          {probe.map((p, i) => (
            <li key={i} className={p.error ? "err" : p.matches > 0 ? "hit" : "miss"}>
              <code>{p.selector}</code>
              <span className="dbg-count">
                {p.error ? "invalid selector" : `${p.matches} match${p.matches === 1 ? "" : "es"}`}
                {!p.error && p.matches > 0 && p.visible !== p.matches && ` · ${p.visible} visible`}
              </span>
              {p.error && <div className="dbg-probe-err">{p.error}</div>}
              {!p.error && p.matches === 0 && (
                <div className="dbg-probe-hint">
                  Nothing matches yet. If the element appears only after a click, scroll or wait,
                  that step has to come first.
                </div>
              )}
              {!p.error && p.text && <div className="dbg-sample">“{p.text}”</div>}
            </li>
          ))}
        </ul>
      )}

      {captured && (
        <>
          <h4>What it captured</h4>
          <p className="dbg-captured">
            {captured.count} record{captured.count === 1 ? "" : "s"}
            {captured.fields && Object.keys(captured.fields).length > 0 && (
              <span className="dbg-fields">
                {Object.entries(captured.fields).map(([name, f]) => (
                  <span key={name} className={f.nonEmpty === 0 ? "empty" : ""}>
                    {name} {f.nonEmpty}/{f.total}
                  </span>
                ))}
              </span>
            )}
          </p>
        </>
      )}
    </div>
  );
}

/* ── Data ─────────────────────────────────────────────────────────────────
   What the run has captured so far, refreshed as it captures more.

   The counts arrive pushed (they are a handful of bytes); the rows are pulled,
   and only while this tab is the one on screen. A run that has scraped 40,000
   rows should not be streaming them into a panel nobody is looking at, and the
   preview is capped server-side for the same reason. */
function DataTab({ socket, runId, summary }) {
  const [data, setData] = useState(null);
  const [truncated, setTruncated] = useState({});
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchData = useCallback(() => {
    if (!socket) return;
    setLoading(true);
    socket.emit("debugData", { runId }, (res) => {
      setLoading(false);
      if (!res || !res.ok) return;
      setData(res.results || null);
      setTruncated(res.truncated || {});
    });
  }, [socket, runId]);

  // On open, and again whenever the counts change while it is open — so the
  // table fills in as the run works rather than being a snapshot of whenever
  // the tab happened to be clicked.
  const signature = summary ? JSON.stringify(summary) : "";
  useEffect(() => { fetchData(); }, [fetchData, signature]);

  const keys = data ? Object.keys(data) : [];
  const key = selected && keys.includes(selected) ? selected : keys[0];

  if (!keys.length) {
    return (
      <p className="dbg-empty small">
        {loading ? "Reading captured data…" : "Nothing captured yet. Rows appear here as the run extracts them."}
      </p>
    );
  }

  return (
    <div className="dbg-data">
      {keys.length > 1 && (
        <div className="dbg-data-keys">
          {keys.map((k) => (
            <button key={k} className={`dbg-key ${k === key ? "active" : ""}`} onClick={() => setSelected(k)}>
              {k}
              <span className="dbg-key-count">
                {Array.isArray(data[k]) ? (truncated[k] || data[k].length).toLocaleString() : 1}
              </span>
            </button>
          ))}
        </div>
      )}
      {truncated[key] && (
        <p className="dbg-hint block">
          Showing the first {data[key].length} of {truncated[key].toLocaleString()} rows captured so far.
        </p>
      )}
      <DataPreview data={data[key]} />
    </div>
  );
}

/* ── Page HTML ────────────────────────────────────────────────────────────
   The existing inspector renders the tree, searches it and copies selectors;
   it only needed the HTML to come from the debug channel instead of the live
   preview's. Auto-fetched whenever this tab is open and the run parks on a new
   step, so the markup on screen always belongs to the pause beside it. */
function PageInspector({ socket, runId, paused }) {
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);

  const fetchHtml = useCallback(() => {
    if (!socket) return;
    const id = `html-${++reqRef.current}`;
    setLoading(true);
    socket.emit("debugControl", { runId, t: "html", id });
  }, [socket, runId]);

  useEffect(() => {
    if (!socket) return;
    const onHtml = (msg) => {
      if (!msg) return;
      setLoading(false);
      setHtml(msg.html || "");
    };
    socket.on("debugHtml", onHtml);
    return () => socket.off("debugHtml", onHtml);
  }, [socket]);

  // Refetch on every new pause — the page behind a later pause is a different
  // page, and showing the previous one next to it would be actively wrong.
  const seq = paused ? paused.seq : null;
  useEffect(() => { if (seq != null) fetchHtml(); }, [seq, fetchHtml]);

  if (!paused) return <p className="dbg-empty small">Pause the run to inspect its page.</p>;
  if (loading && !html) return <p className="dbg-empty small">Reading the page…</p>;

  return (
    <div className="dbg-html">
      <div className="dbg-html-head">
        <span className="mono small">{paused.url}</span>
        <button className="dbg-btn tiny" onClick={fetchHtml}>Refresh</button>
      </div>
      <HtmlInspectorPanel html={html} />
    </div>
  );
}

/* ── Ad-hoc selector probe ────────────────────────────────────────────────── */

function ProbeBox({ socket, runId, enabled }) {
  const [value, setValue] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!socket) return;
    const onResult = (msg) => { setBusy(false); setResult((msg && msg.result) || []); };
    socket.on("debugProbeResult", onResult);
    return () => socket.off("debugProbeResult", onResult);
  }, [socket]);

  const run = (e) => {
    e.preventDefault();
    if (!socket || !value.trim()) return;
    setBusy(true);
    setResult(null);
    socket.emit("debugControl", { runId, t: "probe", id: "adhoc", selectors: [value.trim()] });
  };

  return (
    <div className="dbg-probebox">
      <p className="dbg-hint block">
        Try a selector against the paused page — CSS, or an XPath starting with <code>/</code>.
      </p>
      <form onSubmit={run}>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder=".product-card .price"
          disabled={!enabled}
          spellCheck={false}
        />
        <button className="dbg-btn" disabled={!enabled || busy || !value.trim()}>Test</button>
      </form>
      {!enabled && <p className="dbg-empty small">Available while the run is paused.</p>}
      {result && (
        <ul className="dbg-probe">
          {result.length === 0 && <li className="miss"><span className="dbg-count">no result</span></li>}
          {result.map((p, i) => (
            <li key={i} className={p.error ? "err" : p.matches > 0 ? "hit" : "miss"}>
              <code>{p.selector}</code>
              <span className="dbg-count">
                {p.error ? "invalid selector" : `${p.matches} match${p.matches === 1 ? "" : "es"}`}
                {!p.error && p.matches > 0 && ` · ${p.visible} visible`}
              </span>
              {p.error && <div className="dbg-probe-err">{p.error}</div>}
              {p.sample && <pre className="dbg-sample-html">{p.sample}</pre>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── Icons ────────────────────────────────────────────────────────────────── */

const PlayIcon  = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21" /></svg>;
const PauseIcon = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>;
const StopIcon  = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>;
const StepIcon  = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="4,3 15,12 4,21" /><rect x="17" y="3" width="3" height="18" />
  </svg>
);
