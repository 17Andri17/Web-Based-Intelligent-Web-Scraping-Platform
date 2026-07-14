'use strict';

const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ===========================================================================
   JWT secret resolution — no insecure fallback constant.

   Order of precedence:
     1. JWT_SECRET env var (recommended for real deployments).
     2. A persisted random secret at backend/data/.jwt-secret — generated on
        first boot if absent. Persisting it (rather than a per-process random)
        keeps already-issued login tokens valid across restarts.

   The previous hard-coded 'dev-secret-change-me' meant anyone who read the
   source could forge tokens; this removes that while staying zero-config for
   a local run.
   ========================================================================= */
function resolveJwtSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.trim()) {
    return process.env.JWT_SECRET.trim();
  }
  const secretPath = path.join(__dirname, '..', 'data', '.jwt-secret');
  try {
    if (fs.existsSync(secretPath)) {
      const s = fs.readFileSync(secretPath, 'utf8').trim();
      if (s) return s;
    }
  } catch (_) {}
  const generated = crypto.randomBytes(48).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, generated, { mode: 0o600 });
    console.warn('[auth] JWT_SECRET not set — generated a persistent secret at backend/data/.jwt-secret. Set JWT_SECRET in the environment to override.');
  } catch (err) {
    console.warn('[auth] JWT_SECRET not set and could not persist a generated one (' + err.message + '); using an in-memory secret (tokens will not survive a restart).');
  }
  return generated;
}

const JWT_SECRET = resolveJwtSecret();
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, username: payload.username };
    next();
  } catch (_) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Admin status isn't in the JWT payload (tokens are long-lived and we don't
// want a promotion/demotion to require re-login to take effect, or a stale
// token to keep admin rights after demotion), so this does a fresh DB check.
// Only used on the few routes that manage the shared/platform proxy pool —
// not hot enough to be worth caching. Must run after requireAuth.
async function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Missing token' });
  try {
    const db = require('../db/client');
    const row = await db.get('SELECT is_admin FROM users WHERE id = ?', [req.user.id]);
    if (!row || !row.is_admin) return res.status(403).json({ error: 'Admin access required' });
    req.user.isAdmin = true;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Failed to verify admin status' });
  }
}

module.exports = { signToken, verifyToken, requireAuth, requireAdmin, JWT_SECRET };
