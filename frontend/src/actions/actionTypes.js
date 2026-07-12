export const ACTION_TYPES = {
  // ── Navigation ───────────────────────────────────────────────
  NAVIGATE:            "NAVIGATE",
  GO_BACK:             "GO_BACK",
  RELOAD_PAGE:         "RELOAD_PAGE",
  OPEN_NEW_TAB:        "OPEN_NEW_TAB",
  SWITCH_TAB:          "SWITCH_TAB",

  // ── Interaction ──────────────────────────────────────────────
  CLICK_ELEMENT:       "CLICK_ELEMENT",
  // Click the cookie-consent banner button if it shows up — never fails
  // when the banner is absent (consent may already be stored). With no
  // selector it falls back to the automatic CMP detection cascade.
  DISMISS_COOKIE_BANNER: "DISMISS_COOKIE_BANNER",
  // Detect and (if a solver is configured) solve a CAPTCHA / anti-bot
  // challenge. Free by default: with no solver it just flags the run — you
  // solve challenges by hand while building the scraper. See
  // docs/CAPTCHA_HANDLING.md.
  SOLVE_CAPTCHA:       "SOLVE_CAPTCHA",
  HOVER_ELEMENT:       "HOVER_ELEMENT",
  TYPE_TEXT:           "TYPE_TEXT",
  CLEAR_INPUT:         "CLEAR_INPUT",
  PRESS_KEY:           "PRESS_KEY",
  SCROLL_TO_ELEMENT:   "SCROLL_TO_ELEMENT",
  SCROLL_PAGE:         "SCROLL_PAGE",
  UPLOAD_FILE:         "UPLOAD_FILE",

  // ── Flow Control ─────────────────────────────────────────────
  WAIT:                "WAIT",
  WAIT_FOR_SELECTOR:   "WAIT_FOR_SELECTOR",
  WAIT_FOR_NAVIGATION: "WAIT_FOR_NAVIGATION",
  CONDITION:           "CONDITION",
  LOOP:                "LOOP",
  BREAK_LOOP:          "BREAK_LOOP",

  // ── Extraction ───────────────────────────────────────────────
  EXTRACT_TEXT:        "EXTRACT_TEXT",
  EXTRACT_ATTRIBUTE:   "EXTRACT_ATTRIBUTE",
  EXTRACT_HTML:        "EXTRACT_HTML",
  EXTRACT_TABLE:       "EXTRACT_TABLE",
  EXTRACT_LIST:        "EXTRACT_LIST",
  EXTRACT_JSON:        "EXTRACT_JSON",
  // Call the site's own data API directly (discovered by API Discovery) rather
  // than scraping the DOM — faster, cleaner pagination, more stable.
  EXTRACT_API:         "EXTRACT_API",
  // Like EXTRACT_LIST, but harvests items *while scrolling* and de-dupes by a
  // key — for infinite-scroll AND virtualized/recycling lists where items are
  // removed from the DOM once scrolled past (so a single end-of-page query
  // would miss most of them).
  COLLECT_LIST:        "COLLECT_LIST",

  // ── Data Handling ────────────────────────────────────────────
  SET_VARIABLE:        "SET_VARIABLE",
  TRANSFORM_DATA:      "TRANSFORM_DATA",
  APPEND_TO_LIST:      "APPEND_TO_LIST",
  SAVE_DATA:           "SAVE_DATA",

  // ── Composition ──────────────────────────────────────────────
  // Invoke another saved workflow as a "subflow" — typically used to
  // visit a list of detail-page URLs and run the same extraction logic
  // on each one. The subflow's steps are inlined into the generated
  // script with a fresh puppeteer page bound to the supplied URL.
  RUN_SUBFLOW:         "RUN_SUBFLOW",
};