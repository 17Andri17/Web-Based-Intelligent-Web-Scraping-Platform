'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const users = require('../db/repositories/users.repo');
const db = require('../db/client');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

// Registration can be closed once the owner's account exists (ALLOW_REGISTRATION=false),
// so a LAN-reachable instance can't have new accounts minted against it.
function registrationAllowed() {
  return String(process.env.ALLOW_REGISTRATION || 'true').toLowerCase() !== 'false';
}

router.post('/register', async (req, res) => {
  if (!registrationAllowed()) {
    return res.status(403).json({ error: 'Registration is disabled on this instance.' });
  }
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 chars (letters, digits, _ . -)' });
  }
  if (password.length < 6 || password.length > 200) {
    return res.status(400).json({ error: 'Password must be 6-200 characters' });
  }

  const exists = await users.existsByUsername(username);
  if (exists) return res.status(409).json({ error: 'Username already taken' });

  const hash = await bcrypt.hash(password, 10);
  const userId = await users.create({ username, passwordHash: hash });
  const token = signToken({ sub: userId, username });
  res.status(201).json({ token, user: { id: userId, username } });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const row = await users.findByUsername(username);
  if (!row) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = signToken({ sub: row.id, username: row.username });
  res.json({ token, user: { id: row.id, username: row.username } });
});

router.get('/me', requireAuth, async (req, res) => {
  // isAdmin isn't in the JWT payload (a promotion/demotion via
  // ADMIN_USERNAMES shouldn't need re-login to take effect) — the frontend
  // needs it to decide whether to show shared/platform proxy management
  // controls, so it's a fresh DB read, same as middleware/auth.js's
  // requireAdmin.
  const row = await db.get('SELECT is_admin FROM users WHERE id = ?', [req.user.id]);
  res.json({ user: { ...req.user, isAdmin: !!(row && row.is_admin) } });
});

module.exports = router;
