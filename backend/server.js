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
  cors: { origin: '*' }
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
      // Open Puppeteer page and navigate
      const page = await browserManager.getPage(userId);
      await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
      await page.goto(data.url, { waitUntil: "networkidle2" });

      await page.addScriptTag({ url: "https://cdn.socket.io/4.7.2/socket.io.min.js" });
      // Inject `window.socket = io(...)` with your backend URL and userId
      await page.evaluate((userId) => {
        window.socket = io("http://localhost:3001", { query: { userId } });
      }, userId);
      // await page.addScriptTag({ path: './browser/inject/SelectorTool.js' });

      const session = await page.target().createCDPSession();
      // Start streaming frames
      let streaming = true;
      async function sendFrame() {
        if (!streaming) return;
        // Take screenshot as base64 PNG
        const buf = await page.screenshot({ type: "png" });
        socket.emit("frame", { image: buf.toString("base64") });
        setTimeout(sendFrame, 50); // send ~20 FPS
      }
      while (streaming) {
        const { data } = await session.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: 70,
          fromSurface: true,
        });
        socket.emit("frame", { image: data });
        await new Promise(r => setTimeout(r, 100));
      }

      // Stop stream on disconnect or explicit stop signal
      socket.on("disconnect", () => { streaming = false; });
      socket.on("stopStreaming", () => { streaming = false; });

      socket.emit("message", "Navigation started and streaming video.");
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
