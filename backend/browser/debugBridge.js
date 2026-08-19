'use strict';

/* ===========================================================================
   debugBridge — the child half of Debug Mode
   ---------------------------------------------------------------------------
   A run executes as a spawned child process (services/runner.service.js) and
   talks to the platform through one-way stdout markers. That is enough to
   REPORT what happened; it is not enough to ASK the run to stop, or to look at
   the page it is standing on. Debug Mode adds both, over the child's IPC
   channel — deliberately not stdout, which is the marker/log stream and is
   parsed line by line (a 40 KB JPEG per line would starve it).

   What this module splices into the generated script:

     __dbgGate(info, when, selectors)
        The pause point. Called before and after every step (see
        workflowCodegen's genStepList), and once more from the top-level catch
        so a failure freezes the page instead of only reporting it. Returns
        immediately unless this step is a breakpoint, the user asked to step,
        or a pause is pending — so a debug run at full speed costs one
        function call per step.

     __dbgAttach(page)
        Called from the single page factory (__openPage) for every tab the run
        opens, so the screencast follows the page the run is actually using.
        Debug forces concurrency to 1, so "the newest open tab" is unambiguous.

   Everything here is inert without an IPC channel. A downloaded script never
   contains this code at all, but if a debug script is ever run by hand it must
   complete untouched rather than hang waiting for a resume that cannot come.

   ── The frame path ────────────────────────────────────────────────────────
   Frames are paced twice. Here, against the parent's confirmation: at most one
   frame is in flight over IPC, a frame captured while one is in flight
   REPLACES the waiting one rather than queueing behind it, and Chrome's own
   ack is withheld meanwhile so it throttles capture to our drain rate instead
   of encoding frames we would discard. That is the same contract
   browser/screencastPacer.js implements for the socket hop, which the parent
   applies on top — including its adaptive quality, whose decisions arrive back
   here as a 'quality' message.
   ========================================================================= */

// Frame budget. The run's viewport is typically 1280×720; casting at 900px
// wide keeps a frame in the tens of kilobytes, which reads sharply in a debug
// window without making the IPC hop the bottleneck. The parent may lower
// quality from here (never raise it above this) as its pacer measures the link.
const DEBUG_SCREENCAST = {
  quality: 60,
  maxWidth: 900,
  maxHeight: 900,
  everyNthFrame: 1,
};

/**
 * Source for the in-child debug runtime, spliced into the generated script.
 * @param {object}  opts
 * @param {object}  [opts.screencast]   Overrides for DEBUG_SCREENCAST.
 * @param {boolean} [opts.pauseAtStart] Pause before the first step (default true).
 */
function buildCodegenDebugHelper(opts = {}) {
  const cfg = {
    screencast: { ...DEBUG_SCREENCAST, ...(opts.screencast || {}) },
    pauseAtStart: opts.pauseAtStart !== false,
  };

  return `
// ─── Debug Mode runtime (platform debug runs only) ────────────────────────
const __DBG_CFG = ${JSON.stringify(cfg)};
const __dbgOn = typeof process.send === 'function';
// The IPC channel is a ref'd handle: left alone it would keep this process
// alive after the workflow finishes. Unref it — while PAUSED we hold our own
// keep-alive instead (see __dbgPark), which is the only time we genuinely
// must not exit.
if (__dbgOn && process.channel && process.channel.unref) { try { process.channel.unref(); } catch (_) {} }

function __dbgSend(msg) {
  if (!__dbgOn) return;
  try { process.send(msg); } catch (_) {}
}

/* Report captured rows on every step rather than on a timer. The production
   throttle (see __CHECKPOINT_MS) bounds stdout on a fast run, but it means a
   loop that finishes inside one window never reports at all — so the window
   would show the row count from BEFORE the loop for the whole of it, and only
   jump to the real figure once the run ended. A debug run moves at human speed
   and is being watched precisely to see the numbers move. */
if (__dbgOn) __CHECKPOINT_MS = 0;

/* ── Pause state ─────────────────────────────────────────────────────────
   'run'  — never stop except at a breakpoint
   'step' — stop at the next gate, whatever it is
   A pause requested while the run is moving takes effect at the next gate.
   There is no way to interrupt a step half-way, and no honest one: the page
   would be in a state the workflow itself never produces. */
let __dbgMode        = ${cfg.pauseAtStart ? "'step'" : "'run'"};
let __dbgBreakpoints = new Set();
let __dbgMuted       = new Set();   // steps the user chose to stop stopping on
let __dbgSlowMoMs    = 0;
const __dbgParks     = new Map();   // seq → resolve, one per parked caller
let __dbgKeepAlive   = null;
let __dbgStepSeq     = 0;

function __dbgShouldStop(info) {
  if (!__dbgOn) return false;
  const id = info && info.id;
  if (id && __dbgMuted.has(String(id))) return false;
  if (__dbgMode === 'step') return true;
  if (id && __dbgBreakpoints.has(String(id))) return true;
  return false;
}

/* Park until the parent says otherwise.

   A pending promise does not hold the event loop open on its own. Puppeteer's
   connection to Chrome normally does, but a paused run must not depend on that
   staying true — so it holds one ref'd timer, and only while something is
   parked.

   Parks are keyed rather than kept in a single slot. Debug mode forces
   concurrency to 1, so today only one caller can ever be parked at a time —
   but a single slot means the SECOND park silently overwrites the first, and
   the first promise then never settles. That is a deadlock that would only
   appear the day parallel debugging is allowed, in the form of a run that
   hangs with no error, which is the worst kind to go looking for. */
function __dbgPark(seq) {
  return new Promise((resolve) => {
    __dbgParks.set(seq, resolve);
    if (!__dbgKeepAlive) __dbgKeepAlive = setInterval(() => {}, 60000);
  });
}

/** Release one parked caller, or every one of them when seq is omitted. */
function __dbgRelease(seq) {
  const keys = (seq === undefined || seq === null) ? Array.from(__dbgParks.keys()) : [seq];
  for (const k of keys) {
    const fn = __dbgParks.get(k);
    __dbgParks.delete(k);
    if (fn) fn();
  }
  if (!__dbgParks.size && __dbgKeepAlive) { clearInterval(__dbgKeepAlive); __dbgKeepAlive = null; }
}

/* ── Looking at the page ─────────────────────────────────────────────────── */

function __dbgSafeUrl(p) { try { return p ? p.url() : null; } catch (_) { return null; } }

/* Evaluate the selectors a step is ABOUT to use against the page as it stands
   right now. Run before and after the step, the pair is the answer to the
   question debug mode exists for: "0 matches → 24 matches" says the element
   only exists once the previous step has run, which no amount of watching a
   video tells you. */
async function __dbgProbe(selectors) {
  const page = __dbgActivePage();
  if (!page || !Array.isArray(selectors) || !selectors.length) return null;
  const out = [];
  for (const sel of selectors) {
    const value = sel && sel.value;
    const type  = (sel && sel.type) || 'css';
    if (!value) continue;
    try {
      const r = await page.evaluate((s, t) => {
        const visible = (el) => {
          try {
            const rect = el.getBoundingClientRect();
            const st = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 &&
                   st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
          } catch (_) { return false; }
        };
        let els = [];
        if (t === 'xpath') {
          const it = document.evaluate(s, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let i = 0; i < it.snapshotLength; i++) els.push(it.snapshotItem(i));
        } else {
          els = Array.prototype.slice.call(document.querySelectorAll(s));
        }
        const first = els[0] || null;
        return {
          matches: els.length,
          visible: els.filter(visible).length,
          sample:  first && first.outerHTML ? String(first.outerHTML).slice(0, 500) : null,
          text:    first ? String(first.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) : null,
        };
      }, value, type);
      out.push(Object.assign({ selector: value, type: type }, r));
    } catch (err) {
      // An invalid selector is a finding, not a failure — it is very often the
      // whole reason the user opened the debugger.
      out.push({ selector: value, type: type, matches: 0, visible: 0, error: String((err && err.message) || err) });
    }
  }
  return out.length ? out : null;
}

async function __dbgPageInfo() {
  const page = __dbgActivePage();
  let title = null;
  let nodes = null;
  let viewport = null;
  let scroll = null;
  if (page) {
    try {
      const r = await page.evaluate(() => ({
        t: document.title,
        n: document.getElementsByTagName('*').length,
        // The window maps a click on the streamed image back to a point on the
        // page with these: the frame is a scaled JPEG, so it cannot work out
        // where it was clicked without knowing the size of the real viewport.
        vw: window.innerWidth, vh: window.innerHeight,
        sx: Math.round(window.scrollX), sy: Math.round(window.scrollY),
        sh: Math.max(document.body ? document.body.scrollHeight : 0,
                     document.documentElement ? document.documentElement.scrollHeight : 0),
      }));
      title = r.t; nodes = r.n;
      viewport = { w: r.vw, h: r.vh, pageHeight: r.sh };
      scroll = { x: r.sx, y: r.sy };
    } catch (_) {}
  }
  return { url: __dbgSafeUrl(page), title: title, nodes: nodes, viewport: viewport, scroll: scroll };
}

/* ── The address bar, continuously ────────────────────────────────────────
   The pause payload carries a URL, but a run that is MOVING changes address
   without stopping — pagination walking page 2, 3, 4 is the case that matters,
   and watching it in silence tells you nothing about whether the links are
   actually advancing. So the URL is reported as it changes rather than only at
   a pause.

   Polled rather than hooked to 'framenavigated': page.url() is a cached local
   read, not a round trip, and polling also catches the history.pushState
   navigations a single-page site does — which never fire a frame navigation
   and are exactly where "am I still on page 1?" gets confusing. */
let __dbgLastUrl = null;
let __dbgUrlTimer = null;

function __dbgWatchUrl() {
  if (__dbgUrlTimer) return;
  __dbgUrlTimer = setInterval(() => {
    const url = __dbgSafeUrl(__dbgActivePage());
    if (url && url !== __dbgLastUrl) {
      __dbgLastUrl = url;
      __dbgSend({ t: 'url', url: url });
    }
  }, 400);
  // Never a reason to keep the process alive; the run finishing ends this.
  if (__dbgUrlTimer.unref) __dbgUrlTimer.unref();
}

/* ── Touching the page while it is parked ─────────────────────────────────
   Scrolling is the point of this: a screencast shows one viewport, and "what
   is actually on this page" usually means the part below it. Clicks and typing
   are also possible but are a different kind of act — they change the page the
   workflow is about to operate on, so they are announced in the run log and
   they switch off the scroll restore below.

   Input is only accepted while parked. Injecting a click into a step that is
   mid-execution races with the workflow's own actions, and the resulting page
   belongs to neither of them. */
let __dbgTookControl = false;      // a click or a keystroke happened at this pause
let __dbgSnapTimer = null;

function __dbgSnapSoon() {
  // Scrolling emits screencast frames on its own, but a click that only
  // changes a hover state might not, and a burst of wheel events must not turn
  // into a burst of full-page captures. One capture, shortly after the input
  // stops, covers both.
  if (__dbgSnapTimer) clearTimeout(__dbgSnapTimer);
  __dbgSnapTimer = setTimeout(() => { __dbgSnapTimer = null; __dbgSnapFrame().catch(() => {}); }, 120);
  if (__dbgSnapTimer.unref) __dbgSnapTimer.unref();
}

async function __dbgInput(msg) {
  if (!__dbgParks.size) return;
  const page = __dbgActivePage();
  if (!page) return;
  const x = Number(msg.x) || 0;
  const y = Number(msg.y) || 0;
  try {
    switch (msg.kind) {
      case 'wheel':
        await page.mouse.move(x, y);
        await page.mouse.wheel({ deltaX: Number(msg.deltaX) || 0, deltaY: Number(msg.deltaY) || 0 });
        break;
      case 'move':
        await page.mouse.move(x, y);
        break;
      case 'scrollTo':
        await page.evaluate((sx, sy) => window.scrollTo(sx, sy), Number(msg.sx) || 0, Number(msg.sy) || 0);
        break;
      case 'click':
        __dbgTookControl = true;
        console.log('✋ Page clicked by hand at a debug pause — the run continues on the page as you left it.');
        await page.mouse.click(x, y);
        break;
      case 'key':
        __dbgTookControl = true;
        console.log('✋ Key "' + String(msg.key).slice(0, 20) + '" sent by hand at a debug pause.');
        await page.keyboard.press(String(msg.key));
        break;
      case 'text':
        __dbgTookControl = true;
        console.log('✋ Text typed by hand at a debug pause.');
        await page.keyboard.sendCharacter(String(msg.text));
        break;
      default:
        return;
    }
  } catch (_) { /* a click that navigates mid-flight throws; the page moved on */ }
  __dbgSnapSoon();
  __dbgReportScroll();
}

/* Where the page is now, after being scrolled by hand. Without this the
   window's scroll readout is whatever it was when the run parked, so it would
   sit at "y 0" while the user scrolls past the fold — describing a page that
   is no longer what they are looking at. */
async function __dbgReportScroll() {
  const page = __dbgActivePage();
  if (!page) return;
  try {
    /* Read AFTER the frame that applies the scroll. Dispatching a wheel event
       returns as soon as it is delivered, not when the page has moved — a
       reading taken straight afterwards is of the position before the scroll,
       which makes the readout permanently one gesture behind. Two frames,
       because the first is the one the scroll is applied in.

       The timeout is the fallback for a page that has stopped animating
       entirely, where a queued frame callback might never be run. */
    const s = await page.evaluate(() => new Promise((resolve) => {
      const read = () => resolve({
        x: Math.round(window.scrollX), y: Math.round(window.scrollY),
        h: Math.max(document.body ? document.body.scrollHeight : 0,
                    document.documentElement ? document.documentElement.scrollHeight : 0),
        vh: window.innerHeight,
      });
      let done = false;
      const once = () => { if (!done) { done = true; read(); } };
      requestAnimationFrame(() => requestAnimationFrame(once));
      setTimeout(once, 250);
    }));
    __dbgSend({ t: 'scroll', x: s.x, y: s.y, pageHeight: s.h, viewportHeight: s.vh });
  } catch (_) {}
}

/* Put the page back where the run left it.

   Looking around must not change what happens next. A workflow that scrolls to
   harvest a list, or a step that acts on what is in view, would behave
   differently from a page the user scrolled to the bottom — and the user would
   have no way to connect the two. So a pause spent scrolling is undone on
   resume.

   Not undone when the user clicked or typed: that was a deliberate change to
   the page, and quietly reverting half of it would be worse than leaving it.
   Also skipped if the page navigated in the meantime, where the remembered
   offset means nothing. */
async function __dbgRestoreScroll(before, url) {
  if (!before || __dbgTookControl) return;
  const page = __dbgActivePage();
  if (!page || __dbgSafeUrl(page) !== url) return;
  try {
    await page.evaluate((x, y) => {
      if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
    }, before.x, before.y);
  } catch (_) {}
}

/* ── The gate ─────────────────────────────────────────────────────────────
   'before' — the step has not run; the probe describes the page it will act on
   'after'  — it has; the probe describes what it left behind
   'error'  — it threw, and the page is frozen exactly where it broke */
async function __dbgGate(info, when, selectors) {
  if (!__dbgOn) return;
  if (__dbgSlowMoMs > 0 && when === 'before') {
    await new Promise((r) => setTimeout(r, __dbgSlowMoMs));
  }
  // A failure always stops, whatever the mode: the page will be gone a
  // moment later, and this is the only chance to look at it.
  if (when !== 'error' && !__dbgShouldStop(info)) return;

  const seq = ++__dbgStepSeq;
  let payload;
  let scrollBefore = null;
  __dbgTookControl = false;
  try {
    const info2 = await __dbgPageInfo();
    scrollBefore = info2.scroll;
    // Which worker and which item, when this gate is inside a per-item loop.
    // Empty at concurrency 1 (the loop doesn't tag lanes there) — the window
    // gets "item 12 of 30" from the run's own ITER_TICK stream instead.
    let lane = null;
    try { lane = __laneStore.getStore() || null; } catch (_) {}
    payload = {
      seq: seq,
      when: when,
      step: info || null,
      url: info2.url,
      title: info2.title,
      nodes: info2.nodes,
      viewport: info2.viewport,
      scroll: info2.scroll,
      probe: await __dbgProbe(selectors),
      lane: lane,
      mode: __dbgMode,
      breakpoints: Array.from(__dbgBreakpoints),
      muted: Array.from(__dbgMuted),
    };
  } catch (err) {
    payload = { seq: seq, when: when, step: info || null, error: String((err && err.message) || err) };
  }

  // The picture first, then the words: the window renders both together, and
  // a frame arriving after the payload would show the previous page beside
  // this page's description.
  await __dbgSnapFrame();
  __dbgSend({ t: 'paused', payload: payload });
  await __dbgPark(seq);
  await __dbgRestoreScroll(scrollBefore, payload && payload.url);
  __dbgSend({ t: 'resumed', seq: seq });
}

/* ── Screencast ───────────────────────────────────────────────────────────
   __openPage is the only place a tab is created (see browser/pagePool.js), so
   registering here catches the first page, subflow pages, and new-tab
   navigations alike. */
const __dbgPages = [];
let __dbgCast = null;   // { page, client, quality, onParentAck }

function __dbgActivePage() {
  for (let i = __dbgPages.length - 1; i >= 0; i--) {
    const p = __dbgPages[i];
    try { if (p && !p.isClosed()) return p; } catch (_) {}
  }
  return null;
}

async function __dbgAttach(page) {
  if (!__dbgOn || !page) return;
  __dbgPages.push(page);
  try {
    page.once('close', () => {
      const i = __dbgPages.indexOf(page);
      if (i >= 0) __dbgPages.splice(i, 1);
      if (__dbgCast && __dbgCast.page === page) {
        __dbgCast = null;
        // The run is back on whatever tab remains; follow it there.
        const next = __dbgActivePage();
        if (next) __dbgStartCast(next).catch(() => {});
      }
    });
  } catch (_) {}
  // Only the frontmost tab is composited, and a screencast of a tab that isn't
  // being composited produces almost nothing. A run that opens a detail page
  // has two tabs, so following it means making the one we cast from the live
  // one — otherwise the picture silently freezes on the tab we left.
  try { await page.bringToFront(); } catch (_) {}
  await __dbgStartCast(page).catch(() => {});
  __dbgWatchUrl();
}

async function __dbgStartCast(page, quality) {
  if (!__dbgOn || !page) return;
  const prevQuality = (__dbgCast && __dbgCast.quality) || __DBG_CFG.screencast.quality;
  await __dbgStopCast();
  const q = quality || prevQuality;
  let client;
  try {
    client = await page.createCDPSession();
  } catch (_) { return; }

  let inFlight = false;
  let queued   = null;     // newest undelivered frame; older ones are dropped
  let owedAck  = null;     // Chrome ack withheld on purpose, to throttle capture

  const ackChrome = (sessionId) => {
    if (sessionId == null) return;
    try { client.send('Page.screencastFrameAck', { sessionId: sessionId }).catch(() => {}); } catch (_) {}
  };

  const deliver = (frame) => {
    inFlight = true;
    __dbgSend({ t: 'frame', buf: frame.buf, w: frame.w, h: frame.h });
  };

  const cast = {
    page: page,
    client: client,
    quality: q,
    onParentAck: () => {
      inFlight = false;
      if (queued) {
        const next = queued;
        queued = null;
        deliver(next);
        // The held frame is on the wire, so Chrome may capture the next one.
        if (owedAck !== null) { const s = owedAck; owedAck = null; ackChrome(s); }
      }
    },
  };

  const onFrame = (frame) => {
    let buf;
    try { buf = Buffer.from(frame.data, 'base64'); } catch (_) { return; }
    const md = frame.metadata || {};
    const item = { buf: buf, w: md.deviceWidth || null, h: md.deviceHeight || null };
    if (!inFlight) {
      deliver(item);
      ackChrome(frame.sessionId);
      return;
    }
    queued = item;
    if (owedAck !== null && owedAck !== frame.sessionId) ackChrome(owedAck);
    owedAck = frame.sessionId;
  };

  try {
    client.on('Page.screencastFrame', onFrame);
    await client.send('Page.startScreencast', {
      format: 'jpeg',
      quality: q,
      maxWidth: __DBG_CFG.screencast.maxWidth,
      maxHeight: __DBG_CFG.screencast.maxHeight,
      everyNthFrame: __DBG_CFG.screencast.everyNthFrame,
    });
    __dbgCast = cast;
    __dbgSend({ t: 'cast', url: __dbgSafeUrl(page), quality: q });
  } catch (_) {
    try { await client.detach(); } catch (_) {}
  }
}

async function __dbgStopCast() {
  const cast = __dbgCast;
  __dbgCast = null;
  if (!cast) return;
  try { await cast.client.send('Page.stopScreencast'); } catch (_) {}
  try { await cast.client.detach(); } catch (_) {}
}

/* A screencast is change-driven: Chrome emits a frame when the page repaints
   and nothing at all when it doesn't. That is the right behaviour for a stream
   — but it means a PAUSED page, which by definition has stopped changing,
   would leave the window showing whatever was last painted while the panel
   beside it describes the page as it is now. On a fast step the two can be
   several navigations apart.

   So a pause takes its own picture rather than waiting for one. Once per
   pause, at human speed, this costs nothing worth measuring — and unlike
   provoking a repaint (which Chrome is free to optimise away, because nothing
   visible actually changed) it always produces exactly the frame that belongs
   with the payload. */
async function __dbgSnapFrame() {
  const cast = __dbgCast;
  if (!cast) return;
  try {
    const shot = await cast.client.send('Page.captureScreenshot', { format: 'jpeg', quality: cast.quality });
    if (shot && shot.data) __dbgSend({ t: 'frame', buf: Buffer.from(shot.data, 'base64'), snap: true });
  } catch (_) {}
}

/* ── Control channel ─────────────────────────────────────────────────────── */
if (__dbgOn) {
  process.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    (async () => {
      switch (msg.t) {
        case 'resume':
          // 'step' stops at the next gate; 'run' goes until a breakpoint.
          __dbgMode = msg.mode === 'step' ? 'step' : 'run';
          if (msg.muteStep && msg.stepId) __dbgMuted.add(String(msg.stepId));
          // A specific park when the window names one, otherwise everything
          // parked — "continue" has to mean the run continues, not that one of
          // several stopped workers does.
          __dbgRelease(msg.seq);
          break;
        case 'pause':
          __dbgMode = 'step';
          break;
        case 'breakpoints':
          __dbgBreakpoints = new Set((msg.ids || []).map(String));
          break;
        case 'mute':
          if (msg.stepId) __dbgMuted.add(String(msg.stepId));
          break;
        case 'unmute':
          if (msg.stepId) __dbgMuted.delete(String(msg.stepId));
          break;
        case 'speed':
          __dbgSlowMoMs = Math.max(0, Math.min(10000, Number(msg.ms) || 0));
          break;
        case 'frameAck':
          if (__dbgCast && __dbgCast.onParentAck) __dbgCast.onParentAck();
          break;
        case 'snap':
          // Someone started watching a page that has already stopped changing.
          // There is no frame in flight and none coming, so the picture has to
          // be asked for.
          await __dbgSnapFrame();
          break;
        case 'input':
          await __dbgInput(msg);
          break;
        case 'quality':
          // The parent's pacer measured the link and wants a cheaper frame.
          // Quality is a start parameter, so this restarts the cast.
          if (__dbgCast) {
            await __dbgStartCast(__dbgCast.page, Math.max(20, Math.min(100, Number(msg.q) || 60)));
          }
          break;
        case 'probe': {
          const sels = (msg.selectors || []).map((s) => (
            typeof s === 'string' ? { value: s, type: /^\\(*\\//.test(s) ? 'xpath' : 'css' } : s
          ));
          __dbgSend({ t: 'probeResult', id: msg.id || null, result: await __dbgProbe(sels) });
          break;
        }
        case 'html': {
          const page = __dbgActivePage();
          let html = null;
          try { html = await __snapshotPageHtml(page); } catch (_) {}
          __dbgSend({ t: 'htmlResult', id: msg.id || null, html: html, url: __dbgSafeUrl(page) });
          break;
        }
        default:
          break;
      }
    })().catch(() => {});
  });
  __dbgSend({ t: 'hello', pid: process.pid });
}
`;
}

module.exports = { buildCodegenDebugHelper, DEBUG_SCREENCAST };
