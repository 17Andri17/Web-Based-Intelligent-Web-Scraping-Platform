import { ACTION_TYPES } from "./actionTypes";

export const actionDefinitions = {

  // ═══════════════════════════════════════════════════════════════════════════
  // NAVIGATION
  // ═══════════════════════════════════════════════════════════════════════════

  [ACTION_TYPES.NAVIGATE]: {
    label: "Go to URL",
    category: "Navigation",
    description: "Navigate the browser to a given URL",
    inputs: {
      url: {
        type: "string",
        required: true,
        label: "URL"
      }
    },
    advanced: {
      waitUntil: {
        type: "select",
        label: "Wait until",
        options: [
          { label: "Load", value: "load" },
          { label: "DOM Content Loaded", value: "domcontentloaded" },
          { label: "Network Idle", value: "networkidle" }
        ],
        default: "load"
      },
      timeout: {
        type: "number",
        label: "Timeout (ms)",
        default: 30000
      },
      retryCount: {
        type: "number",
        label: "Retry count",
        default: 0
      },
      onError: {
        type: "select",
        label: "If navigation fails",
        options: [
          { label: "Fail the step", value: "fail" },
          { label: "Retry", value: "retry" },
          { label: "Ignore and continue", value: "ignore" }
        ],
        default: "fail"
      },
      consent: {
        type: "select",
        label: "Cookie consent banner",
        options: [
          { label: "Accept automatically (default)", value: "accept" },
          { label: "Reject automatically", value: "reject" },
          { label: "Leave popup visible (do nothing)", value: "off" }
        ],
        default: "accept"
      },
      captcha: {
        type: "select",
        label: "CAPTCHA handling",
        options: [
          { label: "Auto (detect, wait out challenges, solve if a solver is set)", value: "auto" },
          { label: "Off (ignore CAPTCHAs)", value: "off" }
        ],
        default: "auto"
      }
    },
    outputs: {
      pageUrl: {
        type: "string",
        description: "Final URL after navigation"
      }
    },
    generateCode: ({ urlVar, outputVar, advancedOptions }) => {
      const {
        waitUntil = "load",
        timeout = 30000,
        retryCount = 0,
        onError = "fail"
      } = advancedOptions || {};

      return `
let ${outputVar} = null;

const navigate = async () => {
  await page.goto(${urlVar}, {
    waitUntil: "${waitUntil}",
    timeout: ${timeout}
  });
  return page.url();
};

let attempts = 0;
while (true) {
  try {
    ${outputVar} = await navigate();
    break;
  } catch (err) {
    attempts++;

    if ("${onError}" === "ignore") {
      console.warn("Navigation failed, continuing...");
      break;
    }

    if ("${onError}" === "retry" && attempts <= ${retryCount}) {
      console.warn("Retrying navigation...");
      continue;
    }

    throw err;
  }
}
    `;
    }
  },

  [ACTION_TYPES.GO_BACK]: {
    label: "Go Back",
    category: "Navigation",
    description: "Navigate to the previous page in browser history",
    inputs: {},
    advanced: {
      waitUntil: {
        type: "select",
        label: "Wait until",
        options: [
          { label: "Load", value: "load" },
          { label: "DOM Content Loaded", value: "domcontentloaded" },
          { label: "Network Idle", value: "networkidle" }
        ],
        default: "load"
      },
      timeout: {
        type: "number",
        label: "Timeout (ms)",
        default: 30000
      }
    },
    outputs: {
      pageUrl: { type: "string", description: "URL after going back" }
    },
    generateCode: ({ outputVar, advancedOptions }) => {
      const { waitUntil = "load", timeout = 30000 } = advancedOptions || {};
      return `
await page.goBack({ waitUntil: "${waitUntil}", timeout: ${timeout} });
const ${outputVar} = page.url();
`;
    }
  },

  [ACTION_TYPES.RELOAD_PAGE]: {
    label: "Reload Page",
    category: "Navigation",
    description: "Refresh the current page",
    inputs: {},
    advanced: {
      waitUntil: {
        type: "select",
        label: "Wait until",
        options: [
          { label: "Load", value: "load" },
          { label: "DOM Content Loaded", value: "domcontentloaded" },
          { label: "Network Idle", value: "networkidle" }
        ],
        default: "load"
      },
      timeout: {
        type: "number",
        label: "Timeout (ms)",
        default: 30000
      }
    },
    outputs: {},
    generateCode: ({ advancedOptions }) => {
      const { waitUntil = "load", timeout = 30000 } = advancedOptions || {};
      return `
await page.reload({ waitUntil: "${waitUntil}", timeout: ${timeout} });
`;
    }
  },

  [ACTION_TYPES.OPEN_NEW_TAB]: {
    label: "Open New Tab",
    category: "Navigation",
    description: "Open a URL in a new browser tab and switch to it",
    inputs: {
      url: {
        type: "string",
        required: true,
        label: "URL"
      }
    },
    advanced: {
      waitUntil: {
        type: "select",
        label: "Wait until",
        options: [
          { label: "Load", value: "load" },
          { label: "DOM Content Loaded", value: "domcontentloaded" },
          { label: "Network Idle", value: "networkidle" }
        ],
        default: "load"
      }
    },
    outputs: {
      tabIndex: { type: "number", description: "Index of the new tab" }
    },
    generateCode: ({ outputVar, advancedOptions, params }) => {
      const { waitUntil = "load" } = advancedOptions || {};
      return `
const newPage = await context.newPage();
await newPage.goto(${JSON.stringify(params.url)}, { waitUntil: "${waitUntil}" });
page = newPage;
const ${outputVar} = context.pages().length - 1;
`;
    }
  },

  [ACTION_TYPES.SWITCH_TAB]: {
    label: "Switch Tab",
    category: "Navigation",
    description: "Switch to a browser tab by index (0-based)",
    inputs: {
      tabIndex: {
        type: "number",
        required: true,
        label: "Tab index (0 = first)",
        default: 0
      }
    },
    advanced: {},
    outputs: {
      pageUrl: { type: "string", description: "URL of the activated tab" }
    },
    generateCode: ({ outputVar, params }) => `
const pages = context.pages();
if (${params.tabIndex} >= pages.length) throw new Error("Tab index out of range");
page = pages[${params.tabIndex}];
await page.bringToFront();
const ${outputVar} = page.url();
`
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERACTION
  // ═══════════════════════════════════════════════════════════════════════════

  [ACTION_TYPES.CLICK_ELEMENT]: {
    label: "Click Element",
    category: "Interaction",
    description: "Click on a DOM element matching the given selector",
    inputs: {
      selector: {
        type: "string",
        required: true,
        label: "Primary Selector"
      },
      selectorType: {
        type: "hidden",
        default: "css",
        label: "Selector type"
      },
      fallbackSelectors: {
        type: "selectorList",
        required: false,
        label: "Fallback Selectors",
        default: []
      },
    },
    advanced: {
      timeout: {
        type: "number",
        default: 10000,
        label: "Timeout (ms)"
      },
      waitForNavigation: {
        type: "boolean",
        default: false,
        label: "Wait for navigation after click"
      }
    },
    generateCode: ({ params, advancedOptions }) => {
      const { timeout = 10000, waitForNavigation = false } = advancedOptions || {};
      const selector = JSON.stringify(params.selector);
      return waitForNavigation
        ? `
await Promise.all([
  page.waitForNavigation({ timeout: ${timeout} }),
  page.click(${selector}, { timeout: ${timeout} })
]);
`
        : `
await page.click(${selector}, { timeout: ${timeout} });
`;
    }
  },

  [ACTION_TYPES.DISMISS_COOKIE_BANNER]: {
    label: "Close Cookie Banner",
    category: "Interaction",
    description: "Click the cookie-consent button if it appears. Never fails when the banner is absent (e.g. consent was already given on a previous visit). Leave the selector empty to use automatic banner detection.",
    inputs: {
      selector: {
        type: "string",
        required: false,
        label: "Banner button selector (optional — empty = automatic detection)"
      },
      selectorType: {
        type: "hidden",
        default: "css",
        label: "Selector type"
      },
      fallbackSelectors: {
        type: "selectorList",
        required: false,
        label: "Fallback Selectors",
        default: []
      },
    },
    advanced: {
      timeout: {
        type: "number",
        default: 8000,
        label: "How long to watch for the banner (ms)"
      },
      autoFallback: {
        type: "boolean",
        default: true,
        label: "If the selector isn't found, also try automatic detection"
      }
    },
    generateCode: ({ params }) => {
      if (!params.selector) return `\nawait dismissConsent(page); // automatic cookie-banner detection (never fails)\n`;
      return `
// Close cookie banner if present — never fails when absent
{
  const _el = await page.$(${JSON.stringify(params.selector)});
  if (_el) { try { await _el.click(); } catch (_) {} }
}
`;
    }
  },

  [ACTION_TYPES.SOLVE_CAPTCHA]: {
    label: "Solve CAPTCHA",
    category: "Interaction",
    description:
      "Detect a CAPTCHA / anti-bot challenge (reCAPTCHA, hCaptcha, Cloudflare Turnstile, Cloudflare 'Just a moment') and deal with it. " +
      "Cloudflare interstitials are waited out for free. Token challenges are solved automatically only when a solver is configured " +
      "(CAPTCHA_PROVIDER + CAPTCHA_API_KEY — e.g. CapSolver, ~$0.30–0.80/1000). With no solver it flags the run for review; while building a scraper you can just solve it in the live preview.",
    inputs: {},
    advanced: {
      onUnsolved: {
        type: "select",
        label: "If it can't be solved",
        options: [
          { label: "Continue anyway (flag the run)", value: "continue" },
          { label: "Fail the step", value: "fail" }
        ],
        default: "continue"
      },
      maxWaitMs: {
        type: "number",
        label: "Max wait for a self-clearing challenge (ms)",
        default: 25000
      }
    },
    outputs: {},
    // Real code generation is on the backend (workflowCodegen.js SOLVE_CAPTCHA),
    // which inlines the detector + solver. This placeholder keeps the
    // "Download code" path valid.
    generateCode: () => `
// Solve CAPTCHA if present (detector + solver inlined by the backend)
await solveCaptcha(page, { onUnsolved: "continue" });
`
  },

  [ACTION_TYPES.HOVER_ELEMENT]: {
    label: "Hover Element",
    category: "Interaction",
    description: "Move the mouse over an element to trigger hover state",
    inputs: {
      selector: {
        type: "string",
        required: true,
        label: "Selector"
      }
    },
    advanced: {
      timeout: { type: "number", default: 10000, label: "Timeout (ms)" }
    },
    outputs: {},
    generateCode: ({ params, advancedOptions }) => {
      const { timeout = 10000 } = advancedOptions || {};
      return `
await page.hover(${JSON.stringify(params.selector)}, { timeout: ${timeout} });
`;
    }
  },

  [ACTION_TYPES.TYPE_TEXT]: {
    label: "Type Text",
    category: "Interaction",
    description: "Type text into an input field",
    inputs: {
      selector: {
        type: "string",
        required: true,
        label: "Selector"
      },
      selectorType: {
        type: "hidden",
        default: "css",
        label: "Selector type"
      },
      text: {
        type: "string",
        required: true,
        label: "Text to type"
      }
    },
    advanced: {
      delay: {
        type: "number",
        label: "Delay between keystrokes (ms)",
        default: 0
      },
      clearFirst: {
        type: "boolean",
        label: "Clear field before typing",
        default: true
      },
      pressEnter: {
        type: "boolean",
        label: "Press Enter after typing",
        default: false
      }
    },
    outputs: {},
    generateCode: ({ params, advancedOptions }) => {
      const { delay = 0, clearFirst = true, pressEnter = false } = advancedOptions || {};
      const sel = JSON.stringify(params.selector);
      const text = JSON.stringify(params.text);
      return `
${clearFirst ? `await page.fill(${sel}, "");` : ""}
await page.type(${sel}, ${text}, { delay: ${delay} });
${pressEnter ? `await page.press(${sel}, "Enter");` : ""}
`;
    }
  },

  [ACTION_TYPES.CLEAR_INPUT]: {
    label: "Clear Input",
    category: "Interaction",
    description: "Clear the value of an input field",
    inputs: {
      selector: {
        type: "string",
        required: true,
        label: "Selector"
      }
    },
    advanced: {},
    outputs: {},
    generateCode: ({ params }) => `
await page.fill(${JSON.stringify(params.selector)}, "");
`
  },

  [ACTION_TYPES.PRESS_KEY]: {
    label: "Press Key",
    category: "Interaction",
    description: "Simulate a keyboard key press (e.g. Enter, Tab, Escape, ArrowDown)",
    inputs: {
      key: {
        type: "string",
        required: true,
        label: "Key name",
        placeholder: "Enter, Tab, Escape, ArrowDown…"
      },
      selector: {
        type: "string",
        required: false,
        label: "Target element selector (optional, uses focused element if empty)"
      }
    },
    advanced: {
      count: {
        type: "number",
        label: "Number of times to press",
        default: 1
      }
    },
    outputs: {},
    generateCode: ({ params, advancedOptions }) => {
      const { count = 1 } = advancedOptions || {};
      const key = JSON.stringify(params.key);
      const lines = params.selector
        ? `for (let _i = 0; _i < ${count}; _i++) await page.press(${JSON.stringify(params.selector)}, ${key});`
        : `for (let _i = 0; _i < ${count}; _i++) await page.keyboard.press(${key});`;
      return `\n${lines}\n`;
    }
  },

  [ACTION_TYPES.SCROLL_TO_ELEMENT]: {
    label: "Scroll To Element",
    category: "Interaction",
    description: "Scroll the page until an element is in view",
    inputs: {
      selector: {
        type: "string",
        required: true,
        label: "Selector"
      }
    },
    advanced: {
      behavior: {
        type: "select",
        label: "Scroll behavior",
        options: [
          { label: "Auto", value: "auto" },
          { label: "Smooth", value: "smooth" }
        ],
        default: "auto"
      }
    },
    outputs: {},
    generateCode: ({ params, advancedOptions }) => {
      const { behavior = "auto" } = advancedOptions || {};
      return `
await page.$eval(${JSON.stringify(params.selector)}, (el) =>
  el.scrollIntoView({ behavior: "${behavior}", block: "center" })
);
`;
    }
  },

  [ACTION_TYPES.SCROLL_PAGE]: {
    label: "Scroll Page",
    category: "Interaction",
    description: "Scroll the page by a pixel amount or to the bottom",
    inputs: {
      direction: {
        type: "select",
        required: true,
        label: "Direction",
        options: [
          { label: "Down", value: "down" },
          { label: "Up", value: "up" },
          { label: "To Bottom", value: "bottom" },
          { label: "To Top", value: "top" }
        ],
        default: "down"
      },
      amount: {
        type: "number",
        label: "Amount (px) — ignored for top/bottom",
        default: 500
      }
    },
    advanced: {
      behavior: {
        type: "select",
        label: "Scroll behavior",
        options: [
          { label: "Auto", value: "auto" },
          { label: "Smooth", value: "smooth" }
        ],
        default: "auto"
      }
    },
    outputs: {},
    generateCode: ({ params, advancedOptions }) => {
      const { behavior = "auto" } = advancedOptions || {};
      const dir = params.direction || "down";
      const amount = params.amount || 500;
      if (dir === "bottom") {
        return `\nawait page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "${behavior}" }));\n`;
      }
      if (dir === "top") {
        return `\nawait page.evaluate(() => window.scrollTo({ top: 0, behavior: "${behavior}" }));\n`;
      }
      const delta = dir === "up" ? -amount : amount;
      return `\nawait page.evaluate(() => window.scrollBy({ top: ${delta}, behavior: "${behavior}" }));\n`;
    }
  },

  [ACTION_TYPES.UPLOAD_FILE]: {
    label: "Upload File",
    category: "Interaction",
    description: "Upload a file to an <input type=\"file\"> element",
    inputs: {
      selector: {
        type: "string",
        required: true,
        label: "File input selector"
      },
      filePath: {
        type: "string",
        required: true,
        label: "Absolute path to file on disk"
      }
    },
    advanced: {},
    outputs: {},
    generateCode: ({ params }) => `
const fileInput = await page.$(${JSON.stringify(params.selector)});
await fileInput.setInputFiles(${JSON.stringify(params.filePath)});
`
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // FLOW CONTROL
  // ═══════════════════════════════════════════════════════════════════════════

  [ACTION_TYPES.WAIT]: {
    label: "Wait",
    category: "Flow Control",
    description: "Pause execution for a fixed number of milliseconds",
    inputs: {
      duration: {
        type: "number",
        required: true,
        label: "Duration (ms)",
        default: 1000
      }
    },
    advanced: {},
    outputs: {},
    generateCode: ({ params }) => `
await new Promise(resolve => setTimeout(resolve, ${params.duration ?? 1000}));
`
  },

  [ACTION_TYPES.WAIT_FOR_SELECTOR]: {
    label: "Wait for Selector",
    category: "Flow Control",
    description: "Pause until a CSS selector appears (or disappears) in the DOM",
    inputs: {
      selector: {
        type: "string",
        required: true,
        label: "Selector"
      }
    },
    advanced: {
      state: {
        type: "select",
        label: "Wait for element to be",
        options: [
          { label: "Attached (in DOM)", value: "attached" },
          { label: "Visible", value: "visible" },
          { label: "Hidden", value: "hidden" },
          { label: "Detached (removed)", value: "detached" }
        ],
        default: "visible"
      },
      timeout: { type: "number", label: "Timeout (ms)", default: 30000 }
    },
    outputs: {},
    generateCode: ({ params, advancedOptions }) => {
      const { state = "visible", timeout = 30000 } = advancedOptions || {};
      return `
await page.waitForSelector(${JSON.stringify(params.selector)}, { state: "${state}", timeout: ${timeout} });
`;
    }
  },

  [ACTION_TYPES.WAIT_FOR_NAVIGATION]: {
    label: "Wait for Navigation",
    category: "Flow Control",
    description: "Wait for the browser to finish navigating to a new page",
    inputs: {},
    advanced: {
      waitUntil: {
        type: "select",
        label: "Wait until",
        options: [
          { label: "Load", value: "load" },
          { label: "DOM Content Loaded", value: "domcontentloaded" },
          { label: "Network Idle", value: "networkidle" }
        ],
        default: "load"
      },
      timeout: { type: "number", label: "Timeout (ms)", default: 30000 }
    },
    outputs: {
      pageUrl: { type: "string", description: "URL after navigation" }
    },
    generateCode: ({ outputVar, advancedOptions }) => {
      const { waitUntil = "load", timeout = 30000 } = advancedOptions || {};
      return `
await page.waitForNavigation({ waitUntil: "${waitUntil}", timeout: ${timeout} });
const ${outputVar} = page.url();
`;
    }
  },

  [ACTION_TYPES.CONDITION]: {
    label: "Condition (If / Else)",
    category: "Flow Control",
    description: "Branch execution based on a JavaScript expression",
    inputs: {
      expression: {
        type: "string",
        required: true,
        label: "Condition expression (JS)",
        placeholder: "e.g.  myVar !== null  or  results.length > 0"
      }
    },
    advanced: {
      onError: {
        type: "select",
        label: "If expression throws",
        options: [
          { label: "Treat as false", value: "false" },
          { label: "Fail the step", value: "fail" }
        ],
        default: "fail"
      }
    },
    outputs: {
      conditionResult: { type: "boolean", description: "Result of the condition" }
    },
    generateCode: ({ outputVar, params, advancedOptions }) => {
      const { onError = "fail" } = advancedOptions || {};
      return `
let ${outputVar};
try {
  ${outputVar} = Boolean(${params.expression});
} catch (_condErr) {
  if ("${onError}" === "fail") throw _condErr;
  ${outputVar} = false;
}
// The workflow engine routes to the "then" branch when ${outputVar} === true,
// and to the "else" branch when ${outputVar} === false.
`;
    }
  },

  [ACTION_TYPES.LOOP]: {
    label: "Loop / For Each",
    category: "Flow Control",
    description: "Iterate over a list of elements or a fixed number of times",
    inputs: {
      mode: {
        type: "select",
        required: true,
        label: "Loop mode",
        options: [
          { label: "For Each (iterate over a variable)", value: "forEach" },
          { label: "Fixed count", value: "count" },
          { label: "While expression", value: "while" }
        ],
        default: "forEach"
      },
      source: {
        type: "string",
        label: "Source variable name (for forEach)",
        placeholder: "e.g. extractedLinks"
      },
      count: {
        type: "number",
        label: "Number of iterations (for fixed count)",
        default: 10
      },
      whileExpression: {
        type: "string",
        label: "Continue while expression is true",
        placeholder: "e.g. page.url() !== targetUrl"
      }
    },
    advanced: {
      maxIterations: {
        type: "number",
        label: "Max iterations (safety cap)",
        default: 1000
      },
      itemVar: {
        type: "string",
        label: "Loop item variable name",
        default: "item"
      },
      indexVar: {
        type: "string",
        label: "Loop index variable name",
        default: "index"
      }
    },
    outputs: {},
    // The workflow engine is responsible for executing child steps;
    // generateCode emits the loop header/footer markers.
    generateCode: ({ params, advancedOptions }) => {
      const { maxIterations = 1000, itemVar = "item", indexVar = "index" } = advancedOptions || {};
      const mode = params.mode || "forEach";
      if (mode === "forEach") {
        return `
// LOOP_START: forEach
for (let ${indexVar} = 0; ${indexVar} < Math.min((${params.source} || []).length, ${maxIterations}); ${indexVar}++) {
  const ${itemVar} = ${params.source}[${indexVar}];
  // → child steps run here
}
// LOOP_END
`;
      }
      if (mode === "count") {
        return `
// LOOP_START: count
for (let ${indexVar} = 0; ${indexVar} < Math.min(${params.count || 10}, ${maxIterations}); ${indexVar}++) {
  const ${itemVar} = ${indexVar};
  // → child steps run here
}
// LOOP_END
`;
      }
      // while
      return `
// LOOP_START: while
let _loopGuard = 0;
while ((${params.whileExpression || "false"}) && _loopGuard < ${maxIterations}) {
  _loopGuard++;
  // → child steps run here
}
// LOOP_END
`;
    }
  },

  [ACTION_TYPES.BREAK_LOOP]: {
    label: "Break Loop",
    category: "Flow Control",
    description: "Exit the current loop early",
    inputs: {},
    advanced: {},
    outputs: {},
    generateCode: () => `\nbreak;\n`
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // EXTRACTION
  // ═══════════════════════════════════════════════════════════════════════════

  [`${ACTION_TYPES.EXTRACT_TEXT}`]: {
    label: "Extract Text",
    category: "Extraction",
    description: "Extract text content from an element using CSS selectors",
    inputs: {
      selector: {
        type: "string",
        required: true,
        label: "Primary Selector"
      },
      selectorType: {
        type: "hidden",
        default: "css",
        label: "Selector type"
      },
      fallbackSelectors: {
        type: "selectorList",
        default: [],
        label: "Fallback Selectors"
      },
      multiple: {
        type: "boolean",
        default: false,
        label: "Extract multiple elements"
      }
    },
    advanced: {
      onMultipleFound: {
        type: "select",
        label: "If multiple elements found when multiple=false",
        options: [
          { label: "Fail the step", value: "fail" },
          { label: "Take first element", value: "first" },
          { label: "Join all into one string", value: "join" }
        ],
        default: "first"
      },
      onNotFound: {
        type: "select",
        label: "If element not found",
        options: [
          { label: "Fail the step", value: "fail" },
          { label: "Set output as null", value: "null" },
          { label: "Set output as empty string", value: "empty" }
        ],
        default: "fail"
      }
    },
    outputs: {
      result: { type: "array|string" }
    },
    generateCode: (step) => {
      const { params, advanced, outputVar } = step;
      const selector = JSON.stringify(params.selector);
      const fallback = JSON.stringify(params.fallbackSelectors || []);
      const multiple = params.multiple;
      const onMultiple = advanced?.onMultipleFound || "first";
      const onNotFound = advanced?.onNotFound || "fail";

      return `
let ${outputVar} = null;

const handleMultiple = (values) => {
  if (${multiple}) return values;

  switch ("${onMultiple}") {
    case "fail":
      if (values.length > 1) throw new Error("Multiple elements found");
      return values[0] || null;
    case "first":
      return values[0] || null;
    case "join":
      return values.join(" ");
    default:
      return values[0] || null;
  }
};

const handleNotFound = () => {
  switch ("${onNotFound}") {
    case "fail":
      throw new Error("Element not found: ${params.selector}");
    case "null":
      return null;
    case "empty":
      return "";
    default:
      return null;
  }
};

try {
  const values = await page.$$eval(${selector}, els => els.map(e => e.textContent.trim()));

  if (!values || values.length === 0) {
    ${outputVar} = handleNotFound();
  } else {
    ${outputVar} = handleMultiple(values);
  }

} catch (err) {
  for (const fallbackSelector of ${fallback}) {
    try {
      const values = await page.$$eval(fallbackSelector, els => els.map(e => e.textContent.trim()));

      if (!values || values.length === 0) {
        ${outputVar} = handleNotFound();
      } else {
        ${outputVar} = handleMultiple(values);
      }

      break;
    } catch {}
  }
}
`;
    }
  },

  [ACTION_TYPES.EXTRACT_ATTRIBUTE]: {
    label: "Extract Attribute",
    category: "Extraction",
    description: "Get the value of an HTML attribute (e.g. href, src, data-*) from one or more elements",
    inputs: {
      selector: {
        type: "string",
        required: true,
        label: "Selector"
      },
      selectorType: {
        type: "hidden",
        default: "css",
        label: "Selector type"
      },
      attribute: {
        type: "string",
        required: true,
        label: "Attribute name",
        placeholder: "href, src, data-id…"
      },
      multiple: {
        type: "boolean",
        default: false,
        label: "Extract from all matching elements"
      }
    },
    advanced: {
      onNotFound: {
        type: "select",
        label: "If element not found",
        options: [
          { label: "Fail the step", value: "fail" },
          { label: "Return null", value: "null" }
        ],
        default: "null"
      }
    },
    outputs: {
      result: { type: "string|array", description: "Attribute value(s)" }
    },
    generateCode: ({ params, advancedOptions, outputVar }) => {
      const { onNotFound = "null" } = advancedOptions || {};
      const sel = JSON.stringify(params.selector);
      const attr = JSON.stringify(params.attribute);
      if (params.multiple) {
        return `
const ${outputVar} = await page.$$eval(${sel}, (els, a) => els.map(e => e.getAttribute(a)), ${attr});
`;
      }
      return `
const ${outputVar}_el = await page.$(${sel});
${onNotFound === "fail"
  ? `if (!${outputVar}_el) throw new Error("Element not found: ${params.selector}");`
  : `if (!${outputVar}_el) { var ${outputVar} = null; }`}
${onNotFound === "fail" ? `const ${outputVar} = await ${outputVar}_el.getAttribute(${attr});` : `else { var ${outputVar} = await ${outputVar}_el.getAttribute(${attr}); }`}
`;
    }
  },

  [ACTION_TYPES.EXTRACT_HTML]: {
    label: "Extract HTML",
    category: "Extraction",
    description: "Extract the raw inner or outer HTML of an element",
    inputs: {
      selector: {
        type: "string",
        required: true,
        label: "Selector"
      },
      selectorType: {
        type: "hidden",
        default: "css",
        label: "Selector type"
      },
      mode: {
        type: "select",
        label: "HTML mode",
        options: [
          { label: "Inner HTML", value: "inner" },
          { label: "Outer HTML", value: "outer" }
        ],
        default: "inner"
      }
    },
    advanced: {
      onNotFound: {
        type: "select",
        label: "If element not found",
        options: [
          { label: "Fail the step", value: "fail" },
          { label: "Return null", value: "null" }
        ],
        default: "fail"
      }
    },
    outputs: {
      result: { type: "string", description: "HTML content" }
    },
    generateCode: ({ params, advancedOptions, outputVar }) => {
      const { onNotFound = "fail" } = advancedOptions || {};
      const sel = JSON.stringify(params.selector);
      const prop = params.mode === "outer" ? "outerHTML" : "innerHTML";
      return `
let ${outputVar} = null;
try {
  ${outputVar} = await page.$eval(${sel}, el => el.${prop});
} catch (_e) {
  if ("${onNotFound}" === "fail") throw _e;
}
`;
    }
  },

  [ACTION_TYPES.EXTRACT_TABLE]: {
    label: "Extract Table",
    category: "Extraction",
    description: "Parse an HTML <table> into an array of objects keyed by header row",
    inputs: {
      selector: {
        type: "string",
        required: true,
        label: "Table selector",
        default: "table"
      },
      hasHeader: {
        type: "boolean",
        label: "First row is a header row",
        default: true
      }
    },
    advanced: {
      trimWhitespace: {
        type: "boolean",
        label: "Trim cell whitespace",
        default: true
      }
    },
    outputs: {
      result: { type: "array", description: "Array of row objects" }
    },
    generateCode: ({ params, advancedOptions, outputVar }) => {
      const { trimWhitespace = true } = advancedOptions || {};
      const sel = JSON.stringify(params.selector);
      const hasHeader = params.hasHeader !== false;
      return `
const ${outputVar} = await page.$eval(${sel}, (table, opts) => {
  const rows = Array.from(table.querySelectorAll("tr"));
  const clean = (s) => opts.trim ? s.trim() : s;

  if (opts.hasHeader && rows.length > 0) {
    const headers = Array.from(rows[0].querySelectorAll("th, td")).map(c => clean(c.textContent));
    return rows.slice(1).map(row => {
      const cells = Array.from(row.querySelectorAll("td, th")).map(c => clean(c.textContent));
      return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? null]));
    });
  }

  return rows.map(row =>
    Array.from(row.querySelectorAll("td, th")).map(c => clean(c.textContent))
  );
}, { trim: ${trimWhitespace}, hasHeader: ${hasHeader} });
`;
    }
  },

  [ACTION_TYPES.EXTRACT_LIST]: {
    label: "Extract List",
    category: "Extraction",
    description: "Extract repeated structured items. Each field has its own selector (relative to the container) and an extraction kind — text, attribute, or innerHTML. ✨ AI can auto-detect fields from a sample item.",
    inputs: {
      containerSelector: {
        type: "string",
        required: true,
        label: "Container selector (repeating parent)",
        placeholder: "e.g. .product-card"
      },
      fields: {
        // The custom 'keyvalue' renderer wires up ExtractListFieldsEditor,
        // which is where the AI auto-detect button + per-field UI lives.
        type: "keyvalue",
        required: true,
        label: "Fields",
      },
    },
    outputs: {
      result: { type: "array", description: "Array of extracted objects" }
    },
    generateCode: ({ params, outputVar }) => {
      // Normalise the field map into the rich shape, matching the
      // backend's workflowCodegen.js behaviour. Both forms are supported
      // for backward compatibility — see ExtractListFieldsEditor for the
      // canonical shape.
      const rawFields = params.fields || {};
      const normalised = {};
      for (const [name, v] of Object.entries(rawFields)) {
        if (v == null) continue;
        if (typeof v === "string") {
          normalised[name] = { selector: v, kind: "text", attribute: null };
        } else if (typeof v === "object") {
          const kind = v.kind === "attr" || v.kind === "attribute" ? "attr"
                     : v.kind === "html" ? "html"
                     : "text";
          normalised[name] = {
            selector: typeof v.selector === "string" ? v.selector : "",
            kind,
            attribute: kind === "attr" && typeof v.attribute === "string" ? v.attribute : null,
          };
        }
      }
      const fieldsJson = JSON.stringify(normalised);
      return `
const ${outputVar} = await page.$$eval(
  ${JSON.stringify(params.containerSelector)},
  (containers, fields) => containers.map(container => {
    const item = {};
    for (const [name, spec] of Object.entries(fields)) {
      const sel = spec.selector || "";
      const child = sel ? container.querySelector(sel) : container;
      if (!child) { item[name] = null; continue; }
      if (spec.kind === "attr" && spec.attribute) {
        item[name] = child.getAttribute(spec.attribute);
      } else if (spec.kind === "html") {
        item[name] = (child.innerHTML || "").trim();
      } else {
        item[name] = (child.textContent || "").trim();
      }
    }
    return item;
  }),
  ${fieldsJson}
);
`;
    }
  },

  [ACTION_TYPES.COLLECT_LIST]: {
    label: "Collect List (infinite / virtual scroll)",
    category: "Extraction",
    description:
      "Extract a repeating list that grows as you scroll — including virtualized lists that REMOVE items from the DOM once scrolled past. " +
      "It harvests the visible items on every scroll step and de-dupes by a key you choose, so nothing is missed or double-counted. " +
      "Use this instead of Extract List when the page lazy-loads on scroll or recycles rows.",
    inputs: {
      containerSelector: {
        type: "string",
        required: true,
        label: "Container selector (repeating item)",
        placeholder: "e.g. .product-card",
      },
      fields: {
        // Reuses the same rich fields editor (with AI auto-detect) as EXTRACT_LIST.
        type: "keyvalue",
        required: true,
        label: "Fields",
      },
      keyField: {
        type: "string",
        label: "De-dupe key field (which field uniquely identifies a row)",
        placeholder: "e.g. link or id — leave blank to de-dupe on the whole row",
      },
      scrollContainer: {
        type: "string",
        label: "Scroll container selector (optional — leave blank to scroll the page/window)",
        placeholder: "e.g. .results-scroll — for lists that scroll inside a div",
      },
    },
    advanced: {
      expectedCountSelector: {
        type: "string",
        label: "Expected-total selector (element showing the total, e.g. \"340 results\") — enables completeness check",
        placeholder: ".results-count",
      },
      endSelector: {
        type: "string",
        label: "End-of-list selector (element that appears when there are no more items)",
        placeholder: ".no-more-results",
      },
      loadingSelector: {
        type: "string",
        label: "Loading indicator selector (waited out before deciding 'no new items')",
        placeholder: ".spinner, .loading",
      },
      scrollOverlap: {
        type: "number",
        label: "Scroll overlap (0–0.9) — higher = smaller, safer steps that never skip a window",
        default: 0.35,
      },
      scrollDelay: {
        type: "number",
        label: "Wait after each scroll (ms)",
        default: 1200,
      },
      maxNoNew: {
        type: "number",
        label: "Stop after this many scrolls with no new items (only counted once at the bottom)",
        default: 3,
      },
      maxScrolls: {
        type: "number",
        label: "Max scroll steps (safety cap)",
        default: 300,
      },
    },
    outputs: {
      result: { type: "array", description: "De-duplicated array of collected items" },
    },
    // Real generation is on the backend (workflowCodegen.js) — see COLLECT_LIST.
    generateCode: () => `// Collect List (while scrolling) — generated by the backend\n`,
  },

  [ACTION_TYPES.EXTRACT_JSON]: {
    label: "Extract JSON (from page)",
    category: "Extraction",
    description: "Parse embedded JSON from a <script> tag or a JS variable on the page",
    inputs: {
      source: {
        type: "select",
        required: true,
        label: "Source",
        options: [
          { label: "JSON-LD <script> tag", value: "jsonld" },
          { label: "JS variable (window.*)", value: "variable" },
          { label: "Custom <script> selector", value: "selector" }
        ],
        default: "jsonld"
      },
      variableName: {
        type: "string",
        label: "Window variable name (for 'variable' source)",
        placeholder: "e.g. __NEXT_DATA__"
      },
      scriptSelector: {
        type: "string",
        label: "Script element selector (for 'selector' source)",
        placeholder: "e.g. script#product-data"
      }
    },
    advanced: {
      jsonPath: {
        type: "string",
        label: "JSON path to pluck (dot notation, optional)",
        placeholder: "props.pageProps.product"
      }
    },
    outputs: {
      result: { type: "object|array", description: "Parsed JSON value" }
    },
    generateCode: ({ params, advancedOptions, outputVar }) => {
      const { jsonPath } = advancedOptions || {};
      const pathCode = jsonPath
        ? `.${jsonPath.split(".").map(k => `["${k}"]`).join("")}`
        : "";

      if (params.source === "variable") {
        return `
const ${outputVar} = (await page.evaluate(() => window[${JSON.stringify(params.variableName)}]))${pathCode};
`;
      }
      if (params.source === "selector") {
        return `
const ${outputVar}_raw = await page.$eval(${JSON.stringify(params.scriptSelector)}, el => el.textContent);
const ${outputVar} = JSON.parse(${outputVar}_raw)${pathCode};
`;
      }
      // jsonld (default)
      return `
const ${outputVar}_raw = await page.$eval('script[type="application/ld+json"]', el => el.textContent);
const ${outputVar} = JSON.parse(${outputVar}_raw)${pathCode};
`;
    }
  },

  [ACTION_TYPES.EXTRACT_API]: {
    label: "Call Data API",
    category: "Extraction",
    description:
      "Fetch data directly from the site's own JSON API (discovered by the API panel) instead of scraping the DOM — faster, cleaner, and more stable. " +
      "Optionally paginates by incrementing a page/offset parameter until a page comes back empty. Usually added from the ✨ API panel, which pre-fills it for you.",
    inputs: {
      method: {
        type: "select",
        required: true,
        label: "Method",
        options: [
          { label: "GET", value: "GET" },
          { label: "POST", value: "POST" },
          { label: "PUT", value: "PUT" },
          { label: "PATCH", value: "PATCH" },
          { label: "DELETE", value: "DELETE" }
        ],
        default: "GET"
      },
      url: {
        type: "string",
        required: true,
        label: "Endpoint URL",
        placeholder: "https://site.com/api/products?limit=20"
      },
      jsonPath: {
        type: "string",
        label: "Path to the list in the response (dot notation, optional)",
        placeholder: "data.items"
      },
      paginate: {
        type: "boolean",
        label: "Paginate (walk pages until empty)",
        default: false
      },
      pageParam: {
        type: "string",
        label: "Page/offset parameter name",
        placeholder: "page  or  offset",
        showIf: { paginate: [true] }
      },
      pageParamIn: {
        type: "select",
        label: "Parameter location",
        options: [
          { label: "URL query string", value: "query" },
          { label: "JSON request body", value: "body" }
        ],
        default: "query",
        showIf: { paginate: [true] }
      },
      // Non-editable request bits captured from the browser (auth headers,
      // POST/GraphQL body). Hidden from the editor but carried into codegen.
      headers: { type: "hidden", default: null, label: "Request headers" },
      body: { type: "hidden", default: null, label: "Request body" }
    },
    advanced: {
      startPage: { type: "number", label: "Start page/offset", default: 1 },
      pageStep: { type: "number", label: "Increment per page (1 for page, page-size for offset)", default: 1 },
      maxPages: { type: "number", label: "Max pages (safety cap)", default: 50 },
      stopWhenEmpty: { type: "boolean", label: "Stop when a page returns no items", default: true }
    },
    outputs: {
      result: { type: "array", description: "Rows returned by the API" }
    },
    // Real generation is on the backend (workflowCodegen.js EXTRACT_API). This
    // mirror keeps the client-side "Download code" preview functional.
    generateCode: ({ params, advancedOptions, outputVar }) => {
      const { startPage = 1, pageStep = 1, maxPages = 50, stopWhenEmpty = true } = advancedOptions || {};
      const method = String(params.method || "GET").toUpperCase();
      const headers = (params.headers && typeof params.headers === "object") ? params.headers : {};
      const hasBody = !["GET", "HEAD"].includes(method) && params.body != null && params.body !== "";
      const init = `{ method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers)}${hasBody ? `, body: ${JSON.stringify(String(params.body))}` : ""} }`;
      const pathArr = params.jsonPath ? JSON.stringify(String(params.jsonPath).split(".").filter(Boolean)) : "[]";
      const pluck = `(${pathArr}).reduce((o, k) => (o == null ? o : o[k]), _json)`;
      if (!params.paginate || !params.pageParam) {
        return `
const ${outputVar} = await (async () => {
  const _res = await fetch(${JSON.stringify(params.url)}, ${init});
  if (!_res.ok) throw new Error("API request failed: " + _res.status);
  const _json = await _res.json();
  return ${pluck};
})();
`;
      }
      return `
const ${outputVar} = await (async () => {
  const _all = [];
  let _p = ${startPage};
  for (let _i = 0; _i < ${maxPages}; _i++, _p += ${pageStep}) {
    const _u = new URL(${JSON.stringify(params.url)});
    _u.searchParams.set(${JSON.stringify(params.pageParam)}, String(_p));
    const _res = await fetch(_u.href, ${init});
    if (!_res.ok) break;
    const _json = await _res.json();
    const _data = ${pluck};
    const _items = Array.isArray(_data) ? _data : (_data == null ? [] : [_data]);
    ${stopWhenEmpty ? "if (_items.length === 0) break;" : ""}
    _all.push(..._items);
  }
  return _all;
})();
`;
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DATA HANDLING
  // ═══════════════════════════════════════════════════════════════════════════

  [ACTION_TYPES.SET_VARIABLE]: {
    label: "Set Variable",
    category: "Data Handling",
    description: "Assign a constant value or JavaScript expression to a named variable",
    inputs: {
      name: {
        type: "string",
        required: true,
        label: "Variable name",
        placeholder: "myVar"
      },
      value: {
        type: "string",
        required: true,
        label: "Value (JS expression or quoted string)",
        placeholder: "\"hello\"  or  42  or  someOtherVar + 1"
      }
    },
    advanced: {},
    outputs: {
      result: { type: "any", description: "The assigned value" }
    },
    generateCode: ({ params, outputVar }) => `
const ${outputVar} = ${params.value};
// Alias: ${params.name} = ${outputVar}
let ${params.name} = ${outputVar};
`
  },

  [ACTION_TYPES.TRANSFORM_DATA]: {
    label: "Transform Data",
    category: "Data Handling",
    description: "Apply string or array transformations to a variable (trim, replace, regex, split, map…)",
    inputs: {
      source: {
        type: "string",
        required: true,
        label: "Source variable name",
        placeholder: "rawText"
      },
      operation: {
        type: "select",
        required: true,
        label: "Operation",
        options: [
          { label: "Trim whitespace", value: "trim" },
          { label: "To uppercase", value: "uppercase" },
          { label: "To lowercase", value: "lowercase" },
          { label: "Replace (literal)", value: "replace" },
          { label: "Replace (regex)", value: "replaceRegex" },
          { label: "Split into array", value: "split" },
          { label: "Join array to string", value: "join" },
          { label: "Parse as number", value: "toNumber" },
          { label: "Custom JS expression", value: "custom" }
        ],
        default: "trim"
      },
      searchValue: {
        type: "string",
        label: "Search value / delimiter / regex pattern"
      },
      replaceValue: {
        type: "string",
        label: "Replacement value",
        default: ""
      },
      customExpression: {
        type: "string",
        label: "Custom JS (use 'value' as the input)",
        placeholder: "value.slice(0, 100).replace(/\\s+/g, ' ')"
      }
    },
    advanced: {
      regexFlags: {
        type: "string",
        label: "Regex flags (for replaceRegex)",
        default: "g"
      }
    },
    outputs: {
      result: { type: "any", description: "Transformed value" }
    },
    generateCode: ({ params, advancedOptions, outputVar }) => {
      const { regexFlags = "g" } = advancedOptions || {};
      const src = params.source;
      switch (params.operation) {
        case "trim":         return `const ${outputVar} = String(${src}).trim();`;
        case "uppercase":    return `const ${outputVar} = String(${src}).toUpperCase();`;
        case "lowercase":    return `const ${outputVar} = String(${src}).toLowerCase();`;
        case "replace":      return `const ${outputVar} = String(${src}).split(${JSON.stringify(params.searchValue)}).join(${JSON.stringify(params.replaceValue)});`;
        case "replaceRegex": return `const ${outputVar} = String(${src}).replace(new RegExp(${JSON.stringify(params.searchValue)}, "${regexFlags}"), ${JSON.stringify(params.replaceValue)});`;
        case "split":        return `const ${outputVar} = String(${src}).split(${JSON.stringify(params.searchValue)});`;
        case "join":         return `const ${outputVar} = Array.isArray(${src}) ? ${src}.join(${JSON.stringify(params.searchValue ?? "")}) : String(${src});`;
        case "toNumber":     return `const ${outputVar} = Number(${src});`;
        case "custom":       return `const ${outputVar} = ((value) => (${params.customExpression}))(${src});`;
        default:             return `const ${outputVar} = ${src};`;
      }
    }
  },

  [ACTION_TYPES.APPEND_TO_LIST]: {
    label: "Append to List",
    category: "Data Handling",
    description: "Push an item onto an existing array variable (initialises it if undefined)",
    inputs: {
      listName: {
        type: "string",
        required: true,
        label: "Array variable name",
        placeholder: "results"
      },
      item: {
        type: "string",
        required: true,
        label: "Item expression to append",
        placeholder: "currentItem  or  { title, url }"
      }
    },
    advanced: {},
    outputs: {},
    generateCode: ({ params }) => `
if (!Array.isArray(${params.listName})) ${params.listName} = [];
${params.listName}.push(${params.item});
`
  },

  [ACTION_TYPES.SAVE_DATA]: {
    label: "Save Data",
    category: "Data Handling",
    description: "Persist extracted data to a file (JSON or CSV) or send to a webhook",
    inputs: {
      source: {
        type: "string",
        required: true,
        label: "Variable to save",
        placeholder: "results"
      },
      format: {
        type: "select",
        required: true,
        label: "Output format",
        options: [
          { label: "JSON", value: "json" },
          { label: "CSV", value: "csv" },
          { label: "Webhook (POST)", value: "webhook" }
        ],
        default: "json"
      },
      destination: {
        type: "string",
        required: true,
        label: "File path or webhook URL",
        placeholder: "./output/results.json  or  https://hook.example.com/…"
      }
    },
    advanced: {
      csvDelimiter: {
        type: "string",
        label: "CSV delimiter",
        default: ","
      },
      pretty: {
        type: "boolean",
        label: "Pretty-print JSON",
        default: true
      }
    },
    outputs: {},
    generateCode: ({ params, advancedOptions }) => {
      const { csvDelimiter = ",", pretty = true } = advancedOptions || {};
      const src = params.source;
      const dest = JSON.stringify(params.destination);

      if (params.format === "json") {
        return `
const fs = require("fs");
fs.writeFileSync(${dest}, JSON.stringify(${src}, null, ${pretty ? 2 : 0}), "utf8");
`;
      }
      if (params.format === "csv") {
        return `
const fs = require("fs");
const _rows = Array.isArray(${src}) ? ${src} : [${src}];
const _headers = Object.keys(_rows[0] || {});
const _csvLines = [
  _headers.join(${JSON.stringify(csvDelimiter)}),
  ..._rows.map(r => _headers.map(h => JSON.stringify(r[h] ?? "")).join(${JSON.stringify(csvDelimiter)}))
];
fs.writeFileSync(${dest}, _csvLines.join("\\n"), "utf8");
`;
      }
      // webhook
      return `
const _payload = JSON.stringify(${src});
const _whRes = await fetch(${dest}, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: _payload
});
if (!_whRes.ok) throw new Error("Webhook failed: " + _whRes.status);
`;
    }
  },

  [ACTION_TYPES.RUN_SUBFLOW]: {
    label: "Run Subflow",
    category: "Composition",
    description:
      "Open another saved workflow ('subflow') to capture details from a page. Three modes: " +
      "Single URL; iterate over a list of URLs (e.g. {{products[*].link}}); or — the powerful one — " +
      "Enrich a table: point at a previous Extract List (e.g. products), say which field holds the link, " +
      "and the subflow runs on each row's page and folds the details back INTO that same row.",
    inputs: {
      workflowId: {
        // Custom renderer in WorkflowPanel that pulls the user's saved
        // workflows from context and lets them pick one. Stored as a
        // number — the backend resolves it at run time.
        type: "workflowSelect",
        required: true,
        label: "Subflow (saved workflow)",
      },
      mode: {
        type: "select",
        label: "Run on",
        default: "single",
        options: [
          { label: "Single URL",                                   value: "single"   },
          { label: "List of URLs (iterate over each)",             value: "iterate"  },
          { label: "Enrich a table's rows (open each link, merge back)", value: "enrich"   },
        ],
      },

      // ── single mode ────────────────────────────────────────────────
      url: {
        type: "string",
        label: "URL  (single mode)",
        placeholder: "https://example.com/{{product.link}}  — supports {{variables}}",
        showIf: { mode: ["single", ""] },
      },

      // ── iterate mode ───────────────────────────────────────────────
      urlList: {
        type: "string",
        label: "URL list  (iterate mode)",
        placeholder: "{{products[*].link}}  — dot-walk to pull a column out of a table variable",
        showIf: { mode: ["iterate"] },
      },
      itemVar: {
        type: "string",
        label: "Loop variable name  (iterate mode, optional)",
        placeholder: "url",
        default: "_url",
        showIf: { mode: ["iterate"] },
      },

      // ── enrich mode ────────────────────────────────────────────────
      sourceList: {
        type: "string",
        label: "Source table  (enrich mode)",
        placeholder: "{{products}}  — the Extract List whose rows you want to enrich",
        showIf: { mode: ["enrich"] },
      },
      urlField: {
        type: "string",
        label: "Link field  (which column in each row holds the URL)",
        placeholder: "link",
        default: "link",
        showIf: { mode: ["enrich"] },
      },
      baseUrl: {
        type: "string",
        label: "Base URL for relative links  (optional)",
        placeholder: "https://example.com  — prepended when the link isn't absolute",
        showIf: { mode: ["enrich"] },
      },
      mergeStrategy: {
        type: "select",
        label: "How to merge the detail page's results into the row",
        default: "flat",
        options: [
          { label: "Flat — add detail fields as new columns (lists kept as a nested array)", value: "flat" },
          { label: "Prefix — like Flat but prefix the new column names", value: "prefix" },
          { label: "Nest — put the whole detail object under one column", value: "nest" },
          { label: "Explode — one output row per item of a detail list (denormalise)", value: "explode" },
        ],
        showIf: { mode: ["enrich"] },
      },
      detailPrefix: {
        type: "string",
        label: "Column prefix",
        placeholder: "detail_",
        default: "detail_",
        showIf: { mode: ["enrich"], mergeStrategy: ["prefix"] },
      },
      detailField: {
        type: "string",
        label: "Nested column name",
        placeholder: "detail",
        default: "detail",
        showIf: { mode: ["enrich"], mergeStrategy: ["nest"] },
      },
      explodeField: {
        type: "string",
        label: "List field to explode  (leave blank to auto-pick the first list)",
        placeholder: "reviews",
        showIf: { mode: ["enrich"], mergeStrategy: ["explode"] },
      },

      outputVar: {
        type: "string",
        label: "Save results under (optional)",
        placeholder: "product_detail",
      },
    },
    advanced: {
      timeout: {
        type: "number",
        default: 30000,
        label: "Per-iteration timeout (ms)",
      },
    },
    outputs: {
      result: { type: "object", description: "The subflow's collected results (object in single mode; an array of rows when iterating or enriching)" },
    },
    // The real code generation lives on the backend (so it can reach the
    // DB and inline the subflow's full step tree). For the "Download
    // code" path we emit a small placeholder comment — the backend's
    // workflowCodegen.js handles RUN_SUBFLOW with the inlined version.
    generateCode: ({ params }) => {
      if (params.mode === "iterate")
        return `// Subflow #${params.workflowId} iterating over ${JSON.stringify(params.urlList || "")}\n`;
      if (params.mode === "enrich")
        return `// Subflow #${params.workflowId} enriching ${JSON.stringify(params.sourceList || "")} via field ${JSON.stringify(params.urlField || "link")}\n`;
      return `// Subflow #${params.workflowId} on ${JSON.stringify(params.url || "")}\n`;
    },
  },

};