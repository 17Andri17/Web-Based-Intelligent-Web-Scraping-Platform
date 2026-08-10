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
     MAIL_FROM      default "WebScraper <SMTP_USER>"

   Configuration is read lazily and cached: the transport is built on first
   send, so an instance with no SMTP set up pays nothing and simply reports
   itself as unconfigured.
   ========================================================================= */

let cached = null;          // { transport, from } once built
let cachedKey = null;       // config fingerprint, so env changes rebuild

function config() {
  const host = (process.env.SMTP_HOST || '').trim();
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;
  const user = (process.env.SMTP_USER || '').trim();
  const pass = process.env.SMTP_PASS || '';
  const from = (process.env.MAIL_FROM || '').trim() || (user ? `WebScraper <${user}>` : 'WebScraper <no-reply@localhost>');
  return { host, port, secure, user, pass, from };
}

/** Whether this instance can send mail at all. The UI asks before offering
    the toggles, so a user is never invited to enable something that will
    silently do nothing. */
function isConfigured() {
  return config() !== null;
}

function transport() {
  const cfg = config();
  if (!cfg) return null;
  const key = `${cfg.host}|${cfg.port}|${cfg.secure}|${cfg.user}|${cfg.from}`;
  if (cached && cachedKey === key) return cached;
  cached = {
    transport: nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.pass } } : {}),
    }),
    from: cfg.from,
  };
  cachedKey = key;
  return cached;
}

/**
 * Send one message. Never throws — callers are fire-and-forget paths hanging
 * off a finished run, and a mail server having a bad day must not fail a
 * scrape that already succeeded.
 *
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function send({ to, subject, text, html }) {
  const t = transport();
  if (!t) return { ok: false, error: 'E-mail is not configured on this server (SMTP_HOST is unset).' };
  if (!to) return { ok: false, error: 'No recipient address.' };
  try {
    await t.transport.sendMail({ from: t.from, to, subject, text, html });
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
    await t.transport.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : 'Could not reach the mail server' };
  }
}

// Test hook: drop the memoised transport so a changed env is picked up.
function _reset() { cached = null; cachedKey = null; }

module.exports = { isConfigured, send, verify, _reset };
