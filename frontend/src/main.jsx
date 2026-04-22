import React, { useRef, useEffect, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import io from "socket.io-client";
import { useWorkflow } from "./workflow/useWorkflow";
import { createAction } from "./workflow/stepFactory";
import WorkflowPanel from "./components/WorkflowPanel";
import ElementInspector from "./components/ElementInspector";
import "./styles/app.css";

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

  useEffect(() => {
    const socket = io(SERVER_URL, { query: { userId: USER_ID }, transports: ["websocket"] });
    socketRef.current = socket;
    socket.on("connect",    () => { setStatus("Connected"); setIsConnected(true); });
    socket.on("disconnect", () => { setStatus("Disconnected"); setIsConnected(false); isStreamingRef.current = false; });
    socket.on("message",    msg  => setStatus(typeof msg === "string" ? msg : (msg.msg || "")));
    socket.on("frame",      data => { latestFrameRef.current = data; });
    socket.on("cursorType", data => setCursorType(data.cursor));
    socket.on("actionResult", res => setStatus(res.success ? "Action executed." : "Action failed: " + (res.error || "")));
    socket.on("viewportUpdated", () => {});
    socket.on("browserEvent", (data) => {
      if (data.type === "workflowStep") addStep(createAction(data.action, data.params || {}, data.advanced || {}), [], null);
      if (data.type === "elementSelected") setSelectedElement(data.element);
    });
    return () => socket.disconnect();
  }, []);

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
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
        ctx.drawImage(bitmap, 0, 0);
      } catch (_) {}
      isRenderingRef.current = false;
    }
    renderLoop();
  }, []);

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

  const changeMode = (newMode) => {
    setMode(newMode);
    if (newMode !== "selection") setSelectedElement(null);
    socketRef.current?.emit("setMode", { mode: newMode });
  };

  const handleNavigate = () => {
    if (!socketRef.current || !urlInput.startsWith("http")) return;
    setStatus("Navigating...");
    const rect = canvasContainerRef.current?.getBoundingClientRect();
    socketRef.current.emit("navigate", { url: urlInput, mode, viewportWidth: Math.floor(rect?.width) || 1280, viewportHeight: Math.floor(rect?.height) || 720 });
    isStreamingRef.current = true;
    addStep(createAction("NAVIGATE", { url: urlInput }), [], null);
  };

  const scaled = (e) => { const c = canvasRef.current, r = c.getBoundingClientRect(); return { x: Math.round((e.clientX - r.left) * (c.width / r.width)), y: Math.round((e.clientY - r.top) * (c.height / r.height)) }; };
  const emit = (type, extra = {}) => socketRef.current?.emit("userAction", { type, ...extra });

  return (
    <div className="app-container">
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
          <button className="header-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
            Run
          </button>
          <button className="header-btn secondary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
              <polyline points="17,21 17,13 7,13 7,21"/><polyline points="7,3 7,8 15,8"/>
            </svg>
            Save
          </button>
        </div>
      </header>

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
              <input className="url-input" type="text" value={urlInput} onChange={e => setUrlInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleNavigate()} placeholder="Enter URL to navigate…" />
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
            steps={steps}
            totalCount={totalCount}
            setSteps={setSteps}
            onAdd={addStep}
            onUpdate={updateStep}
            onDelete={deleteStep}
            onReorder={reorderSteps}
          />
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);