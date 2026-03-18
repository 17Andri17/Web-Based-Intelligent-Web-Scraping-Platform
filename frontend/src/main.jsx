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

    // Receive binary frames directly
    socket.on("frame", (data) => {
      latestFrameRef.current = data; // Uint8Array / ArrayBuffer
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

  // === NAVIGATION ===
  const handleNavigate = () => {
    if (socketRef.current && urlInput.startsWith("http")) {
      setStatus("Navigating...");
      socketRef.current.emit("navigate", { url: urlInput });
    }
  };

  // === COORDINATE MAPPING ===
  const getScaledCoords = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();

    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);

    return { x, y };
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

  return (
    <div style={{ padding: "1em", maxWidth: 900 }}>
      <h2>Browser Streaming (Binary, Optimized)</h2>

      <div>
        <input
          style={{ width: "300px" }}
          type="text"
          value={urlInput}
          onChange={e => setUrlInput(e.target.value)}
        />
        <button onClick={handleNavigate}>Go</button>
      </div>

      <div style={{ margin: "1em 0" }}>{status}</div>

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
            cursor: "crosshair",
            display: "block",
            background: "#eee"
          }}
          onClick={handleClick}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
        />
      </div>

      <div style={{ margin: "1em 0" }}>
        <small>Click anywhere in the browser preview to interact</small>
      </div>
    </div>
  );
}

// Mount app
const container = document.getElementById("root");
const root = createRoot(container);
root.render(<App />);