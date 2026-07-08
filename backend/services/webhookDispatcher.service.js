'use strict';

const crypto = require('crypto');
const fetch = require('node-fetch');
const webhooksRepo = require('../db/repositories/webhooks.repo');
const { serializeRun } = require('../utils/apiSerialize');

/* ===========================================================================
   webhookDispatcher
   ---------------------------------------------------------------------------
   Push delivery for the public API: when a run finishes, POST a signed event
   to every active webhook the owner registered for it. Called fire-and-forget
   from executionPipeline, so it covers ALL triggers (UI, scheduled, API) and
   can never fail or slow down a run.

   Event mapping: success → run.completed; error / needs_review → run.failed.
   Cancelled runs emit nothing (the caller cancelled it — nothing to push).

   Security: each delivery is HMAC-SHA256 signed with the endpoint's secret
   over `<timestamp>.<raw body>`, sent as
       X-Scraper-Signature: t=<unix ts>,v1=<hex hmac>
   so the receiver can verify both authenticity and freshness (reject stale
   timestamps to stop replays). Documented in docs/API_REFERENCE.md.
   ========================================================================= */

const TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS || 10000);
const RETRY_DELAYS_MS = [0, 5000, 30000]; // 3 attempts total

function eventForStatus(status) {
  if (status === 'success') return 'run.completed';
  if (status === 'error' || status === 'needs_review') return 'run.failed';
  return null;
}

function sign(secret, timestamp, body) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

async function dispatchRunEvent(runRow) {
  if (!runRow) return;
  const event = eventForStatus(runRow.status);
  if (!event) return;

  let endpoints;
  try {
    endpoints = await webhooksRepo.listActiveForEvent(runRow.user_id, event);
  } catch (_) { return; }

  const live = endpoints.filter(w => {
    try { return JSON.parse(w.events).includes(event); } catch (_) { return false; }
  });
  if (live.length === 0) return;

  const body = JSON.stringify({
    id: 'evt_' + crypto.randomBytes(9).toString('base64url'),
    object: 'event',
    type: event,
    created_at: new Date().toISOString(),
    data: { run: serializeRun(runRow) },
  });

  await Promise.all(live.map(w => deliver(w, event, body)));
}

async function deliver(webhook, event, body) {
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt] > 0) await delay(RETRY_DELAYS_MS[attempt]);
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'ScrapingPlatform-Webhooks/1.0',
          'X-Scraper-Event': event,
          'X-Scraper-Signature': `t=${timestamp},v1=${sign(webhook.secret, timestamp, body)}`,
        },
        body,
        timeout: TIMEOUT_MS,
      });
      if (res.ok) return true;
      // 4xx (other than 408/429) means the receiver actively rejected the
      // payload — retrying the identical request won't change its mind.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        console.warn(`[webhooks] endpoint #${webhook.id} rejected ${event} with HTTP ${res.status} — not retrying`);
        return false;
      }
      console.warn(`[webhooks] endpoint #${webhook.id} returned HTTP ${res.status} (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length})`);
    } catch (err) {
      console.warn(`[webhooks] delivery to endpoint #${webhook.id} failed: ${err.message} (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length})`);
    }
  }
  return false;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { dispatchRunEvent, eventForStatus, sign };
