import { actionDefinitions } from "../actions/actionDefinitions";

export function createAction(type, params = {}, advanced = {}) {
  const def = actionDefinitions[type];
  if (!def) throw new Error(`Unknown action type: ${type}`);

  // 🔹 Build input params
  const finalParams = {};
  for (const [key, paramDef] of Object.entries(def.inputs || {})) {
    if (params[key] !== undefined) {
      finalParams[key] = params[key];
    } else if (paramDef.default !== undefined) {
      finalParams[key] = paramDef.default;
    } else {
      finalParams[key] = null;
    }
  }

  // 🔹 Build advanced options
  const finalAdvanced = {};
  for (const [key, advDef] of Object.entries(def.advanced || {})) {
    if (advanced[key] !== undefined) {
      finalAdvanced[key] = advanced[key];
    } else if (advDef.default !== undefined) {
      finalAdvanced[key] = advDef.default;
    } else {
      finalAdvanced[key] = null;
    }
  }

  // 🔹 Generate output variable name (simple version)
  let outputVar = null;
  if (def.outputs) {
    const baseName = type.toLowerCase();
    outputVar = `${baseName}_${Math.random().toString(36).slice(2, 6)}`;
  }

  return {
    id: crypto.randomUUID(),
    type,
    params: finalParams,
    advanced: finalAdvanced,
    outputVar
  };
}