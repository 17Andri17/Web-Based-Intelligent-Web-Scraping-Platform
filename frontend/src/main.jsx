import React, { useRef, useEffect, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import io from "socket.io-client";
import { useWorkflow } from "./workflow/useWorkflow";
import { createAction } from "./workflow/stepFactory";
import WorkflowPanel from "./components/WorkflowPanel";
import ElementInspector from "./components/ElementInspector";
import ExecutionPanel from "./components/ExecutionPanel";
import "./styles/app.css";
import "./styles/ExecutionPanel.css";

const SERVER_URL = "http://localhost:3001";
const USER_ID = "user_" + Math.random().toString(36).slice(2, 12);

function App() {
  const { steps, totalCount, setSteps, addStep, updateStep, deleteStep, reorderSteps } = useWorkflow();
  const [activeTab, setActiveTab] = useState("stream");

  const canvasRef = useRef(null);
  const canvasContainerRef = useRef(null);
  const socketRef = useRef(null);
  const resizeTimeoutRef = useRef(null);
  const isStreamingRef = useRef(false);
  const latestFrameRef = useRef(null);
  const isRenderingRef = useRef(false);

  const [status, setStatus] = useState("");
  const [urlInput, setUrlInput] = useState("https://deviceandbrowserinfo.com/are_you_a_bot");
  const [mode, setMode] = useState("navigation");
  const [cursorType, setCursorType] = useState("default");
  const [isConnected, setIsConnected] = useState(false);
  const [selectedElement, setSelectedElement] = useState(null);

  // ── Execution state ────────────────────────────────────────────────
  const [execPanelOpen, setExecPanelOpen]   = useState(false);
  const [execStatus,    setExecStatus]      = useState("idle");  // idle | running | done | error
  const [execLogs,      setExecLogs]        = useState([]);
  const [execResults,   setExecResults]     = useState(null);

  const sessionMetaRef = useRef({});  // { startUrl, viewportWidth, viewportHeight }

  // ── Socket ────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = io(SERVER_URL, { query: { userId: USER_ID }, transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("connect",    () => { setStatus("Connected"); setIsConnected(true); });
    socket.on("disconnect", () => { setStatus("Disconnected"); setIsConnected(false); isStreamingRef.current = false; });
    socket.on("message",    msg  => setStatus(typeof msg === "string" ? msg : (msg.msg || "")));
    socket.on("frame",      data => { latestFrameRef.current = data; });
    socket.on("cursorType", data => setCursorType(data.cursor));
    socket.on("actionResult", res => setStatus(res.success ? "Action executed." : "Action failed: " + (res.error || "")));
    socket.on("viewportUpdated", (data) => {
      sessionMetaRef.current.viewportWidth  = data.width;
      sessionMetaRef.current.viewportHeight = data.height;
    });

    socket.on("browserEvent", (data) => {
      if (data.type === "workflowStep") addStep(createAction(data.action, data.params || {}, data.advanced || {}), [], null);
      if (data.type === "elementSelected") setSelectedElement(data.element);
    });

    // ── Execution events ───────────────────────────────────────────
    socket.on("executionStarted", () => {
      setExecStatus("running");
      setExecLogs([]);
      setExecResults(null);
    });

    socket.on("executionLog", (entry) => {
      setExecLogs(prev => [...prev, entry]);
    });

    socket.on("executionDone", ({ success, results }) => {
      setExecStatus(success ? "done" : "error");
      if (results && Object.keys(results).length > 0) setExecResults(results);
    });

    socket.on("codeReady", ({ code }) => {
      downloadTextFile(code, "workflow.js", "text/javascript");
    });

    return () => socket.disconnect();
  }, []);

  // ── Render loop ───────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    async function renderLoop() {
      requestAnimationFrame(renderLoop);
      if (!latestFrameRef.current || isRenderingRef.current) return;
      isRenderingRef.current = true;
      try {
        const frame = latestFrameRef.current; latestFrameRef.current = null;
        const bitmap = await createImageBitmap(new Blob([frame], { type: "image/png" }));
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width; canvas.height = bitmap.height;
        }
        ctx.drawImage(bitmap, 0, 0);
      } catch (_) {}
      isRenderingRef.current = false;
    }
    renderLoop();
  }, []);

  // ── Resize ────────────────────────────────────────────────────────
  const handleResize = useCallback(() => {
    if (!canvasContainerRef.current || !socketRef.current || !isStreamingRef.current) return;
    clearTimeout(resizeTimeoutRef.current);
    resizeTimeoutRef.current = setTimeout(() => {
      const rect = canvasContainerRef.current?.getBoundingClientRect();
      if (rect?.width > 0 && rect?.height > 0)
        socketRef.current.emit("resizeViewport", { width: Math.floor(rect.width), height: Math.floor(rect.height) });
    }, 150);
  }, []);

  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(handleResize);
    ro.observe(container);
    window.addEventListener("resize", handleResize);
    return () => { ro.disconnect(); window.removeEventListener("resize", handleResize); clearTimeout(resizeTimeoutRef.current); };
  }, [handleResize]);

  // ── Actions ───────────────────────────────────────────────────────
  const changeMode = (newMode) => {
    setMode(newMode);
    if (newMode !== "selection") setSelectedElement(null);
    socketRef.current?.emit("setMode", { mode: newMode });
  };

  const handleNavigate = () => {
    if (!socketRef.current || !urlInput.startsWith("http")) return;
    setStatus("Navigating...");
    const rect = canvasContainerRef.current?.getBoundingClientRect();
    const vpW  = Math.floor(rect?.width)  || 1280;
    const vpH  = Math.floor(rect?.height) || 720;
    sessionMetaRef.current = { startUrl: urlInput, viewportWidth: vpW, viewportHeight: vpH };
    socketRef.current.emit("navigate", { url: urlInput, mode, viewportWidth: vpW, viewportHeight: vpH });
    isStreamingRef.current = true;
    addStep(createAction("NAVIGATE", { url: urlInput }), [], null);
  };

  // ── Run workflow ───────────────────────────────────────────────────
  const handleRun = () => {
    if (!socketRef.current || steps.length === 0) return;
    setExecPanelOpen(true);
    setExecStatus("idle");
    setExecLogs([]);
    setExecResults(null);
    socketRef.current.emit("executeWorkflow", {
      steps,
      meta: sessionMetaRef.current,
    });
  };

  // ── Download code ──────────────────────────────────────────────────
  const handleDownloadCode = () => {
    if (!socketRef.current) return;
    socketRef.current.emit("downloadCode", {
      steps,
      meta: sessionMetaRef.current,
    });
  };

  // ── Cancel execution ───────────────────────────────────────────────
  const handleCancelExecution = () => {
    socketRef.current?.emit("cancelExecution");
  };

  // ── Download helper ────────────────────────────────────────────────
  const downloadTextFile = (content, filename, mime) => {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Canvas helpers ─────────────────────────────────────────────────
  const scaled = (e) => {
    const c = canvasRef.current, r = c.getBoundingClientRect();
    return { x: Math.round((e.clientX - r.left) * (c.width / r.width)), y: Math.round((e.clientY - r.top) * (c.height / r.height)) };
  };
  const emit = (type, extra = {}) => socketRef.current?.emit("userAction", { type, ...extra });

  const isRunDisabled = steps.length === 0 || execStatus === "running";

  return (
    <div className="app-container">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="app-header">
        <div className="header-left">
          <div className="logo">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
            </svg>
            <span>WebScraper</span>
          </div>
        </div>
        <div className="header-center">
          <div className="connection-status">
            <span className={`status-dot ${isConnected ? "connected" : "disconnected"}`} />
            <span className="status-text">{status || (isConnected ? "Ready" : "Connecting…")}</span>
          </div>
        </div>
        <div className="header-right">
          {/* Download code button */}
          <button className="header-btn secondary" onClick={handleDownloadCode}
            disabled={steps.length === 0} title="Download as Node.js script">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Download Code
          </button>

          {/* Run button */}
          <button
            className={`header-btn run-btn ${execStatus === "running" ? "running" : ""}`}
            onClick={execStatus === "running" ? () => setExecPanelOpen(true) : handleRun}
            disabled={isRunDisabled && execStatus !== "running"}
            title={execStatus === "running" ? "View execution progress" : "Run workflow"}
          >
            {execStatus === "running" ? (
              <><SpinnerIcon /> Running…</>
            ) : (
              <><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg> Run</>
            )}
          </button>

          {/* Show results badge if done */}
          {(execStatus === "done" || execStatus === "error") && (
            <button
              className={`header-btn secondary ${execStatus === "error" ? "error-badge" : "success-badge"}`}
              onClick={() => setExecPanelOpen(true)}
              title="View results"
            >
              {execStatus === "done" ? "✅ Results" : "❌ Error"}
            </button>
          )}
        </div>
      </header>

      {/* ── Tabs ─────────────────────────────────────────────────────── */}
      <div className="tab-bar">
        <button className={`tab-btn ${activeTab === "stream" ? "active" : ""}`} onClick={() => setActiveTab("stream")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          Live Browser
        </button>
        <button className={`tab-btn ${activeTab === "workflow" ? "active" : ""}`} onClick={() => setActiveTab("workflow")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="16,3 21,3 21,8"/><line x1="4" y1="20" x2="21" y2="3"/>
            <polyline points="21,16 21,21 16,21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>
          </svg>
          Workflow
          {totalCount > 0 && <span className="tab-badge">{totalCount}</span>}
        </button>
      </div>

      {/* ── Main ─────────────────────────────────────────────────────── */}
      <main className="main-content">
        <div className={`stream-panel ${activeTab !== "stream" ? "hidden-panel" : ""}`}>
          <div className="control-bar">
            <div className="mode-toggle">
              <button className={`mode-btn ${mode === "navigation" ? "active" : ""}`} onClick={() => changeMode("navigation")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>
                Navigate
              </button>
              <button className={`mode-btn ${mode === "selection" ? "active" : ""}`} onClick={() => changeMode("selection")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 9l7 7 7-7"/></svg>
                Select
              </button>
            </div>
            <div className="url-input-wrapper">
              <svg className="url-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
              <input className="url-input" type="text" value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleNavigate()}
                placeholder="Enter URL to navigate…" />
              <button className="go-btn" onClick={handleNavigate}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12,5 19,12 12,19"/>
                </svg>
              </button>
            </div>
          </div>

          <div className="canvas-container" ref={canvasContainerRef}>
            <canvas ref={canvasRef} className="browser-canvas"
              style={{ cursor: mode === "selection" ? "crosshair" : cursorType }}
              onClick={e  => { e.preventDefault(); const {x,y} = scaled(e); emit("click",     {x,y}); setStatus(`Clicked: x=${x}, y=${y}`); }}
              onMouseMove={e => { const {x,y} = scaled(e); emit("hover",     {x,y}); }}
              onMouseDown={e => { e.preventDefault(); const {x,y} = scaled(e); emit("mousedown", {x,y}); }}
              onMouseUp={e   => { e.preventDefault(); const {x,y} = scaled(e); emit("mouseup",   {x,y}); }}
              onMouseLeave={() => emit("leave")}
            />
            <div className={`mode-indicator ${mode}`}>
              {mode === "selection"
                ? <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 9l7 7 7-7"/></svg> Selection Mode — click an element to inspect it</>
                : <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg> Navigation Mode</>
              }
            </div>
            {selectedElement && (
              <ElementInspector element={selectedElement} onClose={() => setSelectedElement(null)}
                onAddStep={(step) => { addStep(step, [], null); setStatus(`Added: ${step.type}`); }} />
            )}
          </div>
        </div>

        {activeTab === "workflow" && (
          <WorkflowPanel
            steps={steps} totalCount={totalCount} setSteps={setSteps}
            onAdd={addStep} onUpdate={updateStep} onDelete={deleteStep} onReorder={reorderSteps}
          />
        )}
      </main>

      {/* ── Execution Panel ───────────────────────────────────────────── */}
      <ExecutionPanel
        isOpen={execPanelOpen}
        onClose={() => setExecPanelOpen(false)}
        logs={execLogs}
        status={execStatus}
        results={execResults}
        onCancel={handleCancelExecution}
      />
    </div>
  );
}

function SpinnerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      style={{ animation: "spin 0.8s linear infinite" }}>
      <path d="M21 12a9 9 0 1 1-6.22-8.56"/>
    </svg>
  );
}

createRoot(document.getElementById("root")).render(<App />);