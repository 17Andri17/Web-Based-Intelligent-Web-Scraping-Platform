'use strict';

/* ===========================================================================
   CMP / Cookie-consent auto-dismiss
   ---------------------------------------------------------------------------
   One source of truth for the page-side "find and dismiss the cookie banner"
   logic, reused by BOTH:
     - the live editor session (injected via evaluateOnNewDocument in server.js)
     - generated scrape scripts (inlined by workflowCodegen.js)

   The core is `__consentApplyOnce(preference, registryOnly)` — pure DOM, no
   dependencies. It returns the handled CMP/source name (string) or null.

   Default behaviour is ACCEPT: as a scraper the goal is to remove the overlay
   and unblock content as reliably as possible, and the accept control is the
   one CMPs almost always render with a single, stably-labelled click. A
   'reject' preference is supported (prefers a one-click reject, else falls
   back to accept), and 'off' disables it entirely.

   Cooperation with the in-page SelectorTool: clicks are wrapped with
   window.__consentInProgress__ = true so the selector tool's capture-phase
   click handler lets the synthetic click through to the real button instead
   of treating it as an element selection. This is what keeps consent working
   while the user is in selection mode or switches modes mid-navigation.
   ========================================================================= */

const CONSENT_CASCADE_SRC = `
function __consentApplyOnce(preference, registryOnly) {
  preference = preference === 'reject' ? 'reject' : 'accept';

  // Cooldown: don't re-fire a click before the banner tears down (also avoids
  // fighting SPA re-renders that re-insert the banner momentarily).
  try {
    var _now = Date.now();
    if (window.__consentLastClick__ && _now - window.__consentLastClick__ < 1500) return null;
  } catch (_) {}

  function isVisible(el) {
    if (!el) return false;
    try {
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      var s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      if (parseFloat(s.opacity || '1') < 0.05) return false;
      return true;
    } catch (_) { return false; }
  }

  function clickEl(el) {
    if (!el) return false;
    try { if (el.scrollIntoView) el.scrollIntoView({ block: 'center' }); } catch (_) {}
    // Signal the selector tool (if present) to ignore this synthetic click.
    window.__consentInProgress__ = true;
    window.__consentLastClick__ = Date.now();
    var ok = false;
    try { el.click(); ok = true; } catch (_) {}
    setTimeout(function () { window.__consentInProgress__ = false; }, 0);
    return ok;
  }

  // Query a selector across the document AND any open shadow roots.
  function deepQueryOne(selector, root) {
    root = root || document;
    try { var direct = root.querySelector(selector); if (direct) return direct; } catch (_) {}
    var hosts;
    try { hosts = root.querySelectorAll('*'); } catch (_) { return null; }
    for (var i = 0; i < hosts.length; i++) {
      var sr = hosts[i].shadowRoot;
      if (sr) { var f = deepQueryOne(selector, sr); if (f) return f; }
    }
    return null;
  }
  function firstVisible(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = deepQueryOne(selectors[i]);
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  // ── Method 1: known-CMP registry (highest precision) ─────────────────────
  var REGISTRY = [
    { name: 'OneTrust',
      sig: function () { return !!(window.OneTrust || document.getElementById('onetrust-banner-sdk')); },
      accept: ['#onetrust-accept-btn-handler', '#accept-recommended-btn-handler'],
      reject: ['#onetrust-reject-all-handler', '.ot-pc-refuse-all-handler'] },
    { name: 'Cookiebot',
      sig: function () { return !!(window.Cookiebot || document.getElementById('CybotCookiebotDialog')); },
      accept: ['#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '#CybotCookiebotDialogBodyButtonAccept', '#CybotCookiebotDialogBodyLevelButtonAccept'],
      reject: ['#CybotCookiebotDialogBodyButtonDecline', '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll'] },
    { name: 'Didomi',
      sig: function () { return !!(window.Didomi || document.getElementById('didomi-notice')); },
      accept: ['#didomi-notice-agree-button', 'button[aria-label="Agree and close"]'],
      reject: ['.didomi-continue-without-agreeing', '#didomi-notice-disagree-button'] },
    { name: 'Quantcast',
      sig: function () { return !!(document.querySelector('.qc-cmp2-summary-buttons') || document.querySelector('[class*="qc-cmp2"]')); },
      accept: ['.qc-cmp2-summary-buttons button[mode="primary"]', '.qc-cmp2-footer button[mode="primary"]'],
      reject: ['.qc-cmp2-summary-buttons button[mode="secondary"]'] },
    { name: 'Usercentrics',
      sig: function () { return !!(window.UC_UI || document.querySelector('#usercentrics-root, [id^="usercentrics"]')); },
      accept: ['[data-testid="uc-accept-all-button"]', 'button[data-testid="uc-accept-all-button"]'],
      reject: ['[data-testid="uc-deny-all-button"]'],
      api: function (pref) {
        try {
          if (window.UC_UI && window.UC_UI.isInitialized && window.UC_UI.isInitialized()) {
            if (pref === 'reject') window.UC_UI.denyAllConsents(); else window.UC_UI.acceptAllConsents();
            return true;
          }
        } catch (_) {}
        return false;
      } },
    { name: 'Sourcepoint',
      sig: function () { return !!document.querySelector('[id^="sp_message_container"], .sp_choice_type_11'); },
      accept: ['.sp_choice_type_11', 'button[title="Accept"]', 'button[title="Accept all"]', 'button[aria-label="Accept all"]'],
      reject: ['.sp_choice_type_13', 'button[title="Reject all"]'] },
    { name: 'Osano',
      sig: function () { return !!(window.Osano || document.querySelector('.osano-cm-window')); },
      accept: ['.osano-cm-accept-all', '.osano-cm-accept'],
      reject: ['.osano-cm-denyAll', '.osano-cm-deny'] },
    { name: 'CookieYes',
      sig: function () { return !!document.querySelector('.cky-consent-container, [data-cky-tag]'); },
      accept: ['[data-cky-tag="accept-button"]', '.cky-btn-accept'],
      reject: ['[data-cky-tag="reject-button"]', '.cky-btn-reject'] },
    { name: 'Termly',
      sig: function () { return !!document.querySelector('#termly-code-snippet-support, [data-tid^="banner"]'); },
      accept: ['[data-tid="banner-accept"]', 'button[aria-label="Accept All"]'],
      reject: ['[data-tid="banner-decline"]'] },
    { name: 'Complianz',
      sig: function () { return !!document.querySelector('.cmplz-cookiebanner'); },
      accept: ['.cmplz-accept', 'button.cmplz-btn.cmplz-accept'],
      reject: ['.cmplz-deny'] },
    { name: 'Borlabs',
      sig: function () { return !!document.querySelector('#BorlabsCookieBox, ._brlbs-block-content'); },
      accept: ['#CookieBoxSaveButton', 'a[data-cookie-accept-all]', 'a[data-cookie-accept]'],
      reject: ['a[data-cookie-refuse]'] },
    { name: 'TrustArc',
      sig: function () { return !!document.querySelector('#truste-consent-track, .truste_box_overlay'); },
      accept: ['#truste-consent-button'],
      reject: ['#truste-consent-required'] },
    { name: 'CookieConsent',
      sig: function () { return !!document.querySelector('.cc-window, .cc-banner'); },
      accept: ['.cc-allow', '.cc-btn.cc-allow', 'a[aria-label="allow cookies"]', '.cc-dismiss'],
      reject: ['.cc-deny', '.cc-btn.cc-deny'] },
    { name: 'Klaro',
      sig: function () { return !!document.querySelector('.klaro .cookie-modal, .klaro .cn-body'); },
      accept: ['.klaro .cm-btn-success', '.klaro button.cm-btn-accept-all', '.klaro .cm-btn-accept-all'],
      reject: ['.klaro .cm-btn-decline'] },
    { name: 'Axeptio',
      sig: function () { return !!document.querySelector('#axeptio_overlay, .axeptio_mount'); },
      accept: ['#axeptio_btn_acceptAll', 'button[aria-label="Accept all"]'],
      reject: ['#axeptio_btn_dismiss', '#axeptio_btn_rejectAll'] }
  ];

  for (var r = 0; r < REGISTRY.length; r++) {
    var cmp = REGISTRY[r];
    var present = false;
    try { present = cmp.sig(); } catch (_) {}
    var wantReject = (preference === 'reject' && cmp.reject && cmp.reject.length);
    var btn = firstVisible(wantReject ? cmp.reject : cmp.accept);
    if (btn) { if (clickEl(btn)) return cmp.name; }
    // CMP present but selectors didn't resolve a button → try its JS API.
    if (present && cmp.api) { try { if (cmp.api(preference)) return cmp.name + ' (api)'; } catch (_) {} }
    // Reject requested but no reject control → fall back to accept.
    if (preference === 'reject' && !btn) {
      var acc = firstVisible(cmp.accept || []);
      if (acc) { if (clickEl(acc)) return cmp.name + ' (accept-fallback)'; }
    }
  }

  // In sub-frames we only run the cheap registry pass — the broad heuristic
  // below could mis-fire inside unrelated iframes (ads, embeds).
  if (registryOnly) return null;

  // ── Method 3: generic heuristic (covers the long tail) ───────────────────
  var ACCEPT_WORDS = ['accept all','accept all cookies','accept cookies','accept','agree','i agree','agree and close','agree & close','allow all','allow cookies','allow','got it','ok','okay','understood','continue','akzeptieren','alle akzeptieren','alle cookies akzeptieren','zustimmen','einverstanden','accepter','tout accepter',"j'accepte",'accepter et fermer','aceptar','aceptar todo','acepto','accetta','accetta tutto','aceitar','aceitar todos','akceptuj','akceptuje','akceptuj wszystko','zaakceptuj','zaakceptuj wszystko','zgadzam sie','zezwol na wszystkie','rozumiem','godkann alla','godta alle','hyvaksy kaikki','prihvati sve'];
  var REJECT_WORDS = ['reject all','reject','decline','deny','refuse','disagree','necessary only','only necessary','reject cookies','ablehnen','alle ablehnen','refuser','refuser tout','rechazar','rifiuta','recusar','odrzuc','odrzuc wszystko','nie zgadzam sie','tylko niezbedne','avvisa alla'];
  var BLOCK_WORDS = ['settings','manage','preferences','customize','customise','options','more info','learn more','ustawienia','zarzadzaj','preferencje','dostosuj','wiecej','einstellungen','verwalten','parametres','personnaliser','configurar','impostazioni','definicoes'];

  function norm(t) {
    var s = (t || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    // Strip diacritics so 'odrzuć' matches 'odrzuc', 'akzeptieren' → 'akzeptieren'.
    try { s = s.normalize('NFD').replace(/[\\u0300-\\u036f]/g, ''); } catch (_) {}
    return s;
  }
  // Token-prefix matching. Splitting into word tokens and testing
  // startsWith(phrase) tolerates inflection ('akceptuj' matches 'akceptuję'
  // → 'akceptuje') WITHOUT the substring false-positives that plagued plain
  // includes() — e.g. 'ok' is NOT found inside 'cookie', and 'agree' is NOT
  // found inside 'disagree'. Multi-word phrases are matched as a substring
  // anchored on a word boundary.
  function matchesWordList(text, words) {
    if (!text) return false;
    var toks = text.split(/[^a-z0-9]+/).filter(Boolean);
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (text === w) return true;
      if (w.indexOf(' ') !== -1) {
        var idx = text.indexOf(w);
        if (idx !== -1) {
          var before = idx === 0 ? ' ' : text.charAt(idx - 1);
          if (!/[a-z0-9]/.test(before)) return true;
        }
      } else {
        for (var j = 0; j < toks.length; j++) { if (toks[j].indexOf(w) === 0) return true; }
      }
    }
    return false;
  }
  function looksLikeConsentRegion(el) {
    var node = el;
    for (var d = 0; d < 6 && node && node !== document.body; d++) {
      try {
        var idc = ((node.id || '') + ' ' + (typeof node.className === 'string' ? node.className : '')).toLowerCase();
        if (/cookie|consent|gdpr|cmp|privacy|cc-window|cc-banner|notice/.test(idc)) return true;
        var cs = getComputedStyle(node);
        if (cs.position === 'fixed' || cs.position === 'sticky') {
          var z = parseInt(cs.zIndex || '0', 10);
          if (z >= 100 || node.getAttribute('role') === 'dialog' || node.getAttribute('aria-modal') === 'true') return true;
        }
      } catch (_) {}
      node = node.parentElement || (node.getRootNode && node.getRootNode() && node.getRootNode().host) || null;
    }
    return false;
  }
  // want = words that should be clicked; avoid = words that must NOT be
  // clicked (the block-list PLUS the opposite intent). avoid is authoritative
  // — a "Cookie settings" or "Nie zgadzam się / Disagree" button is skipped
  // even if it also brushes a want word.
  function scanForButton(root, want, avoid) {
    var candidates;
    try { candidates = root.querySelectorAll('button, a[role="button"], [role="button"], input[type="button"], input[type="submit"], a[href="#"]'); }
    catch (_) { return null; }
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (!isVisible(el)) continue;
      var txt = norm(el.innerText || el.textContent || el.value || el.getAttribute('aria-label'));
      if (!txt) continue;
      if (matchesWordList(txt, avoid)) continue;
      if (matchesWordList(txt, want) && looksLikeConsentRegion(el)) return el;
    }
    var hosts;
    try { hosts = root.querySelectorAll('*'); } catch (_) { hosts = []; }
    for (var h = 0; h < hosts.length; h++) {
      if (hosts[h].shadowRoot) { var f = scanForButton(hosts[h].shadowRoot, want, avoid); if (f) return f; }
    }
    return null;
  }

  var want  = preference === 'reject' ? REJECT_WORDS : ACCEPT_WORDS;
  var avoid = BLOCK_WORDS.concat(preference === 'reject' ? ACCEPT_WORDS : REJECT_WORDS);
  var hit = scanForButton(document, want, avoid);
  // reject preference with no reject control → fall back to accept.
  if (!hit && preference === 'reject') hit = scanForButton(document, ACCEPT_WORDS, BLOCK_WORDS.concat(REJECT_WORDS));
  if (hit) { if (clickEl(hit)) return 'heuristic'; }

  return null;
}
`;

/**
 * Self-contained script injected into the live editor session via
 * evaluateOnNewDocument. Installs an auto-runner (poll a few times + watch the
 * DOM for late/SPA banners) and exposes window.__dismissConsent__() for manual
 * triggering. Honours window.__CONSENT_PREF__ ('accept' | 'reject' | 'off').
 */
function buildInjectedConsentScript() {
  return `(function () {
  if (window.__CONSENT_RUNNER_INSTALLED__) return;
  window.__CONSENT_RUNNER_INSTALLED__ = true;
  if (typeof window.__CONSENT_PREF__ === 'undefined') window.__CONSENT_PREF__ = 'accept';

  ${CONSENT_CASCADE_SRC}

  var _isTop = false;
  try { _isTop = (window.top === window); } catch (_) { _isTop = false; }

  // Run the FULL cascade (registry + heuristic) in every frame — many CMPs
  // (Sourcepoint, TrustArc, Google Funding Choices, …) render their banner
  // inside a cross-origin iframe with a non-registry button, so a
  // registry-only pass there would miss them. The heuristic's consent-region
  // + block-word guards keep it from mis-clicking unrelated iframe buttons.
  window.__dismissConsent__ = function (pref) {
    try { return __consentApplyOnce(pref || window.__CONSENT_PREF__ || 'accept', false); }
    catch (e) { return null; }
  };

  // Throttle so a mutation-heavy page can't trigger the full cascade (which
  // walks shadow roots) more than ~2.5x/sec, regardless of mutation volume.
  var _lastRun = 0;
  function tryRun() {
    if (window.__CONSENT_PREF__ === 'off') return;
    var t = Date.now();
    if (t - _lastRun < 400) return;
    _lastRun = t;
    var name = window.__dismissConsent__();
    if (name) { try { console.log('🍪 Consent handled: ' + name); } catch (_) {} }
  }

  // Banners often inject after load — poll a handful of times over a few
  // seconds, and (top frame only) watch the DOM for late / SPA banners.
  var attempts = 0;
  var iv = setInterval(function () { attempts++; tryRun(); if (attempts >= 10) clearInterval(iv); }, 600);

  if (_isTop) {
    try {
      var mo = new MutationObserver(function () { tryRun(); });
      var start = function () {
        try { mo.observe(document.documentElement || document.body, { childList: true, subtree: true }); } catch (_) {}
      };
      if (document.body) start();
      else document.addEventListener('DOMContentLoaded', start, { once: true });
      setTimeout(function () { try { mo.disconnect(); } catch (_) {} }, 15000);
    } catch (_) {}
  }

  if (document.readyState !== 'loading') tryRun();
  else document.addEventListener('DOMContentLoaded', tryRun, { once: true });
})();`;
}

/**
 * Node-side helper source inlined into generated scrape scripts. Defines an
 * async `dismissConsent(targetPage)` that runs the cascade across every frame
 * (top frame = full, sub-frames = registry-only), retrying briefly to catch
 * late banners. Preference comes from process.env.SCRAPER_CONSENT (default
 * 'accept'); set it to 'off' to disable.
 */
function buildCodegenConsentHelper() {
  return `
// ─── Cookie-consent auto-dismiss (CMP banners) ─────────────────────────────
const __CONSENT_SRC = ${JSON.stringify(CONSENT_CASCADE_SRC)};
const __CONSENT_PREF = process.env.SCRAPER_CONSENT || 'accept';
async function dismissConsent(targetPage) {
  const pg = targetPage || (typeof page !== 'undefined' ? page : null);
  if (!pg || __CONSENT_PREF === 'off') return;
  for (let _a = 0; _a < 6; _a++) {
    let _hit = false;
    let _frames = [];
    try { _frames = pg.frames(); } catch (_) { try { _frames = [pg.mainFrame()]; } catch (_2) { _frames = []; } }
    for (const _frame of _frames) {
      try {
        const _name = await _frame.evaluate((src, pref) => {
          try {
            // eslint-disable-next-line no-new-func
            const fn = new Function('preference', src + '\\n;return __consentApplyOnce(preference, false);');
            return fn(pref);
          } catch (_) { return null; }
        }, __CONSENT_SRC, __CONSENT_PREF);
        if (_name) { _hit = true; try { console.log('🍪 Consent handled: ' + _name); } catch (_) {} }
      } catch (_) {}
    }
    if (_hit) break;
    await new Promise(r => setTimeout(r, 500));
  }
}
`;
}

module.exports = { CONSENT_CASCADE_SRC, buildInjectedConsentScript, buildCodegenConsentHelper };
