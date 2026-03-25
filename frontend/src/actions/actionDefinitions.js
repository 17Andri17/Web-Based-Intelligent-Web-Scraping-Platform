import { ACTION_TYPES } from "./actionTypes";

export const actionDefinitions = {
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
      fallbackSelectors: {
        type: "array",
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
      result: {
        type: "array|string"
      }
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

  [ACTION_TYPES.CLICK_ELEMENT]: {
    label: "Click Element",
    category: "Interaction",
    inputs: {
      selector: {
        type: "string",
        required: true,
        label: "Primary Selector"
      },
      fallbackSelectors: {
        type: "array",
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
      }
    },
    generateCode: ({ selectorVar }) => `
await page.click(${selectorVar});
`
  }
}