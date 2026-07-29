'use strict';

/* ===========================================================================
   webhookEvents
   ---------------------------------------------------------------------------
   The single source of truth for the set of webhook event types. Shared by the
   public /v1/webhooks routes, the internal /api/webhooks routes (dashboard UI),
   and the dispatcher, so the three can never disagree on what's valid.
   ========================================================================= */

const WEBHOOK_EVENTS = ['run.completed', 'run.failed', 'run.changed'];

// Human-readable descriptions for the management UI.
const WEBHOOK_EVENT_LABELS = {
  'run.completed': 'When a run finishes successfully',
  'run.failed':    'When a run fails or needs review',
  'run.changed':   'When a monitored workflow’s data changes between runs',
};

module.exports = { WEBHOOK_EVENTS, WEBHOOK_EVENT_LABELS };
