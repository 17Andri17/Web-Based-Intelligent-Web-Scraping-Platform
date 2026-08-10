const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const authRoutes = require('./routes/auth.routes');
const workflowsRoutes = require('./routes/workflows.routes');
const customActionsRoutes = require('./routes/customActions.routes');
const aiRoutes = require('./routes/ai.routes');
const schedulesRoutes = require('./routes/schedules.routes');
const runsRoutes = require('./routes/runs.routes');
const proxiesRoutes = require('./routes/proxies.routes');
const proxyPoolsRoutes = require('./routes/proxyPools.routes');
const apiKeysRoutes = require('./routes/apiKeys.routes');
const webhooksRoutes = require('./routes/webhooks.routes');
const notificationsRoutes = require('./routes/notifications.routes');
const v1Routes = require('./routes/v1');

const app = express();

// Middleware
app.use(express.json({ limit: '4mb' }));
app.use(cors());
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth', authRoutes);
app.use('/api/workflows', workflowsRoutes);
app.use('/api/custom-actions', customActionsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/schedules', schedulesRoutes);
app.use('/api/runs', runsRoutes);
app.use('/api/proxies', proxiesRoutes);
app.use('/api/proxy-pools', proxyPoolsRoutes);
// Dashboard management of public-API keys (JWT-authed, internal).
app.use('/api/api-keys', apiKeysRoutes);
app.use('/api/webhooks', webhooksRoutes);
app.use('/api/notifications', notificationsRoutes);

// Public REST API — versioned, API-key-authed surface for third-party
// programs (docs/API_ARCHITECTURE.md). Internal frontend routes stay /api/*.
app.use('/v1', v1Routes);

// Liveness/readiness probe for a process manager (pm2/systemd/Docker). Reports
// DB reachability; a plain 200 means the HTTP server is up.
const db = require('./db/client');
app.get('/healthz', async (req, res) => {
  let dbOk = false;
  try { await db.get('SELECT 1 AS ok'); dbOk = true; } catch (_) {}
  res.status(dbOk ? 200 : 503).json({ status: dbOk ? 'ok' : 'degraded', db: dbOk, uptime: process.uptime() });
});

// Bundled demo site ("DemoMart") for the guided tour — a deterministic shop
// the streamed browser navigates to. Served from the backend (not the frontend
// build) so it's always reachable by the backend's Chromium in dev and prod.
app.use('/demo', express.static(path.join(__dirname, 'public', 'demo')));

// Serve the built frontend when present (npm run build in frontend/), so a
// single process serves both the API and the UI in production. In dev the
// Vite server runs separately and this block is simply skipped.
const DIST_DIR = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
  app.use(express.static(DIST_DIR));
  // SPA fallback: any non-API GET that didn't match a static file returns
  // index.html so client-side routing works on refresh/deep-link.
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api') || req.path.startsWith('/v1') || req.path === '/healthz') return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
  console.log('[app] serving built frontend from frontend/dist');
} else {
  app.get('/', (req, res) => res.send('Scraper API running'));
}

// Errors under /v1 must keep the public API's one JSON error shape — this
// also catches body-parser failures (malformed JSON, oversized payloads)
// that fire before the /v1 router's own middleware.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (!req.path.startsWith('/v1')) return next(err);
  const status = err.type === 'entity.parse.failed' ? 400
    : err.type === 'entity.too.large' ? 413
    : err.status || err.statusCode || 500;
  if (status >= 500) console.error(`[v1] ${req.method} ${req.path} failed:`, err);
  res.status(status).json({
    error: {
      code: status === 400 ? 'invalid_request'
        : status === 413 ? 'payload_too_large'
        : 'internal_error',
      message: status < 500 ? err.message : 'Internal server error.',
      request_id: req.requestId || null,
    },
  });
});

module.exports = app;
