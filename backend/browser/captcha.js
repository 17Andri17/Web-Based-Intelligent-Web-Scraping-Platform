'use strict';

/* ===========================================================================
   CAPTCHA detection + solving glue
   ---------------------------------------------------------------------------
   One source of truth for the page-side "is there a captcha, and what is it"
   logic, reused by BOTH:
     - the live editor session (injected via evaluateOnNewDocument in server.js)
     - generated scrape scripts (inlined by workflowCodegen.js)

   Deliberately modelled on browser/consent.js — same "shared SRC string, two
   consumers" shape — so live-preview behaviour and real-run behaviour can't
   drift apart.

   ── Layers (see docs/CAPTCHA_HANDLING.md) ──────────────────────────────────
     1. AVOIDANCE   — the existing stealth stack + proxies (nothing here).
     2. DETECTION   — this file. Free, always on. Recognises the widget and
                      pulls the sitekey needed to solve it.
     3. SOLVING     — two paths that SHARE this detector:
          • Live editor: a human solves it in the streamed browser (free), OR
            an "auto-solve" click routes through captchaSolver.service.
          • Scrape run:  auto-solve via captchaSolver.service when a provider
            key is set; otherwise flag the run needs_review (free).

   The core is `__captchaDetectOnce()` — pure DOM, no deps. It inspects the
   CURRENT document only (callers run it per-frame, because reCAPTCHA/hCaptcha/
   Turnstile render inside cross-origin iframes) and returns:

       { present:true, type, sitekey, action?, provider, hint } | { present:false }

   `type` ∈ recaptcha_v2 | recaptcha_v3 | hcaptcha | turnstile |
           cloudflare_interstitial | image_captcha | generic

   Token injection (for the solved-token path) is `__captchaInjectToken(...)`.
   ========================================================================= */

// The token-solving provider client is authored once in the solver service
// and reused verbatim here so the inlined codegen client and the live backend
// client are the same code (see captchaSolver.service.js).
const { PROVIDER_CLIENT_SRC } = require('../services/captchaSolver.service');

/* ---------------------------------------------------------------------------
   CAPTCHA_DETECT_SRC — pure DOM. Defines __captchaDetectOnce() (per-document).
   --------------------------------------------------------------------------- */
const CAPTCHA_DETECT_SRC = `
var __captchaU = (function () {
  function vis(el) {
    if (!el) return false;
    try {
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      var s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.05) return false;
      return true;
    } catch (_) { return true; }
  }
  // Read a sitekey off an element's data-sitekey / data-* attributes.
  function attrKey(el) {
    if (!el) return null;
    return el.getAttribute('data-sitekey') || el.getAttribute('data-site-key') ||
           el.getAttribute('data-hcaptcha-sitekey') || el.getAttribute('sitekey') || null;
  }
  // Pull ?k= / ?sitekey= out of a widget iframe URL.
  function urlKey(src, param) {
    try { var u = new URL(src, location.href); return u.searchParams.get(param) || null; } catch (_) { return null; }
  }
  return { vis: vis, attrKey: attrKey, urlKey: urlKey };
})();

function __captchaDetectOnce() {
  var U = __captchaU;
  var here = '';
  try { here = location.href; } catch (_) {}

  // ── Cloudflare "checking your browser" / Turnstile-managed interstitial ──
  // These often clear THEMSELVES after a few seconds (no solve needed), so we
  // report them distinctly and callers wait rather than pay a solver.
  try {
    var cfMarker = document.querySelector('#challenge-running, #cf-challenge-running, #challenge-form, #trk_jschal_js, [id^="cf-chl"]');
    var bodyClass = (document.body && document.body.className || '') + '';
    var titleTxt = ((document.title || '') + '').toLowerCase();
    var htmlHasCf = false;
    try { htmlHasCf = /cf_chl_opt|__cf_chl|turnstile\\/v0\\/api|challenges\\.cloudflare\\.com/.test(document.documentElement.innerHTML.slice(0, 4000)); } catch (_) {}
    if (cfMarker || /just a moment|checking your browser|attention required/.test(titleTxt) || (htmlHasCf && /challenge/.test(bodyClass))) {
      // If a Turnstile widget with a sitekey is embedded, prefer solving it.
      var tf = document.querySelector('.cf-turnstile[data-sitekey], [data-sitekey][class*="turnstile" i]');
      if (tf) return { present: true, type: 'turnstile', sitekey: U.attrKey(tf), provider: 'cloudflare', hint: 'turnstile in interstitial' };
      return { present: true, type: 'cloudflare_interstitial', sitekey: null, provider: 'cloudflare', hint: (document.title || '').slice(0, 80) };
    }
  } catch (_) {}

  // ── Cloudflare Turnstile (standalone widget) ─────────────────────────────
  try {
    var ts = document.querySelector('.cf-turnstile, [data-sitekey][data-callback][class*="turnstile" i]');
    var tsFrame = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
    if (ts || tsFrame) {
      var tk = ts ? U.attrKey(ts) : null;
      if (!tk && tsFrame) tk = U.urlKey(tsFrame.getAttribute('src'), 'sitekey') || U.urlKey(tsFrame.getAttribute('src'), 'k');
      return { present: true, type: 'turnstile', sitekey: tk, provider: 'cloudflare', hint: 'cf-turnstile widget' };
    }
  } catch (_) {}

  // ── hCaptcha ─────────────────────────────────────────────────────────────
  try {
    var hc = document.querySelector('.h-captcha[data-sitekey], [data-hcaptcha-sitekey], [data-hcaptcha-widget-id]');
    var hcFrame = document.querySelector('iframe[src*="hcaptcha.com"], iframe[src*="assets.hcaptcha"]');
    if (hc || hcFrame) {
      var hk = hc ? (U.attrKey(hc)) : null;
      if (!hk && hcFrame) hk = U.urlKey(hcFrame.getAttribute('src'), 'sitekey');
      return { present: true, type: 'hcaptcha', sitekey: hk, provider: 'hcaptcha', hint: 'h-captcha widget' };
    }
  } catch (_) {}

  // ── Google reCAPTCHA ─────────────────────────────────────────────────────
  try {
    var rc = document.querySelector('.g-recaptcha[data-sitekey], [data-sitekey].g-recaptcha');
    var rcFrame = document.querySelector('iframe[src*="google.com/recaptcha/api2/anchor"], iframe[src*="recaptcha/api2/anchor"], iframe[src*="google.com/recaptcha/enterprise/anchor"]');
    var rcBadge = document.querySelector('.grecaptcha-badge');
    if (rc || rcFrame) {
      var rk = rc ? U.attrKey(rc) : null;
      if (!rk && rcFrame) rk = U.urlKey(rcFrame.getAttribute('src'), 'k');
      // v2 renders a visible anchor/checkbox; a lone badge with no anchor
      // frame is the invisible v3 flavour.
      var isInvisible = !!rcBadge && !rcFrame;
      return {
        present: true,
        type: isInvisible ? 'recaptcha_v3' : 'recaptcha_v2',
        sitekey: rk,
        action: (rc && rc.getAttribute('data-action')) || null,
        provider: 'recaptcha',
        hint: isInvisible ? 'reCAPTCHA v3 badge' : 'reCAPTCHA v2 widget'
      };
    }
    if (rcBadge) {
      return { present: true, type: 'recaptcha_v3', sitekey: null, provider: 'recaptcha', hint: 'reCAPTCHA v3 badge only' };
    }
  } catch (_) {}

  // ── Generic image / text CAPTCHA heuristic ───────────────────────────────
  // A form with an <img> whose src/alt/id screams "captcha" next to a short
  // text input. These need OCR-style solving (2captcha 'normal' method), which
  // we don't wire by default — but detecting it still lets us flag/pause.
  try {
    var img = document.querySelector(
      'img[src*="captcha" i], img[alt*="captcha" i], img[id*="captcha" i], img[class*="captcha" i]'
    );
    if (img && __captchaU.vis(img)) {
      return { present: true, type: 'image_captcha', sitekey: null, provider: 'image', hint: 'image captcha near a form' };
    }
    // Last-resort: an element that both mentions "captcha" in id/class AND is
    // visible. Kept strict to avoid false positives on the word appearing in
    // hidden analytics/consent scripts.
    var generic = document.querySelector('[id*="captcha" i]:not(script):not(style), [class*="captcha" i]:not(script):not(style)');
    if (generic && __captchaU.vis(generic)) {
      return { present: true, type: 'generic', sitekey: null, provider: 'generic', hint: (generic.id || generic.className || '').toString().slice(0, 80) };
    }
  } catch (_) {}

  return { present: false };
}
`;

/* ---------------------------------------------------------------------------
   CAPTCHA_INJECT_SRC — pure DOM. Defines __captchaInjectToken(type, token):
   places a solved token into the page's hidden response field(s) and fires the
   widget callback so the page proceeds as if the user solved it. Returns true
   on a plausible injection.
   --------------------------------------------------------------------------- */
const CAPTCHA_INJECT_SRC = `
function __captchaInjectToken(type, token) {
  if (!token) return false;
  var did = false;
  function setField(sel) {
    document.querySelectorAll(sel).forEach(function (ta) {
      try {
        ta.value = token;
        ta.innerHTML = token;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        did = true;
      } catch (_) {}
    });
  }
  try {
    if (type === 'recaptcha_v2' || type === 'recaptcha_v3') {
      setField('#g-recaptcha-response');
      setField('textarea[name="g-recaptcha-response"]');
      setField('textarea[id^="g-recaptcha-response"]');
    } else if (type === 'hcaptcha') {
      setField('textarea[name="h-captcha-response"]');
      setField('textarea[name="g-recaptcha-response"]'); // hCaptcha compat field
      setField('#h-captcha-response');
    } else if (type === 'turnstile') {
      setField('input[name="cf-turnstile-response"]');
      setField('textarea[name="cf-turnstile-response"]');
    } else {
      setField('#g-recaptcha-response');
    }
  } catch (_) {}

  // Best-effort: invoke a registered grecaptcha/hcaptcha callback so SPA forms
  // that gate a button on the callback (not just the field) unlock too.
  try {
    if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
      var clients = window.___grecaptcha_cfg.clients;
      Object.keys(clients).forEach(function (cid) {
        var c = clients[cid];
        Object.keys(c || {}).forEach(function (k) {
          var o = c[k];
          if (o && typeof o === 'object') {
            Object.keys(o).forEach(function (k2) {
              var inner = o[k2];
              if (inner && typeof inner.callback === 'function') {
                try { inner.callback(token); did = true; } catch (_) {}
              }
            });
          }
        });
      });
    }
  } catch (_) {}
  return did;
}
`;

/**
 * Live-editor injected script (evaluateOnNewDocument, every frame). Polls +
 * watches the DOM for a captcha and, when one appears, reports it once via the
 * sendToNode binding as { type:'captcha', ... }. Never blocks the page or the
 * user's own clicks — a human can solve the captcha directly in the stream.
 *
 * Honours window.__CAPTCHA_PREF__: 'notify' (default) reports detections;
 * 'off' disables detection entirely.
 */
function buildInjectedCaptchaScript() {
  return `(function () {
  if (window.__CAPTCHA_RUNNER_INSTALLED__) return;
  window.__CAPTCHA_RUNNER_INSTALLED__ = true;
  if (typeof window.__CAPTCHA_PREF__ === 'undefined') window.__CAPTCHA_PREF__ = 'notify';

  ${CAPTCHA_DETECT_SRC}
  ${CAPTCHA_INJECT_SRC}

  var _isTop = false;
  try { _isTop = (window.top === window); } catch (_) { _isTop = false; }

  // Expose for a manual/auto-solve trigger driven from the backend.
  window.__detectCaptcha__ = function () { try { return __captchaDetectOnce(); } catch (_) { return { present: false }; } };
  window.__injectCaptchaToken__ = function (type, token) { try { return __captchaInjectToken(type, token); } catch (_) { return false; } };

  var _lastSig = '';
  var _lastRun = 0;
  function tryRun() {
    if (window.__CAPTCHA_PREF__ === 'off') return;
    var t = Date.now();
    if (t - _lastRun < 500) return;
    _lastRun = t;
    var res = null;
    try { res = __captchaDetectOnce(); } catch (_) { res = null; }
    if (!res || !res.present) return;
    // De-dupe: only report a given (type+sitekey) once per page so a polling
    // loop or MutationObserver can't spam the frontend.
    var sig = (res.type || '') + '|' + (res.sitekey || '') + '|' + (_isTop ? 't' : 'f');
    if (sig === _lastSig) return;
    _lastSig = sig;
    try {
      if (typeof window.sendToNode === 'function') {
        window.sendToNode({
          type: 'captcha',
          captchaType: res.type,
          sitekey: res.sitekey || null,
          action: res.action || null,
          provider: res.provider || null,
          hint: res.hint || '',
          url: (function () { try { return location.href; } catch (_) { return ''; } })(),
          inIframe: !_isTop
        });
      }
    } catch (_) {}
  }

  // Captchas frequently mount after load (their script is async), so poll a
  // handful of times over ~10s and (top frame) watch the DOM for 45s.
  var attempts = 0;
  var iv = setInterval(function () { attempts++; tryRun(); if (attempts >= 18) clearInterval(iv); }, 600);

  if (_isTop) {
    try {
      var mo = new MutationObserver(function () { tryRun(); });
      var start = function () {
        try { mo.observe(document.documentElement || document.body, { childList: true, subtree: true }); } catch (_) {}
      };
      if (document.body) start();
      else document.addEventListener('DOMContentLoaded', start, { once: true });
      setTimeout(function () { try { mo.disconnect(); } catch (_) {} }, 45000);
    } catch (_) {}
  }

  if (document.readyState !== 'loading') tryRun();
  else document.addEventListener('DOMContentLoaded', tryRun, { once: true });
})();`;
}

/**
 * Node-side helper source inlined into generated scrape scripts. Defines:
 *
 *   detectCaptcha(page)                 → { present, type, sitekey, url, ... } | { present:false }
 *   solveCaptcha(page, opts)            → { present, solved, type, reason }
 *
 * `solveCaptcha` is the orchestrator used by NAVIGATE auto-handling and the
 * explicit SOLVE_CAPTCHA step:
 *   - detect across every frame;
 *   - a Cloudflare interstitial with no sitekey → WAIT for it to clear (they
 *     usually do) up to opts.maxWaitMs, no solver cost;
 *   - a solvable widget + a configured provider → get a token, inject it,
 *     optionally submit, and continue;
 *   - otherwise → (platform runs) print a CAPTCHA_DETECTED marker so the
 *     pipeline flags needs_review, and either throw (onUnsolved:'fail') or
 *     return unsolved (onUnsolved:'continue').
 *
 * The provider config is read from env at the SCRIPT's runtime, so downloaded
 * scripts opt in by setting CAPTCHA_PROVIDER / CAPTCHA_API_KEY themselves —
 * nothing secret is ever baked into generated code.
 *
 * `reportMarker` (codegen passes !clean) gates the machine-readable
 * CAPTCHA_DETECTED marker so downloaded scripts stay quiet.
 */
function buildCodegenCaptchaHelper(reportMarker) {
  const REPORT = reportMarker ? 'true' : 'false';
  return `
// ─── CAPTCHA detection + solving (see backend/browser/captcha.js) ───────────
const __CAPTCHA_DETECT_SRC = ${JSON.stringify(CAPTCHA_DETECT_SRC)};
const __CAPTCHA_INJECT_SRC = ${JSON.stringify(CAPTCHA_INJECT_SRC)};
const __CAPTCHA_REPORT = ${REPORT};
${PROVIDER_CLIENT_SRC}
function __captchaCfg() {
  var p = String(process.env.CAPTCHA_PROVIDER || 'none').trim().toLowerCase();
  if (p === '2captcha' || p === 'two-captcha' || p === 'twocaptcha') p = 'twocaptcha';
  else if (p === 'cap-solver') p = 'capsolver';
  else if (!p || p === 'off' || p === 'manual') p = 'none';
  return {
    provider: p,
    apiKey: process.env.CAPTCHA_API_KEY || '',
    timeoutMs: Number(process.env.CAPTCHA_HTTP_TIMEOUT_MS) || 20000,
    pollMs: Number(process.env.CAPTCHA_POLL_MS) || (p === 'twocaptcha' ? 5000 : 3000),
    overallTimeoutMs: Number(process.env.CAPTCHA_SOLVE_TIMEOUT_MS) || 180000,
  };
}
function __captchaProviderReady() {
  var c = __captchaCfg();
  return c.provider !== 'none' && !!c.apiKey;
}
const __CAPTCHA_SOLVABLE = { recaptcha_v2: 1, recaptcha_v3: 1, hcaptcha: 1, turnstile: 1 };

// Detect a captcha across every frame of the page (widgets live in iframes).
async function detectCaptcha(targetPage) {
  const pg = targetPage || (typeof page !== 'undefined' ? page : null);
  if (!pg) return { present: false };
  let frames = [];
  try { frames = pg.frames(); } catch (_) { try { frames = [pg.mainFrame()]; } catch (_2) { frames = []; } }
  for (const fr of frames) {
    try {
      const res = await fr.evaluate((src) => {
        try {
          // eslint-disable-next-line no-new-func
          const fn = new Function(src + '\\n;return __captchaDetectOnce();');
          return fn();
        } catch (_) { return { present: false }; }
      }, __CAPTCHA_DETECT_SRC);
      if (res && res.present) {
        let url = '';
        try { url = pg.url(); } catch (_) {}
        if (!res.url) res.url = url;
        res._frameUrl = (function () { try { return fr.url(); } catch (_) { return url; } })();
        return res;
      }
    } catch (_) {}
  }
  return { present: false };
}

async function __captchaInjectIntoPage(pg, type, token) {
  let frames = [];
  try { frames = pg.frames(); } catch (_) { frames = [pg.mainFrame()]; }
  let any = false;
  for (const fr of frames) {
    try {
      const ok = await fr.evaluate((src, t, tok) => {
        try {
          // eslint-disable-next-line no-new-func
          const fn = new Function('type', 'token', src + '\\n;return __captchaInjectToken(type, token);');
          return fn(t, tok);
        } catch (_) { return false; }
      }, __CAPTCHA_INJECT_SRC, type, token);
      if (ok) any = true;
    } catch (_) {}
  }
  return any;
}

// Wait for a Cloudflare-style interstitial to clear on its own.
async function __captchaWaitForClear(pg, maxWaitMs) {
  const deadline = Date.now() + (maxWaitMs || 20000);
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    const d = await detectCaptcha(pg);
    if (!d.present || d.type !== 'cloudflare_interstitial') return !d.present;
  }
  return false;
}

/**
 * opts = { onUnsolved:'continue'|'fail' (default 'continue'), maxWaitMs, stepLabel }
 */
async function solveCaptcha(targetPage, opts) {
  const pg = targetPage || (typeof page !== 'undefined' ? page : null);
  opts = opts || {};
  if (!pg) return { present: false, solved: false };
  if (String(process.env.CAPTCHA_HANDLING || '').toLowerCase() === 'off') return { present: false, solved: false };

  const det = await detectCaptcha(pg);
  if (!det.present) return { present: false, solved: false };

  const label = opts.stepLabel ? (' [' + opts.stepLabel + ']') : '';
  try { console.log('🧩 CAPTCHA detected' + label + ': ' + det.type + (det.sitekey ? ' (sitekey ' + String(det.sitekey).slice(0, 12) + '…)' : '')); } catch (_) {}

  // Cloudflare "just a moment" with no widget → let it settle itself.
  if (det.type === 'cloudflare_interstitial') {
    const cleared = await __captchaWaitForClear(pg, opts.maxWaitMs || 25000);
    if (cleared) { try { console.log('🧩 Cloudflare interstitial cleared on its own.'); } catch (_) {} return { present: true, solved: true, type: det.type }; }
    return __captchaUnsolved(det, opts, 'cloudflare interstitial did not clear');
  }

  // Solvable token widget + a configured provider → solve it.
  if (__CAPTCHA_SOLVABLE[det.type] && det.sitekey && __captchaProviderReady()) {
    const cfg = __captchaCfg();
    try { console.log('🧩 Requesting a solution from ' + cfg.provider + '…'); } catch (_) {}
    const out = await __captchaSolveToken(cfg, {
      type: det.type, sitekey: det.sitekey, url: det.url || det._frameUrl, action: det.action || null,
    });
    if (out && out.ok && out.token) {
      const injected = await __captchaInjectIntoPage(pg, det.type, out.token);
      try { console.log('🧩 CAPTCHA token ' + (injected ? 'injected' : 'obtained (no field to inject — page may read it via callback)') + '.'); } catch (_) {}
      // Give the page a moment to react to the token / callback.
      await new Promise(r => setTimeout(r, 1200));
      return { present: true, solved: true, type: det.type };
    }
    try { console.log('🧩 Solver failed: ' + (out && out.error ? out.error : 'unknown error')); } catch (_) {}
    return __captchaUnsolved(det, opts, out && out.error ? out.error : 'solver failed');
  }

  // No provider (free mode) or an unsolvable/image captcha → flag it.
  const why = !__captchaProviderReady()
    ? 'no solver configured (set CAPTCHA_PROVIDER + CAPTCHA_API_KEY, or solve it in the editor)'
    : (!det.sitekey ? 'could not read a sitekey' : 'captcha type not auto-solvable');
  return __captchaUnsolved(det, opts, why);
}

function __captchaUnsolved(det, opts, reason) {
  if (__CAPTCHA_REPORT) {
    try {
      console.log('CAPTCHA_DETECTED:' + JSON.stringify({
        type: det.type, sitekey: det.sitekey || null, provider: det.provider || null,
        url: det.url || det._frameUrl || null, reason: reason || null,
      }));
    } catch (_) {}
  }
  if ((opts && opts.onUnsolved) === 'fail') {
    throw new Error('CAPTCHA_DETECTED: ' + det.type + ' — ' + (reason || 'unsolved') + '. ' +
      'Configure a solver (CAPTCHA_PROVIDER/CAPTCHA_API_KEY) or solve it manually.');
  }
  try { console.log('🧩 Continuing without solving the captcha (' + (reason || 'unsolved') + '). Data may be blocked.'); } catch (_) {}
  return { present: true, solved: false, type: det.type, reason: reason || 'unsolved' };
}
`;
}

module.exports = {
  CAPTCHA_DETECT_SRC,
  CAPTCHA_INJECT_SRC,
  buildInjectedCaptchaScript,
  buildCodegenCaptchaHelper,
};
