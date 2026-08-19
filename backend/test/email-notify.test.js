'use strict';

/* E-mail alerts must be silent unless someone actually asked for them.

   The failure mode that matters here is not "mail didn't send" — it's mail
   sending when it shouldn't: to a user who opted out, for a successful run, for
   a baseline change summary with nothing in it, or from an instance with no
   SMTP configured at all. Each of those turns the feature into spam and trains
   people to ignore the alerts that do matter.

   Run:  node test/email-notify.test.js  */

const Module = require('module');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      ${detail || ''}`}`);
};

/* ── stubs ────────────────────────────────────────────────────────────────
   emailNotifier reaches for the mailer, the settings repo and the workflows
   repo. Intercept those three requires so this stays a pure unit test with no
   database and no network. */
const sent = [];
let settingsRow = null;
let smtpConfigured = true;
let sendOk = true;
const throttles = new Map();
const tkey = (userId, workflowId) => `${userId}:${Number(workflowId) || 0}`;

const stubs = {
  './mailer.service': {
    isConfigured: () => smtpConfigured,
    // `sent` records ATTEMPTS, so a test can assert that a failed send is
    // retried next time rather than suppressed by a cooldown it never earned.
    send: async (msg) => {
      sent.push(msg);
      return sendOk ? { ok: true } : { ok: false, error: 'smtp down' };
    },
    verify: async () => ({ ok: true }),
  },
  '../db/repositories/notifications.repo': {
    // Mirrors the real repo's gating so the notifier is exercised through the
    // same decision it makes in production.
    async activeForEvent(userId, event) {
      const row = settingsRow;
      if (!row || !row.is_active || !row.email) return null;
      if (event === 'run.failed' && !row.on_failure) return null;
      if (event === 'run.changed' && !row.on_change) return null;
      if (event !== 'run.failed' && event !== 'run.changed') return null;
      return row;
    },
    async markSent() {},

    // Backed by a real map keyed the way the table is, so the per-workflow
    // isolation is genuinely exercised rather than assumed.
    async getThrottle(userId, workflowId) {
      return throttles.get(tkey(userId, workflowId)) || null;
    },
    async countSuppressed(userId, workflowId) {
      const k = tkey(userId, workflowId);
      const row = throttles.get(k) || { last_sent_at: null, suppressed_count: 0 };
      row.suppressed_count += 1;
      throttles.set(k, row);
      return row.suppressed_count;
    },
    async markAlertSent(userId, workflowId) {
      throttles.set(tkey(userId, workflowId), {
        last_sent_at: new Date().toISOString(),
        suppressed_count: 0,
      });
    },
  },
  '../db/repositories/workflows.repo': {
    async getForUser() { return { id: 7, name: 'Price watch' }; },
  },
};

const realLoad = Module._load;
Module._load = function (request, parent) {
  if (parent && /emailNotifier\.service\.js$/.test(parent.filename) && stubs[request]) {
    return stubs[request];
  }
  return realLoad.apply(this, arguments);
};

const notifier = require(path.join(__dirname, '..', 'services', 'emailNotifier.service.js'));

const failedRun  = { id: 1, user_id: 3, workflow_id: 7, status: 'error', ai_summary: 'Could not find the list.', rows_captured: 0 };
const reviewRun  = { ...failedRun, status: 'needs_review' };
const successRun = { ...failedRun, status: 'success' };
const optedIn    = { is_active: 1, email: 'a@b.test', on_failure: 1, on_change: 1 };

// Each case starts from a clean cooldown state — otherwise the second failure
// alert in this file would be suppressed by the first.
const reset = () => { sent.length = 0; throttles.clear(); };
const summary = (counts, extra = {}) => ({ counts, baseline: false, ...extra });

async function main() {
  /* ── run.failed ───────────────────────────────────────────────────────── */
  console.log('failure alerts');

  settingsRow = optedIn; reset();
  await notifier.notifyRunFailed(failedRun);
  t('a failed run mails the opted-in user', sent.length === 1);
  t('the subject names the workflow', sent[0] && /Price watch/.test(sent[0].subject), sent[0] && sent[0].subject);
  t('the body leads with the plain-language summary',
    sent[0] && sent[0].text.includes('Could not find the list.'));
  t('the body carries both text and html parts', sent[0] && !!sent[0].text && !!sent[0].html);

  reset();
  await notifier.notifyRunFailed(reviewRun);
  t('a needs-review run also mails', sent.length === 1);
  t('…worded as "needs a look", not "failed"',
    sent[0] && /needs a look/.test(sent[0].subject), sent[0] && sent[0].subject);

  reset();
  await notifier.notifyRunFailed(successRun);
  t('a SUCCESSFUL run never mails', sent.length === 0);

  reset();
  await notifier.notifyRunFailed({ ...failedRun, status: 'cancelled' });
  t('a cancelled run never mails', sent.length === 0);

  reset();
  await notifier.notifyRunFailed(null);
  t('a missing run row is survivable', sent.length === 0);

  settingsRow = { ...optedIn, on_failure: 0 }; reset();
  await notifier.notifyRunFailed(failedRun);
  t('opting out of failures silences them', sent.length === 0);

  settingsRow = { ...optedIn, is_active: 0 }; reset();
  await notifier.notifyRunFailed(failedRun);
  t('pausing alerts silences everything', sent.length === 0);

  settingsRow = null; reset();
  await notifier.notifyRunFailed(failedRun);
  t('a user with no settings gets nothing', sent.length === 0);

  settingsRow = optedIn; smtpConfigured = false; reset();
  await notifier.notifyRunFailed(failedRun);
  t('an instance with no SMTP sends nothing', sent.length === 0);
  smtpConfigured = true;

  reset();
  await notifier.notifyRunFailed({ ...failedRun, rows_captured: 42 });
  t('a partial run reports the rows it did keep',
    sent[0] && /42/.test(sent[0].text), sent[0] && sent[0].text);

  /* ── failure cooldown ─────────────────────────────────────────────────────
     A broken scraper on a schedule fails over and over with the same message.
     Mailing each one is how a person learns to filter the sender. */
  console.log('failure cooldown');

  settingsRow = optedIn; reset();
  await notifier.notifyRunFailed(failedRun);
  await notifier.notifyRunFailed(failedRun);
  await notifier.notifyRunFailed(failedRun);
  t('a workflow failing repeatedly mails only once', sent.length === 1, `sent ${sent.length}`);

  // …and the suppressed ones are reported, not silently dropped.
  process.env.EMAIL_FAILURE_COOLDOWN_HOURS = '0';
  await notifier.notifyRunFailed(failedRun);
  delete process.env.EMAIL_FAILURE_COOLDOWN_HOURS;
  t('the next mail says how many failures were swallowed',
    sent.length === 2 && /2 more times/.test(sent[1].text), sent[1] && sent[1].text);

  reset();
  await notifier.notifyRunFailed(failedRun);
  await notifier.notifyRunFailed({ ...failedRun, workflow_id: 9 });
  t('a DIFFERENT workflow is not muted by the first one\'s cooldown',
    sent.length === 2, `sent ${sent.length}`);

  reset();
  process.env.EMAIL_FAILURE_COOLDOWN_HOURS = '0';
  await notifier.notifyRunFailed(failedRun);
  await notifier.notifyRunFailed(failedRun);
  delete process.env.EMAIL_FAILURE_COOLDOWN_HOURS;
  t('once the window passes, failures mail again', sent.length === 2, `sent ${sent.length}`);

  // A quiet period must be opened by a mail that actually arrived. Starting one
  // on a failed send would swallow a day of alerts because SMTP blipped.
  reset(); sendOk = false;
  await notifier.notifyRunFailed(failedRun);
  await notifier.notifyRunFailed(failedRun);
  sendOk = true;
  t('a send that FAILED does not start the cooldown', sent.length === 2, `attempts ${sent.length}`);

  /* ── run.changed ──────────────────────────────────────────────────────── */
  console.log('change alerts');

  settingsRow = optedIn; reset();
  await notifier.notifyRunChanged(successRun, summary({ added: 3, changed: 1, removed: 0 }));
  t('a real change mails', sent.length === 1);
  t('the subject counts what changed',
    sent[0] && /3 new/.test(sent[0].subject) && /1 changed/.test(sent[0].subject),
    sent[0] && sent[0].subject);
  t('a zero count is left out of the subject',
    sent[0] && !/gone/.test(sent[0].subject), sent[0] && sent[0].subject);

  reset();
  await notifier.notifyRunChanged(successRun, summary({ added: 0, changed: 0, removed: 0 }));
  t('a run with no changes never mails', sent.length === 0);

  reset();
  await notifier.notifyRunChanged(successRun, { counts: { added: 9 }, baseline: true });
  t('the first (baseline) monitored run never mails', sent.length === 0);

  reset();
  await notifier.notifyRunChanged(successRun, null);
  t('a missing summary is survivable', sent.length === 0);

  settingsRow = { ...optedIn, on_change: 0 }; reset();
  await notifier.notifyRunChanged(successRun, summary({ added: 3 }));
  t('opting out of change alerts silences them', sent.length === 0);

  settingsRow = optedIn; reset();
  await notifier.notifyRunChanged(successRun, summary({ added: 2 }, {
    added: [{ Title: 'Widget', Price: '9.99' }, { Title: 'Gadget', Price: '12.00' }],
  }));
  t('sample rows are previewed in the body',
    sent[0] && /Widget/.test(sent[0].html), sent[0] && sent[0].html.slice(0, 200));

  reset();
  await notifier.notifyRunChanged(successRun, summary({ added: 1 }, {
    added: [{ Title: '<script>alert(1)</script>' }],
  }));
  {
    const html = sent[0] ? sent[0].html : '';
    t('a scraped value cannot inject markup into the e-mail',
      !/<script>/.test(html) && /&lt;script&gt;/.test(html), html.slice(0, 300));
  }

  reset();
  await notifier.notifyRunChanged(successRun, summary({ added: 9 }, {
    added: Array.from({ length: 9 }, (_, i) => ({ Title: `Row ${i}` })),
  }));
  {
    const html = sent[0] ? sent[0].html : '';
    // Capped at 5 samples so an alert never becomes a data dump.
    t('a long change list is capped with an "and N more"',
      /and 4 more/.test(html), html.slice(0, 400));
  }

  Module._load = realLoad;
  console.log(`\n${pass} assertions passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
