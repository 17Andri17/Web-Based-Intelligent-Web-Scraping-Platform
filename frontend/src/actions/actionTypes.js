export const ACTION_TYPES = {
  // ── Navigation ───────────────────────────────────────────────
  NAVIGATE:            "NAVIGATE",
  GO_BACK:             "GO_BACK",
  RELOAD_PAGE:         "RELOAD_PAGE",
  OPEN_NEW_TAB:        "OPEN_NEW_TAB",
  SWITCH_TAB:          "SWITCH_TAB",

  // ── Interaction ──────────────────────────────────────────────
  CLICK_ELEMENT:       "CLICK_ELEMENT",
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

  // ── Data Handling ────────────────────────────────────────────
  SET_VARIABLE:        "SET_VARIABLE",
  TRANSFORM_DATA:      "TRANSFORM_DATA",
  APPEND_TO_LIST:      "APPEND_TO_LIST",
  SAVE_DATA:           "SAVE_DATA",
};