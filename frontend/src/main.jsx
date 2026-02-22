import React, { useRef, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import io from "socket.io-client";

// Backend server URL
const SERVER_URL = "http://localhost:3001";
const USER_ID = "user_" + Math.random().toString(36).slice(2, 12);

function App() {
  const [image, setImage] = useState(null);
  const [status, setStatus] = useState("");
  const imgRef = useRef();
  const socketRef = useRef();
  const [urlInput, setUrlInput] = useState("https://efortuna.pl");

  useEffect(() => {
    const socket = io(SERVER_URL, { query: { userId: USER_ID } });
    socketRef.current = socket;

    socket.on("connect", () => setStatus("Connected"));
    socket.on("message", msg =>
      setStatus(typeof msg === "string" ? msg : (msg.msg || ""))
    );
    socket.on("frame", ({ image }) => setImage(image));
    socket.on("actionResult", res => setStatus(res.success ? "Action executed." : "Action failed: " + (res.error || "")));
    socket.on("disconnect", () => setStatus("Disconnected"));

    return () => socket.disconnect();
  }, []);

  useEffect(() => {
    function sendSize() {
      if (socketRef.current) {
        socketRef.current.emit("setViewport", {
          width: 800,  // Or dynamically measure
          height: 600
        });
      }
    }
    sendSize(); // Initial

    // // Example: resend size on window resize
    // window.addEventListener("resize", sendSize);
    // return () => window.removeEventListener("resize", sendSize);
  }, []);

  // Navigation
  const handleNavigate = () => {
    if (socketRef.current && urlInput.startsWith("http")) {
      setStatus("Navigating...");
      socketRef.current.emit("navigate", { url: urlInput });
    }
  };

  // Mouse click coordinates mapping
  const handleClick = (e) => {
    e.preventDefault();
    const img = imgRef.current;
    if (img && socketRef.current) {
      const rect = img.getBoundingClientRect();
      const x = Math.round(e.clientX - rect.left);
      const y = Math.round(e.clientY - rect.top);
      socketRef.current.emit("userAction", { type: "click", x, y });
      setStatus(`Clicked: x=${x}, y=${y}`);
    }
  };

  const handleMouseMove = (e) => {
    const img = imgRef.current;
    if (img && socketRef.current) {
      const rect = img.getBoundingClientRect();
      const x = Math.round(e.clientX - rect.left);
      const y = Math.round(e.clientY - rect.top);
      // Optional: throttle emission
      socketRef.current.emit("userAction", { type: "hover", x, y });
    }
  };

  const handleMouseDown = (e) => {
    e.preventDefault();
    const img = imgRef.current;
    if (img && socketRef.current) {
      const rect = img.getBoundingClientRect();
      const x = Math.round(e.clientX - rect.left);
      const y = Math.round(e.clientY - rect.top);
      socketRef.current.emit("userAction", { type: "mousedown", x, y });
      console.log("Mouse down at", x, y);
    }
  };
  const handleMouseUp = (e) => {
    const img = imgRef.current;
    if (img && socketRef.current) {
      const rect = img.getBoundingClientRect();
      const x = Math.round(e.clientX - rect.left);
      const y = Math.round(e.clientY - rect.top);
      console.log("Mouse up at", x, y);
      socketRef.current.emit("userAction", { type: "mouseup", x, y });
    }
    e.preventDefault();
  };

  return (
    <div style={{ padding: "1em", maxWidth: 900 }}>
      <h2>Web Scraper Streaming Demo</h2>
      <div>
        <input
          style={{ width: "300px" }}
          type="text"
          value={urlInput}
          placeholder="Enter URL to browse"
          onChange={e => setUrlInput(e.target.value)}
        />
        <button onClick={handleNavigate}>Go</button>
      </div>
      <div style={{ margin: "1em 0" }}>{status}</div>
      <div style={{ border: "2px solid #888", display: "inline-block", position: "relative" }}>
        {image ? (
          <img
            ref={imgRef}
            src={`data:image/png;base64,${image}`}
            width={800}
            height={600}
            alt="Browser stream"
            style={{ cursor: "crosshair", display: "block" }}
            onClick={handleClick}
            onMouseMove={handleMouseMove}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
          />
        ) : (
          <div style={{ width: 800, height: 600, background: "#eee", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span>Waiting for video stream...</span>
          </div>
        )}
      </div>
      <div style={{ margin: "1em 0" }}>
        <small>
          Click anywhere in the browser preview to interact!
        </small>
      </div>
    </div>
  );
}

// Mount the App
const container = document.getElementById("root");
const root = createRoot(container);
root.render(<App />);
