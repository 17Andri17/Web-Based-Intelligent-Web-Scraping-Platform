'use strict';

const crypto = require('crypto');

/* ===========================================================================
   utils/crypto
   ---------------------------------------------------------------------------
   AES-256-GCM encrypt/decrypt for small secrets stored at rest — currently
   only proxy passwords (backend/db/repositories/proxies.repo.js). This is
   the first encrypted-at-rest field in the codebase (the only other secret,
   user passwords, is hashed with bcrypt via backend/routes/auth.routes.js,
   which is one-way and doesn't apply here since a proxy password has to be
   recovered in plaintext to hand to Puppeteer/Chrome).

   Key comes from the PROXY_ENCRYPTION_KEY env var: 32 raw bytes, given as
   base64 or 64 hex chars. Deliberately not derived from JWT_SECRET or any
   other existing secret — rotating one shouldn't silently break the other.
   ========================================================================= */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // 96-bit nonce, the GCM-recommended size

let cachedKey; // resolved once; env vars don't change at runtime

function loadKey() {
  if (cachedKey !== undefined) return cachedKey;

  const raw = process.env.PROXY_ENCRYPTION_KEY;
  if (!raw) {
    cachedKey = null;
    return null;
  }

  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    try { key = Buffer.from(raw, 'base64'); } catch (_) { key = null; }
  }

  if (!key || key.length !== 32) {
    throw new Error(
      'PROXY_ENCRYPTION_KEY is set but is not a valid 32-byte key ' +
      '(expected 64 hex chars or base64 encoding 32 bytes). ' +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  }
  cachedKey = key;
  return key;
}

// True once a usable key is configured — lets callers give a clear 4xx
// instead of a 500 when a proxy password is submitted but nothing is set up.
function isConfigured() {
  return !!loadKey();
}

// Returns "iv:authTag:ciphertext", each base64. Null/empty input -> null
// (a proxy legitimately may have no password, e.g. IP-allowlisted proxies).
function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const key = loadKey();
  if (!key) {
    throw new Error(
      'PROXY_ENCRYPTION_KEY is not set — cannot store a proxy password. ' +
      'Set it in backend/.env, or save the proxy without a password.'
    );
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

function decrypt(stored) {
  if (!stored) return null;
  const key = loadKey();
  if (!key) {
    throw new Error('PROXY_ENCRYPTION_KEY is not set — cannot decrypt stored proxy passwords.');
  }
  const parts = String(stored).split(':');
  if (parts.length !== 3) return null; // corrupt/foreign value — fail soft, not throw
  const [ivB64, tagB64, ctB64] = parts;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
    return plaintext.toString('utf8');
  } catch (_) {
    // Wrong key (rotated) or tampered ciphertext — GCM's authTag check
    // failed. Treat as "password unavailable" rather than crashing a run.
    return null;
  }
}

module.exports = { encrypt, decrypt, isConfigured };
