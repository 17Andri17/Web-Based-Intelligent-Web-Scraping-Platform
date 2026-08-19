'use strict';

const express = require('express');
const notificationsRepo = require('../db/repositories/notifications.repo');
const mailer = require('../services/mailer.service');
const entitlements = require('../services/entitlements.service');
const { requireAuth } = require('../middleware/auth');

/* ===========================================================================
   /api/notifications
   ---------------------------------------------------------------------------
   Account-level "e-mail me when…" settings. One row per user (migration 0010).

   `available` tells the UI whether this instance can send mail at all, so a
   user is never offered a switch that would silently do nothing — the same
   courtesy the Google Sheets screen pays with its service-account status.
   ========================================================================= */

const router = express.Router();
router.use(requireAuth);

// Deliberately permissive: full RFC-5322 validation in a regex is a losing
// game, and the real check is whether mail arrives — which "Send a test" does.
// This only catches obvious typos before they become silent non-delivery.
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function serialize(row) {
  if (!row) return null;
  return {
    isActive:  !!row.is_active,
    email:     row.email,
    onFailure: !!row.on_failure,
    onChange:  !!row.on_change,
    lastStatus: row.last_status || null,
    lastSentAt: row.last_sent_at || null,
  };
}

router.get('/', async (req, res) => {
  const row = await notificationsRepo.getForUser(req.user.id);
  res.json({
    settings: serialize(row),
    available: mailer.isConfigured(),
  });
});

router.put('/', async (req, res) => {
  if (!mailer.isConfigured()) {
    return res.status(400).json({ error: 'E-mail is not set up on this server. Ask whoever runs it to configure SMTP_HOST.' });
  }
  await entitlements.assertFeature(req.user.id, 'emailAlerts', 'E-mail alerts');
  const email = String(req.body?.email || '').trim();
  if (!EMAIL_RX.test(email)) {
    return res.status(400).json({ error: 'That doesn\'t look like an e-mail address.' });
  }
  const row = await notificationsRepo.save({
    userId: req.user.id,
    email,
    onFailure: req.body?.onFailure !== false,
    onChange:  req.body?.onChange  !== false,
    isActive:  req.body?.isActive  !== false,
  });
  res.json({ settings: serialize(row) });
});

router.delete('/', async (req, res) => {
  await notificationsRepo.remove(req.user.id);
  res.json({ ok: true });
});

/* Send a test message to the saved address. The point is to fail LOUDLY here
   rather than silently three weeks later when a real alert doesn't arrive. */
router.post('/test', async (req, res) => {
  const row = await notificationsRepo.getForUser(req.user.id);
  const to = String(req.body?.email || row?.email || '').trim();
  if (!EMAIL_RX.test(to)) {
    return res.status(400).json({ error: 'Save an e-mail address first.' });
  }
  const reachable = await mailer.verify();
  if (!reachable.ok) return res.status(502).json({ error: reachable.error });

  const out = await mailer.send({
    to,
    // Left on the default 'alerts' stream on purpose: this button answers
    // "will my alerts arrive?", so it must go out as the address they will.
    subject: 'Scrapient test message',
    text: 'This is a test from Scrapient. If you got this, your alerts will arrive.',
    html: '<p style="font-family:sans-serif">This is a test from Scrapient. If you got this, your alerts will arrive.</p>',
  });
  if (!out.ok) return res.status(502).json({ error: out.error });
  res.json({ ok: true, sentTo: to });
});

module.exports = router;
