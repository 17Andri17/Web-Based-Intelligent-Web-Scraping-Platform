import { actionDefinitions } from "../actions/actionDefinitions";
import {
  controlDefinitions,
  PAGINATION_CONTROL_TYPES,
  PAGINATION_STRATEGY,
} from "./controlDefinitions";

/* =====================================================================
   createAction  –  leaf node (executable step)
   ===================================================================== */
export function createAction(type, params = {}, advanced = {}) {
  const def = actionDefinitions[type];
  if (!def) throw new Error(`Unknown action type: ${type}`);

  // Build final params from definition schema
  const finalParams = {};
  for (const [key, paramDef] of Object.entries(def.inputs || {})) {
    finalParams[key] = params[key] !== undefined
      ? params[key]
      : paramDef.default !== undefined ? paramDef.default : null;
  }

  // Build final advanced from definition schema
  const finalAdvanced = {};
  for (const [key, advDef] of Object.entries(def.advanced || {})) {
    finalAdvanced[key] = advanced[key] !== undefined
      ? advanced[key]
      : advDef.default !== undefined ? advDef.default : null;
  }

  // Output variable name for steps that produce a value
  let outputVar = null;
  if (def.outputs && Object.keys(def.outputs).length > 0) {
    const baseName = type.toLowerCase().replace(/_/g, '');
    outputVar = `${baseName}_${Math.random().toString(36).slice(2, 6)}`;
  }

  return {
    id:       crypto.randomUUID(),
    kind:     'action',           // ← discriminant
    type,
    params:   finalParams,
    advanced: finalAdvanced,
    outputVar,
  };
}

/* =====================================================================
   createControl  –  composite node (contains nested step arrays)
   ===================================================================== */
export function createControl(type, params = {}) {
  const def = controlDefinitions[type];
  if (!def) throw new Error(`Unknown control type: ${type}`);

  // Build params from definition schema. selectorList / array params seed
  // to an empty array rather than the generic empty string so the editor's
  // list renderer receives the right shape.
  const finalParams = {};
  for (const [key, paramDef] of Object.entries(def.params || {})) {
    // Display-only fields (e.g. the live enrich summary) hold no value.
    if (paramDef.type === 'enrichSummary' || paramDef.type === 'note') continue;
    const emptyDefault = (paramDef.type === 'selectorList' || paramDef.type === 'array') ? [] : '';
    finalParams[key] = params[key] !== undefined
      ? params[key]
      : paramDef.default !== undefined ? paramDef.default : emptyDefault;
  }

  // Initialise each declared branch as an empty array
  const branches = {};
  for (const branch of def.branches) {
    branches[branch.key] = [];
  }

  const step = {
    id:     crypto.randomUUID(),
    kind:   'control',            // ← discriminant
    type,
    params: finalParams,
    ...branches,
  };

  // Native pagination containers carry a meta tag so the renderer and the
  // README/analytics walkers recognise them the same way they recognise
  // the legacy composed pagination loops.
  if (PAGINATION_CONTROL_TYPES.has(type)) {
    step.meta = { kind: 'pagination', strategy: PAGINATION_STRATEGY[type], engine: 'native' };
  }

  return step;
}