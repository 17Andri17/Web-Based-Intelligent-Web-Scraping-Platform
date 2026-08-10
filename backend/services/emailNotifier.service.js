'use strict';

const mailer = require('./mailer.service');
const notificationsRepo = require('../db/repositories/notifications.repo');
const workflowsRepo = require('../db/repositories/workflows.repo');

/* ===========================================================================
   emailNotifier
   ---------------------------------------------------------------------------
   The e-mail half of run notifications, hung off the same two dispatch points
   as webhookDispatcher and driven by the same event names.

   Why this exists: change monitoring and failure alerts could only be
   delivered to a webhook URL, which is a thing a non-technical user cannot
   produce. The feature was built and then made unreachable by its own
   delivery mechanism.

   Deliberately NOT sent for successful runs — a scraper that works is not
   news, and mailing every success is how people learn to ignore the alerts
   that matter. See notifications.repo.activeForEvent.

   Fire-and-forget: every entry point swallows its own errors so a mail
   problem can never fail or delay a run that already finished.
   ========================================================================= */

const MAX_SAMPLE_ROWS = 5;

/* A run row carries workflow_id but not the workflow's name, and the name is
   the only part of the subject line a reader recognises. Resolved here rather
   than at each call site so the dispatch points stay one-liners — and only
   AFTER the opt-in check, so an instance with no e-mail configured does no
   extra queries at all. */
async function workflowNameFor(runRow) {
  const row = await safe(() => workflowsRepo.getForUser(runRow.workflow_id, runRow.user_id));
  return (row && row.name) || `Workflow #${runRow.workflow_id}`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function appUrl() {
  // Best-effort deep link. Without a public URL configured we simply omit the
  // link rather than printing a localhost address into someone's inbox.
  const base = (process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
  return base || null;
}

function layout(title, bodyHtml) {
  const url = appUrl();
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2328">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:24px">
    <h1 style="margin:0 0 14px;font-size:18px;font-weight:650">${esc(title)}</h1>
    ${bodyHtml}
    ${url ? `<p style="margin:22px 0 0"><a href="${esc(url)}" style="display:inline-block;padding:9px 16px;background:#0969da;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600">Open WebScraper</a></p>` : ''}
    <p style="margin:22px 0 0;font-size:12px;color:#656d76">
      You're getting this because e-mail alerts are switched on for your account.
      Turn them off under your name → Notifications.
    </p>
  </div>
</body></html>`;
}

/* ── run.failed ─────────────────────────────────────────────────────────── */

async function notifyRunFailed(runRow) {
  if (!runRow) return;
  // Only failures and needs-review runs are mailed; success is not news.
  if (runRow.status !== 'error' && runRow.status !== 'needs_review') return;
  if (!mailer.isConfigured()) return;
  const settings = await safe(() => notificationsRepo.activeForEvent(runRow.user_id, 'run.failed'));
  if (!settings) return;

  const name = await workflowNameFor(runRow);
  const needsReview = runRow.status === 'needs_review';
  const subject = needsReview
    ? `“${name}” needs a look`
    : `“${name}” failed`;

  // aiSummary is already the plain-language explanation the dashboard shows;
  // the raw error stays out of the e-mail body (it's one click away in the
  // run's logs, and it is not what the reader can act on).
  const summary = runRow.ai_summary || runRow.error_message || 'The run did not complete.';
  const rows = Number(runRow.rows_captured || 0);

  const text = [
    subject,
    '',
    summary,
    rows > 0 ? `\n${rows.toLocaleString()} row(s) captured before it stopped were saved.` : '',
    appUrl() ? `\nOpen WebScraper: ${appUrl()}` : '',
  ].filter(Boolean).join('\n');

  const html = layout(subject, `
    <p style="margin:0 0 12px;font-size:14px;line-height:1.55">${esc(summary)}</p>
    ${rows > 0 ? `<p style="margin:0;font-size:14px;line-height:1.55"><strong>${rows.toLocaleString()}</strong> row(s) captured before it stopped were saved.</p>` : ''}
  `);

  await deliver(runRow.user_id, settings, { subject, text, html });
}

/* ── run.changed ────────────────────────────────────────────────────────── */

async function notifyRunChanged(runRow, changeSummary) {
  if (!runRow || !changeSummary || changeSummary.baseline) return;
  const counts = changeSummary.counts || {};
  const added = Number(counts.added || 0);
  const removed = Number(counts.removed || 0);
  const changed = Number(counts.changed || 0);
  if (added + removed + changed === 0) return;   // nothing to report

  if (!mailer.isConfigured()) return;
  const settings = await safe(() => notificationsRepo.activeForEvent(runRow.user_id, 'run.changed'));
  if (!settings) return;

  const name = await workflowNameFor(runRow);
  const parts = [];
  if (added)   parts.push(`${added} new`);
  if (changed) parts.push(`${changed} changed`);
  if (removed) parts.push(`${removed} gone`);
  const subject = `“${name}”: ${parts.join(', ')}`;

  const sampleHtml = sampleRowsHtml(changeSummary);

  const text = [
    subject,
    '',
    `Since the previous run: ${parts.join(', ')}.`,
    appUrl() ? `\nOpen WebScraper: ${appUrl()}` : '',
  ].filter(Boolean).join('\n');

  const html = layout(subject, `
    <p style="margin:0 0 12px;font-size:14px;line-height:1.55">Since the previous run: <strong>${esc(parts.join(', '))}</strong>.</p>
    ${sampleHtml}
  `);

  await deliver(runRow.user_id, settings, { subject, text, html });
}

/* A short preview of what actually changed, when the stored summary carries
   sample rows. The summary is bounded by changeDiff, so this is already a
   small slice — we cap it again so an e-mail never becomes a data dump. */
function sampleRowsHtml(changeSummary) {
  const groups = [
    ['Added', changeSummary.added],
    ['Changed', changeSummary.changed],
    ['Removed', changeSummary.removed],
  ].filter(([, v]) => Array.isArray(v) && v.length > 0);
  if (groups.length === 0) return '';

  return groups.map(([label, rows]) => {
    const items = rows.slice(0, MAX_SAMPLE_ROWS).map(r => {
      const row = r && typeof r === 'object' && r.row && typeof r.row === 'object' ? r.row : r;
      const preview = Object.entries(row || {})
        .slice(0, 3)
        .map(([k, v]) => `${esc(k)}: ${esc(truncate(v))}`)
        .join(' · ');
      return `<li style="margin:0 0 4px">${preview || '(empty row)'}</li>`;
    }).join('');
    const more = rows.length > MAX_SAMPLE_ROWS ? `<li style="margin:0;color:#656d76">…and ${rows.length - MAX_SAMPLE_ROWS} more</li>` : '';
    return `
      <p style="margin:16px 0 6px;font-size:13px;font-weight:650">${esc(label)}</p>
      <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.5;color:#424a53">${items}${more}</ul>`;
  }).join('');
}

function truncate(v, n = 60) {
  const s = v == null ? '' : String(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/* ── plumbing ───────────────────────────────────────────────────────────── */

async function deliver(userId, settings, message) {
  const out = await mailer.send({ to: settings.email, ...message });
  // Record the outcome so the settings screen can show "last sent" or the
  // reason nothing is arriving, instead of failing invisibly.
  await safe(() => notificationsRepo.markSent(userId, out.ok ? 'ok' : `error: ${out.error}`));
  if (!out.ok) console.warn('[email] notification not sent:', out.error);
}

async function safe(fn) {
  try { return await fn(); } catch (e) {
    console.warn('[email] notification skipped:', e && e.message);
    return null;
  }
}

module.exports = { notifyRunFailed, notifyRunChanged };
