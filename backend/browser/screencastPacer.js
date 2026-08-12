'use strict';

/* ───────────────────────────────────────────────────────────────────────────
   Screencast pacing + adaptive quality.

   The CDP screencast emits a full JPEG every time the page changes. Writing
   those straight to the socket is fine on loopback, where the send buffer
   drains as fast as we can fill it — but over a real network (and especially
   through a tunnel, where the frames must climb the host's uplink) the stream
   is wider than the pipe.

   What made that unbounded rather than merely slow: Chrome throttles on
   `Page.screencastFrameAck`, and the old code acked the moment a frame was
   *queued* onto the socket, not when it was *delivered*. So Chrome kept
   producing at full speed while the wire drained at its own pace, and the
   backlog — and the visible lag — grew for as long as the user kept
   interacting. Dropping stale frames on the client can't help: by then the
   bytes have already been paid for.

   This paces the stream against what the connection actually carries:

     • at most `maxInFlight` frames are on the wire at once, each confirmed by
       a Socket.IO ack the client sends on receipt;
     • while that window is full, a newly captured frame REPLACES the queued
       one instead of joining a queue — so the next thing we send is always
       the current state of the page, never a frame that is already wrong;
     • Chrome is acked only once the window has room, so it throttles its own
       capture to our drain rate instead of encoding frames we would discard.

   The frame rate therefore falls on a slow link while latency stays bounded,
   which is the trade a remote UI wants — a late frame has no value, because
   the thing it depicts is already in the past.

   Adaptive quality rides on the same acks. Round-trip time is a usable
   congestion signal here because it includes transmission time: a frame too
   big for the link takes measurably longer to confirm. When the smoothed RTT
   sits above the high-water mark we lower JPEG quality; when it sits below the
   low-water mark we walk it back up toward the configured maximum. Hysteresis
   plus a cooldown keeps it from oscillating, and it never exceeds the
   operator's configured quality — that value is the ceiling, not the target.
   ─────────────────────────────────────────────────────────────────────────── */

const DEFAULTS = {
  // Frames allowed on the wire simultaneously. 1 gives the lowest possible
  // latency but caps the frame rate at 1/RTT; 2 roughly doubles the rate for
  // one extra frame of delay, which reads as smoother on a typical link.
  maxInFlight: 2,
  // A lost ack must never stall the stream permanently.
  ackTimeoutMs: 5000,
  // Adaptive quality can be turned off entirely for a fixed-quality stream.
  adaptive: true,
  // Floor for adaptive quality — below this JPEG artifacts make the page hard
  // to read, at which point a lower frame rate is the better trade.
  minQuality: 30,
  // Dead band, in ms of round-trip. Outside it we may act; inside it we never
  // do. It is deliberately wide: a quality change re-encodes the ENTIRE frame,
  // so every adjustment is visible across the whole viewport as a shimmer. A
  // controller that settles slightly too low is far easier on the eyes than
  // one that keeps hunting for the perfect value.
  rttLowMs: 120,
  rttHighMs: 300,
  // How long the RTT must stay continuously outside the band before we act.
  // Asymmetric on purpose: congestion is real and worth fixing quickly, but
  // recovery is a luxury and must be certain — moving the mouse alone briefly
  // inflates RTT (hover repaints make frames bigger), and treating that as a
  // capacity signal is what makes a naive controller oscillate during normal
  // interaction.
  degradeAfterMs: 1500,
  recoverAfterMs: 20000,
  // No further change of any kind for this long after one is made.
  holdMs: 6000,
  // Large steps so the controller converges in very few moves. One visible
  // change that then sticks beats several small ones that shimmer.
  degradeStep: 15,
  recoverStep: 10,
  // Weight of the newest sample in the RTT average. Low enough that a single
  // slow frame — a full-page repaint, a garbage-collection pause — cannot move
  // the decision on its own.
  emaAlpha: 0.2,
  // Clock source, injectable so tests can drive round-trip timings exactly
  // rather than sleeping (and inheriting the host's timer granularity).
  now: null,
};

/**
 * @param {object}   opts
 * @param {number}   opts.baseQuality      Configured JPEG quality — the ceiling.
 * @param {function} opts.emitFrame        (buffer, ackCallback) => void
 * @param {function} opts.ackChrome        (sessionId) => void
 * @param {function} opts.onQualityChange  (quality) => void — restart the screencast
 * @param {object}  [opts.options]         Overrides for DEFAULTS.
 */
function createScreencastPacer({ baseQuality, emitFrame, ackChrome, onQualityChange, options = {} }) {
  const cfg = { ...DEFAULTS, ...options };
  const now = cfg.now || Date.now;

  let inFlight      = 0;
  let queued        = null;  // newest undelivered frame; older ones are discarded
  let owedChromeAck = null;  // sessionId deliberately withheld to throttle capture
  let stopped       = false;

  let quality    = baseQuality;
  let rttEma     = 0;
  let lastChange = 0;
  let aboveSince = 0;  // when the RTT last went continuously above the band
  let belowSince = 0;  // …and below it

  /* Decide whether the link's capacity has genuinely changed.

     Two rules keep this from shimmering. First, the average is NEVER reset:
     an earlier version cleared it on every change, which made the very next
     sample the entire average — so one quick frame after a step down looked
     like abundant headroom and stepped straight back up, hunting on a ~cooldown
     period. Second, a decision requires the RTT to sit outside the dead band
     *continuously* for a while; anything that dips back inside cancels it. A
     burst of repaints from mouse movement does exactly that, so it no longer
     reads as congestion. */
  function adapt(rttMs) {
    if (!cfg.adaptive) return;

    rttEma = rttEma ? (cfg.emaAlpha * rttMs + (1 - cfg.emaAlpha) * rttEma) : rttMs;
    const t = now();

    if (rttEma > cfg.rttHighMs)      { if (!aboveSince) aboveSince = t; belowSince = 0; }
    else if (rttEma < cfg.rttLowMs)  { if (!belowSince) belowSince = t; aboveSince = 0; }
    else                             { aboveSince = 0; belowSince = 0; }

    if (t - lastChange < cfg.holdMs) return;

    let next = quality;
    if (aboveSince && t - aboveSince >= cfg.degradeAfterMs) {
      next = Math.max(cfg.minQuality, quality - cfg.degradeStep);
    } else if (belowSince && t - belowSince >= cfg.recoverAfterMs) {
      next = Math.min(baseQuality, quality + cfg.recoverStep);
    }
    if (next === quality) return;

    quality    = next;
    lastChange = t;
    aboveSince = 0;
    belowSince = 0;
    try { onQualityChange(quality); } catch (_) {}
  }

  function send(buf) {
    inFlight++;
    const startedAt = now();
    let settled = false;

    const onDelivered = () => {
      if (settled || stopped) return;
      settled = true;
      clearTimeout(timer);
      inFlight--;
      adapt(now() - startedAt);
      pump();
    };

    const timer = setTimeout(onDelivered, cfg.ackTimeoutMs);
    if (timer.unref) timer.unref();

    emitFrame(buf, onDelivered);
  }

  function pump() {
    if (stopped) return;
    while (inFlight < cfg.maxInFlight && queued) {
      const buf = queued;
      queued = null;
      send(buf);
      // The held frame is now on the wire, so release the ack we were
      // withholding: Chrome can capture the next one WHILE this one is in
      // flight, and it will be waiting when the window reopens. Gating this on
      // free window space instead would serialise capture behind delivery and
      // add a capture round-trip to every single frame.
      if (owedChromeAck !== null) {
        const sessionId = owedChromeAck;
        owedChromeAck = null;
        ackChrome(sessionId);
      }
    }
  }

  return {
    /** Feed a CDP `Page.screencastFrame` payload. */
    handleFrame(frame) {
      if (stopped) return;
      const buf = Buffer.from(frame.data, 'base64');

      if (inFlight < cfg.maxInFlight) {
        send(buf);
        ackChrome(frame.sessionId);   // room to spare: keep capture flowing
        return;
      }

      // Window full: hold the newest frame only, and withhold the ack so
      // Chrome stops encoding frames we would just throw away. If Chrome sent
      // another frame anyway, the previous ack is clearly not what's blocking
      // it, so release that one rather than leaving it dangling forever.
      queued = buf;
      if (owedChromeAck !== null && owedChromeAck !== frame.sessionId) ackChrome(owedChromeAck);
      owedChromeAck = frame.sessionId;
    },

    stop() {
      stopped       = true;
      queued        = null;
      owedChromeAck = null;
    },

    /** Current adaptive quality — used when the screencast is restarted. */
    get quality() { return quality; },
  };
}

module.exports = { createScreencastPacer, SCREENCAST_PACER_DEFAULTS: DEFAULTS };
