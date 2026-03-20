const http = require('http');
const express = require('express');
const app = require('./app');
const scraperServiceFactory = require('./services/scraper.service');
const scraperRoutesFactory = require('./routes/scraper.routes');
const { Server } = require('socket.io');
const browserManager = require('./browser/BrowserManager');
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3001;

// Create HTTP server
const server = http.createServer(app);

// Attach Socket.IO
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket']
});

// Create scraper service
const scraperService = scraperServiceFactory(io);

// Load your injected script (the big one you pasted)
const injectedScript = fs.readFileSync(
  path.join(__dirname, "./browser/inject/SelectorTool.js"),
  "utf8"
);

// === SOCKET.IO ===
io.on("connection", (socket) => {
  const userId = socket.handshake.query.userId || socket.id;
  console.log(`🔌 User connected: ${userId}`);
  socket.join(userId);

  socket.on("navigate", async (data) => {
    let session = null;
    let streaming = true;

    try {
      const page = await browserManager.getPage(userId);

      // ✅ Expose bridge (Puppeteer → Node → Frontend)
      await page.exposeFunction("sendToNode", (event) => {
        socket.emit("browserEvent", event);
      });

      await page.setViewport({
        width: 1400,
        height: 600,
        deviceScaleFactor: 1,
        hasTouch: false,
        isMobile: false
      });

      await page.goto(data.url, { waitUntil: "networkidle2" });

      await page.exposeFunction("sendCursorType", (cursorType) => {
        socket.emit("cursorType", { cursor: cursorType });
      });

      await page.evaluate(() => {
        window.__SELECTION_MODE__ = false;
      });

      await page.addScriptTag({ content: injectedScript });

      await page.evaluate(() => {
        window.__SELECTION_MODE__ = false;
      });

      

      // === SCREENCAST ===
      const client = await page.target().createCDPSession();
      session = client;

      await session.send("Page.startScreencast", {
        format: "png",
        maxWidth: 1400,
        maxHeight: 600,
        everyNthFrame: 1
      });

      const onFrame = async (frame) => {
        if (!streaming) return;

        try {
          const buffer = Buffer.from(frame.data, "base64");

          socket.emit("frame", buffer);

          await session.send("Page.screencastFrameAck", {
            sessionId: frame.sessionId
          });
        } catch (err) {
          console.error("Frame error:", err);
        }
      };

      session.on("Page.screencastFrame", onFrame);

      const stopStreaming = async () => {
        if (!streaming) return;
        streaming = false;

        try {
          await session.send("Page.stopScreencast");
        } catch (e) {}

        session.removeListener("Page.screencastFrame", onFrame);
      };

      socket.on("disconnect", stopStreaming);
      socket.on("stopStreaming", stopStreaming);

      socket.emit("message", "✅ Navigation + streaming started (bridge enabled)");

    } catch (err) {
      console.error(err);
      socket.emit("message", `❌ Navigation error: ${err.message}`);
    }
  });

  // === MODE SWITCHING (navigation vs selection) ===
  socket.on("setMode", async ({ mode }) => {
    try {
      const page = await browserManager.getPage(userId);

      await page.evaluate((mode) => {
        window.__SELECTION_MODE__ = mode === "selection";
      }, mode);

      socket.emit("message", `Mode switched to: ${mode}`);
    } catch (err) {
      console.error(err);
    }
  });

  // === USER ACTIONS ===
  socket.on("userAction", async (action) => {
    try {
      await scraperService.performAction(userId, action, socket);
      socket.emit("message", `Action ${action.type} executed`);
    } catch (err) {
      socket.emit("message", `Error executing action: ${err.message}`);
    }
  });

  socket.on("disconnect", () => {
    console.log(`🔌 User disconnected: ${userId}`);
    scraperService.clearUser(userId);
  });
});

// REST API
app.use('/api/scraper', scraperRoutesFactory(io));

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});