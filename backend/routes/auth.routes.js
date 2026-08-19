'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const users = require('../db/repositories/users.repo');
const oauthAccounts = require('../db/repositories/oauthAccounts.repo');
const entitlements = require('../services/entitlements.service');
const authToken = require('../services/authToken.service');
const mailer = require('../services/mailer.service');
const oauth = require('../services/oauth.service');
const oauthRoutes = require('./oauth.routes');
const { signToken, requireAuth } = require('../middleware/auth');
const { authRateLimit, creditSuccess } = require('../middleware/authRateLimit');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
// Deliberately permissive. Strict RFC 5322 validation rejects addresses that
// genuinely work, and the only real proof an address exists is sending to it.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

/* ── OAuth sub-router ───────────────────────────────────────────────────────
   Mounted before the /:param-free routes below so /api/auth/oauth/* resolves
   to the provider flow rather than falling through. */
router.use('/oauth', oauthRoutes);

// Registration can be closed once the owner's account exists (ALLOW_REGISTRATION=false),
// so a LAN-reachable instance can't have new accounts minted against it.
function registrationAllowed() {
  return String(process.env.ALLOW_REGISTRATION || 'true').toLowerCase() !== 'false';
}

/* Sign-in identity is the EMAIL for anything created since plans landed.
   `username` survives as the display handle, and as the login identifier for
   accounts that predate the email column — those rows have email NULL and
   would otherwise be locked out by an email-only login. Both are accepted;
   which one was supplied is inferred from the '@'. */
function looksLikeEmail(v) {
  return typeof v === 'string' && v.includes('@');
}

/* The shape returned to the client on sign-in and from /me. Carries the plan
   so the UI can gate its own affordances (hide the schedule button on free)
   without a second request — the server enforces regardless, this is only so
   the interface doesn't offer things that will 402. */
async function sessionUser(userId) {
  const row = await users.findById(userId);
  const ent = await entitlements.getForUser(userId, { fresh: true });
  const linked = await oauthAccounts.listForUser(userId);
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    emailVerified: !!row.email_verified,
    isAdmin: !!row.is_admin,
    status: row.status,
    // Drives the account screen: an OAuth-only user is offered "set a
    // password", an existing one "change password".
    hasPassword: await users.hasPassword(userId),
    linkedProviders: linked.map((l) => l.provider),
    plan: {
      slug: ent.plan,
      name: ent.planName,
      status: ent.planStatus,
      effective: ent.effectivePlan,
      lapsed: ent.lapsed,
      features: ent.features,
      limits: ent.limits,
    },
  };
}

/* ── Register ───────────────────────────────────────────────────────────── */
router.post('/register', authRateLimit, async (req, res) => {
  if (!registrationAllowed()) {
    return res.status(403).json({ error: 'Registration is disabled on this instance.' });
  }

  const { email, password } = req.body || {};
  // `username` is optional now — derived from the email when omitted, so the
  // signup form is two fields instead of three.
  let username = req.body && req.body.username;

  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'Enter a valid e-mail address.' });
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
  }

  const normalisedEmail = users.normaliseEmail(email);

  if (username == null || username === '') {
    username = normalisedEmail.split('@')[0].replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 24);
    if (username.length < 3) username = `user${Date.now().toString(36).slice(-6)}`;
    // Collision is possible when two people share a local part across
    // different domains (alice@a.com / alice@b.com).
    let attempt = 0;
    while (await users.existsByUsername(username) && attempt < 20) {
      username = `${username.slice(0, 24)}${Math.floor(1000 + Math.random() * 9000)}`;
      attempt++;
    }
  } else if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 chars (letters, digits, _ . -)' });
  } else if (await users.existsByUsername(username)) {
    return res.status(409).json({ error: 'That username is taken.' });
  }

  if (await users.existsByEmail(normalisedEmail)) {
    // Deliberately explicit rather than a vague "could not register".
    // Registration already discloses whether an address exists (there is no
    // way to let someone sign up while hiding it), so an unhelpful message
    // buys no privacy and just strands the user.
    return res.status(409).json({
      error: 'An account with that e-mail already exists. Try signing in instead.',
    });
  }

  const hash = await bcrypt.hash(password, 10);
  const userId = await users.create({ username, passwordHash: hash, email: normalisedEmail });
  await users.touchLastLogin(userId);
  creditSuccess(req);

  // Verification is sent but NOT awaited as a precondition of signing up.
  // Blocking registration on an SMTP round-trip makes the slowest, least
  // reliable dependency in the stack decide whether someone can create an
  // account. They're signed in either way; the banner in the app nudges them
  // to confirm, and confirming is what unlocks alerts and password reset.
  sendVerificationSafely({ req, userId, email: normalisedEmail, username });

  const token = signToken({ sub: userId, username });
  res.status(201).json({ token, user: await sessionUser(userId) });
});

// Never lets a mail failure surface as a request failure — see the call site.
function sendVerificationSafely({ req, userId, email, username }) {
  if (!mailer.isConfigured()) return;
  authToken.sendVerification({ userId, email, username, appUrl: oauth.appBaseUrl(req) })
    .catch((err) => console.error('[auth] verification mail failed:', err.message));
}

/* ── Log in ─────────────────────────────────────────────────────────────── */
router.post('/login', authRateLimit, async (req, res) => {
  const { password } = req.body || {};
  // Accept either field name: the new UI sends `email`, older clients (and
  // the pre-plans accounts that have no email) send `username`.
  const identifier = (req.body && (req.body.email || req.body.username)) || '';

  if (typeof identifier !== 'string' || !identifier || typeof password !== 'string') {
    return res.status(400).json({ error: 'E-mail and password are required.' });
  }

  const row = looksLikeEmail(identifier)
    ? await users.findByEmail(identifier)
    : await users.findByUsername(identifier);

  if (!row) {
    // Uniform message and status for "no such account" and "wrong password",
    // so login cannot be used to enumerate which addresses are registered.
    return res.status(401).json({ error: 'Invalid e-mail or password.' });
  }

  // An OAuth-only account has a sentinel hash that bcrypt can never match, so
  // this is a usability guard rather than a security one: without it the user
  // is told their password is wrong when they simply never had one.
  if (users.isOAuthOnly(row)) {
    const linked = await oauthAccounts.listForUser(row.id);
    const names = linked.map((l) => (l.provider === 'github' ? 'GitHub' : 'Google'));
    return res.status(409).json({
      error: names.length
        ? `This account signs in with ${names.join(' or ')}. Use that button instead.`
        : 'This account has no password set.',
      code: 'use_oauth',
      providers: linked.map((l) => l.provider),
    });
  }

  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid e-mail or password.' });

  // Checked after the password so a wrong guess against a suspended account
  // doesn't reveal that the account exists.
  if (row.status === 'suspended') {
    return res.status(403).json({
      error: 'This account is suspended. Contact support@scrapient.app.',
      code: 'account_suspended',
    });
  }

  await users.touchLastLogin(row.id);
  creditSuccess(req);

  const token = signToken({ sub: row.id, username: row.username });
  res.json({ token, user: await sessionUser(row.id) });
});

/* ── Current session ────────────────────────────────────────────────────── */
router.get('/me', requireAuth, async (req, res) => {
  const row = await users.findById(req.user.id);
  if (!row) return res.status(401).json({ error: 'Account no longer exists' });
  // A suspension takes effect on the next request rather than waiting for the
  // 7-day token to expire.
  if (row.status === 'suspended') {
    return res.status(403).json({
      error: 'This account is suspended. Contact support@scrapient.app.',
      code: 'account_suspended',
    });
  }
  res.json({ user: await sessionUser(req.user.id) });
});

/* ── Set or change a password ───────────────────────────────────────────────
   Doubles as "add a password to my OAuth account", which is what makes it
   possible to unlink a provider later without being locked out. An account
   with no password may set one without proving the old one — there is
   nothing to prove, and the bearer token is already proof of control. */
router.put('/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD || newPassword.length > MAX_PASSWORD) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
  }

  // Looked up by id, not by the username carried in the token: a username can
  // change, and a stale one in a 7-day token would resolve to the wrong row.
  const currentHash = await users.getPasswordHash(req.user.id);
  if (currentHash === null) return res.status(401).json({ error: 'Account no longer exists' });

  if (!users.isOAuthOnly({ password_hash: currentHash })) {
    if (typeof currentPassword !== 'string' || !currentPassword) {
      return res.status(400).json({ error: 'Enter your current password.' });
    }
    const ok = await bcrypt.compare(currentPassword, currentHash);
    if (!ok) return res.status(403).json({ error: 'Current password is incorrect.' });
  }

  await users.setPasswordHash(req.user.id, await bcrypt.hash(newPassword, 10));
  res.json({ ok: true });
});

/* ── Forgot password ────────────────────────────────────────────────────────
   Always answers 200 with the same body, whether or not the address exists,
   whether or not the account is OAuth-only, and whether or not the mail
   actually sent. Any variation here — a different status, a different
   message, even a noticeably different response time — turns this endpoint
   into an oracle for "is this person a customer?", which is exactly the
   enumeration that login is careful to prevent.

   The one honest exception is SMTP being unconfigured: that is an operator
   problem, not a user secret, and silently pretending to send a mail that can
   never arrive leaves the user waiting forever. */
router.post('/forgot', authRateLimit, async (req, res) => {
  const email = (req.body && req.body.email) || '';

  if (!mailer.isConfigured()) {
    return res.status(503).json({
      error: "Password reset isn't available on this server because e-mail hasn't been set up. Contact support@scrapient.app.",
      code: 'email_not_configured',
    });
  }

  const ALWAYS = {
    ok: true,
    message: 'If that address has an account with a password, a reset link is on its way.',
  };

  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    // Even a malformed address gets the uniform answer — a 400 here would
    // tell a prober that everything else they submitted was well-formed.
    return res.json(ALWAYS);
  }

  try {
    const outcome = await authToken.sendPasswordReset({
      email, appUrl: oauth.appBaseUrl(req),
    });
    // Logged server-side only. This is the detail the response deliberately
    // withholds, and the operator genuinely needs it to answer "I never got
    // the mail" tickets.
    if (!outcome.sent) console.log(`[auth] reset not sent for ${email}: ${outcome.why}`);
  } catch (err) {
    console.error('[auth] reset failed:', err);
  }

  res.json(ALWAYS);
});

/* ── Reset password ─────────────────────────────────────────────────────── */
router.post('/reset', authRateLimit, async (req, res) => {
  const { token, newPassword } = req.body || {};

  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD || newPassword.length > MAX_PASSWORD) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
  }

  const result = await authToken.consume({ token, kind: authToken.KIND_PASSWORD_RESET });
  if (!result.ok) {
    // One message for invalid / used / expired. Distinguishing them would
    // tell someone holding a leaked mailbox whether the reset was already
    // completed — i.e. whether the account has been taken over.
    return res.status(400).json({
      error: 'This reset link is no longer valid. Request a new one.',
      code: 'invalid_token',
    });
  }

  const user = await users.findById(result.userId);
  if (!user) return res.status(400).json({ error: 'This reset link is no longer valid.' });
  if (user.status === 'suspended') {
    return res.status(403).json({
      error: 'This account is suspended. Contact support@scrapient.app.',
      code: 'account_suspended',
    });
  }

  await users.setPasswordHash(user.id, await bcrypt.hash(newPassword, 10));

  /* Completing a reset proves control of the mailbox, so the address is now
     verified — the user just demonstrated exactly what the verification mail
     asks for, and asking again would be busywork. */
  if (!user.email_verified && user.email) {
    await users.setEmail(user.id, user.email, true);
  }

  // Sign them straight in. Making someone who has just proved mailbox control
  // and chosen a password then type that password again is friction with no
  // security benefit.
  creditSuccess(req);
  await users.touchLastLogin(user.id);
  const jwt = signToken({ sub: user.id, username: user.username });
  res.json({ token: jwt, user: await sessionUser(user.id) });
});

/* ── Verify e-mail ──────────────────────────────────────────────────────────
   Unauthenticated: the link is clicked from a mail client, which may not be
   the browser holding the session — and requiring a login first would make
   confirming an address harder than it needs to be. The token is the proof. */
router.post('/verify-email', authRateLimit, async (req, res) => {
  const { token } = req.body || {};

  const result = await authToken.consume({ token, kind: authToken.KIND_EMAIL_VERIFY });
  if (!result.ok) {
    // Unlike password reset, the distinctions are safe to show here — this
    // token guards nothing, and "expired, here's a new one" is far more
    // useful than a flat "invalid".
    const message = result.reason === 'expired'
      ? 'This confirmation link has expired. Sign in and we\'ll send you a new one.'
      : result.reason === 'used'
        ? 'This address is already confirmed — nothing more to do.'
        : 'This confirmation link isn\'t valid. Sign in and we\'ll send you a new one.';
    return res.status(400).json({ error: message, code: result.reason });
  }

  const user = await users.findById(result.userId);
  if (!user) return res.status(400).json({ error: 'That account no longer exists.' });

  /* The token pins the address it was issued for. If the account has since
     moved to a different e-mail, this link proves control of the OLD one and
     must not mark the NEW one verified — otherwise changing your address and
     clicking a stale link would "verify" an address nobody has proved. */
  if (result.email && users.normaliseEmail(user.email || '') !== result.email) {
    return res.status(409).json({
      error: 'Your account uses a different e-mail address now. Sign in and confirm the current one.',
      code: 'email_changed',
    });
  }

  await users.setEmail(user.id, user.email, true);
  res.json({ ok: true, email: user.email });
});

/* ── Resend the verification mail ───────────────────────────────────────── */
router.post('/verify-email/resend', requireAuth, async (req, res) => {
  const user = await users.findById(req.user.id);
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });
  if (!user.email) return res.status(400).json({ error: 'Add an e-mail address first.' });
  if (user.email_verified) return res.json({ ok: true, alreadyVerified: true });

  if (!mailer.isConfigured()) {
    return res.status(503).json({
      error: "E-mail isn't set up on this server, so confirmation can't be sent.",
      code: 'email_not_configured',
    });
  }

  // Stops the button becoming a way to make this server mail an address
  // repeatedly on demand.
  const wait = await authToken.verificationCooldown(req.user.id);
  if (wait > 0) {
    res.setHeader('Retry-After', String(wait));
    return res.status(429).json({
      error: `Just sent one — check your inbox, or try again in ${wait}s.`,
      code: 'cooldown', retryAfter: wait,
    });
  }

  const outcome = await authToken.sendVerification({
    userId: user.id, email: user.email, username: user.username,
    appUrl: oauth.appBaseUrl(req),
  });
  if (!outcome.sent) {
    console.error('[auth] resend failed:', outcome.why);
    return res.status(502).json({ error: 'Could not send the e-mail just now. Try again shortly.' });
  }
  res.json({ ok: true });
});

/* ── Set an e-mail on an account that has none ──────────────────────────────
   Needed by accounts created before the email column existed, and by OAuth
   accounts whose provider returned no verified address. Stored unverified:
   nothing here proves the user controls it, so it must not be usable for
   account linking until a verification mail confirms it. */
router.put('/email', requireAuth, async (req, res) => {
  const { email } = req.body || {};
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'Enter a valid e-mail address.' });
  }
  const normalised = users.normaliseEmail(email);

  const existing = await users.findByEmail(normalised);
  if (existing && existing.id !== req.user.id) {
    return res.status(409).json({ error: 'That e-mail is already used by another account.' });
  }

  await users.setEmail(req.user.id, normalised, false);

  /* Any outstanding verification is for the PREVIOUS address and must not be
     able to mark this one verified. authToken.issue voids earlier tokens of
     the same kind, so sending a fresh one both invalidates the stale link and
     starts confirmation of the new address in a single step. */
  const me = await users.findById(req.user.id);
  sendVerificationSafely({ req, userId: me.id, email: normalised, username: me.username });

  res.json({
    ok: true,
    user: await sessionUser(req.user.id),
    verificationSent: mailer.isConfigured(),
  });
});

module.exports = router;
