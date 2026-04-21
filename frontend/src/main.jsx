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
  const { steps, addStep, updateStep, setSteps } = useWorkflow();
  const [activeTab, setActiveTab] = useState("stream");

  useEffect(() => {
    window.steps = steps;
    window.addStep = addStep;
    window.updateStep = updateStep;
  }, [steps, addStep, updateStep]);

  const canvasRef = useRef(null);
  const canvasContainerRef = useRef(null);
  const socketRef = useRef(null);

  const [status, setStatus] = useState("");
  const [urlInput, setUrlInput] = useState("https://deviceandbrowserinfo.com/are_you_a_bot");
  const [mode, setMode] = useState("navigation");
  const [cursorType, setCursorType] = useState('default');
  const [isConnected, setIsConnected] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 1280, height: 720 });

  // ── Element inspector state ──────────────────────────────────────────────
  const [selectedElement, setSelectedElement] = useState(null);

  const resizeTimeoutRef = useRef(null);
  const isStreamingRef = useRef(false);
  const latestFrameRef = useRef(null);
  const isRenderingRef = useRef(false);

  // === SOCKET CONNECTION ===
  useEffect(() => {
    const socket = io(SERVER_URL, {
      query: { userId: USER_ID },
      transports: ["websocket"]
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setStatus("Connected");
      setIsConnected(true);
    });

    socket.on("message", msg =>
      setStatus(typeof msg === "string" ? msg : (msg.msg || ""))
    );

    socket.on("frame", (data) => {
      latestFrameRef.current = data;
    });

    socket.on("cursorType", (data) => {
      setCursorType(data.cursor);
    });

    socket.on("actionResult", res =>
      setStatus(res.success ? "Action executed." : "Action failed: " + (res.error || ""))
    );

    socket.on("browserEvent", (data) => {
      console.log("📦 Browser event:", data);

      if (data.type === "workflowStep") {
        addStep(createAction(
          data.action,
          data.params || {},
          data.advanced || {}
        ));
      }

      // ── Element selected from injection script ─────────────────────────
      if (data.type === "elementSelected") {
        setSelectedElement(data.element);
      }
    });

    socket.on("viewportUpdated", (data) => {
      setViewportSize({ width: data.width, height: data.height });
    });

    socket.on("disconnect", () => {
      setStatus("Disconnected");
      setIsConnected(false);
      isStreamingRef.current = false;
    });

    return () => socket.disconnect();
  }, []);

  // === RENDER LOOP ===
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    async function renderLoop() {
      requestAnimationFrame(renderLoop);
      if (!latestFrameRef.current || isRenderingRef.current) return;
      isRenderingRef.current = true;
      try {
        const frame = latestFrameRef.current;
        latestFrameRef.current = null;
        const blob = new Blob([frame], { type: "image/png" });
        const bitmap = await createImageBitmap(blob);
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      } catch (err) {
        console.error("Frame render error:", err);
      }
      isRenderingRef.current = false;
    }

    renderLoop();
  }, []);

  // === RESIZE HANDLER ===
  const handleResize = useCallback(() => {
    if (!canvasContainerRef.current || !socketRef.current || !isStreamingRef.current) return;
    if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
    resizeTimeoutRef.current = setTimeout(() => {
      const container = canvasContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const newWidth = Math.floor(rect.width);
      const newHeight = Math.floor(rect.height);
      if (newWidth > 0 && newHeight > 0) {
        socketRef.current.emit("resizeViewport", { width: newWidth, height: newHeight });
      }
    }, 150);
  }, []);

  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);
    window.addEventListener('resize', handleResize);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
    };
  }, [handleResize]);

  // === MODE CHANGE ===
  const changeMode = (newMode) => {
    setMode(newMode);
    // Clear inspector when leaving selection mode
    if (newMode !== 'selection') setSelectedElement(null);
    if (socketRef.current) {
      socketRef.current.emit("setMode", { mode: newMode });
    }
  };

  // === NAVIGATION ===
  const handleNavigate = () => {
    if (socketRef.current && urlInput.startsWith("http")) {
      setStatus("Navigating...");
      const container = canvasContainerRef.current;
      let initialWidth = 1280, initialHeight = 720;
      if (container) {
        const rect = container.getBoundingClientRect();
        initialWidth  = Math.floor(rect.width)  || 1280;
        initialHeight = Math.floor(rect.height) || 720;
      }
      socketRef.current.emit("navigate", {
        url: urlInput,
        mode,
        viewportWidth: initialWidth,
        viewportHeight: initialHeight
      });
      isStreamingRef.current = true;
    }
    addStep(createAction("NAVIGATE", { url: urlInput }));
  };

  // === COORDINATE MAPPING ===
  const getScaledCoords = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - rect.left) * (canvas.width / rect.width)),
      y: Math.round((e.clientY - rect.top)  * (canvas.height / rect.height))
    };
  };

  // === USER ACTIONS ===
  const handleClick = (e) => {
    e.preventDefault();
    if (!socketRef.current) return;
    const { x, y } = getScaledCoords(e);
    socketRef.current.emit("userAction", { type: "click", x, y });
    setStatus(`Clicked: x=${x}, y=${y}`);
  };

  const handleMouseMove = (e) => {
    if (!socketRef.current) return;
    const { x, y } = getScaledCoords(e);
    socketRef.current.emit("userAction", { type: "hover", x, y });
  };

  const handleMouseDown = (e) => {
    e.preventDefault();
    if (!socketRef.current) return;
    const { x, y } = getScaledCoords(e);
    socketRef.current.emit("userAction", { type: "mousedown", x, y });
  };

  const handleMouseUp = (e) => {
    e.preventDefault();
    if (!socketRef.current) return;
    const { x, y } = getScaledCoords(e);
    socketRef.current.emit("userAction", { type: "mouseup", x, y });
  };

  const handleMouseLeave = () => {
    if (!socketRef.current) return;
    socketRef.current.emit("userAction", { type: "leave" });
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") handleNavigate();
  };

  // ── Add step from inspector ──────────────────────────────────────────────
  const handleAddStepFromInspector = useCallback((step) => {
    addStep(step);
    setStatus(`Added: ${step.type}`);
  }, [addStep]);

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="header-left">
          <div className="logo">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
            <span>WebScraper</span>
          </div>
        </div>
        <div className="header-center">
          <div className="connection-status">
            <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`}></span>
            <span className="status-text">{status || (isConnected ? 'Ready' : 'Connecting...')}</span>
          </div>
        </div>
        <div className="header-right">
          <button className="header-btn" title="Run Workflow">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5,3 19,12 5,21" />
            </svg>
            Run
          </button>
          <button className="header-btn secondary" title="Save">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17,21 17,13 7,13 7,21" />
              <polyline points="7,3 7,8 15,8" />
            </svg>
            Save
          </button>
        </div>
      </header>

      {/* Tab Navigation */}
      <div className="tab-bar">
        <button
          className={`tab-btn ${activeTab === 'stream' ? 'active' : ''}`}
          onClick={() => setActiveTab('stream')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
          Live Browser
        </button>
        <button
          className={`tab-btn ${activeTab === 'workflow' ? 'active' : ''}`}
          onClick={() => setActiveTab('workflow')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="16,3 21,3 21,8" />
            <line x1="4" y1="20" x2="21" y2="3" />
            <polyline points="21,16 21,21 16,21" />
            <line x1="15" y1="15" x2="21" y2="21" />
            <line x1="4" y1="4" x2="9" y2="9" />
          </svg>
          Workflow
          {steps.length > 0 && <span className="tab-badge">{steps.length}</span>}
        </button>
      </div>

      {/* Main Content */}
      <main className="main-content">
        {/* Stream Panel */}
        <div className={`stream-panel ${activeTab !== 'stream' ? 'hidden-panel' : ''}`}>
          {/* URL Bar & Controls */}
          <div className="control-bar">
            <div className="mode-toggle">
              <button
                className={`mode-btn ${mode === 'navigation' ? 'active' : ''}`}
                onClick={() => changeMode("navigation")}
                title="Navigation Mode"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
                </svg>
                Navigate
              </button>
              <button
                className={`mode-btn ${mode === 'selection' ? 'active' : ''}`}
                onClick={() => changeMode("selection")}
                title="Selection Mode"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 9l7 7 7-7" />
                </svg>
                Select
              </button>
            </div>

            <div className="url-input-wrapper">
              <svg className="url-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <input
                className="url-input"
                type="text"
                value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Enter URL to navigate..."
              />
              <button className="go-btn" onClick={handleNavigate}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12,5 19,12 12,19" />
                </svg>
              </button>
            </div>
          </div>

          {/* Browser Canvas */}
          <div className="canvas-container" ref={canvasContainerRef}>
            <canvas
              ref={canvasRef}
              className="browser-canvas"
              style={{ cursor: mode === 'selection' ? 'crosshair' : cursorType }}
              onClick={handleClick}
              onMouseMove={handleMouseMove}
              onMouseDown={handleMouseDown}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseLeave}
            />

            {/* Mode indicator */}
            <div className={`mode-indicator ${mode}`}>
              {mode === 'selection' ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M5 9l7 7 7-7" />
                  </svg>
                  Selection Mode — click an element to inspect it
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
                  </svg>
                  Navigation Mode
                </>
              )}
            </div>

            {/* ── Element Inspector overlay ──────────────────────────────── */}
            {selectedElement && (
              <ElementInspector
                element={selectedElement}
                onClose={() => setSelectedElement(null)}
                onAddStep={handleAddStepFromInspector}
              />
            )}
          </div>
        </div>

        {/* Workflow Panel */}
        {activeTab === 'workflow' && (
          <WorkflowPanel
            steps={steps}
            onUpdate={updateStep}
            onAddStep={addStep}
            setSteps={setSteps}
          />
        )}
      </main>
    </div>
  );
}

const container = document.getElementById("root");
const root = createRoot(container);
root.render(<App />);