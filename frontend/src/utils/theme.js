/* =====================================================================
   Theme

   Three states, not two:

     "dark"    — the DEFAULT. This is the palette the product is designed
                 in, and a light OS setting does not override it: someone
                 whose laptop is in light mode still gets the app the way it
                 was built unless they ask otherwise.
     "light"   — an explicit choice.
     "system"  — explicitly asking to follow the device, which is a real
                 preference but not the default one. Written to
                 <html data-theme="system"> so the CSS media query has
                 something to hang off; the app then tracks the machine live,
                 including a mid-session switch.

   Every state writes an attribute — there is no "no attribute" case — so a
   bare <html> can safely mean dark in the stylesheet.

   The choice is per-browser rather than per-account: it's a property of the
   screen you're looking at. Someone on a bright monitor at work and a dark
   laptop at night wants different answers on each, and syncing it to the
   account would fight them.

   applyTheme() is also called once before React mounts (see main.jsx) so the
   first paint is already right — otherwise a light-theme user gets a dark
   flash on every load.
   ===================================================================== */

const KEY = "ws.theme";
export const THEMES = ["system", "light", "dark"];
export const DEFAULT_THEME = "dark";

/** The stored preference, or the dark default when unset/invalid. */
export function getThemePreference() {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.includes(v) ? v : DEFAULT_THEME;
  } catch (_) {
    // Storage disabled (private mode, hardened browser) — take the default.
    return DEFAULT_THEME;
  }
}

/** Which theme is actually on screen right now, resolving "system". */
export function getResolvedTheme(pref = getThemePreference()) {
  if (pref === "light" || pref === "dark") return pref;
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch (_) {
    return DEFAULT_THEME;
  }
}

/**
 * Write the preference to <html> and (unless transient) persist it.
 * Every state sets the attribute, including "system" — the CSS keys its
 * follow-the-OS rule off data-theme="system", so a missing attribute is free
 * to mean "dark" and the default needs no JavaScript to be correct.
 */
export function applyTheme(pref, { persist = true } = {}) {
  const value = THEMES.includes(pref) ? pref : DEFAULT_THEME;
  const root = document.documentElement;

  // Freeze transitions across the swap so the change lands instantly instead
  // of every hover/focus transition in the app cross-fading at once. See the
  // matching [data-theme-switching] rule in app.css.
  const freeze = root.isConnected && typeof window !== "undefined";
  if (freeze) root.setAttribute("data-theme-switching", "");

  root.setAttribute("data-theme", value);

  if (freeze) {
    // Read a layout property to force the new values to be applied while
    // transitions are still suppressed, then release on the next frame.
    void root.offsetHeight;
    const release = () => root.removeAttribute("data-theme-switching");
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(release);
    else setTimeout(release, 0);
  }

  if (persist) {
    try { localStorage.setItem(KEY, value); } catch (_) { /* not fatal */ }
  }
  return value;
}

/**
 * Notify when the OS preference changes — only meaningful while the user is
 * on "system". Returns an unsubscribe function.
 */
export function onSystemThemeChange(fn) {
  let mq;
  try { mq = window.matchMedia("(prefers-color-scheme: light)"); } catch (_) { return () => {}; }
  const handler = () => fn(mq.matches ? "light" : "dark");
  // Safari < 14 only has the deprecated addListener.
  if (mq.addEventListener) mq.addEventListener("change", handler);
  else if (mq.addListener) mq.addListener(handler);
  return () => {
    if (mq.removeEventListener) mq.removeEventListener("change", handler);
    else if (mq.removeListener) mq.removeListener(handler);
  };
}
