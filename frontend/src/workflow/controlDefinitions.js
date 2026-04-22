// Control steps are composite nodes that contain nested step arrays (branches).
// They are fundamentally different from action steps:
//   - They do NOT generate code themselves; the code generator walks their branches
//   - Each control type declares which branch arrays it owns
//   - `params` schema mirrors actionDefinitions.inputs for the field renderer

export const CONTROL_TYPES = {
  IF:        'IF',
  FOR_EACH:  'FOR_EACH',
  WHILE:     'WHILE',
  REPEAT:    'REPEAT',
  TRY_CATCH: 'TRY_CATCH',
};

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