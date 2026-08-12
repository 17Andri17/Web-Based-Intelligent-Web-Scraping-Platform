'use strict';

/* ===========================================================================
   Screencast pacing
   ---------------------------------------------------------------------------
   The property that matters: on a link slower than the stream, latency must
   stay BOUNDED. The old fire-and-forget path acked Chrome as soon as a frame
   was queued onto the socket, so a narrow uplink accumulated a backlog that
   grew for as long as the user kept interacting — the preview drifted further
   behind every second rather than settling into a lower frame rate.

   So these tests drive the pacer with a deliberately slow "network" and assert
   the two things that bound the delay: never more than maxInFlight frames on
   the wire, and a frame waiting behind them is REPLACED by whatever arrived
   since — never queued. A stale frame has no value; the page it depicts has
   already moved on.

   Also covered: Chrome is throttled to the drain rate (so it isn't burning CPU
   encoding frames we discard), a lost ack can't wedge the stream permanently,
   and quality falls under sustained congestion but never past its floor or
   above the operator's configured ceiling.
   ========================================================================= */

const assert = require('assert');
const { createScreencastPacer } = require('../browser/screencastPacer');

let passed = 0;
const ok = (label) => { console.log('  ✓ ' + label); passed++; };
const nextTick = () => new Promise((r) => setImmediate(r));

/* A harness standing in for the socket and the CDP session. Frames emitted are
   held until releaseOne() is called, which is what lets a test model a link
   that drains slower than frames are produced. */
function makeHarness(opts = {}) {
  const delivered = [];      // frames that reached the "client"
  const inflight  = [];      // emitted, not yet acked
  const emitted   = [];      // every emit ever, never drained
  const chromeAcks = [];     // sessionIds acked back to Chrome
  const qualities = [];      // quality values the pacer asked to switch to

  let maxObservedInFlight = 0;

  // Virtual clock. Round-trip timings are what the quality controller decides
  // on, so tests set them exactly rather than sleeping — a real sleep inherits
  // the host's timer granularity (~16ms on Windows), which is coarse enough to
  // turn an intended 1ms "fast frame" into something the controller reads as
  // slow, quietly making a test prove nothing.
  let clock = 100000;

  const pacer = createScreencastPacer({
    baseQuality: opts.baseQuality ?? 80,
    options: { now: () => clock, ...(opts.options || {}) },
    emitFrame: (buf, onDelivered) => {
      inflight.push({ buf, onDelivered });
      emitted.push(buf.toString());
      maxObservedInFlight = Math.max(maxObservedInFlight, inflight.length);
    },
    ackChrome: (sessionId) => { chromeAcks.push(sessionId); },
    onQualityChange: (q) => { qualities.push(q); },
  });

  let seq = 0;
  return {
    pacer, delivered, inflight, emitted, chromeAcks, qualities,
    get maxObservedInFlight() { return maxObservedInFlight; },
    /** Simulate Chrome capturing a frame. `tag` identifies it in assertions. */
    capture(tag) {
      const sessionId = ++seq;
      pacer.handleFrame({ data: Buffer.from(String(tag)).toString('base64'), sessionId });
      return sessionId;
    },
    /** Advance the virtual clock without delivering anything. */
    tick(ms) { clock += ms; },
    /**
     * Simulate the oldest in-flight frame arriving at the client, `rttMs` of
     * virtual time after it was sent.
     */
    async releaseOne(rttMs = 0) {
      const f = inflight.shift();
      if (!f) return null;
      clock += rttMs;
      delivered.push(f.buf.toString());
      f.onDelivered();
      await nextTick();
      return f;
    },
  };
}

(async function run() {
  console.log('\nScreencast pacing');

  /* ── The core property: a slow link costs frame rate, not latency ──────── */
  {
    const h = makeHarness({ options: { maxInFlight: 2 } });

    // Chrome captures 10 frames while the client acks nothing at all.
    for (let i = 1; i <= 10; i++) h.capture(`f${i}`);
    await nextTick();

    assert.strictEqual(h.inflight.length, 2,
      'never more than maxInFlight frames may be on the wire');
    assert.strictEqual(h.maxObservedInFlight, 2, 'the window was never exceeded');
    ok('a burst of frames puts only maxInFlight on the wire');

    // Drain everything. The two frames that were already in flight are old by
    // definition, but of the eight that piled up behind them only the NEWEST
    // may survive — the rest are stale and must have been dropped.
    while (h.inflight.length) await h.releaseOne();

    assert.deepStrictEqual(h.delivered, ['f1', 'f2', 'f10'],
      'the queued frames collapse to the newest one');
    ok('frames waiting behind the window are replaced, not queued');
  }

  /* ── Chrome is throttled to the drain rate, not left encoding freely ───── */
  {
    const h = makeHarness({ options: { maxInFlight: 1 } });

    const a = h.capture('a');   // sent immediately, window now full
    await nextTick();
    assert.deepStrictEqual(h.chromeAcks, [a],
      'the first frame is acked at once so capture keeps flowing');

    const b = h.capture('b');   // arrives with the window full
    await nextTick();
    assert.deepStrictEqual(h.chromeAcks, [a],
      'while the window is full Chrome is left un-acked, so it stops encoding');

    await h.releaseOne();       // window opens
    assert.ok(h.chromeAcks.includes(b),
      'the withheld ack is released once there is room');
    ok('Chrome is throttled to the drain rate while the window is full');
  }

  /* ── A dropped ack must not wedge the stream forever ───────────────────── */
  {
    const h = makeHarness({ options: { maxInFlight: 1, ackTimeoutMs: 20 } });

    h.capture('x');
    await nextTick();
    assert.deepStrictEqual(h.emitted, ['x'], 'first frame is on the wire');

    h.capture('y');             // queued behind the un-acked frame
    await nextTick();
    assert.deepStrictEqual(h.emitted, ['x'], 'second frame is held, window is full');

    // The client never acks. The timeout has to reopen the window anyway.
    await new Promise((r) => setTimeout(r, 60));

    assert.deepStrictEqual(h.emitted, ['x', 'y'],
      'the pump resumed after the ack timeout rather than stalling');
    ok('a lost ack recovers via timeout instead of freezing the stream');
  }

  /* All the quality tests below run against the SHIPPED thresholds, driving a
     virtual clock so each frame's round-trip is exactly what the test says. */

  /* ── Quality backs off under congestion, within its bounds ─────────────── */
  {
    const h = makeHarness({ baseQuality: 80, options: { maxInFlight: 1 } });

    // Every frame takes 800ms to confirm — far over rttHighMs, sustained.
    for (let i = 0; i < 40; i++) {
      h.capture(`s${i}`);
      await h.releaseOne(800);
    }

    assert.ok(h.qualities.length > 0, 'sustained congestion triggered a back-off');
    assert.ok(h.qualities[0] < 80, 'quality moved down, not up');
    assert.ok(Math.min(...h.qualities) >= 30, 'quality never falls below the floor');
    assert.ok(Math.max(...h.qualities) <= 80, 'quality never exceeds the configured ceiling');
    // Steps must be monotonic on a link that never improves.
    assert.deepStrictEqual(h.qualities, [...h.qualities].sort((a, b) => b - a),
      'quality fell monotonically while the link stayed congested');
    ok('quality degrades under congestion and respects floor and ceiling');
  }

  /* ── A healthy link is left alone ──────────────────────────────────────── */
  {
    const h = makeHarness({ baseQuality: 80, options: { maxInFlight: 2 } });

    for (let i = 0; i < 40; i++) {
      h.capture(`q${i}`);
      await h.releaseOne(10);
    }

    assert.deepStrictEqual(h.qualities, [],
      'no restarts were requested on a connection with headroom');
    ok('a fast connection keeps full quality and is never restarted');
  }

  /* ── Regression: one fast frame must not bounce quality back up ─────────
     A quality change re-encodes the whole viewport, so stepping down and
     immediately back up shows as a full-screen shimmer. An earlier version
     cleared its RTT average on every change, which made the very next sample
     the entire average — one quick frame after a back-off then looked like a
     fully recovered link and stepped straight back up.

     Recovery is made maximally easy here (recoverAfterMs 0, no hold) so that
     if a bounce is possible at all, this provokes it. */
  {
    const h = makeHarness({
      baseQuality: 80,
      options: { maxInFlight: 1, recoverAfterMs: 0, holdMs: 0 },
    });

    while (h.qualities.length === 0) {
      h.capture('slow');
      await h.releaseOne(800);
    }
    const afterDegrade = h.qualities[h.qualities.length - 1];
    assert.ok(afterDegrade < 80, 'the link was congested enough to back off');

    // One fast frame — the page briefly stopped changing. That is not
    // evidence the connection recovered, and must not be treated as such.
    h.capture('quick');
    await h.releaseOne(1);

    assert.ok(h.qualities.every((q) => q <= afterDegrade),
      'quality never rose on the strength of a single fast frame');
    ok('a single fast frame does not bounce quality back up');
  }

  /* ── Regression: interaction-driven load must not make it hunt ──────────
     Moving the mouse inflates RTT by itself — hover repaints make frames
     bigger — so load arrives in short bursts while the connection is
     unchanged. Each burst here is 1200ms, deliberately under degradeAfterMs,
     and is followed by an idle stretch that pulls the average back inside the
     band. That must produce no quality change at all: otherwise the viewport
     shimmers for as long as the user keeps moving the mouse.

     `holdMs: 0` removes the cooldown, so nothing but the sustained-evidence
     rule is preventing a change. */
  {
    const h = makeHarness({ baseQuality: 80, options: { maxInFlight: 2, holdMs: 0 } });

    for (let cycle = 0; cycle < 4; cycle++) {
      for (let i = 0; i < 2; i++) {      // burst: big repaint frames
        h.capture(`burst${cycle}-${i}`);
        await h.releaseOne(600);
      }
      for (let i = 0; i < 10; i++) {     // settled: page not changing
        h.capture(`idle${cycle}-${i}`);
        await h.releaseOne(20);
      }
    }

    assert.deepStrictEqual(h.qualities, [],
      'bursty interaction load produced no quality changes at all');
    ok('mouse-driven load bursts do not make the controller hunt');
  }

  /* ── Adaptation can be switched off entirely ────────────────────────────── */
  {
    const h = makeHarness({
      baseQuality: 80,
      options: { maxInFlight: 1, adaptive: false },
    });

    for (let i = 0; i < 40; i++) {
      h.capture(`f${i}`);
      await h.releaseOne(800);
    }

    assert.deepStrictEqual(h.qualities, [],
      'adaptive:false pins quality even under heavy congestion');
    assert.strictEqual(h.pacer.quality, 80, 'quality stayed at the configured value');
    ok('adaptive:false pins quality while pacing still applies');
  }

  /* ── stop() releases everything ────────────────────────────────────────── */
  {
    const h = makeHarness({ options: { maxInFlight: 1 } });
    h.capture('one');
    h.capture('two');           // queued
    await nextTick();

    assert.deepStrictEqual(h.emitted, ['one'], 'second frame is queued, not sent');

    h.pacer.stop();
    await h.releaseOne();       // a late ack arriving after teardown

    assert.deepStrictEqual(h.emitted, ['one'],
      'the late ack did not restart the pump or flush the queued frame');
    ok('stop() drops queued frames and ignores late acks');
  }

  console.log(`\n${passed} assertions passed\n`);
})().catch((err) => { console.error(err); process.exit(1); });
