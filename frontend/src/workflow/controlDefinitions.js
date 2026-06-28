// Control steps are composite nodes that contain nested step arrays (branches).
// They are fundamentally different from action steps:
//   - They do NOT generate code themselves; the code generator walks their branches
//   - Each control type declares which branch arrays it owns
//   - `params` schema mirrors actionDefinitions.inputs for the field renderer

export const CONTROL_TYPES = {
  IF:                'IF',
  FOR_EACH:          'FOR_EACH',
  FOR_EACH_ELEMENTS: 'FOR_EACH_ELEMENTS',
  WHILE:             'WHILE',
  REPEAT:            'REPEAT',
  TRY_CATCH:         'TRY_CATCH',

  // ── Pagination (high-level loop containers) ──────────────────────────
  // These three replace the old "While + If/Break + click/wait" recipe with
  // a single, self-contained step. Each owns one `body` branch whose steps
  // run for every page the pagination visits. All the looping / stop logic
  // lives in the code generator — the user only fills in simple parameters.
  PAGINATE_SCROLL:   'PAGINATE_SCROLL',
  PAGINATE_BUTTON:   'PAGINATE_BUTTON',
  PAGINATE_URL:      'PAGINATE_URL',
};

// The high-level pagination containers, kept as a set so both the renderer
// and the code generator can recognise them without string-matching prefixes.
export const PAGINATION_CONTROL_TYPES = new Set([
  CONTROL_TYPES.PAGINATE_SCROLL,
  CONTROL_TYPES.PAGINATE_BUTTON,
  CONTROL_TYPES.PAGINATE_URL,
]);

// Map each native pagination type → the `strategy` tag we stamp onto
// step.meta. Keeps README detection + any analytics consistent with the
// legacy (composed) pagination loops that already used meta.strategy.
export const PAGINATION_STRATEGY = {
  [CONTROL_TYPES.PAGINATE_SCROLL]: 'infinite_scroll',
  [CONTROL_TYPES.PAGINATE_BUTTON]: 'next_button',
  [CONTROL_TYPES.PAGINATE_URL]:    'url_param',
};

/** True for both the new native containers and legacy meta-tagged loops. */
export function isPaginationStep(step) {
  if (!step || typeof step !== 'object') return false;
  return PAGINATION_CONTROL_TYPES.has(step.type) || step.meta?.kind === 'pagination';
}

export const controlDefinitions = {

  [CONTROL_TYPES.IF]: {
    label:       'If / Else',
    description: 'Branch execution based on a JavaScript expression',
    color:       '#a371f7',   // purple
    bgColor:     'rgba(163, 113, 247, 0.08)',
    icon:        'IF',
    branches: [
      { key: 'then', label: 'Then',  emptyLabel: 'Add steps for the TRUE branch' },
      { key: 'else', label: 'Else',  emptyLabel: 'Add steps for the FALSE branch' },
    ],
    params: {
      expression: {
        type: 'string', required: true,
        label: 'Condition (JS expression)',
        placeholder: 'results.length > 0  or  currentPage < 10',
      },
    },
  },

  [CONTROL_TYPES.FOR_EACH]: {
    label:       'For Each',
    description: 'Iterate over every item in a list variable',
    color:       '#d29922',   // amber
    bgColor:     'rgba(210, 153, 34, 0.08)',
    icon:        '∀',
    branches: [
      { key: 'body', label: 'Loop body', emptyLabel: 'Add steps to run on each item' },
    ],
    params: {
      source: {
        type: 'string', required: true,
        label: 'Source variable (array)',
        placeholder: 'links',
      },
      itemVar: {
        type: 'string',
        label: 'Item variable name',
        default: 'item',
        placeholder: 'item',
      },
      indexVar: {
        type: 'string',
        label: 'Index variable name',
        default: 'index',
        placeholder: 'index',
      },
    },
  },

  [CONTROL_TYPES.FOR_EACH_ELEMENTS]: {
    label:       'For Each Element',
    description: 'Query all elements matching a CSS selector and iterate over each one',
    color:       '#58a6ff',   // blue
    bgColor:     'rgba(88, 166, 255, 0.08)',
    icon:        '⟳',
    branches: [
      { key: 'body', label: 'Loop body', emptyLabel: 'Add steps to run on each matched element' },
    ],
    params: {
      selector: {
        type: 'string', required: true,
        label: 'CSS Selector (matches elements to iterate)',
        placeholder: '.product-card',
      },
      itemVar: {
        type: 'string',
        label: 'Element handle variable name',
        default: 'el',
        placeholder: 'el',
      },
      indexVar: {
        type: 'string',
        label: 'Index variable name',
        default: 'i',
        placeholder: 'i',
      },
    },
  },

  [CONTROL_TYPES.WHILE]: {
    label:       'While',
    description: 'Repeat steps while a condition remains true',
    color:       '#f78166',   // coral-orange
    bgColor:     'rgba(247, 129, 102, 0.08)',
    icon:        '↻',
    branches: [
      { key: 'body', label: 'Loop body', emptyLabel: 'Add steps to repeat' },
    ],
    params: {
      expression: {
        type: 'string', required: true,
        label: 'Continue while (JS expression)',
        placeholder: 'hasNextPage === true',
      },
      maxIterations: {
        type: 'number',
        label: 'Max iterations (safety cap)',
        default: 1000,
      },
    },
  },

  [CONTROL_TYPES.REPEAT]: {
    label:       'Repeat N times',
    description: 'Execute steps a fixed number of times',
    color:       '#3fb950',   // green
    bgColor:     'rgba(63, 185, 80, 0.08)',
    icon:        '⟳',
    branches: [
      { key: 'body', label: 'Loop body', emptyLabel: 'Add steps to repeat' },
    ],
    params: {
      count: {
        type: 'number', required: true,
        label: 'Number of repetitions',
        default: 10,
      },
      indexVar: {
        type: 'string',
        label: 'Index variable name',
        default: 'i',
        placeholder: 'i',
      },
    },
  },

  // ── Pagination: Infinite Scroll ──────────────────────────────────────
  [CONTROL_TYPES.PAGINATE_SCROLL]: {
    label:       'Pagination — Infinite Scroll',
    description: 'Scroll to the bottom repeatedly until no new content loads, then run your steps on the fully-loaded page.',
    color:       '#d29922',   // amber
    bgColor:     'rgba(210, 153, 34, 0.08)',
    icon:        '↕',
    branches: [
      { key: 'body', label: 'Run after all content loads',
        emptyLabel: 'Add the steps that extract the fully-loaded list' },
    ],
    params: {
      scrollDelay: {
        type: 'number',
        label: 'Delay after each scroll (ms)',
        default: 1500,
      },
      maxNoChange: {
        type: 'number',
        label: 'Stop after this many scrolls with no new content',
        default: 3,
      },
      maxIterations: {
        type: 'number',
        label: 'Max scrolls (safety cap)',
        default: 100,
      },
    },
  },

  // ── Pagination: Click a button (Next / Load more) ────────────────────
  [CONTROL_TYPES.PAGINATE_BUTTON]: {
    label:       'Pagination — Click Button',
    description: 'Run your steps on the current page, then click the Next / Load-more button. Repeats until the button can no longer be found.',
    color:       '#58a6ff',   // blue
    bgColor:     'rgba(88, 166, 255, 0.08)',
    icon:        '→',
    branches: [
      { key: 'body', label: 'Run on each page',
        emptyLabel: 'Add the steps that run on every page (before the next click)' },
    ],
    params: {
      selector: {
        type: 'string', required: true,
        label: 'Button selector (main)',
        placeholder: 'a.next, button[aria-label="Next"]',
      },
      fallbackSelectors: {
        type: 'selectorList',
        label: 'Fallback selectors (tried in order if the main one is missing)',
        default: [],
      },
      delay: {
        type: 'number',
        label: 'Wait after each click (ms)',
        default: 2000,
      },
      maxIterations: {
        type: 'number',
        label: 'Max pages (safety cap)',
        default: 200,
      },
    },
  },

  // ── Pagination: URL pages (incrementing) ─────────────────────────────
  [CONTROL_TYPES.PAGINATE_URL]: {
    label:       'Pagination — URL Pages',
    description: 'Navigate page-by-page using a URL pattern that increments. A while-loop keeps going until a page has none of the desired elements — so it adapts when the page count changes.',
    color:       '#2dd4bf',   // teal
    bgColor:     'rgba(45, 212, 191, 0.08)',
    icon:        '🔗',
    branches: [
      { key: 'body', label: 'Run on each page',
        emptyLabel: 'Add the steps that extract each page' },
    ],
    params: {
      urlPattern: {
        type: 'string', required: true,
        label: 'URL pattern — put {n} where the page number goes',
        placeholder: 'https://example.com/products?page={n}',
      },
      contentSelector: {
        type: 'string', required: true,
        label: 'Content selector — stop when a page has none of these',
        placeholder: '.product-card',
      },
      startPage: {
        type: 'number',
        label: 'First page number',
        default: 1,
      },
      step: {
        type: 'number',
        label: 'Increment per page',
        default: 1,
      },
      delay: {
        type: 'number',
        label: 'Wait after each navigation (ms)',
        default: 1500,
      },
      maxIterations: {
        type: 'number',
        label: 'Max pages (safety cap)',
        default: 500,
      },
    },
  },

  [CONTROL_TYPES.TRY_CATCH]: {
    label:       'Try / Catch',
    description: 'Run steps and handle any errors gracefully',
    color:       '#f85149',   // red
    bgColor:     'rgba(248, 81, 73, 0.08)',
    icon:        '⚡',
    branches: [
      { key: 'try',   label: 'Try',   emptyLabel: 'Add steps to attempt' },
      { key: 'catch', label: 'Catch', emptyLabel: 'Add error-handling steps' },
    ],
    params: {
      errorVar: {
        type: 'string',
        label: 'Error variable name',
        default: 'error',
        placeholder: 'error',
      },
    },
  },

};

// Convenience: check if a step is a control block
export function isControlStep(step) {
  return step?.kind === 'control';
}

export function isActionStep(step) {
  return step?.kind === 'action';
}