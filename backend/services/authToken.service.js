'use strict';

const crypto = require('crypto');
const tokens = require('../db/repositories/authTokens.repo');
const users = require('../db/repositories/users.repo');
const mailer = require('./mailer.service');
const { parseUtc } = require('../utils/time');

/* ===========================================================================
   authToken.service
   ---------------------------------------------------------------------------
   Issue, mail and consume the single-use tokens behind password reset and
   e-mail verification.

   Both flows share every rule that matters — 32 bytes of CSPRNG, stored as a
   SHA-256 hash, valid once, expiring, superseding any earlier token of the
   same kind — so they share one implementation. Only what happens on a
   successful consume differs, and that stays in the routes.

   ── What the caller gets back ─────────────────────────────────────────────
   consume() returns a discriminated result rather than throwing, because
   every failure mode here is an expected user situation (stale link, already
   clicked, expired) rather than an exception. Callers must not report the
   distinctions blindly, though — see the note on `reason` below.
   ========================================================================= */

const RESET_TTL_MIN  = Number(process.env.PASSWORD_RESET_TTL_MIN || 60);
const VERIFY_TTL_MIN = Number(process.env.EMAIL_VERIFY_TTL_MIN || 60 * 24); // a day
// A verification mail is a courtesy, not a rate-limited credential, but
// resending must not be a free way to send mail to arbitrary addresses.
const RESEND_COOLDOWN_SEC = Number(process.env.EMAIL_RESEND_COOLDOWN_SEC || 60);

function hash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newToken() {
  // base64url so it survives being pasted into a URL without escaping. 32
  // bytes ≈ 256 bits: not guessable, and short enough not to wrap in a mail
  // client and get truncated on click.
  return crypto.randomBytes(32).toString('base64url');
}

function expiryIso(minutes) {
  return new Date(Date.now() + minutes * 60000).toISOString();
}

/**
 * Mint a token, void any earlier one of the same kind, and return the
 * PLAINTEXT. The plaintext exists only in this return value and the e-mail
 * built from it — never in the database and never in a log.
 */
async function issue({ userId, kind, email = null, ttlMinutes }) {
  await tokens.invalidateForUser(userId, kind);
  const token = newToken();
  await tokens.create({
    userId, kind, tokenHash: hash(token), email,
    expiresAt: expiryIso(ttlMinutes),
  });
  return token;
}

/**
 * Validate and burn a token.
 *
 * `reason` distinguishes not-found / expired / already-used because the
 * VERIFICATION flow can safely show the difference — "this link has expired,
 * here's a new one" is genuinely more useful than "invalid link", and the
 * token is not a credential that guards an existing session.
 *
 * The PASSWORD RESET route deliberately collapses them all into one message.
 * Distinguishing "already used" from "never existed" there tells an attacker
 * holding a leaked mailbox whether a reset was already completed.
 */
async function consume({ token, kind }) {
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'invalid' };

  const row = await tokens.findByHash(hash(token));
  if (!row || row.kind !== kind) return { ok: false, reason: 'invalid' };
  if (row.used_at) return { ok: false, reason: 'used' };
  if (Date.parse(row.expires_at) <= Date.now()) return { ok: false, reason: 'expired' };

  // Atomic: the UPDATE is guarded on used_at IS NULL, so of two concurrent
  // submissions exactly one wins. Checking used_at above and marking it here
  // without the guard would let a double-click through.
  if (!(await tokens.markUsed(row.id))) return { ok: false, reason: 'used' };

  return { ok: true, userId: row.user_id, email: row.email };
}

/* ── Password reset ─────────────────────────────────────────────────────── */

/**
 * Send a reset link if — and only if — the address belongs to an account that
 * can actually use one. Returns a plain summary for logging; the ROUTE must
 * answer identically whatever this returns, so that the response never
 * discloses whether an address is registered.
 */
async function sendPasswordReset({ email, appUrl }) {
  const user = await users.findByEmail(email);
  if (!user) return { sent: false, why: 'no_such_account' };

  // An OAuth-only account has no password to reset. Mailing "here's your
  // reset link" would be actively misleading, and setting a password this way
  // would hand anyone with mailbox access a second way in that the account
  // owner never chose to have.
  if (users.isOAuthOnly(user)) return { sent: false, why: 'oauth_only' };
  if (user.status === 'suspended') return { sent: false, why: 'suspended' };

  const token = await issue({
    userId: user.id,
    kind: tokens.KIND_PASSWORD_RESET,
    ttlMinutes: RESET_TTL_MIN,
  });

  const link = `${appUrl}/reset-password?token=${encodeURIComponent(token)}`;
  const result = await mailer.send({
    // Security mail, not an alert: goes out as MAIL_FROM_AUTH where the
    // operator has separated the streams. See mailer.service.
    kind: 'auth',
    to: user.email,
    subject: 'Reset your Scrapient password',
    text: [
      `Someone asked to reset the password for your Scrapient account (${user.username}).`,
      '',
      'Open this link to choose a new one:',
      link,
      '',
      `The link works once and expires in ${RESET_TTL_MIN} minutes.`,
      '',
      "If this wasn't you, you can ignore this e-mail — your password hasn't changed.",
    ].join('\n'),
    html: emailShell({
      heading: 'Reset your password',
      body: `<p>Someone asked to reset the password for your Scrapient account (<strong>${escapeHtml(user.username)}</strong>).</p>`,
      ctaLabel: 'Choose a new password',
      ctaHref: link,
      footer: `The link works once and expires in ${RESET_TTL_MIN} minutes. If this wasn't you, ignore this e-mail — your password hasn't changed.`,
    }),
  });

  return { sent: !!result.ok, why: result.ok ? 'sent' : result.error };
}

/* ── E-mail verification ────────────────────────────────────────────────── */

async function sendVerification({ userId, email, username, appUrl }) {
  const token = await issue({
    userId,
    kind: tokens.KIND_EMAIL_VERIFY,
    // Pinned so a later address change can't be verified by an older link.
    email: users.normaliseEmail(email),
    ttlMinutes: VERIFY_TTL_MIN,
  });

  const link = `${appUrl}/verify-email?token=${encodeURIComponent(token)}`;
  const result = await mailer.send({
    kind: 'auth',
    to: email,
    subject: 'Confirm your e-mail for Scrapient',
    text: [
      `Welcome to Scrapient${username ? `, ${username}` : ''}.`,
      '',
      'Confirm this address so we can send you run alerts and help you back in if you lose your password:',
      link,
      '',
      `The link expires in ${Math.round(VERIFY_TTL_MIN / 60)} hours.`,
      '',
      "If you didn't create a Scrapient account, ignore this e-mail.",
    ].join('\n'),
    html: emailShell({
      heading: 'Confirm your e-mail',
      body: `<p>Welcome to Scrapient${username ? `, <strong>${escapeHtml(username)}</strong>` : ''}.</p>
             <p>Confirming this address lets us send you alerts when a scraper breaks, and lets you reset your password if you lose it.</p>`,
      ctaLabel: 'Confirm e-mail',
      ctaHref: link,
      footer: `The link expires in ${Math.round(VERIFY_TTL_MIN / 60)} hours. If you didn't create a Scrapient account, ignore this e-mail.`,
    }),
  });

  return { sent: !!result.ok, why: result.ok ? 'sent' : result.error };
}

/**
 * Seconds remaining before another verification mail may be sent, or 0.
 * Prevents the resend button becoming a way to have this server repeatedly
 * mail an address on demand.
 */
async function verificationCooldown(userId) {
  const last = await tokens.lastIssuedAt(userId, tokens.KIND_EMAIL_VERIFY);
  if (!last) return 0;
  const elapsed = (Date.now() - parseUtc(last)) / 1000;
  if (!Number.isFinite(elapsed)) return 0;
  return Math.max(0, Math.ceil(RESEND_COOLDOWN_SEC - elapsed));
}

/* Stored timestamps are parsed as UTC via utils/time — authTokens.repo writes
   ISO-8601 with a 'Z', but the column default is SQLite's CURRENT_TIMESTAMP,
   which yields "YYYY-MM-DD HH:MM:SS" with no marker saying it is UTC. That
   distinction silently defeated this file's resend cooldown once; the helper
   is shared so there is one implementation of it, not one per caller. */

/* ── Mail presentation ──────────────────────────────────────────────────── */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* Table-based, inline-styled, no external assets — the three things every
   mail client still demands in 2026. The raw URL is repeated under the button
   because a meaningful share of clients strip or fail to render it. */
function emailShell({ heading, body, ctaLabel, ctaHref, footer }) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f6f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f5;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e0e5e2;border-radius:8px;">
        <tr><td style="padding:28px 32px 8px;font-family:Georgia,serif;font-size:15px;color:#14675a;font-weight:bold;">Scrapient</td></tr>
        <tr><td style="padding:0 32px;font-family:Georgia,serif;font-size:22px;line-height:1.3;color:#141d1b;">${escapeHtml(heading)}</td></tr>
        <tr><td style="padding:12px 32px 0;font-family:system-ui,-apple-system,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.6;color:#3d4a47;">${body}</td></tr>
        <tr><td style="padding:24px 32px 8px;">
          <a href="${ctaHref}" style="display:inline-block;background:#14675a;color:#ffffff;text-decoration:none;font-family:system-ui,-apple-system,'Segoe UI',Arial,sans-serif;font-size:15px;font-weight:600;padding:12px 22px;border-radius:6px;">${escapeHtml(ctaLabel)}</a>
        </td></tr>
        <tr><td style="padding:8px 32px 0;font-family:system-ui,Arial,sans-serif;font-size:12px;line-height:1.5;color:#67746f;word-break:break-all;">
          Or paste this into your browser:<br /><span style="color:#14675a;">${ctaHref}</span>
        </td></tr>
        <tr><td style="padding:20px 32px 28px;font-family:system-ui,Arial,sans-serif;font-size:12px;line-height:1.5;color:#67746f;border-top:1px solid #eef1ef;margin-top:16px;">${escapeHtml(footer)}</td></tr>
      </table>
      <div style="font-family:system-ui,Arial,sans-serif;font-size:11px;color:#8b968f;padding-top:14px;">Scrapient · scrapient.app</div>
    </td></tr>
  </table>
</body></html>`;
}

module.exports = {
  KIND_PASSWORD_RESET: tokens.KIND_PASSWORD_RESET,
  KIND_EMAIL_VERIFY: tokens.KIND_EMAIL_VERIFY,
  RESET_TTL_MIN,
  VERIFY_TTL_MIN,
  RESEND_COOLDOWN_SEC,
  issue,
  consume,
  sendPasswordReset,
  sendVerification,
  verificationCooldown,
  hash,
};
