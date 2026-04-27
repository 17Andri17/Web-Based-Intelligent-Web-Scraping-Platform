'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app                = require('./app');
const scraperServiceFactory = require('./services/scraper.service');
const browserManager     = require('./browser/BrowserManager');
const { executeWorkflow } = require('./workflow/WorkflowExecutor');
const { generateCode }    = require('./workflow/workflowCodegen');

const PORT = process.env.PORT || 3001;

const server     = http.createServer(app);
const io         = new Server(server, { cors: { origin: '*' }, transports: ['websocket'] });
const scraperService = scraperServiceFactory(io);

const injectedScript   = fs.readFileSync(path.join(__dirname, './browser/inject/SelectorTool.js'), 'utf8');
const injectedSelectors = fs.readFileSync(path.join(__dirname, './browser/selectors.js'), 'utf8');

// Active CDP sessions per user
const userSessions = new Map();

// Track last-known session config per user (startUrl, viewport) for code generation
const userSessionMeta = new Map();

io.on('connection', (socket) => {
  const userId = socket.handshake.query.userId || socket.id;
  console.log(`🔌 User connected: ${userId}`);
  socket.join(userId);

  // ── Reset selection ───────────────────────────────────────────────────────
  socket.on('resetSelection', async () => {
    try {
      const s = userSessions.get(userId);
      if (s?.page) await s.page.evaluate(() => { if (typeof window.__resetSelection__ === 'function') window.__resetSelection__(); });
    } catch (_) {}
  });

  // ── Breadcrumb: navigate to ancestor ─────────────────────────────────────
  socket.on('navigateAncestor', async ({ levelsUp }) => {
    try {
      const s = userSessions.get(userId);
      if (s?.page) await s.page.evaluate((levels) => {
        if (typeof window.__selectAncestor__ === 'function') window.__selectAncestor__(levels);
      }, levelsUp);
    } catch (_) {}
  });

  // ── Breadcrumb: get children of ancestor for picker ───────────────────────
  socket.on('getChildrenOf', async ({ levelsUp }) => {
    try {
      const s = userSessions.get(userId);
      if (!s?.page) { socket.emit('childrenList', { levelsUp, children: [] }); return; }
      const children = await s.page.evaluate((levels) => {
        if (typeof window.__getChildrenOf__ === 'function') return window.__getChildrenOf__(levels);
        return [];
      }, levelsUp);
      socket.emit('childrenList', { levelsUp, children: children || [] });
    } catch (err) {
      socket.emit('childrenList', { levelsUp, children: [] });
    }
  });

  // ── Breadcrumb: select a specific child by index ──────────────────────────
  socket.on('selectChildByIndex', async ({ levelsUp, childIndex }) => {
    try {
      const s = userSessions.get(userId);
      if (s?.page) await s.page.evaluate((levels, idx) => {
        if (typeof window.__selectChildByIndex__ === 'function') window.__selectChildByIndex__(levels, idx);
      }, levelsUp, childIndex);
    } catch (_) {}
  });

  // ── Picker hover highlight ───────────────────────────────────────────────
  socket.on('hoverAncestor', async ({ levelsUp }) => {
    try {
      const s = userSessions.get(userId);
      if (s?.page) await s.page.evaluate((lvl) => {
        if (typeof window.__highlightAncestor__ === 'function') window.__highlightAncestor__(lvl);
      }, levelsUp);
    } catch (_) {}
  });

  socket.on('hoverPickerChild', async ({ levelsUp, childIndex }) => {
    try {
      const s = userSessions.get(userId);
      if (s?.page) await s.page.evaluate((lvl, idx) => {
        if (typeof window.__highlightPickerChild__ === 'function') window.__highlightPickerChild__(lvl, idx);
      }, levelsUp, childIndex);
    } catch (_) {}
  });

  socket.on('unhoverPickerChild', async () => {
    try {
      const s = userSessions.get(userId);
      if (s?.page) await s.page.evaluate(() => {
        if (typeof window.__clearHoverHighlight__ === 'function') window.__clearHoverHighlight__();
      });
    } catch (_) {}
  });

  // ── Navigate ────────────────────────────────────────────────────────────
  socket.on('navigate', async (data) => {
    try {
      const page = await browserManager.getPage(userId);

      await browserManager.ensureBinding(userId, 'sendToNode', (event) => {
        socket.emit('browserEvent', event);
      });
      await browserManager.ensureBinding(userId, 'sendCursorType', (cursorType) => {
        socket.emit('cursorType', { cursor: cursorType });
      });

      const viewportWidth  = data.viewportWidth  || 1280;
      const viewportHeight = data.viewportHeight || 720;

      await page.setViewport({ width: viewportWidth, height: viewportHeight, deviceScaleFactor: 1, hasTouch: false, isMobile: false });
      await page.goto(data.url, { waitUntil: 'networkidle2' });

      // Remember session meta for code generation
      userSessionMeta.set(userId, {
        startUrl:       data.url,
        viewportWidth,
        viewportHeight,
      });

      await page.evaluate(() => { window.__SELECTION_MODE__ = false; });
      await page.addScriptTag({ content: injectedScript });
      await page.addScriptTag({ content: injectedSelectors });
      await page.evaluate(() => { window.__SELECTION_MODE__ = false; });

      const client = await page.target().createCDPSession();

      userSessions.set(userId, {
        session: client,
        page,
        streaming: true,
        currentWidth:  viewportWidth,
        currentHeight: viewportHeight,
      });

      await client.send('Page.startScreencast', {
        format: 'png',
        maxWidth: viewportWidth,
        maxHeight: viewportHeight,
        everyNthFrame: 1,
      });

      socket.emit('viewportUpdated', { width: viewportWidth, height: viewportHeight });

      const onFrame = async (frame) => {
        const s = userSessions.get(userId);
        if (!s?.streaming) return;
        try {
          socket.emit('frame', Buffer.from(frame.data, 'base64'));
          await client.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
        } catch (_) {}
      };
      client.on('Page.screencastFrame', onFrame);

      const stopStreaming = async () => {
        const s = userSessions.get(userId);
        if (!s?.streaming) return;
        s.streaming = false;
        try { await client.send('Page.stopScreencast'); } catch (_) {}
        client.removeListener('Page.screencastFrame', onFrame);
        userSessions.delete(userId);
      };

      socket.on('disconnect',    stopStreaming);
      socket.on('stopStreaming', stopStreaming);

      socket.emit('message', '✅ Navigation + streaming started');
    } catch (err) {
      console.error(err);
      socket.emit('message', `❌ Navigation error: ${err.message}`);
    }
  });

  // ── Resize viewport ──────────────────────────────────────────────────────
  socket.on('resizeViewport', async ({ width, height }) => {
    const s = userSessions.get(userId);
    if (!s?.streaming) return;
    if (Math.abs(s.currentWidth - width) < 10 && Math.abs(s.currentHeight - height) < 10) return;
    try {
      await s.session.send('Page.stopScreencast').catch(() => {});
      await s.page.setViewport({ width, height, deviceScaleFactor: 1, hasTouch: false, isMobile: false });
      s.currentWidth  = width;
      s.currentHeight = height;
      const meta = userSessionMeta.get(userId);
      if (meta) { meta.viewportWidth = width; meta.viewportHeight = height; }
      await s.session.send('Page.startScreencast', { format: 'png', maxWidth: width, maxHeight: height, everyNthFrame: 1 });
      socket.emit('viewportUpdated', { width, height });
    } catch (err) {
      socket.emit('message', `❌ Resize error: ${err.message}`);
    }
  });

  // ── Set selection mode ───────────────────────────────────────────────────
  socket.on('setMode', async ({ mode }) => {
    try {
      const page = await browserManager.getPage(userId);
      await page.evaluate((m) => { window.__SELECTION_MODE__ = m === 'selection'; }, mode);
      socket.emit('message', `Mode: ${mode}`);
    } catch (_) {}
  });

  // ── User actions (mouse/keyboard forwarding) ─────────────────────────────
  socket.on('userAction', async (action) => {
    try {
      await scraperService.performAction(userId, action, socket);
    } catch (err) {
      socket.emit('message', `Error: ${err.message}`);
    }
  });

  // ── Execute workflow ─────────────────────────────────────────────────────
  socket.on('executeWorkflow', async (data) => {
    /*
      data = {
        steps:   [...],   // the full workflow step tree
        meta?:   { startUrl, viewportWidth, viewportHeight }
      }
    */
    const meta = data.meta || userSessionMeta.get(userId) || {};
    const workflow = { steps: data.steps || [], meta };

    socket.emit('executionStarted');

    try {
      await executeWorkflow(workflow, socket);
    } catch (err) {
      socket.emit('executionLog', { line: `❌ Executor error: ${err.message}`, level: 'error' });
      socket.emit('executionDone', { success: false, results: null, error: err.message });
    }
  });

  // ── Download code ─────────────────────────────────────────────────────────
  socket.on('downloadCode', (data) => {
    /*
      data = { steps, meta? }
      Response: codeReady { code: string }
    */
    try {
      const meta = data.meta || userSessionMeta.get(userId) || {};
      const code = generateCode({ steps: data.steps || [], meta });
      socket.emit('codeReady', { code });
    } catch (err) {
      socket.emit('message', `❌ Code generation error: ${err.message}`);
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`🔌 User disconnected: ${userId}`);
    userSessions.delete(userId);
    scraperService.clearUser(userId);
  });
});

server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));