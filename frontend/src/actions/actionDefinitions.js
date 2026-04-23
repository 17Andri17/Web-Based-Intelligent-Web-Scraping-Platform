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
    description: "Extract repeated structured items — each item maps field names to child selectors",
    inputs: {
      containerSelector: {
        type: "string",
        required: true,
        label: "Container selector (repeating parent)",
        placeholder: "e.g. .product-card"
      },
      fields: {
        type: "keyvalue",
        required: true,
        label: "Fields (name → child selector)",
        placeholder: { key: "title", value: "h2.title" }
      }
    },
    advanced: {
      attribute: {
        type: "string",
        label: "Extract attribute instead of text (optional)",
        placeholder: "href, src…"
      }
    },
    outputs: {
      result: { type: "array", description: "Array of extracted objects" }
    },
    generateCode: ({ params, advancedOptions, outputVar }) => {
      const fields = JSON.stringify(params.fields || {});
      const attr = advancedOptions?.attribute ? JSON.stringify(advancedOptions.attribute) : "null";
      return `
const ${outputVar} = await page.$$eval(
  ${JSON.stringify(params.containerSelector)},
  (containers, fields, attr) => containers.map(container => {
    const item = {};
    for (const [name, childSel] of Object.entries(fields)) {
      const el = container.querySelector(childSel);
      if (!el) { item[name] = null; continue; }
      item[name] = attr ? el.getAttribute(attr) : el.textContent.trim();
    }
    return item;
  }),
  ${fields},
  ${attr}
);
`;
    }
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

};