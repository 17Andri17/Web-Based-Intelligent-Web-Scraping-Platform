(function forceSameTab() {
  'use strict';

  /* =========================================================================
     FORCE SAME-TAB NAVIGATION
     ─────────────────────────────────────────────────────────────────────────
     The platform streams a SINGLE browser tab — one CDP screencast bound to one
     puppeteer page (see Page.startScreencast in server.js), and BrowserManager
     caches exactly one page per user. Anything that opens a NEW tab/window
     therefore creates a separate page target the stream never switches to, so a
     click that "works" still looks like nothing happened: the product opened in
     an invisible tab. Marketplaces (e.g. erli.pl) routinely open product links
     in new tabs, which is exactly this case.

     We keep every navigation inside the streamed tab by:
       1. rewriting `target="_blank"` (and a page-wide `<base target="_blank">`)
          to `_self` just before the click's default action runs, and
       2. routing `window.open(url, …)` through same-tab navigation.

     This only acts in NAVIGATION mode. In selection mode the SelectorTool owns
     clicks (it preventDefaults to pick elements), so we deliberately stay out of
     its way and never rewrite anything.
     ========================================================================= */

  // Idempotent: the whole injection bundle is already guarded per-document, but
  // guard here too so a stray re-eval can't stack duplicate listeners.
  if (window.__FORCE_SAME_TAB_INIT__) return;
  window.__FORCE_SAME_TAB_INIT__ = true;

  var BLANK = { _blank: true, _new: true };

  function baseTargetIsBlank() {
    try {
      var b = document.querySelector('base[target]');
      return !!(b && BLANK[(b.getAttribute('target') || '').toLowerCase()]);
    } catch (_) { return false; }
  }

  // Nearest <a href> for the click, walking the composed path so links nested
  // inside open shadow roots (and the common image-wrapped-in-anchor case) are
  // found too.
  function anchorFromEvent(e) {
    var path = (typeof e.composedPath === 'function') ? e.composedPath() : null;
    if (path && path.length) {
      for (var i = 0; i < path.length; i++) {
        var n = path[i];
        if (n && n.tagName && n.tagName.toLowerCase() === 'a' && n.hasAttribute && n.hasAttribute('href')) {
          return n;
        }
      }
      return null;
    }
    var el = e.target;
    while (el && el.nodeType === 1) {
      if (el.tagName && el.tagName.toLowerCase() === 'a' && el.hasAttribute('href')) return el;
      el = el.parentElement;
    }
    return null;
  }

  function neutralizeTarget(el) {
    // Only rewrite the new-tab keywords. Leave `_self`, plain in-page links, and
    // named-frame targets (e.g. target="resultFrame") untouched.
    var t = (el.getAttribute('target') || '').toLowerCase();
    if (BLANK[t]) { el.setAttribute('target', '_self'); return; }
    if (!t && baseTargetIsBlank()) {
      // A page-wide <base target="_blank"> would send this otherwise-targetless
      // link to a new tab — pin it to the current one.
      el.setAttribute('target', '_self');
    }
  }

  // Capture phase: mutate `target` BEFORE the browser computes the click's
  // default navigation. We intentionally do NOT preventDefault — letting the
  // event run keeps SPA routers (Next.js/React links add their own click
  // handlers) working; they simply route inside the same tab now.
  document.addEventListener('click', function (e) {
    if (window.__SELECTION_MODE__) return;     // selection mode handles its own clicks
    if (window.__consentInProgress__) return;  // synthetic cookie-consent clicks
    if (e.defaultPrevented) return;
    var a = anchorFromEvent(e);
    if (a) neutralizeTarget(a);
  }, true);

  // Forms can also break out into a new tab via target="_blank" on submit.
  document.addEventListener('submit', function (e) {
    if (window.__SELECTION_MODE__) return;
    var f = e.target;
    if (f && f.tagName && f.tagName.toLowerCase() === 'form') {
      if (BLANK[(f.getAttribute('target') || '').toLowerCase()]) f.setAttribute('target', '_self');
    }
  }, true);

  // window.open(url, …) → navigate the current tab instead of spawning one the
  // stream can't see. Returning `window` keeps callers that read the result
  // (`var w = window.open(u); w && w.focus()`) from throwing on null.
  try {
    var nativeOpen = window.open;
    window.open = function (url, name, features) {
      if (url) {
        try { window.location.assign(String(url)); }
        catch (_) { try { window.location.href = String(url); } catch (__) {} }
        return window;
      }
      // No URL given (popup opened first, written to later) — preserve native
      // behavior rather than guessing.
      try { return nativeOpen.apply(window, arguments); } catch (_) { return null; }
    };
  } catch (_) {}

})();
