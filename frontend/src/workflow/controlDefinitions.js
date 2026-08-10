// Control steps are composite nodes that contain nested step arrays (branches).
// They are fundamentally different from action steps:
//   - They do NOT generate code themselves; the code generator walks their branches
//   - Each control type declares which branch arrays it owns
//   - `params` schema mirrors actionDefinitions.inputs for the field renderer

// Infinite-scroll pagination and Collect List share one scroll engine on the
// backend, so they share its option schema here too.
import { SCROLL_ACCURACY_ADV } from "../actions/actionDefinitions";

export const CONTROL_TYPES = {
  IF:                'IF',
  FOR_EACH:          'FOR_EACH',
  FOR_EACH_ELEMENTS: 'FOR_EACH_ELEMENTS',
  FOR_EACH_ROW:      'FOR_EACH_ROW',
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
    description: 'Do different steps depending on whether a condition is true.',
    color:       '#a371f7',   // purple
    bgColor:     'rgba(163, 113, 247, 0.08)',
    icon:        'IF',
    branches: [
      { key: 'then', label: 'If it’s true',  emptyLabel: 'Steps to run when the condition is met' },
      { key: 'else', label: 'Otherwise',     emptyLabel: 'Steps to run when it isn’t' },
    ],
    params: {
      expression: {
        type: 'string', required: true,
        label: 'Only run these steps when…',
        placeholder: 'results.length > 0  or  currentPage < 10',
        help: 'Build a condition with the picker above, or type your own expression.',
      },
    },
  },

  [CONTROL_TYPES.FOR_EACH]: {
    label:       'Repeat for every item in a list',
    description: 'Runs the same steps once for each item in a list you captured earlier.',
    color:       '#d29922',   // amber
    bgColor:     'rgba(210, 153, 34, 0.08)',
    icon:        '∀',
    branches: [
      { key: 'body', label: 'Do this for each one', emptyLabel: 'Add the steps to run on every item' },
    ],
    params: {
      source: {
        type: 'string', required: true,
        label: 'Which list?',
        placeholder: 'links',
        help: 'The name of a list an earlier step captured — e.g. Products.',
      },
      itemVar: {
        type: 'string',
        label: 'Call each item',
        default: 'item',
        placeholder: 'item',
        help: 'Later steps refer to the current one as {{item}}.',
      },
      indexVar: {
        type: 'string',
        label: 'Call the position number',
        default: 'index',
        placeholder: 'index',
        help: 'Counts 0, 1, 2… as it goes. Use it as {{index}}.',
      },
    },
  },

  [CONTROL_TYPES.FOR_EACH_ELEMENTS]: {
    label:       'Repeat for every match on the page',
    description: 'Runs the same steps once for every element that matches — every product card, every row, every search result.',
    color:       '#58a6ff',   // blue
    bgColor:     'rgba(88, 166, 255, 0.08)',
    icon:        '⟳',
    branches: [
      { key: 'body', label: 'Do this for each one', emptyLabel: 'Add the steps to run on every match' },
    ],
    params: {
      selector: {
        type: 'string', required: true,
        label: 'Which elements?',
        placeholder: '.product-card',
        help: 'Use “Pick on page” to click one — the platform works out how to match the rest.',
      },
      itemVar: {
        type: 'string',
        label: 'Call each element',
        default: 'el',
        placeholder: 'el',
        help: 'Later steps refer to the current one as {{el}}.',
      },
      indexVar: {
        type: 'string',
        label: 'Call the position number',
        default: 'i',
        placeholder: 'i',
        help: 'Counts 0, 1, 2… as it goes. Use it as {{i}}.',
      },
    },
  },

  [CONTROL_TYPES.FOR_EACH_ROW]: {
    label:       'Add extra detail to every row',
    description: 'Takes a list you already captured and, row by row, runs extra steps — usually on that row’s own link — then adds whatever it finds back onto the row as new columns.',
    color:       '#2dd4bf',   // teal (matches enrich)
    bgColor:     'rgba(45, 212, 191, 0.08)',
    icon:        '⊞',
    branches: [
      { key: 'body', label: 'Do this for each row',
        emptyLabel: 'Add the steps to run per row. Name each extraction — those names become the new columns. Reach the row you’re on with {{row.column}}.' },
    ],
    params: {
      source: {
        type: 'tableSelect', required: true,
        label: 'Which list?',
        placeholder: '{{Products}}',
      },
      openUrlField: {
        type: 'columnSelect',
        label: 'Column holding the link to open (optional)',
        placeholder: 'run on current page',
        columnOf: 'source',
        optional: true,
        help: 'Pick the column with each row’s link to visit its page. Leave empty to stay on the current page.',
      },
      mergeStrategy: {
        type: 'select',
        label: 'Add results as',
        default: 'flat',
        options: [
          { label: 'New columns on each row',              value: 'flat' },
          { label: 'One row per item  (e.g. per review)',  value: 'explode' },
          { label: 'One grouped column',                   value: 'nest' },
          { label: 'New columns with a name prefix',       value: 'prefix' },
        ],
      },
      explodeField: {
        type: 'string',
        label: 'List to expand',
        placeholder: 'auto (first list found)',
        showIf: { mergeStrategy: ['explode'] },
      },
      detailField: {
        type: 'string',
        label: 'Column name',
        default: 'detail',
        placeholder: 'detail',
        showIf: { mergeStrategy: ['nest'] },
      },
      detailPrefix: {
        type: 'string',
        label: 'Prefix',
        default: 'detail_',
        placeholder: 'detail_',
        showIf: { mergeStrategy: ['prefix'] },
      },
      baseUrl: {
        type: 'string',
        label: 'Site address (optional)',
        placeholder: 'https://example.com',
        help: 'Only needed when the links are shortened, like “/product/123” instead of the full address.',
      },
      enrichSummary: {
        type: 'enrichSummary',
        sourceParam: 'source',
        urlParam: 'openUrlField',
        strategyParam: 'mergeStrategy',
        prefixParam: 'detailPrefix',
        nestParam: 'detailField',
      },
      itemVar: {
        type: 'string',
        label: 'Call each row',
        default: 'row',
        placeholder: 'row',
        help: 'Reach the current row’s columns as {{row.columnName}}.',
      },
      indexVar: {
        type: 'string',
        label: 'Call the row number (optional)',
        default: 'index',
        placeholder: 'index',
      },
      timeout: {
        type: 'number',
        label: 'Give up on a row after (ms)',
        default: 30000,
        help: 'A slow or broken page won’t stall the whole run — that row is skipped and the rest continue.',
      },
      outputVar: {
        type: 'string',
        label: 'Save the result as (optional)',
        placeholder: 'products_detailed',
        help: 'Leave empty to update the original list in place.',
      },
    },
  },

  [CONTROL_TYPES.WHILE]: {
    label:       'Repeat while…',
    description: 'Keeps repeating the same steps for as long as a condition stays true.',
    color:       '#f78166',   // coral-orange
    bgColor:     'rgba(247, 129, 102, 0.08)',
    icon:        '↻',
    branches: [
      { key: 'body', label: 'Repeat these steps', emptyLabel: 'Add the steps to repeat' },
    ],
    params: {
      expression: {
        type: 'string', required: true,
        label: 'Keep repeating while…',
        placeholder: 'hasNextPage === true',
        help: 'Build a condition with the picker above, or type your own expression.',
      },
      maxIterations: {
        type: 'number',
        label: 'Stop after this many loops (safety cap)',
        default: 1000,
      },
    },
  },

  [CONTROL_TYPES.REPEAT]: {
    label:       'Repeat a set number of times',
    description: 'Runs the same steps a fixed number of times.',
    color:       '#3fb950',   // green
    bgColor:     'rgba(63, 185, 80, 0.08)',
    icon:        '⟳',
    branches: [
      { key: 'body', label: 'Repeat these steps', emptyLabel: 'Add the steps to repeat' },
    ],
    params: {
      count: {
        type: 'number', required: true,
        label: 'How many times?',
        default: 10,
      },
      indexVar: {
        type: 'string',
        label: 'Call the round number',
        default: 'i',
        placeholder: 'i',
        help: 'Counts 0, 1, 2… as it goes. Use it as {{i}}.',
      },
    },
  },

  // ── Pagination: Infinite Scroll ──────────────────────────────────────
  [CONTROL_TYPES.PAGINATE_SCROLL]: {
    label:       'More pages — Keep scrolling',
    description: 'Scrolls to the bottom over and over until nothing new loads, then runs your steps on the fully-loaded page.',
    color:       '#d29922',   // amber
    bgColor:     'rgba(210, 153, 34, 0.08)',
    icon:        '↕',
    branches: [
      { key: 'body', label: 'Run after all content loads',
        emptyLabel: 'Add the steps that extract the fully-loaded list' },
    ],
    params: {
      scrollContainer: {
        type: 'string',
        label: 'Which box scrolls? (leave empty for the whole page)',
        placeholder: 'e.g. .feed-scroll',
        help: 'Only needed when the list scrolls inside its own box rather than the whole window.',
      },
      ...SCROLL_ACCURACY_ADV,
      scrollDelay: {
        type: 'number',
        label: 'Delay after each scroll (ms) — only used when Accuracy mode is OFF',
        default: 1500,
      },
      maxNoChange: {
        type: 'number',
        label: 'Stop after this many scrolls with no new content — only used when Accuracy mode is OFF',
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
    label:       'More pages — Click “Next”',
    description: 'Runs your steps on the current page, then clicks the Next / Load-more button. Keeps going until that button is no longer there.',
    color:       '#58a6ff',   // blue
    bgColor:     'rgba(88, 166, 255, 0.08)',
    icon:        '→',
    branches: [
      { key: 'body', label: 'Do this on every page',
        emptyLabel: 'Add the steps that run on each page, before it moves to the next one' },
    ],
    params: {
      selector: {
        type: 'string', required: true,
        label: 'Which button?',
        placeholder: 'a.next, button[aria-label="Next"]',
        help: 'Use “Pick on page” to click the site’s Next button.',
      },
      fallbackSelectors: {
        type: 'selectorList',
        label: 'Backup options',
        default: [],
        help: 'Tried in order if the button above stops matching — useful when a site changes its layout.',
      },
      delay: {
        type: 'number',
        label: 'Wait after each click (ms)',
        default: 2000,
        help: 'Gives the next page time to load.',
      },
      maxIterations: {
        type: 'number',
        label: 'Never go past this many pages',
        default: 200,
        help: 'A safety cap, so a site that never runs out of pages can’t loop forever.',
      },
    },
  },

  // ── Pagination: URL pages (incrementing) ─────────────────────────────
  [CONTROL_TYPES.PAGINATE_URL]: {
    label:       'More pages — Numbered web addresses',
    description: 'Walks through pages by counting up in the web address (…?page=1, ?page=2, …). It stops on its own once a page comes back empty, so it still works when the number of pages changes.',
    color:       '#2dd4bf',   // teal
    bgColor:     'rgba(45, 212, 191, 0.08)',
    icon:        '🔗',
    branches: [
      { key: 'body', label: 'Do this on every page',
        emptyLabel: 'Add the steps that collect data from each page' },
    ],
    params: {
      urlPattern: {
        type: 'string', required: true,
        label: 'Web address, with {n} where the page number goes',
        placeholder: 'https://example.com/products?page={n}',
      },
      contentSelector: {
        type: 'string', required: true,
        label: 'What should be on every page?',
        placeholder: '.product-card',
        help: 'When a page turns up none of these, there are no more pages and it stops.',
      },
      startPage: {
        type: 'number',
        label: 'Start counting from',
        default: 1,
      },
      step: {
        type: 'number',
        label: 'Count up by',
        default: 1,
        help: 'Usually 1. Some sites step by the page size instead — 0, 20, 40…',
      },
      delay: {
        type: 'number',
        label: 'Wait after opening each page (ms)',
        default: 1500,
      },
      maxIterations: {
        type: 'number',
        label: 'Never go past this many pages',
        default: 500,
        help: 'A safety cap, so a site that never runs out of pages can’t loop forever.',
      },
    },
  },

  [CONTROL_TYPES.TRY_CATCH]: {
    label:       'Try, and carry on if it fails',
    description: 'Runs the first group of steps. If any of them fail, the run continues with the second group instead of stopping.',
    color:       '#f85149',   // red
    bgColor:     'rgba(248, 81, 73, 0.08)',
    icon:        '⚡',
    branches: [
      { key: 'try',   label: 'Try these steps',        emptyLabel: 'Add the steps to attempt' },
      { key: 'catch', label: 'If something goes wrong', emptyLabel: 'Add what to do instead — or leave empty to just skip and continue' },
    ],
    params: {
      errorVar: {
        type: 'string',
        label: 'Call the error',
        default: 'error',
        placeholder: 'error',
        help: 'Refer to what went wrong as {{error}} — handy for logging or saving it.',
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