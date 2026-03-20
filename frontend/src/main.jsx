import React, { useRef, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import io from "socket.io-client";

const SERVER_URL = "http://localhost:3001";
const USER_ID = "user_" + Math.random().toString(36).slice(2, 12);

function App() {
  const canvasRef = useRef(null);
  const socketRef = useRef(null);

  const [status, setStatus] = useState("");
  const [urlInput, setUrlInput] = useState("https://efortuna.pl");
  const [mode, setMode] = useState("navigation"); 
  const [cursorType, setCursorType] = useState('default');

  // Frame handling
  const latestFrameRef = useRef(null);
  const isRenderingRef = useRef(false);

  // === SOCKET CONNECTION ===
  useEffect(() => {
    const socket = io(SERVER_URL, {
      query: { userId: USER_ID },
      transports: ["websocket"]
    });
    socketRef.current = socket;

    socket.on("connect", () => setStatus("Connected"));

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

    socket.on("disconnect", () => setStatus("Disconnected"));

    return () => socket.disconnect();
  }, []);

  // === RENDER LOOP ===
  useEffect(() => {
    const canvas = canvasRef.current;
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

        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      } catch (err) {
        console.error("Frame render error:", err);
      }

      isRenderingRef.current = false;
    }

    renderLoop();
  }, []);

  // === MODE CHANGE ===
  const changeMode = (newMode) => {
    setMode(newMode);

    if (socketRef.current) {
      socketRef.current.emit("setMode", { mode: newMode });
    }
  };

  // === NAVIGATION ===
  const handleNavigate = () => {
    if (socketRef.current && urlInput.startsWith("http")) {
      setStatus("Navigating...");

      // 🔥 send mode together with navigation
      socketRef.current.emit("navigate", {
        url: urlInput,
        mode
      });
    }
  };

  // === COORDINATE MAPPING ===
  const getScaledCoords = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();

    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY)
    };
  };

  // === USER ACTIONS ===
  const handleClick = (e) => {
    // if (mode === "selection") return; // 🔥 disable click in selection mode

    e.preventDefault();
    if (!socketRef.current) return;

    const { x, y } = getScaledCoords(e);
    socketRef.current.emit("userAction", { type: "click", x, y });
    setStatus(`Clicked: x=${x}, y=${y}`);
  };

  const handleMouseMove = (e) => {
    // if (mode === "selection") return;

    if (!socketRef.current) return;

    const { x, y } = getScaledCoords(e);
    socketRef.current.emit("userAction", { type: "hover", x, y });
  };

  const handleMouseDown = (e) => {
    // if (mode === "selection") return;

    e.preventDefault();
    if (!socketRef.current) return;

    const { x, y } = getScaledCoords(e);
    socketRef.current.emit("userAction", { type: "mousedown", x, y });
  };

  const handleMouseUp = (e) => {
    // if (mode === "selection") return;

    e.preventDefault();
    if (!socketRef.current) return;

    const { x, y } = getScaledCoords(e);
    socketRef.current.emit("userAction", { type: "mouseup", x, y });
  };

  return (
    <div style={{ padding: "1em", paddingTop: 0}}>
      <h2>Browser Streaming (Binary, Optimized)</h2>

      {/* 🔥 MODE SWITCH */}
      <div style={{ marginBottom: "10px" }}>
        <button
          onClick={() => changeMode("navigation")}
          style={{
            marginRight: "10px",
            background: mode === "navigation" ? "#4caf50" : "#ccc"
          }}
        >
          Navigation Mode
        </button>

        <button
          onClick={() => changeMode("selection")}
          style={{
            background: mode === "selection" ? "#ff9800" : "#ccc"
          }}
        >
          Selection Mode
        </button>
      </div>

      {/* NAVIGATION */}
      <div>
        <input
          style={{ width: "300px" }}
          type="text"
          value={urlInput}
          onChange={e => setUrlInput(e.target.value)}
        />
        <button onClick={handleNavigate}>Go</button>
      </div>

      <div style={{ margin: "1em 0" }}>
        {status} | Mode: <b>{mode}</b>
      </div>

      {/* CANVAS */}
      <div
        style={{
          border: "2px solid #888",
          display: "inline-block",
          position: "relative"
        }}
      >
        <canvas
          ref={canvasRef}
          width={1400}
          height={600}
          style={{
            width: "100%",
            maxWidth: "1400px",
            height: "auto",
            display: "block",
            background: "#eee",
            cursor: cursorType
          }}
          onClick={handleClick}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
        />
      </div>

      <div style={{ margin: "1em 0" }}>
        <small>
          {mode === "selection"
            ? "Selection mode: pick elements"
            : "Navigation mode: interact with page"}
        </small>
      </div>
    </div>
  );
}

// Mount app
const container = document.getElementById("root");
const root = createRoot(container);
root.render(<App />);