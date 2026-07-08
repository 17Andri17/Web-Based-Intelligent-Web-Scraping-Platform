'use strict';

const crypto = require('crypto');

/* ===========================================================================
   apiKeys.service
   ---------------------------------------------------------------------------
   Generation + hashing for public API keys (`sk_live_…`).

   Keys are 24 random bytes (base64url → 32 chars) behind a mode prefix, so
   they carry ~192 bits of entropy. That's why plain SHA-256 (not bcrypt) is
   the right storage hash here: the input is unguessable random material, and
   an unsalted deterministic hash is what makes the O(1) indexed lookup on
   the auth path possible.
   ========================================================================= */

const PREFIX_LEN = 12; // 'sk_live_' + first 4 chars — enough to identify, useless to attackers

function hashKey(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

function generateKey(mode = 'live') {
  const key = `sk_${mode}_${crypto.randomBytes(24).toString('base64url')}`;
  return { key, keyHash: hashKey(key), prefix: key.slice(0, PREFIX_LEN) };
}

function looksLikeApiKey(token) {
  return typeof token === 'string' && /^sk_(live|test)_[A-Za-z0-9_-]{16,}$/.test(token);
}

module.exports = { generateKey, hashKey, looksLikeApiKey };
