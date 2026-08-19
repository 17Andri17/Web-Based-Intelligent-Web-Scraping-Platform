'use strict';

/* ===========================================================================
   Password reset and e-mail verification.

   The assertions that matter here are the refusals and the silences:
   /forgot must answer identically for a registered and an unregistered
   address, tokens must be single-use, expiry must bite, and a token issued
   for one address must not verify another.

   SMTP is stubbed by monkey-patching mailer.send so the captured link can be
   read back — no network, no real inbox, and the assertions are about what
   the link DOES rather than how it looked.

   Run: node test/auth-tokens.test.js  (from backend/)
   ========================================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-tokens-test-'));
process.env.DB_PATH = path.join(TMP_DIR, 'test.sqlite');
delete process.env.DB_CLIENT;
process.env.AUTH_RATE_LIMIT = '0';
// mailer.isConfigured() reads these; send() itself is replaced below.
process.env.SMTP_HOST = 'smtp.invalid';
process.env.SMTP_USER = 'test@invalid';
process.env.SMTP_PASS = 'x';
process.env.PUBLIC_APP_URL = 'https://app.test';

const http = require('http');

const db = require('../db/client');
const mailer = require('../services/mailer.service');

/* Capture instead of send. Installed BEFORE app/routes are required so every
   consumer picks up the patched function. */
const outbox = [];
mailer.send = async ({ to, subject, text, html }) => {
  outbox.push({ to, subject, text, html });
  return { ok: true };
};

const app = require('../app');
const users = require('../db/repositories/users.repo');
const authTokens = require('../db/repositories/authTokens.repo');
const authToken = require('../services/authToken.service');
const { signToken } = require('../middleware/auth');

let BASE;
let passed = 0;

function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
    throw new Error(`FAILED: ${name}`);
  }
}

async function api(method, pathname, { token, body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text, headers: res.headers };
}

// Pull the token out of the most recent mail, the way a user's click would.
function lastLinkToken(pattern) {
  const mail = [...outbox].reverse().find((m) => m.text.includes(pattern));
  if (!mail) return null;
  const m = mail.text.match(new RegExp(`${pattern}\\?token=([^\\s]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

async function main() {
  await db.init();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;

  /* ── Signup sends a verification mail ──────────────────────────────────── */
  console.log('verification on signup');
  {
    outbox.length = 0;
    let r = await api('POST', '/api/auth/register', {
      body: { email: 'ada@example.com', password: 'correct-horse' },
    });
    ok('registers', r.status === 201, `got ${r.status} ${r.text}`);
    ok('starts unverified', r.json.user.emailVerified === false);

    // Sent in the background, so give the microtask a beat to land.
    await new Promise((res) => setTimeout(res, 120));
    ok('a verification mail was sent', outbox.length === 1, `outbox=${outbox.length}`);
    ok('…to the address that registered', outbox[0].to === 'ada@example.com');

    const token = lastLinkToken('/verify-email');
    ok('…carrying a confirmation link', !!token);
    ok('…pointing at PUBLIC_APP_URL, not the API origin',
      outbox[0].text.includes('https://app.test/verify-email'));

    // Nothing recoverable is stored: only the hash.
    const row = await authTokens.findByHash(authToken.hash(token));
    ok('only the hash is stored', !!row && row.token_hash !== token);
    ok('…and the hash matches SHA-256 of the plaintext',
      row.token_hash === authToken.hash(token));

    r = await api('POST', '/api/auth/verify-email', { body: { token } });
    ok('confirming works', r.status === 200, `got ${r.status} ${r.text}`);

    const ada = await users.findByEmail('ada@example.com');
    ok('the account is now verified', !!ada.email_verified);

    // Single use: the classic replay.
    r = await api('POST', '/api/auth/verify-email', { body: { token } });
    ok('the same link cannot be used twice', r.status === 400 && r.json.code === 'used');
  }

  /* ── Registration survives a mail failure ──────────────────────────────── */
  console.log('mail failure does not block signup');
  {
    const original = mailer.send;
    mailer.send = async () => { throw new Error('SMTP exploded'); };
    const r = await api('POST', '/api/auth/register', {
      body: { email: 'resilient@example.com', password: 'correct-horse' },
    });
    // The slowest, least reliable dependency in the stack must not decide
    // whether someone can create an account.
    ok('signup succeeds even when SMTP throws', r.status === 201, `got ${r.status}`);
    await new Promise((res) => setTimeout(res, 80));
    mailer.send = original;
  }

  /* ── /forgot leaks nothing ─────────────────────────────────────────────── */
  console.log('forgot password — no account enumeration');
  {
    outbox.length = 0;
    const known = await api('POST', '/api/auth/forgot', { body: { email: 'ada@example.com' } });
    const unknown = await api('POST', '/api/auth/forgot', { body: { email: 'nobody@example.com' } });
    const malformed = await api('POST', '/api/auth/forgot', { body: { email: 'not-an-email' } });

    ok('registered address → 200', known.status === 200);
    ok('unregistered address → 200 as well', unknown.status === 200);
    ok('malformed address → 200 too, not 400',
      malformed.status === 200, `got ${malformed.status}`);
    // Byte-identical bodies: any difference is an oracle for "is this person
    // a customer?", which is precisely what login is careful to avoid.
    ok('all three bodies are byte-identical',
      known.text === unknown.text && unknown.text === malformed.text,
      `${known.text} vs ${unknown.text} vs ${malformed.text}`);
    ok('but only the real account was mailed', outbox.length === 1);
    ok('…and it went to the right address', outbox[0].to === 'ada@example.com');
  }

  /* ── OAuth-only accounts get no reset mail ─────────────────────────────── */
  console.log('oauth-only accounts');
  {
    outbox.length = 0;
    await users.createOAuthUser({ username: 'goog', email: 'goog@example.com' });

    const r = await api('POST', '/api/auth/forgot', { body: { email: 'goog@example.com' } });
    ok('still answers 200', r.status === 200);
    // Mailing "here's your reset link" to an account with no password would
    // be misleading, and setting one this way hands anyone with mailbox
    // access a second way in the owner never chose.
    ok('no reset mail is sent to an OAuth-only account', outbox.length === 0);
  }

  /* ── Reset ─────────────────────────────────────────────────────────────── */
  console.log('reset password');
  {
    outbox.length = 0;
    await api('POST', '/api/auth/forgot', { body: { email: 'ada@example.com' } });
    const token = lastLinkToken('/reset-password');
    ok('a reset link was mailed', !!token);

    let r = await api('POST', '/api/auth/reset', { body: { token, newPassword: 'short' } });
    ok('a too-short password → 400', r.status === 400);

    r = await api('POST', '/api/auth/reset', { body: { token, newPassword: 'brand-new-password' } });
    ok('reset succeeds', r.status === 200, `got ${r.status} ${r.text}`);
    ok('…and signs the user straight in', typeof r.json.token === 'string');

    r = await api('POST', '/api/auth/login', {
      body: { email: 'ada@example.com', password: 'brand-new-password' },
    });
    ok('the new password works', r.status === 200);

    r = await api('POST', '/api/auth/login', {
      body: { email: 'ada@example.com', password: 'correct-horse' },
    });
    ok('the old password does not', r.status === 401);

    r = await api('POST', '/api/auth/reset', { body: { token, newPassword: 'third-password' } });
    ok('the reset link cannot be replayed', r.status === 400);
    ok('…with one message for invalid/used/expired', r.json.code === 'invalid_token');
  }

  /* ── Issuing a new link voids the old one ──────────────────────────────── */
  console.log('token supersession');
  {
    outbox.length = 0;
    await api('POST', '/api/auth/forgot', { body: { email: 'ada@example.com' } });
    const first = lastLinkToken('/reset-password');
    await api('POST', '/api/auth/forgot', { body: { email: 'ada@example.com' } });
    const second = lastLinkToken('/reset-password');
    ok('two different tokens were issued', first && second && first !== second);

    let r = await api('POST', '/api/auth/reset', { body: { token: first, newPassword: 'from-old-link' } });
    // A user who requests twice expects the newest mail to be the live one.
    ok('the FIRST link is dead once a second is requested', r.status === 400, `got ${r.status}`);

    r = await api('POST', '/api/auth/reset', { body: { token: second, newPassword: 'from-new-link' } });
    ok('the newest link works', r.status === 200, `got ${r.status}`);
  }

  /* ── Expiry ────────────────────────────────────────────────────────────── */
  console.log('expiry');
  {
    const ada = await users.findByEmail('ada@example.com');
    const token = await authToken.issue({
      userId: ada.id, kind: authToken.KIND_PASSWORD_RESET, ttlMinutes: 60,
    });
    // Backdate rather than sleep — the rule under test is the comparison, and
    // a test that waits an hour is a test nobody runs.
    await db.run(
      'UPDATE auth_tokens SET expires_at = ? WHERE token_hash = ?',
      [new Date(Date.now() - 1000).toISOString(), authToken.hash(token)]);

    const r = await api('POST', '/api/auth/reset', { body: { token, newPassword: 'too-late-now' } });
    ok('an expired reset link is refused', r.status === 400);

    const verifyToken = await authToken.issue({
      userId: ada.id, kind: authToken.KIND_EMAIL_VERIFY,
      email: 'ada@example.com', ttlMinutes: 60,
    });
    await db.run(
      'UPDATE auth_tokens SET expires_at = ? WHERE token_hash = ?',
      [new Date(Date.now() - 1000).toISOString(), authToken.hash(verifyToken)]);

    const v = await api('POST', '/api/auth/verify-email', { body: { token: verifyToken } });
    ok('an expired confirmation link is refused', v.status === 400);
    // Safe to distinguish here — this token guards nothing, and "expired,
    // here's a new one" beats a flat "invalid".
    ok('…and says so, unlike the reset flow', v.json.code === 'expired');
  }

  /* ── A token is bound to the address it was issued for ─────────────────── */
  console.log('verification is bound to one address');
  {
    const r0 = await api('POST', '/api/auth/register', {
      body: { email: 'mover@old.test', password: 'correct-horse' },
    });
    const jwt = r0.json.token;
    await new Promise((res) => setTimeout(res, 120));
    const staleToken = lastLinkToken('/verify-email');
    ok('a confirmation link was issued for the old address', !!staleToken);

    // They change address before clicking.
    const changed = await api('PUT', '/api/auth/email', {
      token: jwt, body: { email: 'mover@new.test' },
    });
    ok('the address can be changed', changed.status === 200);
    ok('…and reverts to unverified', changed.json.user.emailVerified === false);

    const r = await api('POST', '/api/auth/verify-email', { body: { token: staleToken } });
    // Without the pinned address this would mark mover@new.test verified on
    // the strength of a link proving control of mover@old.test.
    ok('the stale link cannot verify the NEW address', r.status !== 200, `got ${r.status}`);

    const mover = await users.findByEmail('mover@new.test');
    ok('…and the account is still unverified', !mover.email_verified);
  }

  /* ── Resend cooldown ───────────────────────────────────────────────────── */
  console.log('resend cooldown');
  {
    const r0 = await api('POST', '/api/auth/register', {
      body: { email: 'spam@example.com', password: 'correct-horse' },
    });
    const jwt = r0.json.token;
    await new Promise((res) => setTimeout(res, 120));

    let r = await api('POST', '/api/auth/verify-email/resend', { token: jwt });
    // The signup mail was just sent, so an immediate resend is inside the
    // window — the button must not be a way to make this server mail an
    // address on demand.
    ok('an immediate resend is refused', r.status === 429, `got ${r.status}`);
    ok('…with a Retry-After header', !!r.headers.get('retry-after'));

    r = await api('POST', '/api/auth/verify-email/resend');
    ok('resend requires a session', r.status === 401);
  }

  /* ── Suspended accounts ────────────────────────────────────────────────── */
  console.log('suspended accounts');
  {
    outbox.length = 0;
    const r0 = await api('POST', '/api/auth/register', {
      body: { email: 'banned@example.com', password: 'correct-horse' },
    });
    const banned = await users.findByEmail('banned@example.com');
    await db.run(`UPDATE users SET status = 'suspended' WHERE id = ?`, [banned.id]);
    await new Promise((res) => setTimeout(res, 120));
    outbox.length = 0;

    const r = await api('POST', '/api/auth/forgot', { body: { email: 'banned@example.com' } });
    ok('still answers 200', r.status === 200);
    ok('no reset mail for a suspended account', outbox.length === 0);
    void r0;
  }

  /* ── Housekeeping ──────────────────────────────────────────────────────── */
  console.log('pruning');
  {
    const ada = await users.findByEmail('ada@example.com');
    const t = await authToken.issue({
      userId: ada.id, kind: authToken.KIND_PASSWORD_RESET, ttlMinutes: 60,
    });
    await db.run(
      'UPDATE auth_tokens SET expires_at = ? WHERE token_hash = ?',
      [new Date(Date.now() - 30 * 86400000).toISOString(), authToken.hash(t)]);

    const removed = await authTokens.pruneExpired(7);
    ok('long-expired tokens are pruned', removed >= 1, `removed=${removed}`);
    ok('…and are gone', !(await authTokens.findByHash(authToken.hash(t))));
  }

  console.log(`\nAll ${passed} checks passed ✅`);
  server.close();
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
