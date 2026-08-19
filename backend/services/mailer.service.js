'use strict';

const nodemailer = require('nodemailer');

/* ===========================================================================
   mailer
   ---------------------------------------------------------------------------
   One instance-wide SMTP account, configured by environment, mirroring how
   Google Sheets delivery uses one instance service account. Nothing per-user
   is stored beyond the address to send to.

     SMTP_HOST      required to enable e-mail at all
     SMTP_PORT      default 587
     SMTP_SECURE    "true" for implicit TLS (port 465); otherwise STARTTLS
     SMTP_USER      optional — omit for a relay that doesn't authenticate
     SMTP_PASS
     MAIL_FROM      required in practice — see the note on the fallback below
     MAIL_FROM_AUTH optional; sender for account & security mail

   ── Two message streams ───────────────────────────────────────────────────
   One SMTP account, but not necessarily one From address. Mail here splits
   into two kinds with genuinely different stakes:

     'alerts' (default) — run failures and change notices. Automated, frequent,
                          and the kind of thing people eventually mute.
     'auth'             — address confirmation and password reset. Rare, and it
                          absolutely has to arrive: a reset mail in the spam
                          folder is an account someone cannot get back into.

   Sending both as one address pools their reputation, so a run of alerts
   getting marked as spam degrades delivery of the reset mail too. Set
   MAIL_FROM_AUTH to separate them; leave it unset and both use MAIL_FROM,
   which is what every existing deployment already does.

   Callers name the STREAM rather than passing a raw From, deliberately. An
   arbitrary address would be free to sit on a domain this account has no DKIM
   signature for, which silently fails alignment and lands the mail in spam —
   exactly the failure this split exists to avoid.

   Configuration is read lazily and cached: the transport is built on first
   send, so an instance with no SMTP set up pays nothing and simply reports
   itself as unconfigured.
   ========================================================================= */

let cached = null;          // the nodemailer transport, once built
let cachedKey = null;       // connection fingerprint, so env changes rebuild

function config() {
  const host = (process.env.SMTP_HOST || '').trim();
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;
  const user = (process.env.SMTP_USER || '').trim();
  const pass = process.env.SMTP_PASS || '';
  // The fallback is a last resort for a relay whose username happens to be an
  // address. It is NOT viable on a provider whose SMTP username is a fixed
  // literal (Resend's is "resend"), which yields an invalid From and a
  // rejected send — hence "required in practice" in the .env notes.
  const from = (process.env.MAIL_FROM || '').trim() || (user ? `Scrapient <${user}>` : 'Scrapient <no-reply@localhost>');
  return { host, port, secure, user, pass, from };
}

/** Whether this instance can send mail at all. The UI asks before offering
    the toggles, so a user is never invited to enable something that will
    silently do nothing. */
function isConfigured() {
  return config() !== null;
}

/** The From for a given message stream. 'auth' falls back to MAIL_FROM when
    MAIL_FROM_AUTH is unset, so splitting the streams stays entirely opt-in. */
function fromFor(kind) {
  const cfg = config();
  if (!cfg) return null;
  if (kind === 'auth') {
    const authFrom = (process.env.MAIL_FROM_AUTH || '').trim();
    if (authFrom) return authFrom;
  }
  return cfg.from;
}

/* Only the CONNECTION is cached. From is resolved per message now that it
   varies by stream, so it is deliberately absent from the fingerprint. */
function transport() {
  const cfg = config();
  if (!cfg) return null;
  const key = `${cfg.host}|${cfg.port}|${cfg.secure}|${cfg.user}`;
  if (cached && cachedKey === key) return cached;
  cached = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.pass } } : {}),
  });
  cachedKey = key;
  return cached;
}

/**
 * Send one message. Never throws — callers are fire-and-forget paths hanging
 * off a finished run, and a mail server having a bad day must not fail a
 * scrape that already succeeded.
 *
 * @param {'alerts'|'auth'} [kind] which message stream this belongs to; picks
 *        the From address. Defaults to 'alerts' — the higher-volume, lower-
 *        stakes stream, so a caller that forgets cannot accidentally borrow
 *        the reputation of the address reset mail depends on.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function send({ to, subject, text, html, kind }) {
  const t = transport();
  if (!t) return { ok: false, error: 'E-mail is not configured on this server (SMTP_HOST is unset).' };
  if (!to) return { ok: false, error: 'No recipient address.' };
  try {
    await t.sendMail({ from: fromFor(kind), to, subject, text, html });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : 'Send failed' };
  }
}

/** Verify the SMTP connection — used by the "send a test" button so a user
    can find out their settings are wrong before relying on them. */
async function verify() {
  const t = transport();
  if (!t) return { ok: false, error: 'E-mail is not configured on this server (SMTP_HOST is unset).' };
  try {
    await t.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : 'Could not reach the mail server' };
  }
}

// Test hook: drop the memoised transport so a changed env is picked up.
function _reset() { cached = null; cachedKey = null; }

module.exports = { isConfigured, send, verify, fromFor, _reset };
