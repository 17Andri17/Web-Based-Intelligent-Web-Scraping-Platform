const http = require('http');
const express = require('express');
const app = require('./app');
const scraperServiceFactory = require('./services/scraper.service');
const scraperRoutesFactory = require('./routes/scraper.routes');
const { Server } = require('socket.io');
const browserManager = require('./browser/BrowserManager');
const PORT = process.env.PORT || 3001;

// Create HTTP server
const server = http.createServer(app);

// Attach Socket.IO
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket']
});

// Create scraper service (mode per user)
const scraperService = scraperServiceFactory(io);

// === Socket.IO Commands & Streaming ===
io.on("connection", (socket) => {
  const userId = socket.handshake.query.userId || socket.id;
  console.log(`🔌 User connected: ${userId}`);
  socket.join(userId);

  socket.on("navigate", async (data) => {
    try {
      const page = await browserManager.getPage(userId);

      await page.setViewport({
        width: 1400,
        height: 600,
        deviceScaleFactor: 1,
        hasTouch: false,
        isMobile: false
      });

      await page.goto(data.url, { waitUntil: "networkidle2" });

      await page.addScriptTag({
        url: "https://cdn.socket.io/4.7.2/socket.io.min.js"
      });

      await page.evaluate((userId) => {
        window.socket = io("http://localhost:3001", { query: { userId } });
      }, userId);

      const session = await page.target().createCDPSession();

      let streaming = true;

      // Start CDP screencast
      await session.send("Page.startScreencast", {
        format: "png",        // or "png" (higher quality, heavier)
        quality: 90,           // only applies to jpeg
        maxWidth: 1400,
        maxHeight: 600,
        everyNthFrame: 1       // send every frame
      });

      const onFrame = async (frame) => {
        if (!streaming) return;

        try {
          // Convert base64 → binary buffer
          const buffer = Buffer.from(frame.data, "base64");

          // Send binary directly (NO base64)
          socket.emit("frame", buffer);

          // Ack frame (REQUIRED)
          await session.send("Page.screencastFrameAck", {
            sessionId: frame.sessionId
          });
        } catch (err) {
          console.error("Frame error:", err);
        }
      };

      session.on("Page.screencastFrame", onFrame);

      // Stop streaming cleanly
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

      socket.emit("message", "Navigation started and streaming (binary streaming enabled).");

    } catch (err) {
      socket.emit("message", `❌ Navigation error: ${err.message}`);
    }
  });

  // Handle user actions (clicks, input, selection)
  socket.on("userAction", async (action) => {
    try {
      await scraperService.performAction(userId, action, socket);
      socket.emit("message", `Action ${action.type} executed`);
    } catch (err) {
      socket.emit("message", `Error executing action: ${err.message}`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`🔌 User disconnected: ${userId}`);
    scraperService.clearUser(userId);
  });

  // socket.on("setViewport", async ({width, height}) => {
  //   console.log(`Setting viewport for user ${userId} to ${width}x${height}`);
  //   try {
  //     const page = await browserManager.getPage(userId);
  //     await page.setViewport({ width: width, height: height, deviceScaleFactor: 1 });
  //     console.log(`Set viewport for user ${userId}: ${width}x${height}`);
  //   } catch (err) {
  //     console.error("Error setting viewport:", err);
  //   }
  // });
});

// REST API routes (if needed for metadata)
app.use('/api/scraper', scraperRoutesFactory(io));

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
