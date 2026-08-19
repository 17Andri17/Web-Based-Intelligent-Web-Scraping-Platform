'use strict';

/* Which address each kind of mail goes out as.

   The stakes are asymmetric. Run alerts are automated, frequent and eventually
   muted; a password reset has to arrive or someone loses their account. Sending
   both as one address pools their sender reputation, so MAIL_FROM_AUTH exists
   to separate them — and the separation is only worth having if 'auth' really
   does pick it up and everything else really doesn't.

   Run:  node test/mail-from.test.js  */

const mailer = require('../services/mailer.service');

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      ${detail || ''}`}`);
};

// fromFor() reads config(), which returns null without a host.
process.env.SMTP_HOST = 'smtp.example.test';
process.env.SMTP_USER = 'resend';

console.log('one address (MAIL_FROM_AUTH unset)');
process.env.MAIL_FROM = 'Scrapient <noreply@scrapient.app>';
delete process.env.MAIL_FROM_AUTH;

t('alerts use MAIL_FROM',
  mailer.fromFor('alerts') === 'Scrapient <noreply@scrapient.app>', mailer.fromFor('alerts'));
t('auth falls back to MAIL_FROM, so the split stays opt-in',
  mailer.fromFor('auth') === 'Scrapient <noreply@scrapient.app>', mailer.fromFor('auth'));
t('an unnamed stream uses MAIL_FROM',
  mailer.fromFor() === 'Scrapient <noreply@scrapient.app>', mailer.fromFor());

console.log('split streams');
process.env.MAIL_FROM = 'Scrapient <alerts@scrapient.app>';
process.env.MAIL_FROM_AUTH = 'Scrapient <accounts@scrapient.app>';

t('auth mail uses MAIL_FROM_AUTH',
  mailer.fromFor('auth') === 'Scrapient <accounts@scrapient.app>', mailer.fromFor('auth'));
t('alerts keep MAIL_FROM',
  mailer.fromFor('alerts') === 'Scrapient <alerts@scrapient.app>', mailer.fromFor('alerts'));
t('an unnamed stream does NOT borrow the auth address',
  mailer.fromFor() === 'Scrapient <alerts@scrapient.app>', mailer.fromFor());
t('an unknown stream name falls back rather than throwing',
  mailer.fromFor('nonsense') === 'Scrapient <alerts@scrapient.app>', mailer.fromFor('nonsense'));

console.log('blank is not a configured value');
process.env.MAIL_FROM_AUTH = '   ';
t('a whitespace-only MAIL_FROM_AUTH is ignored, not sent as an empty From',
  mailer.fromFor('auth') === 'Scrapient <alerts@scrapient.app>', mailer.fromFor('auth'));

console.log('no SMTP at all');
delete process.env.SMTP_HOST;
t('an unconfigured instance resolves no address', mailer.fromFor('auth') === null);

console.log(`\n${pass} assertions passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
