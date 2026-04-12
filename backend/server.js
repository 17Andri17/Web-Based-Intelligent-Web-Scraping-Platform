const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = require('./app');
const scraperServiceFactory = require('./services/scraper.service');
const browserManager = require('./browser/BrowserManager');

const PORT = process.env.PORT || 3001;

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket']
});

const scraperService = scraperServiceFactory(io);

const injectedScript = fs.readFileSync(
  path.join(__dirname, './browser/inject/SelectorTool.js'),
  'utf8'
);

const injectedSelectors = fs.readFileSync(
  path.join(__dirname, './browser/selectors.js'),
  'utf8'
);

// Store active CDP sessions and streaming state per user
const userSessions = new Map();

io.on('connection', (socket) => {
  const userId = socket.handshake.query.userId || socket.id;
  console.log(`🔌 User connected: ${userId}`);
  socket.join(userId);

  socket.on('navigate', async (data) => {
    let session = null;
    let streaming = true;

    try {
      const page = await browserManager.getPage(userId);

      await page.setCookie({
        name: 'cookie_preferences_accepted',
        value: 'true',
        domain: 'google.com',
        path: '/'
      });

      await browserManager.ensureBinding(userId, 'sendToNode', (event) => {
        socket.emit('browserEvent', event);
      });

      await browserManager.ensureBinding(userId, 'sendCursorType', (cursorType) => {
        socket.emit('cursorType', { cursor: cursorType });
      });

      // Use viewport dimensions from client, or defaults
      const viewportWidth = data.viewportWidth || 1280;
      const viewportHeight = data.viewportHeight || 720;

      await page.setViewport({
        width: viewportWidth,
        height: viewportHeight,
        deviceScaleFactor: 1,
        hasTouch: false,
        isMobile: false
      });

      await page.goto(data.url, { waitUntil: 'networkidle2' });


      await page.evaluate(() => {
        window.__SELECTION_MODE__ = false;
      });

      await page.addScriptTag({ content: injectedScript });
      await page.addScriptTag({ content: injectedSelectors });

      await page.evaluate(() => {
        window.__SELECTION_MODE__ = false;
      });

      const client = await page.target().createCDPSession();
      session = client;

      // Store session info for later resize handling
      userSessions.set(userId, {
        session: client,
        page: page,
        streaming: true,
        currentWidth: viewportWidth,
        currentHeight: viewportHeight
      });

      await session.send('Page.startScreencast', {
        format: 'png',
        maxWidth: viewportWidth,
        maxHeight: viewportHeight,
        everyNthFrame: 1
      });

      // Emit initial viewport size to client
      socket.emit('viewportUpdated', { width: viewportWidth, height: viewportHeight });

      const onFrame = async (frame) => {
        const userSession = userSessions.get(userId);
        if (!userSession || !userSession.streaming) return;

        try {
          const buffer = Buffer.from(frame.data, 'base64');
          socket.emit('frame', buffer);

          await session.send('Page.screencastFrameAck', {
            sessionId: frame.sessionId
          });
        } catch (err) {
          console.error('Frame error:', err);
        }
      };

      session.on('Page.screencastFrame', onFrame);

      const stopStreaming = async () => {
        const userSession = userSessions.get(userId);
        if (!userSession || !userSession.streaming) return;
        userSession.streaming = false;

        try {
          await session.send('Page.stopScreencast');
        } catch (e) {}

        session.removeListener('Page.screencastFrame', onFrame);
        userSessions.delete(userId);
      };

      socket.on('disconnect', stopStreaming);
      socket.on('stopStreaming', stopStreaming);

      socket.emit('message', '✅ Navigation + streaming started (bridge enabled)');
    } catch (err) {
      console.error(err);
      socket.emit('message', `❌ Navigation error: ${err.message}`);
    }
  });

  // Handle viewport resize requests from client
  socket.on('resizeViewport', async ({ width, height }) => {
    const userSession = userSessions.get(userId);
    if (!userSession || !userSession.streaming) {
      console.log(`⚠️ No active session for user ${userId}, cannot resize`);
      return;
    }

    try {
      const { session, page, currentWidth, currentHeight } = userSession;
      
      // Only resize if dimensions actually changed significantly (avoid micro-resizes)
      if (Math.abs(currentWidth - width) < 10 && Math.abs(currentHeight - height) < 10) {
        return;
      }

      console.log(`📐 Resizing viewport for ${userId}: ${width}x${height}`);

      // Stop current screencast
      try {
        await session.send('Page.stopScreencast');
      } catch (e) {}

      // Update viewport
      await page.setViewport({
        width: width,
        height: height,
        deviceScaleFactor: 1,
        hasTouch: false,
        isMobile: false
      });

      // Update stored dimensions
      userSession.currentWidth = width;
      userSession.currentHeight = height;

      // Restart screencast with new dimensions
      await session.send('Page.startScreencast', {
        format: 'png',
        maxWidth: width,
        maxHeight: height,
        everyNthFrame: 1
      });

      // Notify client of successful resize
      socket.emit('viewportUpdated', { width, height });
      socket.emit('message', `📐 Viewport resized to ${width}x${height}`);
    } catch (err) {
      console.error('Viewport resize error:', err);
      socket.emit('message', `❌ Resize error: ${err.message}`);
    }
  });

  socket.on('setMode', async ({ mode }) => {
    try {
      const page = await browserManager.getPage(userId);

      await page.evaluate((modeValue) => {
        window.__SELECTION_MODE__ = modeValue === 'selection';
      }, mode);

      socket.emit('message', `Mode switched to: ${mode}`);
    } catch (err) {
      console.error(err);
    }
  });

  socket.on('userAction', async (action) => {
    try {
      await scraperService.performAction(userId, action, socket);
      socket.emit('message', `Action ${action.type} executed`);
    } catch (err) {
      socket.emit('message', `Error executing action: ${err.message}`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`🔌 User disconnected: ${userId}`);
    userSessions.delete(userId);
    scraperService.clearUser(userId);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});